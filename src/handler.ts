import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { authenticate, AuthError } from './auth/authenticate';
import { upsertUser } from './db/users';
import { createRequestLogger, type RequestLogger } from './logging/logger';
import { checkAndIncrement, RateLimitError } from './rateLimit/dailyLimit';
import { proxyMessages, UpstreamError } from './upstream/anthropic';

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const logger = createRequestLogger(event);
  try {
    const result = await dispatch(event, logger);
    logger.log({ statusCode: result.statusCode ?? 200 });
    return result;
  } catch (err) {
    logger.setError('unhandled');
    logger.log({
      statusCode: 500,
      extra: { message: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
};

async function dispatch(
  event: APIGatewayProxyEventV2,
  logger: RequestLogger,
): Promise<APIGatewayProxyStructuredResultV2> {
  if (event.rawPath === '/health') {
    return handleHealth(event, logger);
  }
  if (event.rawPath === '/v1/messages') {
    return handleMessages(event, logger);
  }
  return jsonResponse(404, { error: 'not_found', path: event.rawPath });
}

async function handleHealth(
  event: APIGatewayProxyEventV2,
  logger: RequestLogger,
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const claims = await authenticate(event);
    logger.setUserId(claims.sub);
    const { created } = await upsertUser(claims.sub);
    return jsonResponse(200, { ok: true, userId: claims.sub, created });
  } catch (err) {
    return errorResponse(err, logger);
  }
}

async function handleMessages(
  event: APIGatewayProxyEventV2,
  logger: RequestLogger,
): Promise<APIGatewayProxyStructuredResultV2> {
  if (event.requestContext.http.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' });
  }
  try {
    const claims = await authenticate(event);
    logger.setUserId(claims.sub);
    await checkAndIncrement(claims.sub);
    const result = await proxyMessages(
      event.headers,
      event.body,
      event.isBase64Encoded ?? false,
      logger.requestId,
    );
    logger.setUpstreamStatus(result.statusCode);
    return {
      statusCode: result.statusCode,
      headers: result.headers,
      body: result.body,
    };
  } catch (err) {
    return errorResponse(err, logger);
  }
}

function errorResponse(err: unknown, logger: RequestLogger): APIGatewayProxyStructuredResultV2 {
  if (err instanceof RateLimitError) {
    logger.setError(err.reason);
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
    logger.setError(err.reason);
    return jsonResponse(err.statusCode, { error: err.reason });
  }
  throw err;
}

function jsonResponse(statusCode: number, body: object): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
