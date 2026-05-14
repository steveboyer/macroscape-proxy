import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  console.log('event', JSON.stringify(event));

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'macrosight-proxy is alive',
      path: event.rawPath,
    }),
  };
};
