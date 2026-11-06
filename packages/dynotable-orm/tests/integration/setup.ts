import {
  type CreateTableCommandInput,
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  type DynamoDBClientConfig
} from '@aws-sdk/client-dynamodb';

/** DynamoDB Local only. Integration tests never reach real AWS. */
export const LOCAL: DynamoDBClientConfig & {endpoint: string} = {
  endpoint: process.env.DYNAMODB_LOCAL_ENDPOINT ?? 'http://127.0.0.1:8000',
  region: 'local',
  credentials: {accessKeyId: 'local', secretAccessKey: 'local'}
};

export const localClient = () => new DynamoDBClient(LOCAL);

let n = 0;
/** Unique per file and per process (the `<case>_${pid}_${n}` pattern), so parallel files never share a table. */
export const uniqueTableName = (base: string) =>
  `${base.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 180)}_${process.pid}_${n++}`;

export async function createTable(
  client: DynamoDBClient,
  input: CreateTableCommandInput
): Promise<void> {
  await client.send(new CreateTableCommand(input));
}

export async function deleteTable(client: DynamoDBClient, name: string): Promise<void> {
  await client.send(new DeleteTableCommand({TableName: name}));
}
