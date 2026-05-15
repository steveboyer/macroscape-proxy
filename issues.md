# macrosight-proxy backlog

This file is the single source of truth for macrosight-proxy's backlog and history.

Every item has a permanent ID (`MSP###`). Refer to items by ID. New items take the next free number (currently **MSP039** is next). IDs never change once assigned, even if items are reordered, edited, or completed.

## Contents

- [Active backlog](#active-backlog)
- [Future / longer-term](#future--longer-term)
- [Done](#done)

---

## Active backlog

### Infrastructure

- [ ] **MSP008** — Local dev workflow: esbuild watch, `sam local invoke` or equivalent for endpoint testing, dotenv-style local config that mirrors Secrets Manager keys without committing values.

- [ ] **MSP033** — Add `permissions: contents: read` to `.github/workflows/ci.yml` so the default `GITHUB_TOKEN` scope is explicit and immune to org/repo setting drift.

- [ ] **MSP034** — Add `concurrency: { group: deploy, cancel-in-progress: false }` to `.github/workflows/deploy.yml` so two merges to `main` in quick succession serialize through `cdk deploy` instead of racing.

- [ ] **MSP036** — Enable branch protection on `main`: require PR before merge, require CI to pass, disallow force-pushes and deletions. Public repo with an OIDC-trusted deploy role makes this load-bearing.

- [ ] **MSP037** — Don't populate the `macrosight-proxy/upstream-api-key` secret in production until handler-side auth (MSP010–MSP012) is in place. The `HttpApi` `/{proxy+}` route is currently unauthenticated and public; that's harmless while the handler just echoes JSON, but the moment the secret is populated and the handler reads it, the open endpoint becomes a wallet-drain vector against Anthropic.

- [ ] **MSP038** — Pin GitHub Actions in `.github/workflows/*.yml` to commit SHAs rather than `@v4` major-version tags. Particularly load-bearing for `deploy.yml`, which has IAM deploy permissions via OIDC. Configure Dependabot (or similar) to keep the pinned SHAs current.

### Auth

- [ ] **MSP009** — Apple Developer Sign-In configuration: services ID, key, team ID. Document the values needed in README and store the private key in Secrets Manager (MSP005).

- [ ] **MSP010** — Apple ID token verification: fetch and cache JWKS, validate signature, check `iss`, `aud`, and `exp` claims. Reject tokens that fail any check with 401.

- [ ] **MSP011** — Auto-create user record in DynamoDB on first authenticated request. Idempotent: subsequent requests look up rather than recreate.

- [ ] **MSP012** — `/health` endpoint that authenticates the caller and returns the verified user identity. First end-to-end auth proof point.

### Forwarding

- [ ] **MSP013** — `/v1/messages` POST handler that proxies to `https://api.anthropic.com/v1/messages`. Body passed through unchanged.

- [ ] **MSP014** — Header rewriting: strip the caller's Authorization header, attach the Anthropic API key from Secrets Manager, preserve content-type and other Anthropic-required headers (e.g., `anthropic-version`, `anthropic-beta` for prompt caching).

- [ ] **MSP015** — Streaming response support if MacroSight uses streaming on any call shape. If not, mark this complete with a note that streaming was not needed.

- [ ] **MSP016** — Sanitized upstream error pass-through. Forward Anthropic's status codes and a safe subset of error details, never the full upstream response (which may contain implementation details we don't want to leak).

### Rate limiting

- [ ] **MSP017** — Daily request counter in DynamoDB keyed by user and date. Atomic increment via `UpdateItem` with `ADD`.

- [ ] **MSP018** — Configurable per-user daily limit. Return 429 with `Retry-After` header when exceeded. Default limit set in CDK config, overridable per user via DynamoDB attribute.

### Observability and security

- [ ] **MSP019** — Structured CloudWatch logging with secret redaction. JSON log shape: `requestId`, `userId`, `route`, `latencyMs`, `upstreamStatus`. Anthropic API key and Apple private key never appear in logs (assert via lint rule or test).

- [ ] **MSP020** — Request ID propagation. Generate or accept an inbound request ID header, attach it to every log line and to the upstream Anthropic call.

- [ ] **MSP021** — IAM least-privilege audit on the Lambda execution role. Limit to specific DynamoDB table ARN, specific Secrets Manager secret ARNs, and CloudWatch Logs only.

- [ ] **MSP035** — Remove the `console.log('event', JSON.stringify(event))` line in `src/handler.ts` before MSP010 lands. Once auth is in place, that line would log inbound `Authorization` JWTs to CloudWatch. Land alongside or before the structured logging work in MSP019.

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

- [x] **MSP006** — Custom domain via Route 53 hosted zone plus ACM certificate plus API Gateway custom domain mapping.

      Project rebranded MacroSight → Macroscape; API serves at `api.macroscape.app`. `lib/macrosight-proxy-stack.ts` now provisions a `HostedZone` for `macroscape.app` (RETAIN on destroy), an ACM `Certificate` for `api.macroscape.app` DNS-validated against the zone, an APIGW v2 `DomainName` wired as `defaultDomainMapping` on `HttpApi`, and A + AAAA alias records pointing at `ApiGatewayv2DomainProperties`. Stack outputs the four `HostedZoneNameServers` so they can be copied to the registrar. First deploy hangs on cert validation until NS delegation propagates — minutes, not hours, in practice. Stack and repo names (`MacrosightProxyStack`, `macrosight-proxy`) intentionally unchanged — renaming would orphan the CFN stack and break the OIDC role's trust-policy subject claim; track separately if desired.

- [x] **MSP005** — AWS Secrets Manager entries for the Anthropic API key and the Apple Sign-In private key. No secret values in code or environment variables committed to git.

      `lib/macrosight-proxy-stack.ts`: `UpstreamApiKey` (`macrosight-proxy/upstream-api-key`) was already in place from `1daa0c4`; added `AppleSignInPrivateKey` (`macrosight-proxy/apple-signin-private-key`) for client_secret JWT signing against Apple's token endpoint. Both secrets are created empty — populate post-deploy via console/CLI. Lambda gets `grantRead` on both and the ARNs surface via `UPSTREAM_SECRET_ARN` / `APPLE_SIGNIN_SECRET_ARN` env vars. Apple ID-token verification (MSP010) uses JWKS, not this private key — the private key is for the auth-code-exchange / token-revocation paths.

- [x] **MSP002** — Lambda function definition on ARM Graviton2 architecture, sized at the smallest memory tier that handles the workload (start at 512 MB, tune later).

      `lib/macrosight-proxy-stack.ts`: added `architecture: lambda.Architecture.ARM_64` and bumped `memorySize` 256 → 512 per the item's stated starting point. Tune downward once the real handler (MSP013–MSP016) is in place and there's profile data to inform the choice.

- [x] **MSP004** — DynamoDB single-table design. PK conventions: `USER#{appleUserId}` for user records, `USAGE#{appleUserId}` with SK `DATE#{YYYY-MM-DD}` for usage records. TTL attribute on usage rows so old counters auto-expire.

      CDK table from `1daa0c4` (`TableV2` with generic `pk`/`sk`/`ttl`) plus the schema-conventions module `src/db/keys.ts`: `userKey`, `usageKey`, `usageTtl` (epoch seconds at end-of-UTC-day + 90-day default retention). End-of-day normalization means rows written at 00:01 and 23:59 of the same date expire together. UTC reset boundary so per-day limits behave consistently across user timezones. Nothing exercises the helpers yet — MSP011 / MSP017 will be the first consumers; fix forward if those reveal a problem.

- [x] **MSP007** — GitHub Actions workflow for CDK synth and deploy on push to `main`. OIDC-based AWS auth (no long-lived access keys in repo secrets).

      Done in `8410ec1` (`GithubOidcStack` provisions the OIDC provider + `MacrosightProxyGithubDeployRole`, restricted to `repo:steveboyer/macrosight-proxy:ref:refs/heads/main`) and `cbe75c7` (`.github/workflows/ci.yml` runs lint/format/tsc/synth; `.github/workflows/deploy.yml` assumes the deploy role via `aws-actions/configure-aws-credentials@v4` and runs `cdk deploy MacrosightProxyStack --require-approval never`). Hardening follow-ups split out as MSP033 / MSP034 / MSP036.

- [x] **MSP003** — API Gateway HTTP API with Lambda proxy integration. HTTP API rather than REST API; only the routes actually needed.

      Done in `1daa0c4`. `HttpApi` + `HttpLambdaIntegration` in `lib/macrosight-proxy-stack.ts`. Single catch-all `/{proxy+}` route on any method — fine while the handler is a placeholder; tighten to specific routes once MSP012 / MSP013 land.

- [x] **MSP001** — CDK app skeleton in TypeScript with esbuild bundling, Node.js 20 runtime target.

      Done in `cbcaae3` (scaffold) and `1daa0c4` (`NodejsFunction` with esbuild bundling). Runtime is `NODEJS_22_X` rather than 20 — moved forward to match the project's pinned `.nvmrc` / `engines.node`.
