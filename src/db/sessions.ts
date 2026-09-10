import { createHash, randomBytes } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { client, getTableName } from './client';
import { sessionKey, sessionTtl, userKey } from './keys';

/**
 * Refresh-token storage for proxy sessions (MSP047).
 *
 * Two properties the shape below is built around:
 *
 *  1. **Only hashes are stored.** The raw token exists in the response body
 *     and on the client; the table holds SHA-256. Reading the table gives an
 *     attacker nothing they can present.
 *  2. **Rotation with reuse detection.** Each redeem consumes the presented
 *     token and issues a new one. A *consumed* token presented again means
 *     either a replay or a stolen copy racing the legitimate client — either
 *     way the whole chain is revoked rather than guessing which caller is real.
 *
 * Chain revocation is a per-user epoch on the user record rather than a scan
 * over that user's tokens: bumping `sessionEpoch` invalidates every outstanding
 * refresh token for the user in one write, with no GSI and no unbounded delete.
 */

const REFRESH_TOKEN_BYTES = 32;
const DEFAULT_REFRESH_TOKEN_TTL_DAYS = 90;

export interface RefreshRecord {
  userId: string;
  epoch: number;
  expiresAt: string;
  consumedAt: string | null;
}

export interface IssuedRefreshToken {
  token: string;
  expiresAt: Date;
  expiresIn: number;
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export async function issueRefreshToken(
  userId: string,
  epoch: number,
  now: Date = new Date(),
): Promise<IssuedRefreshToken> {
  const token = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
  const ttlDays = readRefreshTtlDays();
  const expiresAt = new Date(now.getTime() + ttlDays * 86_400_000);

  await client.send(
    new PutCommand({
      TableName: getTableName(),
      Item: {
        ...sessionKey(hashRefreshToken(token)),
        userId,
        epoch,
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        consumedAt: null,
        ttl: sessionTtl(expiresAt),
      },
      // A hash collision here would silently overwrite a live session; a
      // 256-bit random token makes that impossible in practice, and the guard
      // makes it loud rather than silent if the assumption ever breaks.
      ConditionExpression: 'attribute_not_exists(pk)',
    }),
  );

  return { token, expiresAt, expiresIn: Math.floor((expiresAt.getTime() - now.getTime()) / 1000) };
}

export async function getRefreshRecord(token: string): Promise<RefreshRecord | null> {
  const result = await client.send(
    new GetCommand({ TableName: getTableName(), Key: sessionKey(hashRefreshToken(token)) }),
  );
  const item = result.Item;
  if (!item || typeof item.userId !== 'string' || typeof item.epoch !== 'number') {
    return null;
  }
  return {
    userId: item.userId,
    epoch: item.epoch,
    expiresAt: typeof item.expiresAt === 'string' ? item.expiresAt : new Date(0).toISOString(),
    consumedAt: typeof item.consumedAt === 'string' ? item.consumedAt : null,
  };
}

/**
 * Marks a refresh token consumed. Returns false when it was already consumed —
 * the conditional write is what makes this safe under concurrency: two parallel
 * redeems of the same token can't both win, so exactly one caller proceeds and
 * the loser is treated as reuse.
 */
export async function consumeRefreshToken(token: string, now: Date = new Date()): Promise<boolean> {
  try {
    await client.send(
      new UpdateCommand({
        TableName: getTableName(),
        Key: sessionKey(hashRefreshToken(token)),
        UpdateExpression: 'SET consumedAt = :now',
        ConditionExpression: 'attribute_exists(pk) AND attribute_type(consumedAt, :null)',
        ExpressionAttributeValues: { ':now': now.toISOString(), ':null': 'NULL' },
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      return false;
    }
    throw err;
  }
}

export async function getSessionEpoch(userId: string): Promise<number> {
  const result = await client.send(
    new GetCommand({
      TableName: getTableName(),
      Key: userKey(userId),
      ProjectionExpression: 'sessionEpoch',
    }),
  );
  const epoch = result.Item?.sessionEpoch;
  return typeof epoch === 'number' ? epoch : 0;
}

/** Revokes every outstanding refresh token for the user in a single write. */
export async function bumpSessionEpoch(userId: string): Promise<number> {
  const result = await client.send(
    new UpdateCommand({
      TableName: getTableName(),
      Key: userKey(userId),
      UpdateExpression: 'ADD sessionEpoch :one',
      ExpressionAttributeValues: { ':one': 1 },
      ReturnValues: 'UPDATED_NEW',
    }),
  );
  const epoch = result.Attributes?.sessionEpoch;
  return typeof epoch === 'number' ? epoch : 1;
}

function readRefreshTtlDays(): number {
  const raw = process.env.REFRESH_TOKEN_TTL_DAYS;
  if (!raw) return DEFAULT_REFRESH_TOKEN_TTL_DAYS;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_REFRESH_TOKEN_TTL_DAYS;
}
