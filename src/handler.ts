import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { authenticate, AuthError } from './auth/authenticate';
import {
  createSession,
  logoutSession,
  refreshSession,
  type SessionResponse,
} from './auth/sessions';
import { upsertUser } from './db/users';
import { createRequestLogger, type RequestLogger } from './logging/logger';
import { checkAndIncrement, RateLimitError } from './rateLimit/dailyLimit';
import { proxyMessages, proxyModels, UpstreamError } from './upstream/anthropic';
import { proxyFoodsSearch } from './upstream/usda';

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
  const path = event.rawPath;

  if (path === '/health') {
    return handleHealth(event, logger);
  }
  // Routes follow the `/v1/<upstream>/<endpoint>` convention (see CONTRACT.md).
  if (path === '/v1/anthropic/messages') {
    return handleAnthropic(event, logger);
  }
  if (path === '/v1/anthropic/models') {
    return handleAnthropicModels(event, logger);
  }
  if (path === '/v1/usda/foods/search') {
    return handleFoodsSearch(event, logger);
  }
  // Session endpoints (MSP044). Not upstream-forwarding, so they sit outside
  // the `/v1/<upstream>/<endpoint>` convention — same exception as /health.
  if (path === '/v1/auth/session') {
    return handleAuthSession(event, logger);
  }
  if (path === '/v1/auth/refresh') {
    return handleAuthRefresh(event, logger);
  }
  if (path === '/v1/auth/logout') {
    return handleAuthLogout(event, logger);
  }
  return jsonResponse(404, { error: 'not_found', path });
}

// Auth routes get their own counter and stay off the shared total: a token
// refresh isn't an AI call, and charging it would let background refreshes
// spend the user's daily budget. The bound still matters — without one these
// are an unauthenticated-ish DoS surface — so it's generous, not absent.
// One device refreshing hourly costs ~24/day; this leaves room for several.
const AUTH_FALLBACK_DAILY_LIMIT = 200;

async function handleAuthSession(
  event: APIGatewayProxyEventV2,
  logger: RequestLogger,
): Promise<APIGatewayProxyStructuredResultV2> {
  if (event.requestContext.http.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' });
  }
  try {
    const body = parseJsonBody(event);
    const appleIdToken = readStringField(body, 'appleIdToken');
    if (!appleIdToken) {
      throw new AuthError(400, 'invalid_request', 'body must include appleIdToken');
    }
    const session = await createSession(appleIdToken);
    logger.setUserId(session.userId);
    await checkAndIncrement(session.userId, 'auth', {
      countTowardTotal: false,
      fallbackGroupLimit: AUTH_FALLBACK_DAILY_LIMIT,
    });
    return jsonResponse(200, sessionBody(session));
  } catch (err) {
    return errorResponse(err, logger);
  }
}

async function handleAuthRefresh(
  event: APIGatewayProxyEventV2,
  logger: RequestLogger,
): Promise<APIGatewayProxyStructuredResultV2> {
  if (event.requestContext.http.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' });
  }
  try {
    const body = parseJsonBody(event);
    const refreshToken = readStringField(body, 'refreshToken');
    if (!refreshToken) {
      throw new AuthError(400, 'invalid_request', 'body must include refreshToken');
    }
    const session = await refreshSession(refreshToken);
    logger.setUserId(session.userId);
    await checkAndIncrement(session.userId, 'auth', {
      countTowardTotal: false,
      fallbackGroupLimit: AUTH_FALLBACK_DAILY_LIMIT,
    });
    return jsonResponse(200, sessionBody(session));
  } catch (err) {
    return errorResponse(err, logger);
  }
}

async function handleAuthLogout(
  event: APIGatewayProxyEventV2,
  logger: RequestLogger,
): Promise<APIGatewayProxyStructuredResultV2> {
  if (event.requestContext.http.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' });
  }
  try {
    const body = parseJsonBody(event);
    const refreshToken = readStringField(body, 'refreshToken');
    if (!refreshToken) {
      throw new AuthError(400, 'invalid_request', 'body must include refreshToken');
    }
    await logoutSession(refreshToken);
    return jsonResponse(200, { ok: true });
  } catch (err) {
    return errorResponse(err, logger);
  }
}

function sessionBody(session: SessionResponse) {
  return {
    accessToken: session.accessToken,
    accessExpiresIn: session.accessExpiresIn,
    refreshToken: session.refreshToken,
    refreshExpiresIn: session.refreshExpiresIn,
  };
}

function parseJsonBody(event: APIGatewayProxyEventV2): unknown {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf-8')
    : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    throw new AuthError(400, 'invalid_request', 'body must be valid JSON');
  }
}

function readStringField(body: unknown, field: string): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
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

async function handleAnthropic(
  event: APIGatewayProxyEventV2,
  logger: RequestLogger,
): Promise<APIGatewayProxyStructuredResultV2> {
  if (event.requestContext.http.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' });
  }
  try {
    const claims = await authenticate(event);
    logger.setUserId(claims.sub);
    await checkAndIncrement(claims.sub, 'anthropic');
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

// A model-list fetch isn't an AI call and the client caches the result, so it
// gets its own `models` counter and stays off the shared total — otherwise an
// app launch would spend part of the user's daily AI budget. The fallback keeps
// the route bounded even with no DEFAULT_DAILY_LIMIT_MODELS configured.
const MODELS_FALLBACK_DAILY_LIMIT = 50;

async function handleAnthropicModels(
  event: APIGatewayProxyEventV2,
  logger: RequestLogger,
): Promise<APIGatewayProxyStructuredResultV2> {
  if (event.requestContext.http.method !== 'GET') {
    return jsonResponse(405, { error: 'method_not_allowed' });
  }
  try {
    const claims = await authenticate(event);
    logger.setUserId(claims.sub);
    await checkAndIncrement(claims.sub, 'models', {
      countTowardTotal: false,
      fallbackGroupLimit: MODELS_FALLBACK_DAILY_LIMIT,
    });
    const result = await proxyModels(event.headers, event.queryStringParameters, logger.requestId);
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

async function handleFoodsSearch(
  event: APIGatewayProxyEventV2,
  logger: RequestLogger,
): Promise<APIGatewayProxyStructuredResultV2> {
  if (event.requestContext.http.method !== 'GET') {
    return jsonResponse(405, { error: 'method_not_allowed' });
  }
  try {
    const claims = await authenticate(event);
    logger.setUserId(claims.sub);
    await checkAndIncrement(claims.sub, 'usda');
    const result = await proxyFoodsSearch(event.queryStringParameters, logger.requestId);
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
        scope: err.scope,
        ...(err.group !== null ? { group: err.group } : {}),
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
  // Unknown error — propagate so the top-level wrapper logs it as
  // `error: "unhandled"` and Lambda returns 500 (with the stack in CW logs).
  throw err;
}

function jsonResponse(statusCode: number, body: object): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
