#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { MacroscapeProxyStack } from '../lib/macroscape-proxy-stack';
import { GithubOidcStack } from '../lib/github-oidc-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

new MacroscapeProxyStack(app, 'MacroscapeProxyStack', { env });

new GithubOidcStack(app, 'MacrosightProxyGithubOidcStack', {
  env,
  githubOwner: 'steveboyer',
  githubRepo: 'macrosight-proxy',
  allowedBranches: ['main'],
});
