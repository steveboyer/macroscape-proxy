import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { UpstreamError } from './errors';
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

  const response = await fetch(url, {
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

  // USDA returns 429 for over-quota, 403 for DEMO_KEY exhaustion. Both
  // map to `upstream_rate_limited` so iOS can keep its
  // SearchError.rateLimited distinction (vs auth-401).
  const isRateLimit = response.status === 429 || response.status === 403;
  return {
    statusCode: isRateLimit ? 429 : response.status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(sanitizeUsdaError(rawBody, isRateLimit)),
  };
}

interface SanitizedUsdaError {
  error: 'upstream_error' | 'upstream_rate_limited';
  upstream: {
    type: string;
    message: string;
  };
}

function sanitizeUsdaError(rawBody: string, isRateLimit: boolean): SanitizedUsdaError {
  const envelope = isRateLimit ? 'upstream_rate_limited' : 'upstream_error';
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
