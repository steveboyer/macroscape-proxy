import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { client, getTableName } from '../db/client';
import { groupUsageKey, usageKey, userKey, usageTtl } from '../db/keys';

const DEFAULT_TOTAL_LIMIT_FALLBACK = 100;

export type RateLimitScope = 'total' | 'group';

export class RateLimitError extends Error {
  readonly statusCode = 429;
  readonly reason = 'daily_limit_exceeded';
  readonly scope: RateLimitScope;
  readonly group: string | null;
  readonly limit: number;
  readonly count: number;
  readonly retryAfterSeconds: number;
  readonly resetsAt: string;

  constructor(
    scope: RateLimitScope,
    group: string | null,
    count: number,
    limit: number,
    now: Date = new Date(),
  ) {
    super(`daily ${scope} limit ${limit} exceeded (count=${count})`);
    this.name = 'RateLimitError';
    this.scope = scope;
    this.group = group;
    this.count = count;
    this.limit = limit;
    this.retryAfterSeconds = secondsUntilUtcMidnight(now);
    this.resetsAt = nextUtcMidnight(now).toISOString();
  }
}

export interface UsageResult {
  total: { count: number; limit: number };
  group: { count: number; limit: number | null };
}

// Tracks two counters per request: a per-user total across all endpoints,
// and a per-user-per-group counter. Total limit is always enforced. Group
// limit is enforced only when `DEFAULT_DAILY_LIMIT_<GROUP>` env var or the
// user's `dailyLimit<Group>` attribute is set; otherwise the group counter
// is recorded for observability only.
export async function checkAndIncrement(appleUserId: string, group: string): Promise<UsageResult> {
  const limits = await getUserLimits(appleUserId, group);
  const now = new Date();

  // Rejected requests still bump the counter (no rollback). Intentional —
  // for the rest of the day the user was over the limit anyway, and a
  // rollback would add a second round-trip + race window for no benefit.
  const totalCount = await incrementTotal(appleUserId, now);
  if (totalCount > limits.totalLimit) {
    throw new RateLimitError('total', null, totalCount, limits.totalLimit, now);
  }

  const groupCount = await incrementGroup(appleUserId, group, now);
  if (limits.groupLimit !== null && groupCount > limits.groupLimit) {
    throw new RateLimitError('group', group, groupCount, limits.groupLimit, now);
  }

  return {
    total: { count: totalCount, limit: limits.totalLimit },
    group: { count: groupCount, limit: limits.groupLimit },
  };
}

interface UserLimits {
  totalLimit: number;
  groupLimit: number | null;
}

async function getUserLimits(appleUserId: string, group: string): Promise<UserLimits> {
  const groupAttr = `dailyLimit${pascal(group)}`;
  const result = await client.send(
    new GetCommand({
      TableName: getTableName(),
      Key: userKey(appleUserId),
      ProjectionExpression: '#total, #group',
      ExpressionAttributeNames: {
        '#total': 'dailyLimit',
        '#group': groupAttr,
      },
    }),
  );

  const totalOverride = result.Item?.dailyLimit;
  const groupOverride = result.Item?.[groupAttr];

  return {
    totalLimit:
      typeof totalOverride === 'number' && totalOverride > 0
        ? totalOverride
        : readDefaultTotalLimit(),
    groupLimit:
      typeof groupOverride === 'number' && groupOverride > 0
        ? groupOverride
        : readDefaultGroupLimit(group),
  };
}

async function incrementTotal(appleUserId: string, now: Date): Promise<number> {
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
  return typeof result.Attributes?.count === 'number' ? result.Attributes.count : 1;
}

async function incrementGroup(appleUserId: string, group: string, now: Date): Promise<number> {
  const result = await client.send(
    new UpdateCommand({
      TableName: getTableName(),
      Key: groupUsageKey(appleUserId, group, now),
      UpdateExpression: 'ADD #c :one SET #t = if_not_exists(#t, :ttl)',
      ExpressionAttributeNames: { '#c': 'count', '#t': 'ttl' },
      ExpressionAttributeValues: { ':one': 1, ':ttl': usageTtl(now) },
      ReturnValues: 'UPDATED_NEW',
    }),
  );
  return typeof result.Attributes?.count === 'number' ? result.Attributes.count : 1;
}

function readDefaultTotalLimit(): number {
  return parsePositiveInt(process.env.DEFAULT_DAILY_LIMIT, DEFAULT_TOTAL_LIMIT_FALLBACK);
}

function readDefaultGroupLimit(group: string): number | null {
  const envName = `DEFAULT_DAILY_LIMIT_${group.toUpperCase()}`;
  const raw = process.env[envName];
  if (!raw) return null;
  return parsePositiveInt(raw, null);
}

function parsePositiveInt(raw: string | undefined, fallback: number): number;
function parsePositiveInt(raw: string | undefined, fallback: null): number | null;
function parsePositiveInt(raw: string | undefined, fallback: number | null): number | null {
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function pascal(group: string): string {
  return group.length === 0 ? '' : group[0].toUpperCase() + group.slice(1);
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
