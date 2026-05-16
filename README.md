# macroscape-proxy

[![CI](https://github.com/steveboyer/macroscape-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/steveboyer/macroscape-proxy/actions/workflows/ci.yml)

AWS Lambda proxy for the [Macroscape](https://github.com/steveboyer) iOS app. Authenticates Apple Sign-In users and forwards `/v1/messages` requests to the Anthropic API, with per-user rate limiting and centralized API key handling.

## Status

Pre-implementation. See [`issues.md`](./issues.md) for the full backlog.

## Stack

- AWS CDK (TypeScript)
- Lambda (Node.js 20 runtime, ARM64) behind API Gateway HTTP API
- DynamoDB single-table design
- Secrets Manager for the Anthropic API key and Apple Sign-In private key

## Local development

Requires Node.js 22 (see `.nvmrc`).

```sh
nvm use
npm install
npm run lint
npm run build
```

## License

[MIT](./LICENSE)
