import { randomUUID } from 'crypto';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// Only allow conservative characters in caller-provided request IDs so a
// malicious caller can't smuggle log-line breaks or quotes into our JSON.
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

export interface RequestLogger {
  readonly requestId: string;
  setUserId(userId: string): void;
  setUpstreamStatus(status: number): void;
  setError(reason: string): void;
  log(final: { statusCode: number; extra?: Record<string, unknown> }): void;
}

export function createRequestLogger(event: APIGatewayProxyEventV2): RequestLogger {
  const requestId = pickOrGenerateRequestId(event);
  const startedAt = Date.now();
  const ctx: Record<string, unknown> = {
    requestId,
    lambdaRequestId: event.requestContext.requestId,
    route: event.rawPath,
    method: event.requestContext.http.method,
  };

  return {
    requestId,
    setUserId(userId) {
      ctx.userId = userId;
    },
    setUpstreamStatus(status) {
      ctx.upstreamStatus = status;
    },
    setError(reason) {
      ctx.error = reason;
    },
    log(final) {
      const line = {
        ...ctx,
        ...(final.extra ?? {}),
        statusCode: final.statusCode,
        latencyMs: Date.now() - startedAt,
      };
      // Single JSON line per request; CloudWatch captures stdout.
      console.log(JSON.stringify(line));
    },
  };
}

function pickOrGenerateRequestId(event: APIGatewayProxyEventV2): string {
  const inbound = event.headers['x-request-id'];
  if (inbound && REQUEST_ID_RE.test(inbound)) {
    return inbound;
  }
  return randomUUID();
}
