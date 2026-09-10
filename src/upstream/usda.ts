import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { fetchUpstream, UpstreamError } from './errors';
import type { ProxyResponse } from './anthropic';

const USDA_URL = 'https://api.nal.usda.gov/fdc/v1/foods/search';

// USDA authenticates via `api_key` as a *query parameter* (not a header
// like Anthropic's `x-api-key`). Allowlist the user-facing params; the
// proxy strips any caller-provided `api_key` and substitutes its own
// after this filter.
const FORWARDED_QUERY_PARAMS = new Set(['query', 'dataType', 'pageSize']);

// Module-scope singleton. Cache invalidates with container recycling.
const secretsClient = new SecretsManagerClient({});
let cachedApiKey: string | null = null;

export async function proxyFoodsSearch(
  callerQueryParams: Record<string, string | undefined> | undefined,
  requestId: string,
): Promise<ProxyResponse> {
  const apiKey = await getUsdaApiKey();

  const url = new URL(USDA_URL);
  if (callerQueryParams) {
    for (const [name, value] of Object.entries(callerQueryParams)) {
      if (value === undefined) continue;
      if (FORWARDED_QUERY_PARAMS.has(name)) {
        url.searchParams.set(name, value);
      }
    }
  }
  url.searchParams.set('api_key', apiKey);

  const response = await fetchUpstream('USDA', url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
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
    return {
      statusCode: response.status,
      headers: responseHeaders,
      body: rawBody,
    };
  }

  // Classify the failure by api.data.gov's conventions. Rate limiting is
  // HTTP 429 (`OVER_RATE_LIMIT`). HTTP 403 is an API-*key* problem
  // (`API_KEY_INVALID` / `API_KEY_MISSING` / `API_KEY_DISABLED` / …) — a
  // proxy misconfiguration, NOT a rate limit. Conflating the two reported
  // an unconfigured key to iOS as `upstream_rate_limited`, producing a
  // bogus "rate limit" message that tripped on the very first search. Map
  // key problems to 503 `upstream_not_configured` (iOS →
  // SearchError.proxyNotConfigured) so the real cause is visible; the fix
  // is operational (populate `macroscape-proxy/usda-api-key`).
  const usdaErrorCode = extractUsdaErrorCode(rawBody);
  const isRateLimit = response.status === 429 || usdaErrorCode === 'OVER_RATE_LIMIT';
  const isKeyProblem = response.status === 403 || (usdaErrorCode?.startsWith('API_KEY_') ?? false);

  const envelope: SanitizedUsdaError['error'] = isRateLimit
    ? 'upstream_rate_limited'
    : isKeyProblem
      ? 'upstream_not_configured'
      : 'upstream_error';
  const statusCode = isRateLimit ? 429 : isKeyProblem ? 503 : response.status;
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(sanitizeUsdaError(rawBody, envelope)),
  };
}

// Pulls api.data.gov's machine-readable error code out of either response
// shape: `{ error: { code, message } }` or `{ error: "STRING" }`.
function extractUsdaErrorCode(rawBody: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (parsed && typeof parsed === 'object') {
      const errField = (parsed as { error?: unknown }).error;
      if (errField && typeof errField === 'object') {
        const code = (errField as { code?: unknown }).code;
        return typeof code === 'string' ? code : undefined;
      }
      if (typeof errField === 'string') return errField;
    }
  } catch {
    // Non-JSON body — no code to extract.
  }
  return undefined;
}

interface SanitizedUsdaError {
  error: 'upstream_error' | 'upstream_rate_limited' | 'upstream_not_configured';
  upstream: {
    type: string;
    message: string;
  };
}

function sanitizeUsdaError(
  rawBody: string,
  envelope: SanitizedUsdaError['error'],
): SanitizedUsdaError {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (parsed && typeof parsed === 'object') {
      // USDA's envelope is inconsistent: `{ "error": { "code", "message" } }`
      // for some failures, plain `{ "error": "API_KEY_MISSING" }` for others.
      const errField = (parsed as { error?: unknown }).error;
      if (errField && typeof errField === 'object') {
        const e = errField as { code?: unknown; message?: unknown };
        return {
          error: envelope,
          upstream: {
            type: typeof e.code === 'string' ? e.code : 'unknown',
            message: typeof e.message === 'string' ? e.message : '',
          },
        };
      }
      if (typeof errField === 'string') {
        return { error: envelope, upstream: { type: errField, message: '' } };
      }
    }
  } catch {
    // Fall through.
  }
  return {
    error: envelope,
    upstream: {
      type: 'unknown',
      message: 'Upstream returned a non-JSON or unexpected error response',
    },
  };
}

async function getUsdaApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;
  const secretArn = process.env.USDA_SECRET_ARN;
  if (!secretArn) {
    throw new Error('USDA_SECRET_ARN env var is required');
  }
  const result = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretArn }));
  const value = result.SecretString;
  if (!value) {
    throw new UpstreamError(503, 'upstream_not_configured');
  }
  cachedApiKey = value;
  return value;
}
