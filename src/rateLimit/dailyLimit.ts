import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { client, getTableName } from '../db/client';
import { userKey, usageKey, usageTtl } from '../db/keys';

const DEFAULT_LIMIT_FALLBACK = 100;

export class RateLimitError extends Error {
  readonly statusCode = 429;
  readonly reason = 'daily_limit_exceeded';
  readonly limit: number;
  readonly count: number;
  readonly retryAfterSeconds: number;
  readonly resetsAt: string;

  constructor(count: number, limit: number, now: Date = new Date()) {
    super(`daily limit ${limit} exceeded (count=${count})`);
    this.name = 'RateLimitError';
    this.count = count;
    this.limit = limit;
    this.retryAfterSeconds = secondsUntilUtcMidnight(now);
    this.resetsAt = nextUtcMidnight(now).toISOString();
  }
}

export interface UsageResult {
  count: number;
  limit: number;
}

export async function checkAndIncrement(appleUserId: string): Promise<UsageResult> {
  const limit = await getUserDailyLimit(appleUserId);
  const count = await incrementUsage(appleUserId);
  if (count > limit) {
    throw new RateLimitError(count, limit);
  }
  return { count, limit };
}

async function getUserDailyLimit(appleUserId: string): Promise<number> {
  const fallback = readDefaultLimit();
  const result = await client.send(
    new GetCommand({
      TableName: getTableName(),
      Key: userKey(appleUserId),
      ProjectionExpression: 'dailyLimit',
    }),
  );
  const override = result.Item?.dailyLimit;
  return typeof override === 'number' && override > 0 ? override : fallback;
}

async function incrementUsage(appleUserId: string): Promise<number> {
  const now = new Date();
  const result = await client.send(
    new UpdateCommand({
      TableName: getTableName(),
      Key: usageKey(appleUserId, now),
      UpdateExpression: 'ADD #c :one SET #t = if_not_exists(#t, :ttl)',
      ExpressionAttributeNames: { '#c': 'count', '#t': 'ttl' },
      ExpressionAttributeValues: { ':one': 1, ':ttl': usageTtl(now) },
      ReturnValues: 'UPDATED_NEW',
    }),
  );
  const newCount = result.Attributes?.count;
  return typeof newCount === 'number' ? newCount : 1;
}

function readDefaultLimit(): number {
  const raw = process.env.DEFAULT_DAILY_LIMIT;
  if (!raw) return DEFAULT_LIMIT_FALLBACK;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LIMIT_FALLBACK;
}

function secondsUntilUtcMidnight(now: Date): number {
  const midnight = nextUtcMidnight(now);
  return Math.max(1, Math.ceil((midnight.getTime() - now.getTime()) / 1000));
}

function nextUtcMidnight(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0),
  );
}
