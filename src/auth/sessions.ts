import { upsertUser } from '../db/users';
import {
  bumpSessionEpoch,
  consumeRefreshToken,
  getRefreshRecord,
  getSessionEpoch,
  issueRefreshToken,
  type RefreshRecord,
} from '../db/sessions';
import { AuthError } from './authenticate';
import { verifyAppleIdToken, AppleTokenError } from './appleVerifier';
import { mintAccessToken } from './sessionTokens';

/**
 * Session flows for MSP044 — the three `/v1/auth/*` routes.
 *
 * `/session` is the only place an Apple `id_token` is required; after that the
 * client runs entirely on proxy credentials, so Sign in with Apple fires once
 * per install rather than every ten minutes.
 */

export interface SessionResponse {
  accessToken: string;
  accessExpiresIn: number;
  refreshToken: string;
  refreshExpiresIn: number;
  userId: string;
}

/**
 * Both flows are split into a **lookup** step and a **commit** step so the
 * caller can charge the rate limit in between. Doing the whole thing in one
 * call meant a 429 could fire *after* the old refresh token was already
 * consumed and a replacement minted: the client got an error, its token was
 * spent, and its retry looked exactly like a replay — which revokes the
 * user's whole chain. Hitting a rate limit must not sign anyone out.
 */

/** Verifies the Apple assertion. No writes — safe to call before rate limiting. */
export async function verifyAppleAssertion(appleIdToken: string): Promise<string> {
  try {
    const claims = await verifyAppleIdToken(appleIdToken);
    return claims.sub;
  } catch (err) {
    if (err instanceof AppleTokenError) {
      throw new AuthError(401, err.reason, err.message);
    }
    throw err;
  }
}

/** Commit step for `/v1/auth/session`. */
export async function startSession(sub: string): Promise<SessionResponse> {
  await upsertUser(sub);
  const epoch = await getSessionEpoch(sub);
  return mintPair(sub, epoch);
}

/**
 * Lookup step for `/v1/auth/refresh`. Read-only: resolves the presented token
 * to its record so the caller knows which user to charge. Every validity
 * decision — including reuse detection, which mutates — happens in
 * `completeRefresh`, after the limit has been charged.
 */
export async function beginRefresh(refreshToken: string): Promise<RefreshRecord> {
  const record = await getRefreshRecord(refreshToken);
  if (!record) {
    throw new AuthError(401, 'invalid_refresh_token', 'no record for presented token');
  }
  return record;
}

export async function completeRefresh(
  refreshToken: string,
  record: RefreshRecord,
): Promise<SessionResponse> {
  // Epoch first, and deliberately so. A consumed token whose epoch is already
  // stale is inert history, not evidence of theft: the chain it belonged to
  // was revoked long ago. Checking `consumedAt` before the epoch made every
  // replay of such a token bump the epoch again — and because consumed rows
  // live ~120 days (expiry + the TTL grace) and the epoch is per-user, anyone
  // holding one old token could sign the user out of every device, wait for
  // them to sign back in, and do it again indefinitely.
  const epoch = await getSessionEpoch(record.userId);
  if (record.epoch !== epoch) {
    throw new AuthError(401, 'invalid_refresh_token', 'token predates a chain revocation');
  }

  if (Date.parse(record.expiresAt) <= Date.now()) {
    throw new AuthError(401, 'invalid_refresh_token', 'token expired');
  }

  // Replay of a token from the *current* chain. Either the client is retrying
  // against a stale copy or someone lifted one; there's no way to tell them
  // apart from here, so revoke the chain and make both parties sign in again.
  if (record.consumedAt !== null) {
    await bumpSessionEpoch(record.userId);
    throw new AuthError(401, 'refresh_token_reused', 'consumed token replayed; chain revoked');
  }

  // Consume before issuing. If the process dies between the two the client
  // simply re-authenticates — the reverse order could leave a consumed-but-
  // unreplaced session, which looks identical to theft on the next call.
  const consumed = await consumeRefreshToken(refreshToken);
  if (!consumed) {
    // Lost a race with a concurrent redeem of the same token.
    await bumpSessionEpoch(record.userId);
    throw new AuthError(401, 'refresh_token_reused', 'concurrent redeem; chain revoked');
  }

  return mintPair(record.userId, epoch);
}

export async function logoutSession(refreshToken: string): Promise<void> {
  const record = await getRefreshRecord(refreshToken);
  if (!record) {
    // Idempotent by design: signing out an already-dead session is a success,
    // not an error, so a client can retry a failed logout without handling 401.
    return;
  }
  await consumeRefreshToken(refreshToken);
}

async function mintPair(userId: string, epoch: number): Promise<SessionResponse> {
  const access = await mintAccessToken(userId);
  const refresh = await issueRefreshToken(userId, epoch);
  return {
    accessToken: access.token,
    accessExpiresIn: access.expiresIn,
    refreshToken: refresh.token,
    refreshExpiresIn: refresh.expiresIn,
    userId,
  };
}
