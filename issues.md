# macroscape-proxy backlog

This file is the single source of truth for macroscape-proxy's backlog and history.

Every item has a permanent ID (`MSP###`). Refer to items by ID. New items take the next free number (currently **MSP040** is next). IDs never change once assigned, even if items are reordered, edited, or completed. The `MSP` prefix predates the macroscape rebrand (MSP039) and is preserved so IDs remain stable.

## Contents

- [Active backlog](#active-backlog)
- [Future / longer-term](#future--longer-term)
- [Done](#done)

---

## Active backlog

### Infrastructure

- [ ] **MSP008** — Local dev workflow: esbuild watch, `sam local invoke` or equivalent for endpoint testing, dotenv-style local config that mirrors Secrets Manager keys without committing values.

- [ ] **MSP036** — Enable branch protection on `main`: require PR before merge, require CI to pass, disallow force-pushes and deletions. Public repo with an OIDC-trusted deploy role makes this load-bearing.

- [ ] **MSP037** — Don't populate the `macroscape-proxy/upstream-api-key` secret in production until handler-side auth (MSP010–MSP012) is in place. The `HttpApi` `/{proxy+}` route is currently unauthenticated and public; that's harmless while the handler just echoes JSON, but the moment the secret is populated and the handler reads it, the open endpoint becomes a wallet-drain vector against Anthropic.

### Auth

- [ ] **MSP009** — Apple Developer Sign-In configuration: services ID, key, team ID. Document the values needed in README and store the private key in Secrets Manager (MSP005).

### Forwarding

- [ ] **MSP015** — Streaming response support if MacroScape uses streaming on any call shape. If not, mark this complete with a note that streaming was not needed.

- [ ] **MSP016** — Sanitized upstream error pass-through. Forward Anthropic's status codes and a safe subset of error details, never the full upstream response (which may contain implementation details we don't want to leak).

### Rate limiting

### Observability and security

- [ ] **MSP019** — Structured CloudWatch logging with secret redaction. JSON log shape: `requestId`, `userId`, `route`, `latencyMs`, `upstreamStatus`. Anthropic API key and Apple private key never appear in logs (assert via lint rule or test).

- [ ] **MSP020** — Request ID propagation. Generate or accept an inbound request ID header, attach it to every log line and to the upstream Anthropic call.

- [ ] **MSP021** — IAM least-privilege audit on the Lambda execution role. Limit to specific DynamoDB table ARN, specific Secrets Manager secret ARNs, and CloudWatch Logs only.

### Testing

- [ ] **MSP022** — Unit tests for Apple ID token verification using fixture JWTs (valid, expired, wrong issuer, wrong audience, malformed).

- [ ] **MSP023** — Integration test for `/v1/messages` happy path with a mocked Anthropic upstream and a mocked Apple JWKS.

### Documentation

- [ ] **MSP024** — README covering architecture overview, local dev setup, AWS prerequisites, deploy steps, and how to rotate the Anthropic key.

- [ ] **MSP025** — Mermaid architecture diagram in README showing iOS app, API Gateway, Lambda, DynamoDB, Secrets Manager, and Anthropic upstream.

---

## Future / longer-term

- [ ] **MSP026** — Plan tiers (free vs paid) with differentiated rate limits. Stored on user record, enforced in MSP018 logic.

- [ ] **MSP027** — Detailed per-call audit log in a dedicated DynamoDB table beyond CloudWatch. Useful for billing reconciliation and abuse forensics.

- [ ] **MSP028** — CloudWatch billing alarms for cost protection. Trigger SNS notification at configured monthly spend thresholds.

- [ ] **MSP029** — AWS WAF rules in front of API Gateway for basic abuse protection (rate limit by IP, block obvious scanner patterns).

- [ ] **MSP030** — Multi-region deployment with latency-based routing. Likely overkill for current scale; revisit if launch demand warrants.

- [ ] **MSP031** — Admin endpoint for usage review (auth-protected, single-user for now).

- [ ] **MSP032** — Migrate AIRequestLog inspection from the iOS client to a proxy-side store. Trade: better central observability, larger blast radius if compromised. Decide based on launch posture.

---

## Done

(Most recent first; ID order is reverse-chronological.)

- [x] **MSP017 + MSP018** — Per-user daily rate limit on `/v1/messages` with 429 + `Retry-After`.

      New `src/rateLimit/dailyLimit.ts` exports `checkAndIncrement(userId)` and `RateLimitError`. Flow per `/v1/messages` request (after auth, before upstream): (1) `GetCommand` on `USER#<sub>/PROFILE` reading `dailyLimit` attribute, fall back to `DEFAULT_DAILY_LIMIT` env var (currently `100`); (2) atomic `UpdateCommand` on `USAGE#<sub>/DATE#YYYY-MM-DD` — `ADD #count :one SET #ttl = if_not_exists(#ttl, :ttl)` — returns the new count post-increment in one round trip, sets the 90-day TTL the first time the row is touched. If new count > limit, throw `RateLimitError`; handler maps to `429 { error: "daily_limit_exceeded", limit, count, resetsAt }` with header `Retry-After: <seconds until UTC midnight>`. Over-counting after rejection is intentional and benign — rejected requests still bump the counter, which doesn't change outcomes for that day.

      Extracted `src/db/client.ts` (shared DynamoDBDocumentClient singleton + `getTableName` helper) so `users.ts` and `dailyLimit.ts` share one client/pool instead of each instantiating their own.

      Per-user override: set the `dailyLimit` number attribute on the user's `USER#<sub>/PROFILE` row directly via DynamoDB console/CLI. No admin endpoint yet (MSP031, future). `/health` is intentionally NOT rate-limited — it's cheap, doesn't call upstream, and the iOS app may poll it to refresh user state.

- [x] **MSP013 + MSP014** — `/v1/messages` POST proxy to `https://api.anthropic.com/v1/messages` with header rewriting.

      Auth-gated POST route. New `src/upstream/anthropic.ts` fetches the Anthropic key from `macroscape-proxy/upstream-api-key` via `@aws-sdk/client-secrets-manager`, caches it module-scope (warm-start reuse; cache invalidates with container recycling — fine until secret rotation is routine). Header policy is a **strict allowlist** (`content-type`, `anthropic-version`, `anthropic-beta`, `accept`, `accept-encoding`) — anything else from the caller is dropped, and the caller's `Authorization` (Apple JWT) never leaves the proxy. Outbound headers add `x-api-key: <secret>` and force `content-type: application/json`. Body is passed through unchanged (with base64-decode if the caller flagged `isBase64Encoded`). Response forwards Anthropic's status + content-type + body; other upstream headers are dropped pending MSP016. Empty secret returns `503 upstream_not_configured` (until the secret is populated post-deploy). Non-POST methods return `405 method_not_allowed`. Auth lifted out of the handler into `src/auth/authenticate.ts` (`AuthError` with `statusCode` + `reason`) so both `/health` and `/v1/messages` share one path. Streaming and error sanitization are still deferred to MSP015 and MSP016.

      **Post-deploy:** populate `macroscape-proxy/upstream-api-key` with the Anthropic API key — until then, every `/v1/messages` call returns 503.

- [x] **MSP011** — Auto-create user record in DynamoDB on first authenticated request. Idempotent: subsequent requests look up rather than recreate.

      New `src/db/users.ts` exports `upsertUser(appleUserId): { created }`. Uses `DynamoDBDocumentClient` (lib-dynamodb) with `PutCommand` + `ConditionExpression: attribute_not_exists(pk)` to insert idempotently — the first write succeeds (`created: true`), subsequent writes hit the conditional check and return `created: false` without a second round trip to read the row. Item shape: `{ pk: 'USER#<sub>', sk: 'PROFILE', createdAt: <ISO timestamp> }` per the conventions in `src/db/keys.ts` (MSP004). Wired into `/health` so the response is now `{ ok: true, userId, created }`. Lambda already has `grantReadWriteData` on the table from MSP001/MSP004. Module-scope DynamoDB client survives warm starts.

- [x] **MSP012** — `/health` endpoint that authenticates the caller and returns the verified user identity. First end-to-end auth proof point.

      `src/handler.ts` now routes on `event.rawPath`: `/health` extracts the Bearer token from `Authorization`, calls `verifyAppleIdToken` (MSP010), returns `{ ok: true, userId: claims.sub }` on success or `401 { error: <reason> }` on `AppleTokenError` (one of `missing_bearer_token`, `expired`, `invalid_signature`, `invalid_issuer`, `invalid_audience`, `malformed`, `jwks_fetch_failed`). Unexpected errors propagate to Lambda 500. All other paths return 404. The previous placeholder echo (any path → 200 with `macroscape-proxy is alive`) is gone — `GET /` is now 404. Helpers (`extractBearerToken`, `jsonResponse`) live inline in `handler.ts`; extract into a module when MSP013 also needs them.

- [x] **MSP010** — Apple ID token verification: fetch and cache JWKS, validate signature, check `iss`, `aud`, and `exp` claims.

      New module `src/auth/appleVerifier.ts` exports `verifyAppleIdToken(token)` and a typed `AppleTokenError` (with discriminator `reason`: `expired` / `invalid_signature` / `invalid_issuer` / `invalid_audience` / `malformed` / `jwks_fetch_failed`) so the eventual route handler (MSP012) can map errors to 401 vs 500. Uses `jose` — module-scope `createRemoteJWKSet` singleton survives Lambda warm starts, so warm invocations reuse the cached JWKS (cold starts pay one HTTPS fetch from `appleid.apple.com/auth/keys`). Issuer is hardcoded (`https://appleid.apple.com`); audience is the iOS Bundle ID `app.macroscape.MacroScape`, passed as `APPLE_AUD` env var via `lib/macroscape-proxy-stack.ts` so a deploy-time misconfiguration fails fast. `sub` claim presence is asserted at runtime (Apple always populates it). Out of scope here: the route that *calls* the verifier (MSP012) and fixture-driven unit tests (MSP022).

- [x] **MSP038** — Pin GitHub Actions in `.github/workflows/*.yml` to commit SHAs rather than `@v4` major-version tags.

      All three actions pinned to their latest v4-series SHA (preserving the current major; major bumps stay deliberate): `actions/checkout` → `34e114876b0b11c390a56381ad16ebd13914f8d5` (v4.3.1), `actions/setup-node` → `49933ea5288caeca8642d1e84afbd3f7d6820020` (v4.4.0), `aws-actions/configure-aws-credentials` → `7474bc4690e29a8392af63c5b98e7449536d5c3a` (v4.3.1). New `.github/dependabot.yml` runs the `github-actions` ecosystem weekly to keep pins current; Dependabot will surface v5/v6 majors as reviewable PRs rather than silently consuming them.

- [x] **MSP034** — Add `concurrency: { group: deploy, cancel-in-progress: false }` to `.github/workflows/deploy.yml`.

      Two merges to `main` in quick succession now serialize through `cdk deploy` instead of racing for the CloudFormation stack lock. `cancel-in-progress: false` is deliberate — never abandon an in-flight deploy mid-rollout, since CFN can be left in `UPDATE_IN_PROGRESS` requiring manual recovery.

- [x] **MSP033** — Add `permissions: contents: read` to `.github/workflows/ci.yml`.

      Top-level `permissions` block makes the default `GITHUB_TOKEN` scope explicit and immune to org/repo setting drift. `deploy.yml` already had explicit permissions (`id-token: write` + `contents: read`); CI just needs read.

- [x] **MSP035** — Remove the `console.log('event', JSON.stringify(event))` line in `src/handler.ts` before MSP010 lands.

      Dropped the line. The placeholder handler now logs nothing per request. MSP019 will reintroduce structured, redaction-aware logging when there's an auth-verified user to attach `userId` to. Landing this before MSP010 means no JWT-leak window exists if MSP010 deploys ahead of MSP019.

- [x] **MSP039** — Full rebrand of the project to macroscape (the painful one).

      Code-side rebrand committed across five commits: stack and entry-point files now `bin/macroscape-proxy.ts` + `lib/macroscape-proxy-stack.ts` exporting `MacroScapeProxyStack`, with matching updates to `cdk.json` `app` entry and CI/deploy workflow stack names; IAM deploy role renamed to `MacroScapeProxyGithubDeployRole` with OIDC `githubRepo`, stack construct ID, and deploy workflow `role-to-assume` ARN all aligned; Secrets Manager prefix moved to `macroscape-proxy/*` (both secrets currently empty so reseed was trivial); prose updates to `package.json`, `README.md`, `CLAUDE.md`, this file; and a followup commit switching brand casing to `MacroScape` across display prose and PascalCase identifiers (`MacroScapeProxyStack`, `MacroScapeProxyGithubOidcStack`, `MacroScapeProxyGithubDeployRole`, `MacroScapeZone`). Lowercase slugs (file names, npm name, repo, secret prefixes, domain) intentionally stay all-lowercase.

      Manual rollout completed 2026-05-16: deployed the new OIDC stack, renamed the GitHub repo and re-pointed the remote, deployed `MacroScapeProxyStack` (which created the `macroscape.app` hosted zone — NS records delegated at Namecheap, ACM auto-validated within minutes), destroyed the pre-rebrand `MacrosightProxyStack` and its two orphaned empty DynamoDB tables, and renamed the local working directory.

- [x] **MSP006** — Custom domain via Route 53 hosted zone plus ACM certificate plus API Gateway custom domain mapping.

      Project rebranded to MacroScape; API serves at `api.macroscape.app`. `lib/macroscape-proxy-stack.ts` now provisions a `HostedZone` for `macroscape.app` (RETAIN on destroy), an ACM `Certificate` for `api.macroscape.app` DNS-validated against the zone, an APIGW v2 `DomainName` wired as `defaultDomainMapping` on `HttpApi`, and A + AAAA alias records pointing at `ApiGatewayv2DomainProperties`. Stack outputs the four `HostedZoneNameServers` so they can be copied to the registrar. First deploy hangs on cert validation until NS delegation propagates — minutes, not hours, in practice. At this stage the stack and repo names were intentionally left at their pre-rebrand identifiers — renaming would have orphaned the CFN stack and broken the OIDC role's trust-policy subject claim; that rename was subsequently handled in MSP039.

- [x] **MSP005** — AWS Secrets Manager entries for the Anthropic API key and the Apple Sign-In private key. No secret values in code or environment variables committed to git.

      `lib/macroscape-proxy-stack.ts`: `UpstreamApiKey` (`macroscape-proxy/upstream-api-key`) was already in place from `1daa0c4`; added `AppleSignInPrivateKey` (`macroscape-proxy/apple-signin-private-key`) for client_secret JWT signing against Apple's token endpoint. Both secrets are created empty — populate post-deploy via console/CLI. Lambda gets `grantRead` on both and the ARNs surface via `UPSTREAM_SECRET_ARN` / `APPLE_SIGNIN_SECRET_ARN` env vars. Apple ID-token verification (MSP010) uses JWKS, not this private key — the private key is for the auth-code-exchange / token-revocation paths.

- [x] **MSP002** — Lambda function definition on ARM Graviton2 architecture, sized at the smallest memory tier that handles the workload (start at 512 MB, tune later).

      `lib/macroscape-proxy-stack.ts`: added `architecture: lambda.Architecture.ARM_64` and bumped `memorySize` 256 → 512 per the item's stated starting point. Tune downward once the real handler (MSP013–MSP016) is in place and there's profile data to inform the choice.

- [x] **MSP004** — DynamoDB single-table design. PK conventions: `USER#{appleUserId}` for user records, `USAGE#{appleUserId}` with SK `DATE#{YYYY-MM-DD}` for usage records. TTL attribute on usage rows so old counters auto-expire.

      CDK table from `1daa0c4` (`TableV2` with generic `pk`/`sk`/`ttl`) plus the schema-conventions module `src/db/keys.ts`: `userKey`, `usageKey`, `usageTtl` (epoch seconds at end-of-UTC-day + 90-day default retention). End-of-day normalization means rows written at 00:01 and 23:59 of the same date expire together. UTC reset boundary so per-day limits behave consistently across user timezones. Nothing exercises the helpers yet — MSP011 / MSP017 will be the first consumers; fix forward if those reveal a problem.

- [x] **MSP007** — GitHub Actions workflow for CDK synth and deploy on push to `main`. OIDC-based AWS auth (no long-lived access keys in repo secrets).

      Done in `8410ec1` (`GithubOidcStack` provisions the OIDC provider + `MacroScapeProxyGithubDeployRole`, restricted to `repo:steveboyer/macroscape-proxy:ref:refs/heads/main`) and `cbe75c7` (`.github/workflows/ci.yml` runs lint/format/tsc/synth; `.github/workflows/deploy.yml` assumes the deploy role via `aws-actions/configure-aws-credentials@v4` and runs `cdk deploy MacroScapeProxyStack --require-approval never`). Hardening follow-ups split out as MSP033 / MSP034 / MSP036.

- [x] **MSP003** — API Gateway HTTP API with Lambda proxy integration. HTTP API rather than REST API; only the routes actually needed.

      Done in `1daa0c4`. `HttpApi` + `HttpLambdaIntegration` in `lib/macroscape-proxy-stack.ts`. Single catch-all `/{proxy+}` route on any method — fine while the handler is a placeholder; tighten to specific routes once MSP012 / MSP013 land.

- [x] **MSP001** — CDK app skeleton in TypeScript with esbuild bundling, Node.js 20 runtime target.

      Done in `cbcaae3` (scaffold) and `1daa0c4` (`NodejsFunction` with esbuild bundling). Runtime is `NODEJS_22_X` rather than 20 — moved forward to match the project's pinned `.nvmrc` / `engines.node`.
