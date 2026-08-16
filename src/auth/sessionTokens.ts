import { SignJWT, jwtVerify, decodeJwt, decodeProtectedHeader, errors as joseErrors } from 'jose';
import { getSigningKeys } from './sessionKeys';

/**
 * Proxy-issued access tokens (MSP044).
 *
 * Apple's id_token is an authentication assertion for the moment of sign-in,
 * not a bearer credential for ongoing API calls: it lives ~10 minutes and iOS
 * has no API to silently re-mint one, so using it per-request forced a Sign in
 * with Apple sheet every ten minutes. The proxy issues its own token instead —
 * same `sub`, so every downstream consumer (rate-limit counters, user records,
 * cost attribution) is unchanged.
 */

export const PROXY_ISSUER = 'https://api.macroscape.app';
export const PROXY_AUDIENCE = 'macroscape-proxy';

const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 3600;
const ALG = 'HS256';

export type AccessTokenErrorReason = 'expired' | 'invalid_signature' | 'malformed';

export class AccessTokenError extends Error {
  readonly reason: AccessTokenErrorReason;
  constructor(reason: AccessTokenErrorReason, message: string) {
    super(message);
    this.name = 'AccessTokenError';
    this.reason = reason;
  }
}

export interface AccessTokenClaims {
  sub: string;
  exp: number;
}

export async function mintAccessToken(sub: string): Promise<{ token: string; expiresIn: number }> {
  const { activeKid, keys } = await getSigningKeys();
  const key = keys.get(activeKid);
  if (!key) {
    throw new Error(`no signing key for activeKid ${activeKid}`);
  }

  const expiresIn = readAccessTokenTtl();
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: ALG, kid: activeKid })
    .setSubject(sub)
    .setIssuer(PROXY_ISSUER)
    .setAudience(PROXY_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${expiresIn}s`)
    .sign(key);

  return { token, expiresIn };
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  const { keys } = await getSigningKeys();

  let kid: string | undefined;
  try {
    kid = decodeProtectedHeader(token).kid;
  } catch (err) {
    throw new AccessTokenError('malformed', err instanceof Error ? err.message : String(err));
  }

  // An unknown (or absent) `kid` means the token was signed with a key this
  // container doesn't hold — a retired key, or a forgery. Same outcome either
  // way: reject rather than trying every key in turn.
  const key = kid ? keys.get(kid) : undefined;
  if (!key) {
    // `kid` is attacker-controlled and this message reaches CloudWatch, so
    // clamp it — an unbounded string here is a log-injection lever, and the
    // value has no diagnostic worth beyond its first few characters.
    throw new AccessTokenError('invalid_signature', `unknown kid: ${describeKid(kid)}`);
  }

  try {
    const { payload } = await jwtVerify(token, key, {
      issuer: PROXY_ISSUER,
      audience: PROXY_AUDIENCE,
      algorithms: [ALG],
    });
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new AccessTokenError('malformed', 'token payload missing sub claim');
    }
    return { sub: payload.sub, exp: payload.exp ?? 0 };
  } catch (err) {
    if (err instanceof AccessTokenError) throw err;
    if (err instanceof joseErrors.JWTExpired) {
      throw new AccessTokenError('expired', err.message);
    }
    if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
      throw new AccessTokenError('invalid_signature', err.message);
    }
    throw new AccessTokenError('malformed', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Cheap, unverified issuer peek used to route a bearer token to the right
 * verifier. Deliberately not a trust decision — a forged `iss` only picks
 * which verifier rejects the token.
 */
export function looksLikeProxyToken(token: string): boolean {
  try {
    return decodeJwt(token).iss === PROXY_ISSUER;
  } catch {
    return false;
  }
}

function describeKid(kid: string | undefined): string {
  if (kid === undefined) return '(absent)';
  const safe = kid.replace(/[^\w.-]/g, '?').slice(0, 32);
  return safe.length < kid.length ? `${safe}…` : safe;
}

function readAccessTokenTtl(): number {
  const raw = process.env.ACCESS_TOKEN_TTL_SECONDS;
  if (!raw) return DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
}
