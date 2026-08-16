import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

import {
  beginRefresh,
  completeRefresh,
  logoutSession,
  startSession,
  verifyAppleAssertion,
} from '../src/auth/sessions';
import { AuthError } from '../src/auth/authenticate';
import { hashRefreshToken } from '../src/db/sessions';
import { parseSigningKeys, resetSigningKeyCacheForTests } from '../src/auth/sessionKeys';
import { mintAccessToken, verifyAccessToken, looksLikeProxyToken } from '../src/auth/sessionTokens';

// Apple verification is exercised end-to-end in handler.integration.test.ts;
// here it's stubbed so these cases stay focused on session mechanics.
vi.mock('../src/auth/appleVerifier', async () => {
  const actual = await vi.importActual<typeof import('../src/auth/appleVerifier')>(
    '../src/auth/appleVerifier',
  );
  return {
    ...actual,
    verifyAppleIdToken: vi.fn(async (token: string) => {
      if (token === 'bad-apple-token') {
        throw new actual.AppleTokenError('expired', 'token expired');
      }
      return { sub: 'apple-sub-123' };
    }),
  };
});

const ddbMock = mockClient(DynamoDBDocumentClient);
const smMock = mockClient(SecretsManagerClient);
const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

const SIGNING_SECRET = 'test-signing-secret-value-0123456789';

beforeAll(() => {
  process.env.TABLE_NAME = 'test-table';
  process.env.SESSION_SECRET_ARN = 'arn:aws:secretsmanager:us-west-2:123:secret:session-XXX';
});

afterAll(() => {
  consoleLogSpy.mockRestore();
});

beforeEach(() => {
  ddbMock.reset();
  smMock.reset();
  resetSigningKeyCacheForTests();
  smMock.on(GetSecretValueCommand).resolves({ SecretString: SIGNING_SECRET });
  ddbMock.on(PutCommand).resolves({});
  ddbMock.on(UpdateCommand).resolves({ Attributes: { sessionEpoch: 1 } });
  ddbMock.on(GetCommand).resolves({ Item: undefined });
});

describe('signing key parsing', () => {
  it('accepts a bare secret as a single default key', () => {
    const keys = parseSigningKeys('  plain-secret  ');
    expect(keys.activeKid).toBe('default');
    expect(keys.keys.has('default')).toBe(true);
  });

  it('accepts the two-key rotation shape', () => {
    const keys = parseSigningKeys(
      JSON.stringify({ activeKid: 'new', keys: { new: 'aaa', old: 'bbb' } }),
    );
    expect(keys.activeKid).toBe('new');
    expect([...keys.keys.keys()].sort()).toEqual(['new', 'old']);
  });

  it('rejects an activeKid with no matching key rather than signing with nothing', () => {
    expect(() =>
      parseSigningKeys(JSON.stringify({ activeKid: 'missing', keys: { a: 'x' } })),
    ).toThrow(/activeKid/);
  });

  it('rejects JSON-looking garbage instead of using it as a literal key', () => {
    expect(() => parseSigningKeys('{not json')).toThrow(/not valid JSON/);
  });
});

describe('access tokens', () => {
  it('round-trips a minted token', async () => {
    const { token, expiresIn } = await mintAccessToken('user-1');
    expect(expiresIn).toBe(3600);
    const claims = await verifyAccessToken(token);
    expect(claims.sub).toBe('user-1');
  });

  it('is identifiable as a proxy token by issuer', async () => {
    const { token } = await mintAccessToken('user-1');
    expect(looksLikeProxyToken(token)).toBe(true);
    expect(looksLikeProxyToken('not-a-jwt')).toBe(false);
  });

  it('rejects a token signed with a key this container does not hold', async () => {
    const { token } = await mintAccessToken('user-1');
    // Rotate the secret out from under the cache — the old kid is now unknown.
    resetSigningKeyCacheForTests();
    smMock.on(GetSecretValueCommand).resolves({
      SecretString: JSON.stringify({ activeKid: 'other', keys: { other: 'different-secret' } }),
    });
    await expect(verifyAccessToken(token)).rejects.toMatchObject({
      reason: 'invalid_signature',
    });
  });
});

// The route splits verify → charge → mint (see handler.ts); this helper runs
// the two halves back to back the way a successful request does.
const createSession = async (appleToken: string) =>
  startSession(await verifyAppleAssertion(appleToken));

// Same for refresh: look up, then commit.
const refreshSession = async (token: string) => completeRefresh(token, await beginRefresh(token));

describe('createSession', () => {
  it('exchanges an Apple id_token for an access + refresh pair', async () => {
    const session = await createSession('good-apple-token');
    expect(session.userId).toBe('apple-sub-123');
    expect(session.accessExpiresIn).toBe(3600);
    expect(session.refreshExpiresIn).toBeGreaterThan(0);
    const claims = await verifyAccessToken(session.accessToken);
    expect(claims.sub).toBe('apple-sub-123');
  });

  it('stores only the hash of the refresh token', async () => {
    const session = await createSession('good-apple-token');
    const puts = ddbMock.commandCalls(PutCommand);
    const sessionPut = puts.find((c) =>
      String(c.args[0].input.Item?.pk ?? '').startsWith('SESSION#'),
    );
    expect(sessionPut).toBeDefined();
    const stored = JSON.stringify(sessionPut!.args[0].input.Item);
    expect(stored).not.toContain(session.refreshToken);
    expect(stored).toContain(hashRefreshToken(session.refreshToken));
  });

  it('surfaces an Apple verification failure as a 401', async () => {
    await expect(createSession('bad-apple-token')).rejects.toBeInstanceOf(AuthError);
  });
});

describe('refreshSession', () => {
  const liveRecord = (overrides: Record<string, unknown> = {}) => ({
    Item: {
      userId: 'user-1',
      epoch: 0,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      consumedAt: null,
      ...overrides,
    },
  });

  it('rotates: consumes the presented token and issues a new one', async () => {
    ddbMock
      .on(GetCommand)
      .callsFake((input) =>
        String(input.Key?.pk ?? '').startsWith('SESSION#')
          ? liveRecord()
          : { Item: { sessionEpoch: 0 } },
      );

    const session = await refreshSession('presented-token');
    expect(session.userId).toBe('user-1');

    const consumed = ddbMock
      .commandCalls(UpdateCommand)
      .some((c) => String(c.args[0].input.UpdateExpression).includes('consumedAt'));
    expect(consumed).toBe(true);
    expect(session.refreshToken).not.toBe('presented-token');
  });

  it('revokes the whole chain when an already-consumed token is replayed', async () => {
    ddbMock
      .on(GetCommand)
      .callsFake((input) =>
        String(input.Key?.pk ?? '').startsWith('SESSION#')
          ? liveRecord({ consumedAt: new Date().toISOString() })
          : { Item: { sessionEpoch: 0 } },
      );

    await expect(refreshSession('replayed')).rejects.toMatchObject({
      reason: 'refresh_token_reused',
    });

    const bumped = ddbMock
      .commandCalls(UpdateCommand)
      .some((c) => String(c.args[0].input.UpdateExpression).includes('ADD sessionEpoch'));
    expect(bumped).toBe(true);
  });

  // Regression: the epoch check has to come *before* the consumed check.
  // With the order reversed, anyone holding a long-dead consumed token could
  // replay it to revoke every live session, wait for the user to sign back
  // in, and repeat — for the ~120 days the row survives.
  it('does not re-revoke when a consumed token from a revoked epoch is replayed', async () => {
    ddbMock
      .on(GetCommand)
      .callsFake((input) =>
        String(input.Key?.pk ?? '').startsWith('SESSION#')
          ? liveRecord({ epoch: 0, consumedAt: new Date().toISOString() })
          : { Item: { sessionEpoch: 4 } },
      );

    await expect(refreshSession('old-consumed')).rejects.toMatchObject({
      reason: 'invalid_refresh_token',
    });

    const bumped = ddbMock
      .commandCalls(UpdateCommand)
      .some((c) => String(c.args[0].input.UpdateExpression).includes('ADD sessionEpoch'));
    expect(bumped).toBe(false);
  });

  // Regression: the lookup step runs before the rate limit is charged, so it
  // must not mutate. If a 429 could fire after the token was consumed, the
  // client's retry would look like a replay and sign the user out.
  it('beginRefresh neither consumes nor mints', async () => {
    ddbMock
      .on(GetCommand)
      .callsFake((input) =>
        String(input.Key?.pk ?? '').startsWith('SESSION#')
          ? liveRecord()
          : { Item: { sessionEpoch: 0 } },
      );

    const record = await beginRefresh('presented-token');
    expect(record.userId).toBe('user-1');
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('rejects a token minted before a chain revocation without re-revoking', async () => {
    ddbMock
      .on(GetCommand)
      .callsFake((input) =>
        String(input.Key?.pk ?? '').startsWith('SESSION#')
          ? liveRecord({ epoch: 0 })
          : { Item: { sessionEpoch: 3 } },
      );

    await expect(refreshSession('stale-epoch')).rejects.toMatchObject({
      reason: 'invalid_refresh_token',
    });

    const bumped = ddbMock
      .commandCalls(UpdateCommand)
      .some((c) => String(c.args[0].input.UpdateExpression).includes('ADD sessionEpoch'));
    expect(bumped).toBe(false);
  });

  it('rejects an expired token', async () => {
    ddbMock
      .on(GetCommand)
      .callsFake((input) =>
        String(input.Key?.pk ?? '').startsWith('SESSION#')
          ? liveRecord({ expiresAt: new Date(Date.now() - 1000).toISOString() })
          : { Item: { sessionEpoch: 0 } },
      );
    await expect(refreshSession('expired')).rejects.toMatchObject({
      reason: 'invalid_refresh_token',
    });
  });

  it('rejects an unknown token', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    await expect(refreshSession('never-issued')).rejects.toMatchObject({
      reason: 'invalid_refresh_token',
    });
  });

  it('treats a lost consume race as reuse and revokes the chain', async () => {
    ddbMock
      .on(GetCommand)
      .callsFake((input) =>
        String(input.Key?.pk ?? '').startsWith('SESSION#')
          ? liveRecord()
          : { Item: { sessionEpoch: 0 } },
      );
    ddbMock.on(UpdateCommand).callsFake((input) => {
      if (String(input.UpdateExpression).includes('consumedAt')) {
        throw new ConditionalCheckFailedException({ $metadata: {}, message: 'race' });
      }
      return { Attributes: { sessionEpoch: 1 } };
    });

    await expect(refreshSession('raced')).rejects.toMatchObject({
      reason: 'refresh_token_reused',
    });
  });
});

describe('logoutSession', () => {
  it('is idempotent for an unknown token', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    await expect(logoutSession('already-gone')).resolves.toBeUndefined();
  });
});
