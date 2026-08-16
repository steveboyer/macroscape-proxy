import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { CryptoKey, JWK } from 'jose';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

import { handler } from '../src/handler';

const ISS = 'https://appleid.apple.com';
const AUD = 'app.macroscape.MacroScape';
const KID = 'integration-test-kid';
const ANTHROPIC_API_KEY = 'sk-ant-integration-test-key-XXXXX';

const ddbMock = mockClient(DynamoDBDocumentClient);
const smMock = mockClient(SecretsManagerClient);

let signingKey: CryptoKey;
let publicJwk: JWK;
const fetchMock = vi.fn();
const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

beforeAll(async () => {
  process.env.APPLE_AUD = AUD;
  process.env.TABLE_NAME = 'test-table';
  process.env.UPSTREAM_SECRET_ARN = 'arn:aws:secretsmanager:us-west-2:123:secret:upstream-XXX';
  process.env.USDA_SECRET_ARN = 'arn:aws:secretsmanager:us-west-2:123:secret:usda-XXX';
  process.env.APPLE_SIGNIN_SECRET_ARN =
    'arn:aws:secretsmanager:us-west-2:123:secret:apple-signin-XXX';
  process.env.DEFAULT_DAILY_LIMIT = '100';

  const trusted = await generateKeyPair('RS256');
  signingKey = trusted.privateKey;
  publicJwk = await exportJWK(trusted.publicKey);
  publicJwk.kid = KID;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';

  vi.stubGlobal('fetch', fetchMock);
});

afterAll(() => {
  vi.unstubAllGlobals();
  consoleLogSpy.mockRestore();
});

beforeEach(() => {
  ddbMock.reset();
  smMock.reset();
  fetchMock.mockReset();
  consoleLogSpy.mockClear();

  // Defaults — individual tests override as needed.
  smMock.on(GetSecretValueCommand).resolves({ SecretString: ANTHROPIC_API_KEY });
  ddbMock.on(GetCommand).resolves({ Item: undefined });
  ddbMock.on(PutCommand).resolves({});
  ddbMock.on(UpdateCommand).resolves({ Attributes: { count: 1 } });
});

async function signToken(
  overrides: { sub?: string; expSecondsFromNow?: number } = {},
): Promise<string> {
  return new SignJWT({ sub: overrides.sub ?? '001234.abc.5678' })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(ISS)
    .setAudience(AUD)
    .setIssuedAt()
    .setExpirationTime(
      overrides.expSecondsFromNow !== undefined
        ? Math.floor(Date.now() / 1000) + overrides.expSecondsFromNow
        : '10m',
    )
    .sign(signingKey);
}

function jwksResponse(): Response {
  return new Response(JSON.stringify({ keys: [publicJwk] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function routeFetch(handlers: {
  anthropic?: () => Response | Promise<Response>;
  usda?: () => Response | Promise<Response>;
}) {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('appleid.apple.com')) return jwksResponse();
    if (url.includes('api.anthropic.com')) {
      if (!handlers.anthropic) throw new Error(`Unexpected Anthropic fetch: ${url}`);
      return handlers.anthropic();
    }
    if (url.includes('api.nal.usda.gov')) {
      if (!handlers.usda) throw new Error(`Unexpected USDA fetch: ${url}`);
      return handlers.usda();
    }
    throw new Error(`Unmocked fetch: ${url}`);
  });
}

function makeAnthropicEvent(token: string, body: object): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /v1/anthropic/messages',
    rawPath: '/v1/anthropic/messages',
    rawQueryString: '',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
      'x-bogus-header': 'should-be-dropped',
    },
    requestContext: {
      accountId: '123',
      apiId: 'test-api',
      domainName: 'api.macroscape.app',
      domainPrefix: 'api',
      http: {
        method: 'POST',
        path: '/v1/anthropic/messages',
        protocol: 'HTTP/1.1',
        sourceIp: '1.2.3.4',
        userAgent: 'integration-test',
      },
      requestId: 'apigw-req-test-1',
      routeKey: 'POST /v1/anthropic/messages',
      stage: '$default',
      time: '01/Jan/2026:00:00:00 +0000',
      timeEpoch: Date.now(),
    },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
}

// The models route caches successful upstream responses at module scope, keyed
// by anthropic-version + query string. Tests can't reach that cache to clear
// it, so each test below uses a distinct `limit` value to get a fresh key —
// except the one that deliberately exercises a cache hit.
function makeModelsEvent(
  token: string,
  rawQueryString: string,
  queryStringParameters: Record<string, string>,
  method = 'GET',
): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: `${method} /v1/anthropic/models`,
    rawPath: '/v1/anthropic/models',
    rawQueryString,
    queryStringParameters,
    headers: {
      authorization: `Bearer ${token}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'should-be-dropped',
      'x-bogus-header': 'should-be-dropped',
    },
    requestContext: {
      accountId: '123',
      apiId: 'test-api',
      domainName: 'api.macroscape.app',
      domainPrefix: 'api',
      http: {
        method,
        path: '/v1/anthropic/models',
        protocol: 'HTTP/1.1',
        sourceIp: '1.2.3.4',
        userAgent: 'integration-test',
      },
      requestId: 'apigw-req-models-1',
      routeKey: `${method} /v1/anthropic/models`,
      stage: '$default',
      time: '01/Jan/2026:00:00:00 +0000',
      timeEpoch: Date.now(),
    },
    isBase64Encoded: false,
  };
}

const MODELS_BODY = {
  data: [
    {
      type: 'model',
      id: 'claude-opus-4-7',
      display_name: 'Claude Opus 4.7',
      created_at: '2026-02-01T00:00:00Z',
    },
  ],
  has_more: false,
  first_id: 'claude-opus-4-7',
  last_id: 'claude-opus-4-7',
};

describe('GET /v1/anthropic/models — integration', () => {
  it('happy path: forwards to the Models API and returns the response unchanged', async () => {
    let capturedRequest: { url: string; init: RequestInit } | undefined;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('appleid.apple.com')) return jwksResponse();
      if (url.includes('api.anthropic.com')) {
        capturedRequest = { url, init: init ?? {} };
        return new Response(JSON.stringify(MODELS_BODY), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unmocked fetch: ${url}`);
    });

    const token = await signToken();
    const event = makeModelsEvent(token, 'limit=11&nope=drop-me', {
      limit: '11',
      nope: 'drop-me',
    });

    const result = (await handler(event)) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
    expect(result.body).toBe(JSON.stringify(MODELS_BODY));

    expect(capturedRequest).toBeDefined();
    // Query allowlist: `limit` survives, anything else is dropped.
    expect(capturedRequest!.url).toBe('https://api.anthropic.com/v1/models?limit=11');
    expect(capturedRequest!.init.method).toBe('GET');
    const outboundHeaders = capturedRequest!.init.headers as Record<string, string>;
    expect(outboundHeaders['x-api-key']).toBe(ANTHROPIC_API_KEY);
    expect(outboundHeaders['anthropic-version']).toBe('2023-06-01');
    expect(outboundHeaders['x-request-id']).toBeDefined();
    // Apple JWT dropped; so are the beta header (Models API is GA) and junk.
    expect(outboundHeaders['authorization']).toBeUndefined();
    expect(outboundHeaders['anthropic-beta']).toBeUndefined();
    expect(outboundHeaders['x-bogus-header']).toBeUndefined();

    // Group counter only — the models route stays off the shared total.
    expect(ddbMock.commandCalls(UpdateCommand).length).toBe(1);
  });

  it('serves a repeat request from the module-scope cache without calling upstream', async () => {
    let upstreamCalls = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('appleid.apple.com')) return jwksResponse();
      if (url.includes('api.anthropic.com')) {
        upstreamCalls += 1;
        return new Response(JSON.stringify(MODELS_BODY), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unmocked fetch: ${url}`);
    });

    const token = await signToken();
    const event = makeModelsEvent(token, 'limit=22', { limit: '22' });

    const first = (await handler(event)) as APIGatewayProxyStructuredResultV2;
    const second = (await handler(event)) as APIGatewayProxyStructuredResultV2;

    expect(first.body).toBe(JSON.stringify(MODELS_BODY));
    expect(second.body).toBe(first.body);
    expect(upstreamCalls).toBe(1);
    // Still rate-limited on the cached path — one group increment per request.
    expect(ddbMock.commandCalls(UpdateCommand).length).toBe(2);
  });

  it('rejects a non-GET method with 405', async () => {
    routeFetch({});
    const token = await signToken();
    const event = makeModelsEvent(token, '', {}, 'POST');

    const result = (await handler(event)) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(405);
    expect(JSON.parse(result.body as string).error).toBe('method_not_allowed');
  });

  it('sanitizes a non-2xx Models response into the upstream_error envelope', async () => {
    routeFetch({
      anthropic: () =>
        new Response(
          JSON.stringify({
            type: 'error',
            error: {
              type: 'authentication_error',
              message: 'invalid x-api-key',
              internal_trace_id: 'leak-me-please',
            },
          }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
    });

    const token = await signToken();
    const event = makeModelsEvent(token, 'limit=33', { limit: '33' });

    const result = (await handler(event)) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(401);
    const body = JSON.parse(result.body as string);
    expect(body.error).toBe('upstream_error');
    expect(body.upstream).toEqual({
      type: 'authentication_error',
      message: 'invalid x-api-key',
    });
    expect(JSON.stringify(body)).not.toContain('leak-me-please');
  });

  it('returns 429 scoped to the models group when its own limit is exceeded', async () => {
    // No DEFAULT_DAILY_LIMIT_MODELS in the test env, so the handler's
    // fallback of 50 is what's enforced here.
    ddbMock.on(UpdateCommand).resolvesOnce({ Attributes: { count: 51 } });
    routeFetch({});

    const token = await signToken();
    const event = makeModelsEvent(token, 'limit=44', { limit: '44' });

    const result = (await handler(event)) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(429);
    const body = JSON.parse(result.body as string);
    expect(body.error).toBe('daily_limit_exceeded');
    expect(body.scope).toBe('group');
    expect(body.group).toBe('models');
    expect(body.limit).toBe(50);
    expect(body.count).toBe(51);

    const anthropicCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('api.anthropic.com'),
    );
    expect(anthropicCalls.length).toBe(0);
  });
});

describe('POST /v1/anthropic/messages — integration', () => {
  it('happy path: forwards to Anthropic and returns the upstream response unchanged', async () => {
    const anthropicBody = {
      id: 'msg_test_abc',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello from mocked Anthropic' }],
      model: 'claude-opus-4-7',
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 8 },
    };
    let capturedRequest: { url: string; init: RequestInit } | undefined;
    routeFetch({
      anthropic: () => {
        return new Response(JSON.stringify(anthropicBody), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    // Capture the outbound Anthropic call's url + init for inspection.
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('appleid.apple.com')) return jwksResponse();
      if (url.includes('api.anthropic.com')) {
        capturedRequest = { url, init: init ?? {} };
        return new Response(JSON.stringify(anthropicBody), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unmocked fetch: ${url}`);
    });

    const token = await signToken();
    const callerBody = {
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const event = makeAnthropicEvent(token, callerBody);

    const result = (await handler(event)) as APIGatewayProxyStructuredResultV2;

    // Response forwarded byte-for-byte.
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe(JSON.stringify(anthropicBody));
    const contentType = result.headers?.['content-type'] ?? result.headers?.['Content-Type'];
    expect(contentType).toBe('application/json');

    // Outbound request shape.
    expect(capturedRequest).toBeDefined();
    expect(capturedRequest!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(capturedRequest!.init.method).toBe('POST');
    const outboundHeaders = capturedRequest!.init.headers as Record<string, string>;
    expect(outboundHeaders['x-api-key']).toBe(ANTHROPIC_API_KEY);
    expect(outboundHeaders['content-type']).toBe('application/json');
    expect(outboundHeaders['anthropic-version']).toBe('2023-06-01');
    expect(outboundHeaders['anthropic-beta']).toBe('prompt-caching-2024-07-31');
    expect(outboundHeaders['x-request-id']).toBeDefined();
    // Apple JWT must NOT be forwarded.
    expect(outboundHeaders['authorization']).toBeUndefined();
    expect(outboundHeaders['Authorization']).toBeUndefined();
    // Disallowed caller headers must be dropped.
    expect(outboundHeaders['x-bogus-header']).toBeUndefined();
    // Body forwarded unchanged.
    expect(capturedRequest!.init.body).toBe(JSON.stringify(callerBody));

    // Rate-limit counter was incremented (total + group).
    expect(ddbMock.commandCalls(UpdateCommand).length).toBe(2);

    // Secret-redaction (deferred MSP019 assertion): the API key value must
    // never appear in any console.log line.
    const allLog = consoleLogSpy.mock.calls.flat().join(' ');
    expect(allLog).not.toContain(ANTHROPIC_API_KEY);
  });

  it('rejects an expired token with 401 invalid', async () => {
    routeFetch({}); // only JWKS will be fetched
    const token = await signToken({ expSecondsFromNow: -60 });
    const event = makeAnthropicEvent(token, { model: 'claude-opus-4-7', messages: [] });

    const result = (await handler(event)) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(401);
    const body = JSON.parse(result.body as string);
    expect(body.error).toBe('expired');

    // Upstream was never called — auth failed before proxy.
    const anthropicCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('api.anthropic.com'),
    );
    expect(anthropicCalls.length).toBe(0);
  });

  it('sanitizes a non-2xx Anthropic response into upstream_error envelope', async () => {
    const upstreamError = {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'messages: at least one message is required',
        internal_trace_id: 'leak-me-please',
      },
    };
    routeFetch({
      anthropic: () =>
        new Response(JSON.stringify(upstreamError), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    });

    const token = await signToken();
    const event = makeAnthropicEvent(token, { model: 'claude-opus-4-7', messages: [] });

    const result = (await handler(event)) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body as string);
    expect(body.error).toBe('upstream_error');
    expect(body.upstream).toEqual({
      type: 'invalid_request_error',
      message: 'messages: at least one message is required',
    });
    // internal_trace_id must NOT leak through.
    expect(body.upstream.internal_trace_id).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('leak-me-please');
  });

  it('returns 429 with Retry-After when the total rate limit is exceeded', async () => {
    // Total counter increment returns count > limit on first call.
    ddbMock.on(UpdateCommand).resolvesOnce({ Attributes: { count: 101 } });
    routeFetch({}); // upstream not expected to be called

    const token = await signToken();
    const event = makeAnthropicEvent(token, { model: 'claude-opus-4-7', messages: [] });

    const result = (await handler(event)) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(429);
    const body = JSON.parse(result.body as string);
    expect(body.error).toBe('daily_limit_exceeded');
    expect(body.scope).toBe('total');
    expect(body.limit).toBe(100);
    expect(body.count).toBe(101);
    expect(body.resetsAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const retryAfter = result.headers?.['Retry-After'] ?? result.headers?.['retry-after'];
    expect(retryAfter).toBeDefined();
    expect(Number(retryAfter)).toBeGreaterThan(0);

    // Upstream not called.
    const anthropicCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('api.anthropic.com'),
    );
    expect(anthropicCalls.length).toBe(0);
  });
});
