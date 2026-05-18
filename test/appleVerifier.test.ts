import { beforeAll, describe, expect, it } from 'vitest';
import {
  type CryptoKey,
  SignJWT,
  createLocalJWKSet,
  createRemoteJWKSet,
  exportJWK,
  generateKeyPair,
} from 'jose';
import { AppleTokenError, verifyAppleIdToken } from '../src/auth/appleVerifier';

const ISS = 'https://appleid.apple.com';
const AUD = 'app.macroscape.MacroScape';
const KID = 'test-kid-1';

type JwksResolver = ReturnType<typeof createRemoteJWKSet>;

describe('verifyAppleIdToken', () => {
  let signingKey: CryptoKey;
  let unknownKey: CryptoKey;
  let jwks: JwksResolver;

  beforeAll(async () => {
    process.env.APPLE_AUD = AUD;

    const trusted = await generateKeyPair('RS256');
    signingKey = trusted.privateKey;
    const trustedJwk = await exportJWK(trusted.publicKey);
    trustedJwk.kid = KID;
    trustedJwk.alg = 'RS256';
    trustedJwk.use = 'sig';
    jwks = createLocalJWKSet({ keys: [trustedJwk] });

    // A second keypair whose public key is NOT in our JWKS.
    const other = await generateKeyPair('RS256');
    unknownKey = other.privateKey;
  });

  async function sign(
    overrides: {
      iss?: string;
      aud?: string;
      sub?: string | null;
      expSecondsFromNow?: number;
      kid?: string;
      key?: CryptoKey;
    } = {},
  ): Promise<string> {
    const builder = new SignJWT(
      overrides.sub === null ? {} : { sub: overrides.sub ?? '001234.abc.5678' },
    )
      .setProtectedHeader({ alg: 'RS256', kid: overrides.kid ?? KID })
      .setIssuer(overrides.iss ?? ISS)
      .setAudience(overrides.aud ?? AUD)
      .setIssuedAt()
      .setExpirationTime(
        overrides.expSecondsFromNow !== undefined
          ? Math.floor(Date.now() / 1000) + overrides.expSecondsFromNow
          : '10m',
      );
    return builder.sign(overrides.key ?? signingKey);
  }

  it('accepts a valid token and returns the sub claim', async () => {
    const token = await sign();
    const claims = await verifyAppleIdToken(token, jwks);
    expect(claims.sub).toBe('001234.abc.5678');
    expect(claims.iss).toBe(ISS);
    expect(claims.aud).toBe(AUD);
  });

  it('rejects an expired token with reason "expired"', async () => {
    const token = await sign({ expSecondsFromNow: -60 });
    await expect(verifyAppleIdToken(token, jwks)).rejects.toMatchObject({
      name: 'AppleTokenError',
      reason: 'expired',
    });
  });

  it('rejects a token whose iss is not Apple with reason "invalid_issuer"', async () => {
    const token = await sign({ iss: 'https://evil.example.com' });
    await expect(verifyAppleIdToken(token, jwks)).rejects.toMatchObject({
      name: 'AppleTokenError',
      reason: 'invalid_issuer',
    });
  });

  it('rejects a token whose aud does not match the configured Bundle ID with reason "invalid_audience"', async () => {
    const token = await sign({ aud: 'com.wrong.bundle' });
    await expect(verifyAppleIdToken(token, jwks)).rejects.toMatchObject({
      name: 'AppleTokenError',
      reason: 'invalid_audience',
    });
  });

  it('rejects a token signed by an untrusted key (kid matches JWKS but signature does not) with reason "invalid_signature"', async () => {
    const token = await sign({ key: unknownKey });
    await expect(verifyAppleIdToken(token, jwks)).rejects.toMatchObject({
      name: 'AppleTokenError',
      reason: 'invalid_signature',
    });
  });

  it('rejects a token whose kid is not present in JWKS with reason "jwks_fetch_failed"', async () => {
    const token = await sign({ kid: 'unknown-kid' });
    await expect(verifyAppleIdToken(token, jwks)).rejects.toMatchObject({
      name: 'AppleTokenError',
      reason: 'jwks_fetch_failed',
    });
  });

  it('rejects a non-JWT string with reason "malformed"', async () => {
    await expect(verifyAppleIdToken('not.a.jwt', jwks)).rejects.toMatchObject({
      name: 'AppleTokenError',
      reason: 'malformed',
    });
  });

  it('rejects a token missing the sub claim with reason "malformed"', async () => {
    const token = await sign({ sub: null });
    await expect(verifyAppleIdToken(token, jwks)).rejects.toMatchObject({
      name: 'AppleTokenError',
      reason: 'malformed',
    });
  });

  it('throws a plain Error when APPLE_AUD env var is missing', async () => {
    const saved = process.env.APPLE_AUD;
    delete process.env.APPLE_AUD;
    try {
      const token = await sign();
      const err = await verifyAppleIdToken(token, jwks).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(AppleTokenError);
      expect((err as Error).message).toContain('APPLE_AUD');
    } finally {
      process.env.APPLE_AUD = saved;
    }
  });
});
