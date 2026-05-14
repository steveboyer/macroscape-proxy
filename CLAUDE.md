# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Backlog: see issues.md (single source of truth for what's done, in progress, and planned).

## Project

AWS Lambda proxy for the MacroSight iOS app. Authenticates Apple Sign-In users and forwards `/v1/messages` requests to the Anthropic API, with per-user rate limiting and centralized API key handling. Pre-implementation — `src/handler.ts` is still a placeholder echo handler.

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
npm run cdk -- deploy MacrosightProxyStack
npm run cdk -- deploy MacrosightProxyGithubOidcStack
```

There are no tests yet.

## Architecture

Two CDK stacks, both instantiated in `bin/macrosight-proxy.ts`:

- **`MacrosightProxyStack`** (`lib/macrosight-proxy-stack.ts`) — the runtime proxy. Wires together:
  - `HttpApi` with a catch-all `/{proxy+}` route on any method,
  - `NodejsFunction` bundled from `src/handler.ts` via esbuild (Node 22 runtime),
  - `TableV2` DynamoDB table with generic `pk`/`sk` keys + `ttl` attribute (schema intentionally unrefined — pick access patterns first),
  - `Secret` for the upstream (Anthropic) API key; created empty, populate post-deploy via console/CLI,
  - Explicit `LogGroup` with 2-week retention (otherwise Lambda creates one with indefinite retention).
  Table and secret are passed to the handler via `TABLE_NAME` / `UPSTREAM_SECRET_ARN` env vars. Table has `RemovalPolicy.RETAIN`.

- **`GithubOidcStack`** (`lib/github-oidc-stack.ts`) — one-time bootstrap for CI. Creates a GitHub OIDC provider and a `MacrosightProxyGithubDeployRole` that GitHub Actions assumes (restricted to specified branches, default `main`). That role doesn't deploy directly; it's allowed to assume the CDK bootstrap roles (`cdk-hnb659fds-*`), which is what actually performs `cdk deploy`.

The two stacks are independent — deploy `GithubOidcStack` once per account, deploy `MacrosightProxyStack` on every change.

### `src/` vs `lib/` split

- `src/` — Lambda runtime code. `tsconfig.json` has `rootDir: src`, so `tsc` only compiles this directory. Bundling for deployment happens via `NodejsFunction`'s esbuild, not `tsc`.
- `lib/` + `bin/` — CDK infrastructure code. Executed by `cdk` via `ts-node` (see `cdk.json` `app`). Not part of the Lambda bundle.

Keep that boundary intact: don't import from `lib/` inside `src/` or vice versa.
