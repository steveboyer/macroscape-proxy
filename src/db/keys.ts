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

export const usageTtl = (date: Date, retentionDays = DEFAULT_USAGE_RETENTION_DAYS): number => {
  const startOfNextDayUtc = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + 1,
  );
  return Math.floor(startOfNextDayUtc / 1000) + retentionDays * 86_400;
};

const toUtcDateString = (date: Date): string => date.toISOString().slice(0, 10);
