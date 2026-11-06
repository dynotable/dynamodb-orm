import {DynamoDBClient, ListTablesCommand} from '@aws-sdk/client-dynamodb';
import {expect, it} from 'vitest';

it('blocks fetch', async () => {
  const cause = await fetch('http://127.0.0.1:8000').catch((e: Error) => e.cause);
  expect(String(cause)).toContain('Network access is blocked');
});

it('blocks the AWS SDK', async () => {
  const client = new DynamoDBClient({
    endpoint: 'http://127.0.0.1:8000',
    region: 'local',
    credentials: {accessKeyId: 'x', secretAccessKey: 'x'},
    maxAttempts: 1
  });
  await expect(client.send(new ListTablesCommand({}))).rejects.toThrow('Network access is blocked');
});
