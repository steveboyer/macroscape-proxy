#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { MacroScapeProxyStack } from '../lib/macroscape-proxy-stack';
import { GithubOidcStack } from '../lib/github-oidc-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

new MacroScapeProxyStack(app, 'MacroScapeProxyStack', { env });

new GithubOidcStack(app, 'MacroScapeProxyGithubOidcStack', {
  env,
  githubOwner: 'steveboyer',
  githubRepo: 'macroscape-proxy',
  allowedBranches: ['main'],
});
