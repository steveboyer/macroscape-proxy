import { DynamoDBClient, ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { userKey } from './keys';

// Module-scope singleton — survives Lambda warm starts.
const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export interface UpsertUserResult {
  created: boolean;
}

export async function upsertUser(appleUserId: string): Promise<UpsertUserResult> {
  const tableName = process.env.TABLE_NAME;
  if (!tableName) {
    throw new Error('TABLE_NAME env var is required');
  }

  try {
    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          ...userKey(appleUserId),
          createdAt: new Date().toISOString(),
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
    return { created: true };
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      return { created: false };
    }
    throw err;
  }
}
