import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

/**
 * Signing-key material for proxy-issued access tokens (MSP044).
 *
 * The secret holds JSON so two keys can be live at once, which is what makes
 * rotation possible without a flag day: publish the new key under a new `kid`,
 * flip `activeKid`, and tokens signed with the old key keep verifying until
 * they expire (≤ 1h later), at which point the old entry can be dropped.
 *
 *   { "activeKid": "2026-08", "keys": { "2026-08": "<secret>", "2026-05": "<secret>" } }
 *
 * **Key values are used as raw UTF-8 bytes, not decoded.** A base64url string
 * pasted here is HMAC'd as its literal characters, so it carries the entropy
 * of the encoded text rather than of the bytes it encodes — fine, but don't
 * assume "32 base64url chars" means a 256-bit key. Use a high-entropy string
 * of at least 32 characters; the CDK-generated value is 64 alphanumerics.
 *
 * A bare (non-JSON) secret value is accepted as a single key under the kid
 * `default`. That's the shape a human gets by pasting a random string into the
 * console, which is how every other secret in this stack is populated — the
 * tolerant read means a fat-fingered rotation degrades to "one key" rather
 * than to "all requests 500".
 *
 * **On key compromise, rotating the secret is not sufficient.** The parsed
 * keys are cached for the life of the container, so a leaked key keeps
 * verifying until every warm Lambda recycles. Rotate *and* redeploy to force
 * new containers; see MSP046 for the runbook.
 */

const secretsClient = new SecretsManagerClient({});

export interface SigningKeys {
  activeKid: string;
  keys: Map<string, Uint8Array>;
}

// Module-scope cache — survives Lambda warm starts, dies with the container.
// Same lifetime rules as the upstream API key cache in src/upstream/anthropic.ts:
// a rotation is picked up as containers recycle, not instantly.
let cached: SigningKeys | null = null;

export async function getSigningKeys(): Promise<SigningKeys> {
  if (cached) return cached;

  const arn = process.env.SESSION_SECRET_ARN;
  if (!arn) {
    throw new Error('SESSION_SECRET_ARN env var is required');
  }

  const result = await secretsClient.send(new GetSecretValueCommand({ SecretId: arn }));
  const raw = result.SecretString;
  if (!raw || raw.trim().length === 0) {
    throw new Error('session signing secret is empty — populate it before serving auth routes');
  }

  cached = parseSigningKeys(raw);
  return cached;
}

export function parseSigningKeys(raw: string): SigningKeys {
  const encoder = new TextEncoder();
  const trimmed = raw.trim();

  if (!trimmed.startsWith('{')) {
    return { activeKid: 'default', keys: new Map([['default', encoder.encode(trimmed)]]) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Looked like JSON but isn't. Treating it as a literal key would silently
    // sign with a brace-wrapped blob, so fail loudly instead.
    throw new Error('session signing secret starts with "{" but is not valid JSON');
  }

  const obj = parsed as { activeKid?: unknown; keys?: unknown };
  const activeKid = typeof obj.activeKid === 'string' ? obj.activeKid : null;
  const keysObj = obj.keys;
  if (!activeKid || typeof keysObj !== 'object' || keysObj === null) {
    throw new Error('session signing secret must have string `activeKid` and object `keys`');
  }

  const keys = new Map<string, Uint8Array>();
  for (const [kid, value] of Object.entries(keysObj as Record<string, unknown>)) {
    if (typeof value === 'string' && value.length > 0) {
      keys.set(kid, encoder.encode(value));
    }
  }

  if (!keys.has(activeKid)) {
    throw new Error(`session signing secret \`activeKid\` (${activeKid}) has no matching key`);
  }

  return { activeKid, keys };
}

// Test seam — the module cache would otherwise leak key material between cases.
export function resetSigningKeyCacheForTests(): void {
  cached = null;
}
