# macroscape-proxy backlog

This file is the single source of truth for macroscape-proxy's backlog and history.

Every item has a permanent ID (`MSP###`). Refer to items by ID. New items take the next free number
(currently **MSP044** is next). IDs never change once assigned, even if items are reordered, edited,
or completed. The `MSP` prefix predates the macroscape rebrand (MSP039) and is preserved so IDs
remain stable.

## Contents

- [Active backlog](#active-backlog)
- [Future / longer-term](#future--longer-term)
- [Done](#done)

---

## Active backlog

### Infrastructure

- [ ] **MSP008** — Local dev workflow: esbuild watch, `sam local invoke` or equivalent for endpoint
      testing, dotenv-style local config that mirrors Secrets Manager keys without committing
      values.

### Auth

### Forwarding

- [ ] **MSP015** — Streaming response support if MacroScape uses streaming on any call shape. If
      not, mark this complete with a note that streaming was not needed.

### Observability and security

### Testing

### Documentation

---

## Future / longer-term

- [ ] **MSP026** — Plan tiers (free vs paid) with differentiated rate limits. Stored on user record,
      enforced in MSP018 logic.

- [ ] **MSP027** — Detailed per-call audit log in a dedicated DynamoDB table beyond CloudWatch.
      Useful for billing reconciliation and abuse forensics.

- [ ] **MSP028** — CloudWatch billing alarms for cost protection. Trigger SNS notification at
      configured monthly spend thresholds.

- [ ] **MSP029** — AWS WAF rules in front of API Gateway for basic abuse protection (rate limit by
      IP, block obvious scanner patterns).

- [ ] **MSP030** — Multi-region deployment with latency-based routing. Likely overkill for current
      scale; revisit if launch demand warrants.

- [ ] **MSP031** — Admin endpoint for usage review (auth-protected, single-user for now).

- [ ] **MSP032** — Migrate AIRequestLog inspection from the iOS client to a proxy-side store. Trade:
      better central observability, larger blast radius if compromised. Decide based on launch
      posture.

---

## Done

(Most recent first; ID order is reverse-chronological.)

- [x] **MSP036** — Enable branch protection on `main`.

      Pre-step: flipped the repo from private to public via `gh api -X PATCH repos/steveboyer/macroscape-proxy -F private=false` (branch protection on private repos requires GitHub Pro). Pre-flight scan confirmed no secrets in tracked files or git history (the only `-----BEGIN PRIVATE KEY-----` hits were doc references in `docs/apple-setup.md`; the only `sk-ant-...` was the deliberate fake fixture in `test/handler.integration.test.ts`). AWS account ID is visible in `deploy.yml` and `lib/` — not secret (appears in IAM trust policies by design).

      Branch protection applied via `gh api -X PUT repos/.../branches/main/protection` with: `required_status_checks` (strict, contexts: `["check"]` — the CI job; `deploy` excluded since it only runs on push to main and would deadlock PRs); `required_pull_request_reviews` (count `0` — PR required but no approving review needed while solo); `enforce_admins: true` (otherwise the admin can bypass and it's theater); `allow_force_pushes: false`; `allow_deletions: false`; `required_linear_history: true` (squash/rebase only). Bump `required_approving_review_count` to `1` if/when collaborators land.

      Direct push to `main` now fails. Workflow: feature branch → PR → CI must go green → squash-merge.

- [x] **MSP043** — Remove the transitional `/v1/messages` and `/v1/foods/search` legacy aliases.

      Routing in `src/handler.ts` now matches only the canonical `/v1/anthropic/messages` and `/v1/usda/foods/search`; the old flat paths return 404 like any unknown route. CONTRACT.md drops the alias notes from the URL conventions section, both endpoint headings (and their "legacy alias" paragraphs), and the rate-limit section. README's route table drops the two alias rows. CLAUDE.md gets three stale `/v1/messages`-only references corrected to mention both upstream routes (the project description, the architecture bullet, and the `src/handler.ts` layout note).

      Historical Done entries in this file (MSP013/14, MSP017/18, MSP040, MSP041) keep their original `/v1/messages` and `/v1/foods/search` text — those are accurate accounts of what the path was at the time of that work. Upstream URLs (`api.anthropic.com/v1/messages`, `api.nal.usda.gov/fdc/v1/foods/search`) and the integration test's upstream-URL assertion are unchanged — different URL.

      Per-MSP040/042 plan, iOS confirmed cutover ahead of the 90-day window. Callers still using the legacy paths now get `404 { error: "not_found", path: "..." }`.

- [x] **MSP023** — Integration test for `/v1/anthropic/messages` with mocked upstream + JWKS.

      `test/handler.integration.test.ts` drives `handler` directly with a synthesized `APIGatewayProxyEventV2` and mocks three layers: (1) global `fetch` URL-routed to return our test JWKS for `appleid.apple.com` and configurable Anthropic responses for `api.anthropic.com`; (2) `DynamoDBDocumentClient` via `aws-sdk-client-mock` (new dev dep) intercepting `GetCommand` / `PutCommand` / `UpdateCommand`; (3) `SecretsManagerClient` same library for the upstream API key. Apple JWTs are freshly signed per test with the `jose`-generated RSA keypair from MSP022's pattern (no real Apple traffic).

      Four cases: happy path (forwards to Anthropic, returns response byte-for-byte, asserts request shape — `x-api-key` injected, caller `Authorization` dropped, header allowlist enforced, `x-request-id` propagated, rate-limit counter incremented), expired token (401 `expired`, upstream never called), Anthropic 4xx (sanitized to `upstream_error` envelope with the internal trace ID stripped), rate-limit exceeded (429 `daily_limit_exceeded` with `Retry-After` header and `scope: total`, upstream never called).

      MSP019's deferred **secret-redaction assertion** now lives here as part of the happy path: a `console.log` spy captures every log line during the request and asserts the Anthropic API key value never appears in any of them. Verified-by-construction now becomes verified-by-test.

      `npm test` runs 13 cases (9 verifier + 4 integration) in ~270ms; already wired into CI via the step added in MSP022.

- [x] **MSP025** — Mermaid architecture diagram in README.

      Replaced the ASCII flow MSP024 left as a placeholder with a Mermaid `flowchart LR`: iOS on the left, AWS subgraph in the middle (APIGW → Lambda + DynamoDB + Secrets Manager), and the three external services on the right (Apple JWKS, Anthropic, USDA). Labeled edges call out the Bearer id_token, JWKS verification, `GetSecretValue`, and the two upstream auth mechanisms (`x-api-key` for Anthropic, `api_key=…` query param for USDA). GitHub renders Mermaid natively in markdown, so the diagram is visible in the browser without external tooling.

- [x] **MSP024** — README covering architecture overview, local dev setup, AWS prerequisites, deploy
      steps, and how to rotate an upstream API key.

      Replaced the 31-line stub with a sectioned README. Architecture section gives the iOS → APIGW → Lambda → upstreams flow (ASCII; the Mermaid version is MSP025) plus a stack summary of `MacroScapeProxyStack` + `MacroScapeProxyGithubOidcStack` and a route table covering `/health`, `/v1/anthropic/messages` (+ `/v1/messages` legacy alias), `/v1/usda/foods/search` (+ `/v1/foods/search` legacy alias). Local dev mirrors the commands in CLAUDE.md and notes there's no `sam local` workflow yet (MSP008). AWS prerequisites covers the three first-time setup steps: `cdk bootstrap`, one-time OIDC stack deploy, registrar NS delegation for `macroscape.app`. Deploy section documents both CI/CD (`.github/workflows/deploy.yml` via OIDC, serialized via `concurrency: deploy`) and manual `cdk diff` / `cdk deploy`, with a table of the three Secrets Manager entries to populate post-deploy. Rotation section explains the warm-container caching behavior and shows `aws secretsmanager put-secret-value` plus the env-var-bump trick to force immediate rollout (vs waiting for warm containers to recycle). Pointers to `CONTRACT.md` (HTTP contract), `issues.md` (backlog), and `docs/` (operator setup) up top.

      Corrected stale facts from the old README: Node runtime is 22 (not 20), status is no longer "pre-implementation", upstreams include USDA not just Anthropic, Secrets Manager has three entries not two.

- [x] **MSP009** — Apple Developer Sign-In configuration: Services ID, Key, Team ID; document and
      populate the private-key secret.

      Documentation-only task (no code change). New `docs/apple-setup.md` covers what to register at developer.apple.com — App ID with Sign in with Apple capability (currently required, for the iOS native flow the proxy already supports), and the Services ID + Key (`.p8`) + Team ID (currently deferred, for future server-side flows like revocation/refresh/web-flow). Includes the `aws secretsmanager put-secret-value` command for populating `macroscape-proxy/apple-signin-private-key` with the `.p8` contents.

      No env-var plumbing for the three IDs yet (YAGNI — `APPLE_TEAM_ID`, `APPLE_SERVICES_ID`, `APPLE_KEY_ID` will be added to `lib/macroscape-proxy-stack.ts` when the first code path that consumes them lands). `APPLE_AUD` already documents the iOS Bundle ID coupling. CLAUDE.md updated to point future sessions at `docs/`.

      Operational follow-up (manual, when ready): user registers the Services ID + Key + Team ID and `put-secret-value`s the `.p8` contents. Lambda already has IAM read on the secret from MSP005 + MSP021.

- [x] **MSP042** — Adopt `/v1/<upstream-provider>/<endpoint>` URL convention for all
      upstream-forwarding routes.

      Decision: every route that forwards to a third-party upstream lives at `/v1/<upstream>/<endpoint>`. Provider visible in the URL gives free debugging/observability, makes per-upstream rate-limit counters and cost attribution real, and gives future upstreams (`/v1/openai/...`, `/v1/openfoodfacts/...`) a clean slot. Routes that don't forward upstream (currently only `/health`) skip the prefix.

      Concrete changes: added `/v1/usda/foods/search` as the canonical USDA search route (handler unchanged; `/v1/foods/search` now a legacy alias on the same deprecation cadence as `/v1/messages`). Renamed the rate-limit group from `foods` to `usda` so the group identifier matches the URL convention end-to-end (DynamoDB key prefix `USAGE-usda#<sub>`, env var `DEFAULT_DAILY_LIMIT_USDA`, per-user override attribute `dailyLimitUsda`). No data migration needed — no production users yet.

      CONTRACT.md now has a `## URL conventions` section near the top documenting the pattern + rationale to prevent future relitigation. Endpoint section heading and rate-limit examples updated.

- [x] **MSP041** — Proxy USDA FoodData Central `/foods/search` via `GET /v1/foods/search`.

      Same Sign in with Apple auth as the Anthropic path. New Secrets Manager entry `macroscape-proxy/usda-api-key` (created empty; populate post-deploy). `USDA_SECRET_ARN` env var added. New `src/upstream/usda.ts` exports `proxyFoodsSearch(queryParams, requestId)`: strict allowlist of caller query params (`query`, `dataType`, `pageSize`); caller-provided `api_key` is dropped defensively; proxy injects its own. Response forwarded byte-for-byte on 2xx (USDA's `foods[].fdcId` / `description` / `dataType` / `foodNutrients[]` shape unchanged for the iOS decoder). USDA 429 (over-quota) and 403 (DEMO_KEY exhausted) both map to `429 { error: "upstream_rate_limited", upstream: { type, message } }` — distinct from the proxy's `daily_limit_exceeded`, so iOS preserves its `SearchError.rateLimited` UI distinction. Other USDA non-2xx pass through as `upstream_error` with sanitized envelope (USDA's `{ error: { code, message } }` and `{ error: "STRING" }` shapes both handled). Per-user daily rate limit applies (group `foods`).

      `UpstreamError` extracted to `src/upstream/errors.ts` and re-exported from `anthropic.ts` for backward compat; `usda.ts` imports it from the new location.

      **Post-deploy:** populate `macroscape-proxy/usda-api-key` with a real USDA FoodData Central API key (register at api.data.gov). Default quota is 1000 req/hour shared across all proxy users — proxy's per-user daily limit (100/day default total) keeps any single user from monopolizing it.

- [x] **MSP040** — Rename `/v1/messages` → `/v1/anthropic/messages` with transitional alias;
      per-endpoint rate-limit counters.

      Routing: `/v1/messages` and `/v1/anthropic/messages` both dispatch to the same handler, so iOS can flip the URL constant on its own timeline. Both report `group: "anthropic"` to the rate limiter. CONTRACT.md marks `/v1/messages` legacy with a target removal window (no earlier than 90 days after iOS confirms cutover).

      Rate-limit refactor in `src/rateLimit/dailyLimit.ts`: now tracks **two counters** per request — a per-user **total** (existing `USAGE#<sub>/DATE#YYYY-MM-DD`) and a per-user **per-endpoint-group** counter (`USAGE-<group>#<sub>/DATE#YYYY-MM-DD`). Group is set explicitly per handler (`anthropic`, `foods`; future: `openai`). Total is always enforced against `DEFAULT_DAILY_LIMIT`. Per-group is **always tracked** (observability) and enforced only when `DEFAULT_DAILY_LIMIT_<GROUP>` env var or user's `dailyLimit<Group>` attribute is set — no per-group enforcement currently configured. `RateLimitError` carries `scope` (`"total"` | `"group"`) and `group` (string | null); 429 body adds those fields so iOS can distinguish "you've hit your total quota" from "you've hit your foods quota" without changing the existing fields.

      Existing `USAGE#<sub>` data preserved unchanged (the rename only adds the parallel `USAGE-<group>#<sub>` rows). No migration needed.

- [x] **MSP037** — Don't populate `macroscape-proxy/upstream-api-key` until handler-side auth is in
      place.

      Satisfied: auth gate (MSP010 + MSP012, Apple JWT verification on every `/v1/messages` call) plus per-user daily rate limit (MSP017 + MSP018) together close the wallet-drain vector this item was guarding against. Pre-auth, an unauthenticated caller couldn't drain the secret because the secret was empty; post-auth, only users with a valid Apple Sign-In id_token can reach the proxy, and each is capped at the per-user daily limit (default 100/day, override per user). The remaining residual risk — rogue authenticated user burning their own quota — is bounded by the limit and visible via the per-`userId` CloudWatch logs from MSP019. Secret population is now safe to do (and required for `/v1/messages` to function).

- [x] **MSP021** — IAM least-privilege audit on the Lambda execution role.

      Before: `table.grantReadWriteData(handler)` granted 12 DynamoDB actions (BatchGetItem, BatchWriteItem, ConditionCheckItem, DeleteItem, DescribeTable, GetItem, GetRecords, GetShardIterator, PutItem, Query, Scan, UpdateItem); `secret.grantRead(handler)` granted GetSecretValue + DescribeSecret. After: `table.grant(handler, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem')` (exactly the three actions `src/db` + `src/rateLimit` issue) and an explicit `iam.PolicyStatement` granting only `secretsmanager:GetSecretValue` on the two secret ARNs. Resource scoping was already tight pre-audit (specific table ARN, specific secret ARNs, no wildcards). CloudWatch Logs grants are already minimal via the explicit `LogGroup` pattern (`logs:CreateLogStream` + `logs:PutLogEvents` on the LogGroup ARN). Verified by `cdk synth` diff of `ProxyHandlerServiceRoleDefaultPolicy`.

- [x] **MSP022** — Unit tests for Apple ID token verification using fixture JWTs.

      First test framework in the repo: `vitest` (single dev-dep, native TS, fast, Jest-compatible API). `npm test` / `npm run test:watch`; `npm test` added as a step to `.github/workflows/ci.yml` (between `tsc --noEmit` and `cdk synth`). `vitest.config.ts` scopes runs to `test/**/*.test.ts`.

      To avoid mocking `jose` or adding test-only branches in production code, refactored `verifyAppleIdToken(token)` → `verifyAppleIdToken(token, jwks?)` with a default of the existing `createRemoteJWKSet(APPLE_JWKS_URL)`. Tests pass their own `createLocalJWKSet` over a freshly-generated RSA keypair, so the production code path is exercised end-to-end (jose's `jwtVerify`, the error-mapping branch, the env-var check) — only the network call is swapped.

      `test/appleVerifier.test.ts` covers nine cases: valid (returns `sub`/`iss`/`aud`), expired, wrong `iss`, wrong `aud`, untrusted signing key (kid in JWKS, signature fails → `invalid_signature`), unknown kid (kid not in JWKS → `jwks_fetch_failed`), non-JWT string (`malformed`), missing `sub` (`malformed`), missing `APPLE_AUD` env var (plain `Error`, not `AppleTokenError`).

      MSP019's deferred secret-redaction assertion still pending — would land here naturally as a tenth test that drives a real request and greps the log output for the secret pattern, but requires a more invasive logger mock; deferred to MSP023 (integration test).

- [x] **MSP019 + MSP020** — Structured CloudWatch logging + request ID propagation.

      New `src/logging/logger.ts` exports `createRequestLogger(event)` which captures request-scoped context (`requestId`, `lambdaRequestId`, `route`, `method`) at construction time, exposes setters for `userId` / `upstreamStatus` / `error`, and emits a single JSON log line per request via `console.log` (CloudWatch captures stdout). The top-level `handler` wraps `dispatch` so the final log line — including `statusCode` + `latencyMs` — fires for every request, even unhandled exceptions (logged with `error: "unhandled"` then rethrown so Lambda returns 500). Route handlers set `userId` after `authenticate`, `upstreamStatus` after `proxyMessages`; `errorResponse` sets `error` for `AuthError` / `RateLimitError` / `UpstreamError` so the reason lands in the log.

      Request ID: caller's `x-request-id` is accepted (validated against `^[A-Za-z0-9_-]{1,200}$` to prevent log-line injection) or a UUID is generated. The same ID is attached as `x-request-id` on the outbound Anthropic call, so iOS → proxy → Anthropic correlation works end-to-end. CONTRACT.md updated to document the propagation. Secret redaction is verified-by-construction: nothing logs request/response bodies, the Anthropic `x-api-key` only appears in outbound headers (never logged), the Apple JWT only appears in inbound headers (never logged), and the Apple `.p8` private key isn't loaded at all (auth path is JWKS-only). A runtime assert or lint rule was deferred until tests exist (MSP022).

- [x] **MSP016** — Sanitized upstream error pass-through.

      Non-2xx responses from Anthropic are now wrapped in a known envelope so upstream implementation details (request IDs, internal codes, stack traces) can't leak through. `src/upstream/anthropic.ts` branches on `response.status`: 2xx falls through unchanged (existing behavior preserved); non-2xx parses the body as JSON, extracts `error.type` + `error.message` from Anthropic's standard error shape, and returns `{ error: "upstream_error", upstream: { type, message } }` with the original status code preserved. Anything unparseable or shape-mismatched falls back to `type: "unknown"` + a generic message. CONTRACT.md updated with the new envelope and a row in the error table. No new dependencies.

- [x] **MSP017 + MSP018** — Per-user daily rate limit on `/v1/messages` with 429 + `Retry-After`.

      New `src/rateLimit/dailyLimit.ts` exports `checkAndIncrement(userId)` and `RateLimitError`. Flow per `/v1/messages` request (after auth, before upstream): (1) `GetCommand` on `USER#<sub>/PROFILE` reading `dailyLimit` attribute, fall back to `DEFAULT_DAILY_LIMIT` env var (currently `100`); (2) atomic `UpdateCommand` on `USAGE#<sub>/DATE#YYYY-MM-DD` — `ADD #count :one SET #ttl = if_not_exists(#ttl, :ttl)` — returns the new count post-increment in one round trip, sets the 90-day TTL the first time the row is touched. If new count > limit, throw `RateLimitError`; handler maps to `429 { error: "daily_limit_exceeded", limit, count, resetsAt }` with header `Retry-After: <seconds until UTC midnight>`. Over-counting after rejection is intentional and benign — rejected requests still bump the counter, which doesn't change outcomes for that day.

      Extracted `src/db/client.ts` (shared DynamoDBDocumentClient singleton + `getTableName` helper) so `users.ts` and `dailyLimit.ts` share one client/pool instead of each instantiating their own.

      Per-user override: set the `dailyLimit` number attribute on the user's `USER#<sub>/PROFILE` row directly via DynamoDB console/CLI. No admin endpoint yet (MSP031, future). `/health` is intentionally NOT rate-limited — it's cheap, doesn't call upstream, and the iOS app may poll it to refresh user state.

- [x] **MSP013 + MSP014** — `/v1/messages` POST proxy to `https://api.anthropic.com/v1/messages`
      with header rewriting.

      Auth-gated POST route. New `src/upstream/anthropic.ts` fetches the Anthropic key from `macroscape-proxy/upstream-api-key` via `@aws-sdk/client-secrets-manager`, caches it module-scope (warm-start reuse; cache invalidates with container recycling — fine until secret rotation is routine). Header policy is a **strict allowlist** (`content-type`, `anthropic-version`, `anthropic-beta`, `accept`, `accept-encoding`) — anything else from the caller is dropped, and the caller's `Authorization` (Apple JWT) never leaves the proxy. Outbound headers add `x-api-key: <secret>` and force `content-type: application/json`. Body is passed through unchanged (with base64-decode if the caller flagged `isBase64Encoded`). Response forwards Anthropic's status + content-type + body; other upstream headers are dropped pending MSP016. Empty secret returns `503 upstream_not_configured` (until the secret is populated post-deploy). Non-POST methods return `405 method_not_allowed`. Auth lifted out of the handler into `src/auth/authenticate.ts` (`AuthError` with `statusCode` + `reason`) so both `/health` and `/v1/messages` share one path. Streaming and error sanitization are still deferred to MSP015 and MSP016.

      **Post-deploy:** populate `macroscape-proxy/upstream-api-key` with the Anthropic API key — until then, every `/v1/messages` call returns 503.

- [x] **MSP011** — Auto-create user record in DynamoDB on first authenticated request. Idempotent:
      subsequent requests look up rather than recreate.

      New `src/db/users.ts` exports `upsertUser(appleUserId): { created }`. Uses `DynamoDBDocumentClient` (lib-dynamodb) with `PutCommand` + `ConditionExpression: attribute_not_exists(pk)` to insert idempotently — the first write succeeds (`created: true`), subsequent writes hit the conditional check and return `created: false` without a second round trip to read the row. Item shape: `{ pk: 'USER#<sub>', sk: 'PROFILE', createdAt: <ISO timestamp> }` per the conventions in `src/db/keys.ts` (MSP004). Wired into `/health` so the response is now `{ ok: true, userId, created }`. Lambda already has `grantReadWriteData` on the table from MSP001/MSP004. Module-scope DynamoDB client survives warm starts.

- [x] **MSP012** — `/health` endpoint that authenticates the caller and returns the verified user
      identity. First end-to-end auth proof point.

      `src/handler.ts` now routes on `event.rawPath`: `/health` extracts the Bearer token from `Authorization`, calls `verifyAppleIdToken` (MSP010), returns `{ ok: true, userId: claims.sub }` on success or `401 { error: <reason> }` on `AppleTokenError` (one of `missing_bearer_token`, `expired`, `invalid_signature`, `invalid_issuer`, `invalid_audience`, `malformed`, `jwks_fetch_failed`). Unexpected errors propagate to Lambda 500. All other paths return 404. The previous placeholder echo (any path → 200 with `macroscape-proxy is alive`) is gone — `GET /` is now 404. Helpers (`extractBearerToken`, `jsonResponse`) live inline in `handler.ts`; extract into a module when MSP013 also needs them.

- [x] **MSP010** — Apple ID token verification: fetch and cache JWKS, validate signature, check
      `iss`, `aud`, and `exp` claims.

      New module `src/auth/appleVerifier.ts` exports `verifyAppleIdToken(token)` and a typed `AppleTokenError` (with discriminator `reason`: `expired` / `invalid_signature` / `invalid_issuer` / `invalid_audience` / `malformed` / `jwks_fetch_failed`) so the eventual route handler (MSP012) can map errors to 401 vs 500. Uses `jose` — module-scope `createRemoteJWKSet` singleton survives Lambda warm starts, so warm invocations reuse the cached JWKS (cold starts pay one HTTPS fetch from `appleid.apple.com/auth/keys`). Issuer is hardcoded (`https://appleid.apple.com`); audience is the iOS Bundle ID `app.macroscape.MacroScape`, passed as `APPLE_AUD` env var via `lib/macroscape-proxy-stack.ts` so a deploy-time misconfiguration fails fast. `sub` claim presence is asserted at runtime (Apple always populates it). Out of scope here: the route that *calls* the verifier (MSP012) and fixture-driven unit tests (MSP022).

- [x] **MSP038** — Pin GitHub Actions in `.github/workflows/*.yml` to commit SHAs rather than `@v4`
      major-version tags.

      All three actions pinned to their latest v4-series SHA (preserving the current major; major bumps stay deliberate): `actions/checkout` → `34e114876b0b11c390a56381ad16ebd13914f8d5` (v4.3.1), `actions/setup-node` → `49933ea5288caeca8642d1e84afbd3f7d6820020` (v4.4.0), `aws-actions/configure-aws-credentials` → `7474bc4690e29a8392af63c5b98e7449536d5c3a` (v4.3.1). New `.github/dependabot.yml` runs the `github-actions` ecosystem weekly to keep pins current; Dependabot will surface v5/v6 majors as reviewable PRs rather than silently consuming them.

- [x] **MSP034** — Add `concurrency: { group: deploy, cancel-in-progress: false }` to
      `.github/workflows/deploy.yml`.

      Two merges to `main` in quick succession now serialize through `cdk deploy` instead of racing for the CloudFormation stack lock. `cancel-in-progress: false` is deliberate — never abandon an in-flight deploy mid-rollout, since CFN can be left in `UPDATE_IN_PROGRESS` requiring manual recovery.

- [x] **MSP033** — Add `permissions: contents: read` to `.github/workflows/ci.yml`.

      Top-level `permissions` block makes the default `GITHUB_TOKEN` scope explicit and immune to org/repo setting drift. `deploy.yml` already had explicit permissions (`id-token: write` + `contents: read`); CI just needs read.

- [x] **MSP035** — Remove the `console.log('event', JSON.stringify(event))` line in `src/handler.ts`
      before MSP010 lands.

      Dropped the line. The placeholder handler now logs nothing per request. MSP019 will reintroduce structured, redaction-aware logging when there's an auth-verified user to attach `userId` to. Landing this before MSP010 means no JWT-leak window exists if MSP010 deploys ahead of MSP019.

- [x] **MSP039** — Full rebrand of the project to macroscape (the painful one).

      Code-side rebrand committed across five commits: stack and entry-point files now `bin/macroscape-proxy.ts` + `lib/macroscape-proxy-stack.ts` exporting `MacroScapeProxyStack`, with matching updates to `cdk.json` `app` entry and CI/deploy workflow stack names; IAM deploy role renamed to `MacroScapeProxyGithubDeployRole` with OIDC `githubRepo`, stack construct ID, and deploy workflow `role-to-assume` ARN all aligned; Secrets Manager prefix moved to `macroscape-proxy/*` (both secrets currently empty so reseed was trivial); prose updates to `package.json`, `README.md`, `CLAUDE.md`, this file; and a followup commit switching brand casing to `MacroScape` across display prose and PascalCase identifiers (`MacroScapeProxyStack`, `MacroScapeProxyGithubOidcStack`, `MacroScapeProxyGithubDeployRole`, `MacroScapeZone`). Lowercase slugs (file names, npm name, repo, secret prefixes, domain) intentionally stay all-lowercase.

      Manual rollout completed 2026-05-16: deployed the new OIDC stack, renamed the GitHub repo and re-pointed the remote, deployed `MacroScapeProxyStack` (which created the `macroscape.app` hosted zone — NS records delegated at Namecheap, ACM auto-validated within minutes), destroyed the pre-rebrand `MacrosightProxyStack` and its two orphaned empty DynamoDB tables, and renamed the local working directory.

- [x] **MSP006** — Custom domain via Route 53 hosted zone plus ACM certificate plus API Gateway
      custom domain mapping.

      Project rebranded to MacroScape; API serves at `api.macroscape.app`. `lib/macroscape-proxy-stack.ts` now provisions a `HostedZone` for `macroscape.app` (RETAIN on destroy), an ACM `Certificate` for `api.macroscape.app` DNS-validated against the zone, an APIGW v2 `DomainName` wired as `defaultDomainMapping` on `HttpApi`, and A + AAAA alias records pointing at `ApiGatewayv2DomainProperties`. Stack outputs the four `HostedZoneNameServers` so they can be copied to the registrar. First deploy hangs on cert validation until NS delegation propagates — minutes, not hours, in practice. At this stage the stack and repo names were intentionally left at their pre-rebrand identifiers — renaming would have orphaned the CFN stack and broken the OIDC role's trust-policy subject claim; that rename was subsequently handled in MSP039.

- [x] **MSP005** — AWS Secrets Manager entries for the Anthropic API key and the Apple Sign-In
      private key. No secret values in code or environment variables committed to git.

      `lib/macroscape-proxy-stack.ts`: `UpstreamApiKey` (`macroscape-proxy/upstream-api-key`) was already in place from `1daa0c4`; added `AppleSignInPrivateKey` (`macroscape-proxy/apple-signin-private-key`) for client_secret JWT signing against Apple's token endpoint. Both secrets are created empty — populate post-deploy via console/CLI. Lambda gets `grantRead` on both and the ARNs surface via `UPSTREAM_SECRET_ARN` / `APPLE_SIGNIN_SECRET_ARN` env vars. Apple ID-token verification (MSP010) uses JWKS, not this private key — the private key is for the auth-code-exchange / token-revocation paths.

- [x] **MSP002** — Lambda function definition on ARM Graviton2 architecture, sized at the smallest
      memory tier that handles the workload (start at 512 MB, tune later).

      `lib/macroscape-proxy-stack.ts`: added `architecture: lambda.Architecture.ARM_64` and bumped `memorySize` 256 → 512 per the item's stated starting point. Tune downward once the real handler (MSP013–MSP016) is in place and there's profile data to inform the choice.

- [x] **MSP004** — DynamoDB single-table design. PK conventions: `USER#{appleUserId}` for user
      records, `USAGE#{appleUserId}` with SK `DATE#{YYYY-MM-DD}` for usage records. TTL attribute on
      usage rows so old counters auto-expire.

      CDK table from `1daa0c4` (`TableV2` with generic `pk`/`sk`/`ttl`) plus the schema-conventions module `src/db/keys.ts`: `userKey`, `usageKey`, `usageTtl` (epoch seconds at end-of-UTC-day + 90-day default retention). End-of-day normalization means rows written at 00:01 and 23:59 of the same date expire together. UTC reset boundary so per-day limits behave consistently across user timezones. Nothing exercises the helpers yet — MSP011 / MSP017 will be the first consumers; fix forward if those reveal a problem.

- [x] **MSP007** — GitHub Actions workflow for CDK synth and deploy on push to `main`. OIDC-based
      AWS auth (no long-lived access keys in repo secrets).

      Done in `8410ec1` (`GithubOidcStack` provisions the OIDC provider + `MacroScapeProxyGithubDeployRole`, restricted to `repo:steveboyer/macroscape-proxy:ref:refs/heads/main`) and `cbe75c7` (`.github/workflows/ci.yml` runs lint/format/tsc/synth; `.github/workflows/deploy.yml` assumes the deploy role via `aws-actions/configure-aws-credentials@v4` and runs `cdk deploy MacroScapeProxyStack --require-approval never`). Hardening follow-ups split out as MSP033 / MSP034 / MSP036.

- [x] **MSP003** — API Gateway HTTP API with Lambda proxy integration. HTTP API rather than REST
      API; only the routes actually needed.

      Done in `1daa0c4`. `HttpApi` + `HttpLambdaIntegration` in `lib/macroscape-proxy-stack.ts`. Single catch-all `/{proxy+}` route on any method — fine while the handler is a placeholder; tighten to specific routes once MSP012 / MSP013 land.

- [x] **MSP001** — CDK app skeleton in TypeScript with esbuild bundling, Node.js 20 runtime target.

      Done in `cbcaae3` (scaffold) and `1daa0c4` (`NodejsFunction` with esbuild bundling). Runtime is `NODEJS_22_X` rather than 20 — moved forward to match the project's pinned `.nvmrc` / `engines.node`.
