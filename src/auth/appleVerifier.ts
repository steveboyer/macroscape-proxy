import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from 'jose';
import type { JWTPayload } from 'jose';

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_JWKS_URL = new URL('https://appleid.apple.com/auth/keys');

// Module-scope singleton — survives Lambda warm starts so warm invocations
// reuse the cached JWKS instead of re-fetching from Apple each time.
const jwks = createRemoteJWKSet(APPLE_JWKS_URL);

export interface AppleClaims extends JWTPayload {
  sub: string;
  email?: string;
  email_verified?: boolean | 'true' | 'false';
  is_private_email?: boolean | 'true' | 'false';
  auth_time?: number;
  nonce_supported?: boolean;
}

export type AppleTokenErrorReason =
  | 'expired'
  | 'invalid_signature'
  | 'invalid_issuer'
  | 'invalid_audience'
  | 'malformed'
  | 'jwks_fetch_failed';

export class AppleTokenError extends Error {
  readonly reason: AppleTokenErrorReason;
  constructor(reason: AppleTokenErrorReason, message: string) {
    super(message);
    this.name = 'AppleTokenError';
    this.reason = reason;
  }
}

export async function verifyAppleIdToken(token: string): Promise<AppleClaims> {
  const aud = process.env.APPLE_AUD;
  if (!aud) {
    throw new Error('APPLE_AUD env var is required');
  }

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: APPLE_ISSUER,
      audience: aud,
    });

    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new AppleTokenError('malformed', 'token payload missing sub claim');
    }

    return payload as AppleClaims;
  } catch (err) {
    if (err instanceof AppleTokenError) throw err;
    throw mapJoseError(err);
  }
}

function mapJoseError(err: unknown): AppleTokenError {
  if (err instanceof joseErrors.JWTExpired) {
    return new AppleTokenError('expired', err.message);
  }
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    const reason: AppleTokenErrorReason =
      err.claim === 'iss'
        ? 'invalid_issuer'
        : err.claim === 'aud'
          ? 'invalid_audience'
          : 'malformed';
    return new AppleTokenError(reason, err.message);
  }
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
    return new AppleTokenError('invalid_signature', err.message);
  }
  if (err instanceof joseErrors.JWKSNoMatchingKey || err instanceof joseErrors.JWKSInvalid) {
    return new AppleTokenError('jwks_fetch_failed', err.message);
  }
  if (err instanceof joseErrors.JWSInvalid || err instanceof joseErrors.JWTInvalid) {
    return new AppleTokenError('malformed', err.message);
  }
  // Fail closed on any unrecognized error class.
  return new AppleTokenError('malformed', err instanceof Error ? err.message : String(err));
}
