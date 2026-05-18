# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Backlog: see issues.md (single source of truth for what's done, in progress, and planned).

API contract lives in CONTRACT.md in this repo.

Operator setup docs live under `docs/` (e.g., `docs/apple-setup.md` for the developer.apple.com registrations Sign in with Apple needs).

## Project

AWS Lambda proxy for the MacroScape iOS app, served at `https://api.macroscape.app`. Authenticates Sign in with Apple callers (id_token in `Authorization: Bearer`), auto-creates a user record on first authenticated request, enforces a per-user daily rate limit on `/v1/messages`, and forwards those requests to the Anthropic API with a strict header allowlist and centralized API key handling.

## Commands

```sh
nvm use                  # Node 22 (see .nvmrc)
npm install
npm run lint             # eslint .
npm run lint:fix
npm run format           # prettier --write .
npm run format:check
npm run build            # tsc — compiles src/ only (Lambda code). CDK app code in bin/ + lib/ is not type-checked by this script; it runs via ts-node.
npm run cdk -- synth
npm run cdk -- diff
npm run cdk -- deploy MacroScapeProxyStack
npm run cdk -- deploy MacroScapeProxyGithubOidcStack
```

There are no tests yet.

## Architecture

Two CDK stacks, both instantiated in `bin/macroscape-proxy.ts`:

- **`MacroScapeProxyStack`** (`lib/macroscape-proxy-stack.ts`) — the runtime proxy. Wires:
  - `HttpApi` with a catch-all `/{proxy+}` route on any method (the handler does internal routing — `/health`, `/v1/messages`, 404 otherwise). `defaultDomainMapping` points it at `api.macroscape.app` via an APIGW v2 `DomainName`.
  - `NodejsFunction` bundled from `src/handler.ts` via esbuild (Node 22, ARM_64, 512 MB).
  - `TableV2` DynamoDB single-table store. Generic `pk`/`sk`/`ttl`; access patterns defined in `src/db/keys.ts` — `USER#<sub>/PROFILE` for user records (optional `dailyLimit` attribute overrides the per-user daily limit) and `USAGE#<sub>/DATE#YYYY-MM-DD` for daily request counters (the latter carry a 90-day `ttl`). `RemovalPolicy.RETAIN`.
  - Two `Secret`s in Secrets Manager, both created empty — populate post-deploy:
    - `macroscape-proxy/upstream-api-key` — Anthropic API key.
    - `macroscape-proxy/apple-signin-private-key` — Apple `.p8` for server-side `client_secret` JWT signing (not currently used; auth path is JWKS-only).
  - `HostedZone` for `macroscape.app` (RETAIN), ACM `Certificate` for `api.macroscape.app` (DNS-validated against that zone), A + AAAA alias records pointing at the APIGW v2 domain. NS delegation lives at the registrar (Namecheap).
  - Explicit `LogGroup` with 2-week retention (otherwise Lambda creates one with indefinite retention).

  Handler env vars: `TABLE_NAME`, `UPSTREAM_SECRET_ARN`, `APPLE_SIGNIN_SECRET_ARN`, `APPLE_AUD` (currently `app.macroscape.MacroScape` — the iOS Bundle ID; JWTs whose `aud` doesn't match are rejected), `DEFAULT_DAILY_LIMIT` (currently `100`).

- **`GithubOidcStack`** (`lib/github-oidc-stack.ts`) — one-time bootstrap for CI. Creates a GitHub OIDC provider and a `MacroScapeProxyGithubDeployRole` that GitHub Actions assumes (restricted to specified branches, default `main`). That role doesn't deploy directly; it's allowed to assume the CDK bootstrap roles (`cdk-hnb659fds-*`), which is what actually performs `cdk deploy`.

The two stacks are independent — deploy `GithubOidcStack` once per account, deploy `MacroScapeProxyStack` on every change.

### `src/` layout

Lambda code organized by concern:

- `src/handler.ts` — entry point. Dispatches on `event.rawPath`; `/health` and `/v1/messages` are the only routes (404 otherwise; 405 on non-POST `/v1/messages`). Catches `AuthError` / `RateLimitError` / `UpstreamError` and maps them to HTTP responses; other errors propagate to Lambda 500.
- `src/auth/` — Sign in with Apple verification. `appleVerifier.ts` wraps `jose` against Apple's JWKS (module-cached, survives warm starts); `authenticate.ts` is the route-level helper (extract Bearer token → verify → throw `AuthError(401)` on any failure).
- `src/db/` — DynamoDB single-table helpers. `client.ts` (shared `DynamoDBDocumentClient` singleton + `getTableName`), `keys.ts` (key shapes + TTL helpers), `users.ts` (idempotent `upsertUser` via `attribute_not_exists` conditional).
- `src/rateLimit/` — `dailyLimit.ts`: atomic `UpdateItem ADD` for the per-user usage counter, throws `RateLimitError` (→ 429 + `Retry-After`) on exceed. Reads the per-user `dailyLimit` override or falls back to `DEFAULT_DAILY_LIMIT`.
- `src/upstream/` — `anthropic.ts`: Secrets-Manager–backed API key fetch (cached after first call), strict header allowlist (`content-type`, `anthropic-version`, `anthropic-beta`, `accept`, `accept-encoding`), byte-for-byte request body and response pass-through.

### `src/` vs `lib/` split

- `src/` — Lambda runtime code. `tsconfig.json` has `rootDir: src`, so `tsc` only compiles this directory. Bundling for deployment happens via `NodejsFunction`'s esbuild, not `tsc`.
- `lib/` + `bin/` — CDK infrastructure code. Executed by `cdk` via `ts-node` (see `cdk.json` `app`). Not part of the Lambda bundle.

Keep that boundary intact: don't import from `lib/` inside `src/` or vice versa.
