import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as path from 'path';

const DOMAIN_NAME = 'macroscape.app';
const API_HOSTNAME = 'api.macroscape.app';

export class MacroscapeProxyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // DynamoDB table for whatever state the proxy needs (rate limits,
    // cache, device registry). Generic pk/sk keys; refine the schema
    // once you've decided on access patterns.
    const table = new dynamodb.TableV2(this, 'ProxyTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.RETAIN, // keep data on stack destroy
    });

    // Secret for the upstream API key. Created with an empty placeholder;
    // populate the real value via console or CLI after first deploy.
    const upstreamApiKey = new secretsmanager.Secret(this, 'UpstreamApiKey', {
      secretName: 'macrosight-proxy/upstream-api-key',
      description: 'API key for the upstream service',
    });

    const appleSignInPrivateKey = new secretsmanager.Secret(this, 'AppleSignInPrivateKey', {
      secretName: 'macrosight-proxy/apple-signin-private-key',
      description: 'Apple Sign-In .p8 private key for client_secret JWT signing',
    });

    // Explicit log group so we control retention. Without this the Lambda
    // creates a log group with indefinite retention by default.
    const handlerLogGroup = new logs.LogGroup(this, 'HandlerLogGroup', {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const handler = new lambdaNodejs.NodejsFunction(this, 'ProxyHandler', {
      entry: path.join(__dirname, '../src/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(10),
      logGroup: handlerLogGroup,
      environment: {
        TABLE_NAME: table.tableName,
        UPSTREAM_SECRET_ARN: upstreamApiKey.secretArn,
        APPLE_SIGNIN_SECRET_ARN: appleSignInPrivateKey.secretArn,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
    });

    table.grantReadWriteData(handler);
    upstreamApiKey.grantRead(handler);
    appleSignInPrivateKey.grantRead(handler);

    // Hosted zone for the apex. RETAIN keeps it (and the registrar NS
    // delegation) intact across stack tear-downs. On a re-create after
    // tear-down, delete the orphaned zone first or switch to fromLookup.
    const hostedZone = new route53.HostedZone(this, 'MacroscapeZone', {
      zoneName: DOMAIN_NAME,
    });
    hostedZone.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    // First deploy hangs here until the four NS records (see
    // HostedZoneNameServers output) are delegated at the macroscape.app
    // registrar — validation completes within minutes of propagation.
    const certificate = new acm.Certificate(this, 'ApiCertificate', {
      domainName: API_HOSTNAME,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    const domainName = new apigatewayv2.DomainName(this, 'ApiDomainName', {
      domainName: API_HOSTNAME,
      certificate,
    });

    const api = new apigatewayv2.HttpApi(this, 'ProxyApi', {
      description: 'Macroscape proxy API',
      defaultDomainMapping: { domainName },
    });

    api.addRoutes({
      path: '/{proxy+}',
      methods: [apigatewayv2.HttpMethod.ANY],
      integration: new apigatewayv2Integrations.HttpLambdaIntegration('ProxyIntegration', handler),
    });

    const aliasTarget = route53.RecordTarget.fromAlias(
      new route53Targets.ApiGatewayv2DomainProperties(
        domainName.regionalDomainName,
        domainName.regionalHostedZoneId,
      ),
    );

    new route53.ARecord(this, 'ApiAliasA', {
      zone: hostedZone,
      recordName: 'api',
      target: aliasTarget,
    });

    new route53.AaaaRecord(this, 'ApiAliasAaaa', {
      zone: hostedZone,
      recordName: 'api',
      target: aliasTarget,
    });

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: `https://${API_HOSTNAME}`,
      description: 'Custom domain URL of the proxy API',
    });

    new cdk.CfnOutput(this, 'ApiGatewayEndpoint', {
      value: api.apiEndpoint,
      description: 'Native API Gateway endpoint (fallback if custom domain has issues)',
    });

    new cdk.CfnOutput(this, 'HostedZoneNameServers', {
      value: cdk.Fn.join(', ', hostedZone.hostedZoneNameServers ?? []),
      description: 'Delegate these NS records at the macroscape.app registrar',
    });
  }
}
