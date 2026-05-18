import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { client, getTableName } from './client';
import { userKey } from './keys';

export interface UpsertUserResult {
  created: boolean;
}

export async function upsertUser(appleUserId: string): Promise<UpsertUserResult> {
  try {
    await client.send(
      new PutCommand({
        TableName: getTableName(),
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
