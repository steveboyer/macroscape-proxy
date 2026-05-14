#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { MacrosightProxyStack } from '../lib/macrosight-proxy-stack';
import { GithubOidcStack } from '../lib/github-oidc-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

new MacrosightProxyStack(app, 'MacrosightProxyStack', { env });

new GithubOidcStack(app, 'MacrosightProxyGithubOidcStack', {
  env,
  githubOwner: 'steveboyer',
  githubRepo: 'macrosight-proxy',
  allowedBranches: ['main'],
});
