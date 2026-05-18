// Shared error type for upstream proxy modules so handler.ts can map any
// upstream failure (Anthropic, USDA, future) to a uniform response.
export class UpstreamError extends Error {
  readonly statusCode: number;
  readonly reason: string;
  constructor(statusCode: number, reason: string, message?: string) {
    super(message ?? reason);
    this.name = 'UpstreamError';
    this.statusCode = statusCode;
    this.reason = reason;
  }
}
