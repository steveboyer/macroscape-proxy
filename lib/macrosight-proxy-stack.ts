import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as path from 'path';

export class MacrosightProxyStack extends cdk.Stack {
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
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      logGroup: handlerLogGroup,
      environment: {
        TABLE_NAME: table.tableName,
        UPSTREAM_SECRET_ARN: upstreamApiKey.secretArn,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
    });

    table.grantReadWriteData(handler);
    upstreamApiKey.grantRead(handler);

    const api = new apigatewayv2.HttpApi(this, 'ProxyApi', {
      description: 'MacroSight proxy API',
    });

    api.addRoutes({
      path: '/{proxy+}',
      methods: [apigatewayv2.HttpMethod.ANY],
      integration: new apigatewayv2Integrations.HttpLambdaIntegration(
        'ProxyIntegration',
        handler,
      ),
    });

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.apiEndpoint,
      description: 'Base URL of the proxy API',
    });
  }
}
