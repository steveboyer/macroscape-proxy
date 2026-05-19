import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { verifyAppleIdToken, AppleTokenError, type AppleClaims } from './appleVerifier';

// Route-level wrapper around appleVerifier: Bearer extraction + verification +
// uniform error type. Handler maps `AuthError` to a 401 JSON response;
// `reason` is the stable wire-level discriminator (`expired`, `invalid_signature`,
// etc.), `message` carries the human-readable detail for CloudWatch only.
export class AuthError extends Error {
  readonly statusCode: number;
  readonly reason: string;
  constructor(statusCode: number, reason: string, message?: string) {
    super(message ?? reason);
    this.statusCode = statusCode;
    this.reason = reason;
    this.name = 'AuthError';
  }
}

export async function authenticate(event: APIGatewayProxyEventV2): Promise<AppleClaims> {
  const token = extractBearerToken(event);
  if (!token) {
    throw new AuthError(401, 'missing_bearer_token');
  }
  try {
    return await verifyAppleIdToken(token);
  } catch (err) {
    if (err instanceof AppleTokenError) {
      throw new AuthError(401, err.reason, err.message);
    }
    throw err;
  }
}

function extractBearerToken(event: APIGatewayProxyEventV2): string | null {
  // API Gateway HTTP API normalizes header names to lowercase, but check the
  // canonical capitalization too as a defensive fallback in case the runtime
  // (or a future upstream) ever forwards them as-cased.
  const header = event.headers.authorization ?? event.headers.Authorization;
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}
