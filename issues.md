# macrosight-proxy backlog

This file is the single source of truth for macrosight-proxy's backlog and history.

Every item has a permanent ID (`MSP###`). Refer to items by ID. New items take the next free number (currently **MSP026** is next). IDs never change once assigned, even if items are reordered, edited, or completed.

## Contents

- [Active backlog](#active-backlog)
- [Future / longer-term](#future--longer-term)
- [Done](#done)

---

## Active backlog

### Infrastructure

- [ ] **MSP001** — CDK app skeleton in TypeScript with esbuild bundling, Node.js 20 runtime target.

- [ ] **MSP002** — Lambda function definition on ARM Graviton2 architecture, sized at the smallest memory tier that handles the workload (start at 512 MB, tune later).

- [ ] **MSP003** — API Gateway HTTP API with Lambda proxy integration. HTTP API rather than REST API; only the routes actually needed.

- [ ] **MSP004** — DynamoDB single-table design. PK conventions: `USER#{appleUserId}` for user records, `USAGE#{appleUserId}` with SK `DATE#{YYYY-MM-DD}` for usage records. TTL attribute on usage rows so old counters auto-expire.

- [ ] **MSP005** — AWS Secrets Manager entries for the Anthropic API key and the Apple Sign-In private key. No secret values in code or environment variables committed to git.

- [ ] **MSP006** — Custom domain via Route 53 hosted zone plus ACM certificate plus API Gateway custom domain mapping.

- [ ] **MSP007** — GitHub Actions workflow for CDK synth and deploy on push to `main`. OIDC-based AWS auth (no long-lived access keys in repo secrets).

- [ ] **MSP008** — Local dev workflow: esbuild watch, `sam local invoke` or equivalent for endpoint testing, dotenv-style local config that mirrors Secrets Manager keys without committing values.

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

_(none yet)_
