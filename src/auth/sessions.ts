import { upsertUser } from '../db/users';
import {
  bumpSessionEpoch,
  consumeRefreshToken,
  getRefreshRecord,
  getSessionEpoch,
  issueRefreshToken,
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

export async function createSession(appleIdToken: string): Promise<SessionResponse> {
  let sub: string;
  try {
    const claims = await verifyAppleIdToken(appleIdToken);
    sub = claims.sub;
  } catch (err) {
    if (err instanceof AppleTokenError) {
      throw new AuthError(401, err.reason, err.message);
    }
    throw err;
  }

  await upsertUser(sub);
  const epoch = await getSessionEpoch(sub);
  return mintPair(sub, epoch);
}

export async function refreshSession(refreshToken: string): Promise<SessionResponse> {
  const record = await getRefreshRecord(refreshToken);
  if (!record) {
    throw new AuthError(401, 'invalid_refresh_token', 'no record for presented token');
  }

  // Replay of an already-consumed token. Either the client is retrying against
  // a stale copy or someone lifted one; there's no way to tell them apart from
  // here, so revoke the whole chain and make both parties sign in again.
  if (record.consumedAt !== null) {
    await bumpSessionEpoch(record.userId);
    throw new AuthError(401, 'refresh_token_reused', 'consumed token replayed; chain revoked');
  }

  if (Date.parse(record.expiresAt) <= Date.now()) {
    throw new AuthError(401, 'invalid_refresh_token', 'token expired');
  }

  // Epoch mismatch means the chain was revoked after this token was minted
  // (a logout-all, or a prior reuse detection). Not reuse — don't bump again.
  const epoch = await getSessionEpoch(record.userId);
  if (record.epoch !== epoch) {
    throw new AuthError(401, 'invalid_refresh_token', 'token predates a chain revocation');
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
