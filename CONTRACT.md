# macroscape-proxy API contract

The API surface clients consume to talk to the proxy. Currently the only client is the MacroScape
iOS app.

## Base URL

```
https://api.macroscape.app
```

## URL conventions

Upstream-forwarding endpoints follow the pattern:

```
/v1/<upstream-provider>/<endpoint>
```

Examples:

- `/v1/anthropic/messages` — proxies to `api.anthropic.com`
- `/v1/usda/foods/search` — proxies to `api.nal.usda.gov`

The upstream provider is visible in the URL on purpose. This:

- makes debugging and observability trivial (no path-to-provider mapping required);
- enables per-upstream rate-limit counters, cost attribution, and per-provider configuration;
- gives future upstreams a clean slot (`/v1/openai/...`, `/v1/openfoodfacts/...`);
- makes provider swaps an explicit decision at the URL level rather than a hidden one.

Routes that don't forward to a third-party upstream don't follow this pattern — currently only
`/health`.

## Authentication

All endpoints require a bearer token:

```
Authorization: Bearer <proxy_access_token>
```

The access token is **issued by the proxy**, not by Apple. The client signs in with Apple once,
exchanges the resulting `id_token` for a session at `POST /v1/auth/session`, and from then on uses
the proxy's access token — refreshing it over HTTP at `POST /v1/auth/refresh` with no further Apple
interaction. See [Session endpoints](#session-endpoints) for the full flow.

> **Why the proxy issues its own token.** An earlier version of this contract said the client sends
> Apple's `id_token` on every request and "refreshes via the iOS framework". That is not possible:
> Apple's `id_token` lives ~10 minutes and iOS has no API to silently re-mint one
> (`ASAuthorizationController.performRequests()` always runs the interactive flow, and
> `credentialState(forUserID:)` returns authorization state, not a token). The id_token is an
> authentication assertion for the moment of sign-in, not a credential for ongoing API calls, and
> using it as one forced a Sign in with Apple sheet roughly every ten minutes. MSP047 replaced it
> with the exchange described below.

**Transitional:** the upstream-forwarding routes and `/health` still accept a raw Apple `id_token`
in `Authorization` for one release, so a client that hasn't adopted sessions keeps working. The
proxy picks the verifier by the token's `iss` claim. This path will be removed once the iOS client
has shipped session support (macroscape MS154) — new clients should not use it.

### Token verification

Proxy access tokens are HS256 JWTs verified against a signing key held in Secrets Manager:

| Check       | Required value                                                     |
| ----------- | ------------------------------------------------------------------ |
| Signature   | HMAC-SHA256 against the key named by the token's `kid` header      |
| `iss` claim | `https://api.macroscape.app`                                       |
| `aud` claim | `macroscape-proxy`                                                 |
| `exp` claim | Must be in the future (tokens live 1 hour)                         |
| `sub` claim | The Apple `sub` — unchanged, so `userId` is stable across the swap |

The `kid` header exists so two signing keys can be live at once during rotation; a token naming an
unknown `kid` is rejected as `invalid_signature` rather than tried against every key.

### Apple id_token verification (transitional path)

An Apple `id_token` presented directly is verified before the request is processed. This is also
exactly what `POST /v1/auth/session` does with the token in its body:

| Check       | Required value                                            |
| ----------- | --------------------------------------------------------- |
| Signature   | Verified against Apple's public keys                      |
| `iss` claim | `https://appleid.apple.com`                               |
| `aud` claim | `app.macroscape.MacroScape` (the iOS app's Bundle ID)     |
| `exp` claim | Must be in the future                                     |
| `sub` claim | Must be a non-empty string (used as the proxy's `userId`) |

JWKS is fetched from `https://appleid.apple.com/auth/keys` and cached in the Lambda container; cold
starts pay one HTTPS fetch.

## Endpoints

## Session endpoints

Three routes manage the session lifecycle. Like `/health`, they don't forward to a third-party
upstream, so they sit outside the `/v1/<upstream>/<endpoint>` convention. All three take a JSON body
and require no `Authorization` header — the credential is _in_ the body.

**Rate-limited on their own `auth` counter**, off the shared daily total: a token refresh isn't an
AI call, and charging it would let background refreshes spend the user's upstream budget.

### `POST /v1/auth/session`

Exchanges an Apple `id_token` for a proxy session. Call this once, after Sign in with Apple.

**Request:**

```json
{ "appleIdToken": "<Apple identityToken>" }
```

**Response (200):**

```json
{
  "accessToken": "<proxy JWT>",
  "accessExpiresIn": 3600,
  "refreshToken": "<opaque string>",
  "refreshExpiresIn": 7776000
}
```

`*ExpiresIn` values are seconds. The Apple token is verified exactly as documented above; a bad one
returns the same 401 reasons (`expired`, `invalid_signature`, …). The user record is created on
first call, so a separate `/health` call is not required to provision one.

### `POST /v1/auth/refresh`

Exchanges a refresh token for a new pair. **Refresh tokens are single-use** — each redeem consumes
the presented token and returns a new one; store the new one before discarding the old.

**Request:**

```json
{ "refreshToken": "<opaque string>" }
```

**Response (200):** identical shape to `/v1/auth/session`.

**Reuse detection.** Presenting an already-consumed token **from the current chain** returns
`401 { "error": "refresh_token_reused" }` **and revokes every outstanding refresh token for that
user**. A replay is either a client retrying against a stale copy or a stolen token racing the real
client; the proxy can't tell those apart, so it invalidates the chain and forces a fresh Sign in
with Apple. Clients must therefore persist the rotated token durably before using it — a client that
loses the new token and retries with the old one will sign the user out.

"From the current chain" is load-bearing. A consumed token whose chain was _already_ revoked is
inert history, not evidence of theft, and returns `invalid_refresh_token` with no side effect —
otherwise replaying one old token would revoke the user's sessions again on every attempt, for as
long as the row survives.

Hitting the rate limit never costs you a session: the limit is charged before the presented token is
consumed, so a `429` leaves the token spendable.

A token that predates a revocation returns `401 { "error": "invalid_refresh_token" }` instead, and
does **not** trigger another revocation.

### `POST /v1/auth/logout`

Consumes the presented refresh token.

**Request:**

```json
{ "refreshToken": "<opaque string>" }
```

**Response (200):** `{ "ok": true }`

Idempotent — logging out an unknown or already-consumed token is a success, so a client can retry a
failed logout without special-casing 401.

> ⚠️ **Access tokens are not revoked by logout.** They're stateless and carry no server-side
> validity check, so an already-issued access token keeps working until its `exp` (≤ 1 hour). This
> is the deliberate trade for not doing a database read on every proxied request. Logout stops the
> session from being _extended_, not from finishing its current hour. If instant kill becomes a
> requirement, that needs a denylist keyed by `jti` — file an issue rather than shortening the TTL,
> which would just multiply refresh traffic.

### `GET /health`

Verifies auth and ensures a user record exists in the proxy's database. Suitable as a liveness/auth
probe from the client. **Not rate-limited.**

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

### `POST /v1/anthropic/messages`

Proxies the request to `https://api.anthropic.com/v1/messages`. Body is forwarded **unchanged**.
Response status + `content-type` + body are forwarded back unchanged. **Rate-limited** (see below).

**Request:**

```
POST /v1/anthropic/messages
Authorization: Bearer <id_token>
Content-Type: application/json
anthropic-version: 2023-06-01
anthropic-beta: prompt-caching-2024-07-31

<Anthropic request body — passed through>
```

The caller's `Authorization` header (the Apple id_token) is **dropped** before forwarding to
Anthropic. The proxy attaches its own `x-api-key` from Secrets Manager.

**Request headers forwarded to Anthropic** (strict allowlist; anything else is dropped):

- `content-type`
- `anthropic-version`
- `anthropic-beta`
- `accept`
- `accept-encoding`

**Request ID propagation:** The client may include an `x-request-id` header (alphanumeric + `-`/`_`,
max 200 chars) to correlate iOS-side and proxy-side logs. If absent or invalid, the proxy generates
a UUID. Either way, the same ID is attached to the outbound request to Anthropic as `x-request-id`,
and surfaces in every proxy CloudWatch log line for the request.

**Response (2xx):** Anthropic's response, byte-for-byte. Prompt-cache hit/miss is visible in
`usage.cache_read_input_tokens` / `usage.cache_creation_input_tokens` in the body.

**Response (non-2xx from Anthropic):** Anthropic's status code is preserved; the body is
**sanitized** into a known envelope to prevent upstream implementation details (request IDs,
internal codes, stack traces) from leaking:

```json
{
  "error": "upstream_error",
  "upstream": {
    "type": "<Anthropic error type, e.g. invalid_request_error, rate_limit_error, overloaded_error, api_error>",
    "message": "<Anthropic's human-readable error message>"
  }
}
```

If the upstream response isn't parseable JSON or doesn't match Anthropic's standard
`{ error: { type, message } }` shape, `upstream.type` falls back to `"unknown"` with a generic
message. The status code is still forwarded as-is.

**Response headers forwarded back to caller:** `content-type` only. Anthropic's `request-id`,
`anthropic-organization-id`, and rate-limit headers are currently dropped. To request additional
headers be exposed, file an issue.

### `GET /v1/anthropic/models`

Proxies the request to `https://api.anthropic.com/v1/models` so a client that holds no Anthropic key
can discover which models are available. Response is forwarded **byte-for-byte** — the proxy does no
filtering, sorting, or reshaping; the client decides what to show. **Rate-limited on its own counter
only** (see below) — this does not consume the user's daily AI quota.

**Request:**

```
GET /v1/anthropic/models?limit=20
Authorization: Bearer <id_token>
anthropic-version: 2023-06-01
```

**Query params forwarded to Anthropic** (strict allowlist; anything else is dropped):

- `limit`
- `after_id`
- `before_id`

The Models API paginates with `after_id` / `before_id` and returns `has_more` / `first_id` /
`last_id` — **not** the `page` / `next_page` scheme used elsewhere. The proxy deliberately does not
normalize this; code against Anthropic's shape.

**Request headers forwarded to Anthropic** (strict allowlist):

- `anthropic-version` (required by Anthropic)
- `accept`
- `accept-encoding`

No `anthropic-beta` — the Models API is GA and takes no beta header. As on `/v1/anthropic/messages`,
the caller's `Authorization` is dropped and the proxy attaches its own `x-api-key`.

**Response (2xx):** Anthropic's response, byte-for-byte. Each entry in `data[]` carries `id`,
`display_name`, `created_at`, and a `capabilities` tree. Note there is no `context_window` field —
the input window is `max_input_tokens` and `max_tokens` is the output cap. The Models API returns
**no pricing**; clients that display cost must maintain their own pricing table.

**Response (non-2xx from Anthropic):** Same `upstream_error` envelope as `/v1/anthropic/messages`,
with Anthropic's status code preserved.

**Caching:** Successful responses are cached in the Lambda container for 5 minutes, keyed by
`anthropic-version` + forwarded query params, so a warm container answers most launches without
touching upstream. Worst-case staleness for a newly released model is 5 minutes.

### `GET /v1/usda/foods/search`

Proxies the request to `https://api.nal.usda.gov/fdc/v1/foods/search`. **Rate-limited** (see below).

**Request:**

```
GET /v1/usda/foods/search?query=<text>&dataType=Foundation,SR%20Legacy&pageSize=15
Authorization: Bearer <id_token>
```

**Query params forwarded to USDA** (strict allowlist; anything else is dropped):

- `query`
- `dataType`
- `pageSize`

USDA authenticates via `api_key` **query parameter** (not a header). If the caller includes
`api_key` in the query string, the proxy **drops it** and substitutes its own from Secrets Manager.
Never pass through a stale or test API key.

**Response (2xx):** USDA's response, byte-for-byte (status + `content-type` + body). USDA's response
shape (`foods[].fdcId`, `description`, `dataType`, `foodNutrients[]…`) is unchanged.

**Response (non-2xx from USDA):** Sanitized to a known envelope, classified by api.data.gov's
conventions:

- **429** (or error code `OVER_RATE_LIMIT`) →
  `429 { error: "upstream_rate_limited", upstream: { type, message } }` — distinct from the proxy's
  own `daily_limit_exceeded` 429 (which signals the per-user proxy quota was hit).
- **403** (or error code `API_KEY_*`: `API_KEY_INVALID` / `API_KEY_MISSING` / `API_KEY_DISABLED` /
  …) → `503 { error: "upstream_not_configured", upstream: { type, message } }`. A 403 from
  api.data.gov is an API-_key_ problem, not a rate limit — the operator must populate a valid
  `macroscape-proxy/usda-api-key`.
- Any other non-2xx → `{ error: "upstream_error", upstream: { type, message } }` with USDA's status
  code preserved.

## Error responses

All proxy-originated error responses have a JSON body of the form:

```json
{ "error": "<reason>", "...optional fields": "..." }
```

| Status  | `error`                   | When                                                                        | Extra fields                                   |
| ------- | ------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------- |
| 401     | `missing_bearer_token`    | No `Authorization` header, or doesn't match `Bearer <token>`                | —                                              |
| 401     | `expired`                 | id_token's `exp` is in the past                                             | —                                              |
| 401     | `invalid_signature`       | id_token signature doesn't verify against Apple's JWKS                      | —                                              |
| 401     | `invalid_issuer`          | id_token's `iss` is not `https://appleid.apple.com`                         | —                                              |
| 401     | `invalid_audience`        | id_token's `aud` is not `app.macroscape.MacroScape`                         | —                                              |
| 401     | `malformed`               | Token isn't a parseable JWT, or `sub` is missing                            | —                                              |
| 401     | `jwks_fetch_failed`       | Proxy couldn't fetch Apple's JWKS (transient)                               | —                                              |
| 401     | `invalid_refresh_token`   | Refresh token unknown, expired, or predates a chain revocation              | —                                              |
| 401     | `refresh_token_reused`    | Consumed refresh token replayed; **the user's whole chain is revoked**      | —                                              |
| 400     | `invalid_request`         | Malformed JSON body, or a required field is missing on a `/v1/auth/*` route | —                                              |
| 404     | `not_found`               | Unknown route                                                               | `path`                                         |
| 405     | `method_not_allowed`      | Wrong HTTP method (e.g., `GET /v1/anthropic/messages`)                      | —                                              |
| 429     | `daily_limit_exceeded`    | User hit their daily request limit on the proxy itself                      | `scope`, `group`, `limit`, `count`, `resetsAt` |
| 429     | `upstream_rate_limited`   | USDA returned 429 / `OVER_RATE_LIMIT` (over-quota)                          | `upstream` (type, message)                     |
| 503     | `upstream_not_configured` | Upstream key not populated in Secrets Manager, or USDA 403 `API_KEY_*`      | `upstream` (type, message) for the USDA case   |
| 4xx/5xx | `upstream_error`          | Upstream returned non-2xx (other than rate-limit); status forwarded         | `upstream` (type, message)                     |
| 500     | (none)                    | Unexpected internal error; Lambda default response (not this JSON shape)    | —                                              |

The recommended client mapping:

- **401 on a proxied route** → refresh the access token at `/v1/auth/refresh` and retry once; only
  fall back to Sign in with Apple if the refresh itself fails
- **401 `invalid_refresh_token` / `refresh_token_reused`** → the session is gone; discard the stored
  refresh token and prompt for Sign in with Apple
- **401** of any other kind → re-auth via Sign in with Apple and retry once
- **429 `daily_limit_exceeded`** → respect `Retry-After`; surface `resetsAt` in UI; this is the
  proxy throttling the user
- **429 `upstream_rate_limited`** → the upstream provider is throttling (genuine over-quota); back
  off and retry, surface as a distinct UI message from the proxy's own quota
- **503 `upstream_not_configured`** → brief backoff and retry; usually transient during proxy
  rollout, but a persistent 503 means the upstream API key is missing or invalid (operator action)
- **5xx other** → standard backoff with jitter
- **4xx other** → user-facing error, no retry

## Rate limiting

Rate-limited endpoints are `POST /v1/anthropic/messages`, `GET /v1/usda/foods/search`,
`GET /v1/anthropic/models`, and the three `/v1/auth/*` routes. `/health` is **not** rate-limited.

The proxy tracks **two counters per user per UTC day**:

- **Total counter** — incremented on every request that counts against the user's AI budget,
  regardless of endpoint. Enforced against `DEFAULT_DAILY_LIMIT` (currently `100/day`) unless the
  user's `dailyLimit` attribute overrides it.
- **Per-group counter** — incremented on every rate-limited request within a group. Group names
  match the URL convention's `<upstream-provider>` segment (`anthropic`, `usda`; future: `openai`,
  etc.), except for routes carved out of the total (see below). Always tracked for observability.
  **Enforced** when a `DEFAULT_DAILY_LIMIT_<GROUP>` env var or the user's `dailyLimit<Group>`
  attribute is set (e.g., `DEFAULT_DAILY_LIMIT_USDA=500`, `dailyLimitUsda=500`). Currently only the
  `models` group is enforced (`50/day`); for `anthropic` and `usda` the total is the binding limit.

**Routes off the total counter.** `GET /v1/anthropic/models` and the `/v1/auth/*` routes increment
only their own group counter (`models`, `auth`), not the total. Neither is an AI call, and charging
them would let an app launch or a background token refresh spend part of the user's daily budget.
Their group limits (`50/day` and `200/day`) are what bound them — a 429 from those routes carries
`"scope": "group"` with `"group": "models"` or `"group": "auth"`. The `auth` limit is generous
because one device refreshing hourly costs ~24/day; it exists to bound the surface, not to shape
normal use.

Counted regardless of upstream outcome — upstream errors, 5xx responses, etc. still consume quota.

When exceeded:

```
HTTP/2 429
Retry-After: <seconds until UTC midnight>
Content-Type: application/json

{
  "error": "daily_limit_exceeded",
  "scope": "total",          // or "group"
  "group": "usda",           // present iff scope == "group"; one of: anthropic, usda, ...
  "limit": 100,
  "count": 101,
  "resetsAt": "<ISO timestamp of next UTC midnight>"
}
```

The client gets both the header (per RFC 7231) and the body fields (for UI). Use whichever fits.

## Not yet implemented

These are tracked in `issues.md` and will land in future releases. Clients should be prepared for
them to change:

- **Streaming responses** (`stream: true` in Anthropic body) — proxy currently buffers the full
  response and may not handle Anthropic SSE chunked transfer correctly. If your client needs
  streaming, file an issue before depending on `/v1/anthropic/messages` for streaming calls.
- **Additional response headers** — Anthropic's `request-id` and rate-limit hints are dropped. Easy
  to add when requested.
- **Model retrieve** (`GET /v1/anthropic/models/{id}`) — not implemented. The list route
  (`GET /v1/anthropic/models`, shipped under MSP045) is enough for current clients; file an issue if
  live capability lookup for a single model is needed.
- **Access-token revocation before expiry** — logout consumes the refresh token but an
  already-issued access token stays valid until its `exp` (≤ 1 hour). Instant kill needs a `jti`
  denylist checked per request; not built, since it trades a database read on every proxied call for
  a one-hour window. File an issue if a use case needs it.
- **Apple `id_token` as a direct bearer credential** — still accepted on the proxied routes and
  `/health` for one release so pre-session clients keep working (see Authentication). Slated for
  removal once macroscape MS154 has shipped and been verified in the field.
