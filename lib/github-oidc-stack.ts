import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';

export interface GithubOidcStackProps extends cdk.StackProps {
  githubOwner: string;
  githubRepo: string;
  allowedBranches?: string[];
}

export class GithubOidcStack extends cdk.Stack {
  public readonly deployRoleArn: string;

  constructor(scope: Construct, id: string, props: GithubOidcStackProps) {
    super(scope, id, props);

    const { githubOwner, githubRepo, allowedBranches = ['main'] } = props;

    const githubProvider = new iam.OpenIdConnectProvider(this, 'GithubProvider', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });

    const subjectClaims = allowedBranches.map(
      (branch) => `repo:${githubOwner}/${githubRepo}:ref:refs/heads/${branch}`,
    );

    const deployRole = new iam.Role(this, 'GithubDeployRole', {
      roleName: 'MacroScapeProxyGithubDeployRole',
      assumedBy: new iam.FederatedPrincipal(
        githubProvider.openIdConnectProviderArn,
        {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          },
          'ForAnyValue:StringLike': {
            'token.actions.githubusercontent.com:sub': subjectClaims,
          },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
      maxSessionDuration: cdk.Duration.hours(1),
    });

    // Allow this role to assume the CDK bootstrap roles, which is what
    // `cdk deploy` actually uses to do its work.
    const account = cdk.Stack.of(this).account;
    const region = cdk.Stack.of(this).region;
    const bootstrapQualifier = 'hnb659fds';

    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [
          `arn:aws:iam::${account}:role/cdk-${bootstrapQualifier}-deploy-role-${account}-${region}`,
          `arn:aws:iam::${account}:role/cdk-${bootstrapQualifier}-file-publishing-role-${account}-${region}`,
          `arn:aws:iam::${account}:role/cdk-${bootstrapQualifier}-image-publishing-role-${account}-${region}`,
          `arn:aws:iam::${account}:role/cdk-${bootstrapQualifier}-lookup-role-${account}-${region}`,
        ],
      }),
    );

    this.deployRoleArn = deployRole.roleArn;

    new cdk.CfnOutput(this, 'DeployRoleArn', {
      value: deployRole.roleArn,
      description: 'IAM role ARN for GitHub Actions to assume',
    });
  }
}
