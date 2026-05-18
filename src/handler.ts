import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { verifyAppleIdToken, AppleTokenError } from './auth/appleVerifier';
import { upsertUser } from './db/users';

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  if (event.rawPath === '/health') {
    return handleHealth(event);
  }
  return jsonResponse(404, { error: 'not_found', path: event.rawPath });
};

async function handleHealth(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const token = extractBearerToken(event);
  if (!token) {
    return jsonResponse(401, { error: 'missing_bearer_token' });
  }
  try {
    const claims = await verifyAppleIdToken(token);
    const { created } = await upsertUser(claims.sub);
    return jsonResponse(200, { ok: true, userId: claims.sub, created });
  } catch (err) {
    if (err instanceof AppleTokenError) {
      return jsonResponse(401, { error: err.reason });
    }
    throw err;
  }
}

function extractBearerToken(event: APIGatewayProxyEventV2): string | null {
  const header = event.headers.authorization ?? event.headers.Authorization;
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

function jsonResponse(statusCode: number, body: object): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
