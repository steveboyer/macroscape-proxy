// Shared error type for upstream proxy modules so handler.ts can map any
// upstream failure (Anthropic, USDA, future) to a uniform response.
export class UpstreamError extends Error {
  readonly statusCode: number;
  readonly reason: string;
  // Extra fields merged into the JSON error envelope (e.g. `upstream`).
  readonly extra: Record<string, unknown>;
  constructor(
    statusCode: number,
    reason: string,
    message?: string,
    extra: Record<string, unknown> = {},
  ) {
    super(message ?? reason);
    this.name = 'UpstreamError';
    this.statusCode = statusCode;
    this.reason = reason;
    this.extra = extra;
  }
}

// Upstream calls get their own deadline, comfortably inside the Lambda
// timeout (see `UPSTREAM_TIMEOUT_MS` in lib/macroscape-proxy-stack.ts).
// Without one, a slow Anthropic call — Opus on a big label photo routinely
// takes >10 s — outlives the function, Lambda kills it, and API Gateway
// answers with its own `{"message":"Internal Server Error"}` instead of a
// proxy envelope the client can act on (MSP048).
const DEFAULT_UPSTREAM_TIMEOUT_MS = 27_000;

export function upstreamTimeoutMs(): number {
  const raw = process.env.UPSTREAM_TIMEOUT_MS;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_UPSTREAM_TIMEOUT_MS;
}

/**
 * `fetch` with a deadline and typed failures. A timeout becomes
 * `504 upstream_timeout`; a connection-level failure (DNS, TLS, reset —
 * undici surfaces these as `TypeError: fetch failed`) becomes
 * `502 upstream_unreachable`. Both carry an `upstream` block naming the
 * provider so the client can say which service it was, not just "500".
 */
export async function fetchUpstream(
  provider: string,
  url: string | URL,
  init: RequestInit,
): Promise<Response> {
  const timeoutMs = upstreamTimeoutMs();
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new UpstreamError(504, 'upstream_timeout', `${provider} timed out`, {
        upstream: {
          type: 'timeout',
          message: `${provider} did not respond within ${timeoutMs} ms`,
        },
      });
    }
    if (err instanceof TypeError) {
      throw new UpstreamError(502, 'upstream_unreachable', `${provider} unreachable`, {
        upstream: {
          type: 'unreachable',
          message: `Could not connect to ${provider}`,
        },
      });
    }
    throw err;
  }
}
