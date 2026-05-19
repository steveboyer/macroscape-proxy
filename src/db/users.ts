import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { client, getTableName } from './client';
import { userKey } from './keys';

export interface UpsertUserResult {
  created: boolean;
}

// Atomic upsert-or-noop. The conditional PutItem inserts only when no row
// exists for this user; on subsequent calls DynamoDB rejects the write with
// ConditionalCheckFailedException, which we treat as `created: false`. This
// avoids the read-then-write race a check-and-insert pattern would have.
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
