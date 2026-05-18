import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { UpstreamError } from './errors';

export { UpstreamError };

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// Strict allowlist. The caller's Authorization (Apple JWT) is dropped
// on purpose — the proxy attaches its own x-api-key.
const FORWARDED_HEADER_NAMES = new Set([
  'content-type',
  'anthropic-version',
  'anthropic-beta',
  'accept',
  'accept-encoding',
]);

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
