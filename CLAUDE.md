# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Backlog: see issues.md (single source of truth for what's done, in progress, and planned).

API contract lives in CONTRACT.md in this repo.

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

- **`MacroScapeProxyStack`** (`lib/macroscape-proxy-stack.ts`) — the runtime proxy. Wires together:
  - `HttpApi` with a catch-all `/{proxy+}` route on any method,
  - `NodejsFunction` bundled from `src/handler.ts` via esbuild (Node 22 runtime),
  - `TableV2` DynamoDB table with generic `pk`/`sk` keys + `ttl` attribute (schema intentionally unrefined — pick access patterns first),
  - `Secret` for the upstream (Anthropic) API key; created empty, populate post-deploy via console/CLI,
  - Explicit `LogGroup` with 2-week retention (otherwise Lambda creates one with indefinite retention).
  Table and secret are passed to the handler via `TABLE_NAME` / `UPSTREAM_SECRET_ARN` env vars. Table has `RemovalPolicy.RETAIN`.

- **`GithubOidcStack`** (`lib/github-oidc-stack.ts`) — one-time bootstrap for CI. Creates a GitHub OIDC provider and a `MacroScapeProxyGithubDeployRole` that GitHub Actions assumes (restricted to specified branches, default `main`). That role doesn't deploy directly; it's allowed to assume the CDK bootstrap roles (`cdk-hnb659fds-*`), which is what actually performs `cdk deploy`.

The two stacks are independent — deploy `GithubOidcStack` once per account, deploy `MacroScapeProxyStack` on every change.

### `src/` vs `lib/` split

- `src/` — Lambda runtime code. `tsconfig.json` has `rootDir: src`, so `tsc` only compiles this directory. Bundling for deployment happens via `NodejsFunction`'s esbuild, not `tsc`.
- `lib/` + `bin/` — CDK infrastructure code. Executed by `cdk` via `ts-node` (see `cdk.json` `app`). Not part of the Lambda bundle.

Keep that boundary intact: don't import from `lib/` inside `src/` or vice versa.
