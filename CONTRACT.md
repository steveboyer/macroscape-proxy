# macroscape-proxy API contract

The API surface clients consume to talk to the proxy. Currently the only client is the MacroScape iOS app.

## Base URL

```
https://api.macroscape.app
```

## Authentication

All endpoints require **Sign in with Apple**. The client sends Apple's id_token in every request:

```
Authorization: Bearer <id_token>
```

The id_token is obtained on iOS via `ASAuthorizationAppleIDCredential.identityToken` after a successful Sign in with Apple flow. Apple id_tokens have a ~10-minute TTL; the client refreshes via the iOS framework, not via the proxy.

### JWT verification

Every id_token is verified before the request is processed:

| Check       | Required value                                              |
| ----------- | ----------------------------------------------------------- |
| Signature   | Verified against Apple's public keys                        |
| `iss` claim | `https://appleid.apple.com`                                 |
| `aud` claim | `app.macroscape.MacroScape` (the iOS app's Bundle ID)       |
| `exp` claim | Must be in the future                                       |
| `sub` claim | Must be a non-empty string (used as the proxy's `userId`)   |

JWKS is fetched from `https://appleid.apple.com/auth/keys` and cached in the Lambda container; cold starts pay one HTTPS fetch.

## Endpoints

### `GET /health`

Verifies auth and ensures a user record exists in the proxy's database. Suitable as a liveness/auth probe from the client. **Not rate-limited.**

**Request:**

```
GET /health
Authorization: Bearer <id_token>
```

**Response (200):**

```json
{
  "ok": true,
  "userId": "<Apple sub claim>",
  "created": true
}
```

`created: true` on the user's first `/health`; `false` on subsequent calls.

### `POST /v1/messages`

Proxies the request to `https://api.anthropic.com/v1/messages`. Body is forwarded **unchanged**. Response status + `content-type` + body are forwarded back unchanged. **Rate-limited** (see below).

**Request:**

```
POST /v1/messages
Authorization: Bearer <id_token>
Content-Type: application/json
anthropic-version: 2023-06-01
anthropic-beta: prompt-caching-2024-07-31

<Anthropic request body — passed through>
```

The caller's `Authorization` header (the Apple id_token) is **dropped** before forwarding to Anthropic. The proxy attaches its own `x-api-key` from Secrets Manager.

**Request headers forwarded to Anthropic** (strict allowlist; anything else is dropped):

- `content-type`
- `anthropic-version`
- `anthropic-beta`
- `accept`
- `accept-encoding`

**Response (2xx):** Anthropic's response, byte-for-byte. Prompt-cache hit/miss is visible in `usage.cache_read_input_tokens` / `usage.cache_creation_input_tokens` in the body.

**Response (non-2xx from Anthropic):** Anthropic's status code is preserved; the body is **sanitized** into a known envelope to prevent upstream implementation details (request IDs, internal codes, stack traces) from leaking:

```json
{
  "error": "upstream_error",
  "upstream": {
    "type": "<Anthropic error type, e.g. invalid_request_error, rate_limit_error, overloaded_error, api_error>",
    "message": "<Anthropic's human-readable error message>"
  }
}
```

If the upstream response isn't parseable JSON or doesn't match Anthropic's standard `{ error: { type, message } }` shape, `upstream.type` falls back to `"unknown"` with a generic message. The status code is still forwarded as-is.

**Response headers forwarded back to caller:** `content-type` only. Anthropic's `request-id`, `anthropic-organization-id`, and rate-limit headers are currently dropped. To request additional headers be exposed, file an issue.

## Error responses

All proxy-originated error responses have a JSON body of the form:

```json
{ "error": "<reason>", "...optional fields": "..." }
```

| Status | `error`                  | When                                                                         | Extra fields                |
| ------ | ------------------------ | ---------------------------------------------------------------------------- | --------------------------- |
| 401    | `missing_bearer_token`   | No `Authorization` header, or doesn't match `Bearer <token>`                 | —                           |
| 401    | `expired`                | id_token's `exp` is in the past                                              | —                           |
| 401    | `invalid_signature`      | id_token signature doesn't verify against Apple's JWKS                       | —                           |
| 401    | `invalid_issuer`         | id_token's `iss` is not `https://appleid.apple.com`                          | —                           |
| 401    | `invalid_audience`       | id_token's `aud` is not `app.macroscape.MacroScape`                          | —                           |
| 401    | `malformed`              | Token isn't a parseable JWT, or `sub` is missing                             | —                           |
| 401    | `jwks_fetch_failed`      | Proxy couldn't fetch Apple's JWKS (transient)                                | —                           |
| 404    | `not_found`              | Unknown route                                                                | `path`                      |
| 405    | `method_not_allowed`     | Wrong HTTP method (e.g., `GET /v1/messages`)                                 | —                           |
| 429    | `daily_limit_exceeded`   | User hit their daily request limit on `/v1/messages`                         | `limit`, `count`, `resetsAt` |
| 503    | `upstream_not_configured`| Proxy's Anthropic API key isn't populated in Secrets Manager (transient)     | —                           |
| 4xx/5xx| `upstream_error`         | Anthropic returned non-2xx; status code is forwarded from Anthropic          | `upstream` (type, message)  |
| 500    | (none)                   | Unexpected internal error; Lambda default response (not this JSON shape)     | —                           |

The recommended client mapping:

- **401** of any kind → re-auth via Sign in with Apple and retry once
- **429** → respect `Retry-After`; surface `resetsAt` in UI
- **503 `upstream_not_configured`** → brief backoff and retry (transient during proxy rollout)
- **5xx other** → standard backoff with jitter
- **4xx other** → user-facing error, no retry

## Rate limiting

`POST /v1/messages` is rate-limited per user per UTC day:

- **Default limit:** 100 requests per day
- **Reset:** UTC midnight
- **Per-user override:** set the `dailyLimit` number attribute on the user's `USER#<sub>/PROFILE` row in DynamoDB (no admin endpoint yet)
- **Counted regardless of upstream outcome** — Anthropic errors, 5xx responses, etc. still consume quota
- **`/health` is NOT rate-limited**

When exceeded:

```
HTTP/2 429
Retry-After: <seconds until UTC midnight>
Content-Type: application/json

{
  "error": "daily_limit_exceeded",
  "limit": 100,
  "count": 101,
  "resetsAt": "<ISO timestamp of next UTC midnight>"
}
```

The client gets both the header (per RFC 7231) and the body fields (for UI). Use whichever fits.

## Not yet implemented

These are tracked in `issues.md` and will land in future releases. Clients should be prepared for them to change:

- **Streaming responses** (`stream: true` in Anthropic body) — proxy currently buffers the full response and may not handle Anthropic SSE chunked transfer correctly. If your client needs streaming, file an issue before depending on `/v1/messages` for streaming calls.
- **Additional response headers** — Anthropic's `request-id` and rate-limit hints are dropped. Easy to add when requested.
