/**
 * Single-table key shapes for the macroscape-proxy DynamoDB table.
 *
 * User:  pk = USER#<appleUserId>,  sk = PROFILE
 * Usage: pk = USAGE#<appleUserId>, sk = DATE#YYYY-MM-DD (UTC)
 *
 * Usage rows carry a `ttl` attribute set to DEFAULT_USAGE_RETENTION_DAYS
 * after the end of the date they represent, so old daily counters self-clean.
 * UTC is the reset boundary so per-day limits behave consistently regardless
 * of user timezone.
 */

export const DEFAULT_USAGE_RETENTION_DAYS = 90;

export type ItemKey = { pk: string; sk: string };

export const userKey = (appleUserId: string): ItemKey => ({
  pk: `USER#${appleUserId}`,
  sk: 'PROFILE',
});

export const usageKey = (appleUserId: string, date: Date): ItemKey => ({
  pk: `USAGE#${appleUserId}`,
  sk: `DATE#${toUtcDateString(date)}`,
});

// Per-endpoint-group counter. Sits alongside the total-only `usageKey` so a
// future enforcement decision can choose total, per-group, or both.
export const groupUsageKey = (appleUserId: string, group: string, date: Date): ItemKey => ({
  pk: `USAGE-${group}#${appleUserId}`,
  sk: `DATE#${toUtcDateString(date)}`,
});

// Refresh-token record (MSP047). Keyed by the SHA-256 of the token, never the
// token itself: a database dump is then useless for authenticating, since the
// stored value can't be presented and can't be reversed into one that can.
export const sessionKey = (refreshTokenHash: string): ItemKey => ({
  pk: `SESSION#${refreshTokenHash}`,
  sk: 'REFRESH',
});

// Consumed rows are kept (not deleted) so a replayed token is distinguishable
// from an unknown one — that difference is what makes reuse detection possible.
// The grace period keeps them readable past their own expiry for the same reason.
export const sessionTtl = (expiresAt: Date, graceDays = 30): number =>
  Math.floor(expiresAt.getTime() / 1000) + graceDays * 86_400;

export const usageTtl = (date: Date, retentionDays = DEFAULT_USAGE_RETENTION_DAYS): number => {
  const startOfNextDayUtc = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + 1,
  );
  return Math.floor(startOfNextDayUtc / 1000) + retentionDays * 86_400;
};

const toUtcDateString = (date: Date): string => date.toISOString().slice(0, 10);
