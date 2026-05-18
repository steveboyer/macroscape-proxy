import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// Module-scope singleton — survives Lambda warm starts.
export const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export function getTableName(): string {
  const name = process.env.TABLE_NAME;
  if (!name) {
    throw new Error('TABLE_NAME env var is required');
  }
  return name;
}
