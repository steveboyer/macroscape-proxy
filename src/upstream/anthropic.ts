import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { UpstreamError } from './errors';

export { UpstreamError };

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models';

// Strict allowlist. The caller's Authorization (Apple JWT) is dropped
// on purpose — the proxy attaches its own x-api-key.
const FORWARDED_HEADER_NAMES = new Set([
  'content-type',
  'anthropic-version',
  'anthropic-beta',
  'accept',
  'accept-encoding',
]);

// Narrower than the /v1/messages allowlist: the Models API is GA (no
// `anthropic-beta`) and a GET carries no body (no `content-type`).
const MODELS_FORWARDED_HEADER_NAMES = new Set(['anthropic-version', 'accept', 'accept-encoding']);

// The Models API paginates with `after_id` / `before_id` and returns
// `has_more` / `first_id` / `last_id` — deliberately *not* the
// `page` / `next_page` scheme USDA uses. Forwarded as-is; see CONTRACT.md.
const MODELS_FORWARDED_QUERY_PARAMS = new Set(['limit', 'after_id', 'before_id']);

// The model list changes on the order of weeks, and the iOS client fetches it
// on launch, so a module-scope TTL cache means a warm container answers most
// launches without touching upstream. Same lifetime rules as the JWKS cache:
// it dies with the container, so the worst-case staleness is the TTL.
const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;
// Cache keys embed caller-supplied pagination params, so the key space is
// caller-controlled. Cap the map and drop it wholesale when it overflows —
// an unbounded Map here would be a memory-growth lever for any authenticated
// caller cycling `after_id` values.
const MODELS_CACHE_MAX_ENTRIES = 32;
const modelsCache = new Map<string, { expiresAt: number; response: ProxyResponse }>();

// Module-scope singleton. Cached key survives Lambda warm starts.
// Cache invalidates with container recycling — fine until secret rotation
// becomes a routine concern, at which point this needs a TTL or version check.
const secretsClient = new SecretsManagerClient({});
let cachedApiKey: string | null = null;

export interface ProxyResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export async function proxyMessages(
  callerHeaders: Record<string, string | undefined>,
  callerBody: string | undefined,
  isBase64Encoded: boolean,
  requestId: string,
): Promise<ProxyResponse> {
  const apiKey = await getUpstreamApiKey();

  const outboundHeaders: Record<string, string> = {
    'x-api-key': apiKey,
    'content-type': 'application/json',
    'x-request-id': requestId,
  };
  for (const [name, value] of Object.entries(callerHeaders)) {
    if (value === undefined) continue;
    const lname = name.toLowerCase();
    if (FORWARDED_HEADER_NAMES.has(lname)) {
      outboundHeaders[lname] = value;
    }
  }

  const body =
    callerBody === undefined
      ? ''
      : isBase64Encoded
        ? Buffer.from(callerBody, 'base64').toString('utf-8')
        : callerBody;

  const response = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: outboundHeaders,
    body,
  });

  const rawBody = await response.text();
  const isSuccess = response.status >= 200 && response.status < 300;

  if (isSuccess) {
    const responseHeaders: Record<string, string> = {};
    const upstreamContentType = response.headers.get('content-type');
    if (upstreamContentType) {
      responseHeaders['content-type'] = upstreamContentType;
    }
    return {
      statusCode: response.status,
      headers: responseHeaders,
      body: rawBody,
    };
  }

  // Non-2xx — sanitize to a known envelope so upstream implementation
  // details (request IDs, internal codes, stack traces) can't leak.
  return {
    statusCode: response.status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(sanitizeUpstreamError(rawBody)),
  };
}

export async function proxyModels(
  callerHeaders: Record<string, string | undefined>,
  callerQueryParams: Record<string, string | undefined> | undefined,
  requestId: string,
): Promise<ProxyResponse> {
  const url = new URL(ANTHROPIC_MODELS_URL);
  if (callerQueryParams) {
    for (const [name, value] of Object.entries(callerQueryParams)) {
      if (value === undefined) continue;
      if (MODELS_FORWARDED_QUERY_PARAMS.has(name)) {
        url.searchParams.set(name, value);
      }
    }
  }
  // Sort so `?limit=2&after_id=x` and `?after_id=x&limit=2` share a cache entry.
  url.searchParams.sort();

  const forwardedHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(callerHeaders)) {
    if (value === undefined) continue;
    const lname = name.toLowerCase();
    if (MODELS_FORWARDED_HEADER_NAMES.has(lname)) {
      forwardedHeaders[lname] = value;
    }
  }

  // `anthropic-version` is part of the key: different versions can return
  // different response shapes, so they must not share a cached body.
  const cacheKey = `${forwardedHeaders['anthropic-version'] ?? ''}|${url.search}`;
  const cached = modelsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.response;
  }

  const apiKey = await getUpstreamApiKey();
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      ...forwardedHeaders,
      'x-api-key': apiKey,
      'x-request-id': requestId,
    },
  });

  const rawBody = await response.text();
  const isSuccess = response.status >= 200 && response.status < 300;

  if (isSuccess) {
    const responseHeaders: Record<string, string> = {};
    const upstreamContentType = response.headers.get('content-type');
    if (upstreamContentType) {
      responseHeaders['content-type'] = upstreamContentType;
    }
    const proxied: ProxyResponse = {
      statusCode: response.status,
      headers: responseHeaders,
      body: rawBody,
    };
    // Only successes are cached — an upstream blip shouldn't be pinned for the
    // whole TTL.
    if (modelsCache.size >= MODELS_CACHE_MAX_ENTRIES) {
      modelsCache.clear();
    }
    modelsCache.set(cacheKey, { expiresAt: Date.now() + MODELS_CACHE_TTL_MS, response: proxied });
    return proxied;
  }

  return {
    statusCode: response.status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(sanitizeUpstreamError(rawBody)),
  };
}

interface SanitizedUpstreamError {
  error: 'upstream_error';
  upstream: {
    type: string;
    message: string;
  };
}

function sanitizeUpstreamError(rawBody: string): SanitizedUpstreamError {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      const err = (parsed as { error: unknown }).error;
      if (err && typeof err === 'object') {
        const e = err as { type?: unknown; message?: unknown };
        return {
          error: 'upstream_error',
          upstream: {
            type: typeof e.type === 'string' ? e.type : 'unknown',
            message: typeof e.message === 'string' ? e.message : '',
          },
        };
      }
    }
  } catch {
    // Fall through.
  }
  return {
    error: 'upstream_error',
    upstream: {
      type: 'unknown',
      message: 'Upstream returned a non-JSON or unexpected error response',
    },
  };
}

async function getUpstreamApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;
  const secretArn = process.env.UPSTREAM_SECRET_ARN;
  if (!secretArn) {
    throw new Error('UPSTREAM_SECRET_ARN env var is required');
  }
  const result = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretArn }));
  const value = result.SecretString;
  if (!value) {
    throw new UpstreamError(503, 'upstream_not_configured');
  }
  cachedApiKey = value;
  return value;
}
