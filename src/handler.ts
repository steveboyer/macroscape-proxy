import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { authenticate, AuthError } from './auth/authenticate';
import { upsertUser } from './db/users';
import { checkAndIncrement, RateLimitError } from './rateLimit/dailyLimit';
import { proxyMessages, UpstreamError } from './upstream/anthropic';

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  if (event.rawPath === '/health') {
    return handleHealth(event);
  }
  if (event.rawPath === '/v1/messages') {
    return handleMessages(event);
  }
  return jsonResponse(404, { error: 'not_found', path: event.rawPath });
};

async function handleHealth(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    const claims = await authenticate(event);
    const { created } = await upsertUser(claims.sub);
    return jsonResponse(200, { ok: true, userId: claims.sub, created });
  } catch (err) {
    return errorResponse(err);
  }
}

async function handleMessages(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (event.requestContext.http.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' });
  }
  try {
    const claims = await authenticate(event);
    await checkAndIncrement(claims.sub);
    const result = await proxyMessages(event.headers, event.body, event.isBase64Encoded ?? false);
    return {
      statusCode: result.statusCode,
      headers: result.headers,
      body: result.body,
    };
  } catch (err) {
    return errorResponse(err);
  }
}

function errorResponse(err: unknown): APIGatewayProxyResultV2 {
  if (err instanceof RateLimitError) {
    return {
      statusCode: err.statusCode,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(err.retryAfterSeconds),
      },
      body: JSON.stringify({
        error: err.reason,
        limit: err.limit,
        count: err.count,
        resetsAt: err.resetsAt,
      }),
    };
  }
  if (err instanceof AuthError || err instanceof UpstreamError) {
    return jsonResponse(err.statusCode, { error: err.reason });
  }
  throw err;
}

function jsonResponse(statusCode: number, body: object): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
