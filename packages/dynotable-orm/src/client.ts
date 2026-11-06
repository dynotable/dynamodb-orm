import {
  BatchGetItemCommand,
  type BatchGetItemCommandInput,
  type BatchGetItemCommandOutput,
  BatchWriteItemCommand,
  type BatchWriteItemCommandInput,
  type BatchWriteItemCommandOutput,
  DeleteItemCommand,
  type DeleteItemCommandInput,
  type DeleteItemCommandOutput,
  DynamoDBClient,
  GetItemCommand,
  type GetItemCommandInput,
  type GetItemCommandOutput,
  PutItemCommand,
  type PutItemCommandInput,
  type PutItemCommandOutput,
  QueryCommand,
  type QueryCommandInput,
  type QueryCommandOutput,
  ScanCommand,
  type ScanCommandInput,
  type ScanCommandOutput,
  TransactWriteItemsCommand,
  type TransactWriteItemsCommandInput,
  type TransactWriteItemsCommandOutput,
  UpdateItemCommand,
  type UpdateItemCommandInput,
  type UpdateItemCommandOutput
} from '@aws-sdk/client-dynamodb';

export interface Defaults {
  prefix?: string;
  suffix?: string;
}

let client: DynamoDBClient | undefined;
let defaults: Defaults = {};

/**
 * The client every model uses, unless the model option or a call's `client` gives another. Without an argument, the
 * next call gets a new client with the SDK's default configuration, as dynamoose's `aws.ddb.revert()`.
 */
export function setClient(c?: DynamoDBClient): void {
  client = c;
}

/** Created on first use with the SDK's default configuration, when `setClient` was not called. */
export function getClient(): DynamoDBClient {
  return (client ??= new DynamoDBClient({}));
}

/** The table-name prefix and suffix of every model that does not set its own. Replaces the earlier defaults, as dynamoose's `Table.defaults.set`. */
export function setDefaults(d: Defaults): void {
  defaults = {...d};
}

export const getDefaults = (): Readonly<Defaults> => defaults;

interface Io {
  getItem: [GetItemCommandInput, GetItemCommandOutput];
  putItem: [PutItemCommandInput, PutItemCommandOutput];
  updateItem: [UpdateItemCommandInput, UpdateItemCommandOutput];
  deleteItem: [DeleteItemCommandInput, DeleteItemCommandOutput];
  query: [QueryCommandInput, QueryCommandOutput];
  scan: [ScanCommandInput, ScanCommandOutput];
  batchGetItem: [BatchGetItemCommandInput, BatchGetItemCommandOutput];
  batchWriteItem: [BatchWriteItemCommandInput, BatchWriteItemCommandOutput];
  transactWriteItems: [TransactWriteItemsCommandInput, TransactWriteItemsCommandOutput];
}
const COMMANDS: {[M in keyof Io]: new (input: Io[M][0]) => unknown} = {
  getItem: GetItemCommand,
  putItem: PutItemCommand,
  updateItem: UpdateItemCommand,
  deleteItem: DeleteItemCommand,
  query: QueryCommand,
  scan: ScanCommand,
  batchGetItem: BatchGetItemCommand,
  batchWriteItem: BatchWriteItemCommand,
  transactWriteItems: TransactWriteItemsCommand
};

/**
 * Sends one request. A client with the method of that name (the SDK's aggregated `DynamoDB` class, or a test
 * stand-in) gets the method call, as dynamoose made it, so a spy on `ddb.getItem` still sees the request.
 * Any other client gets `send(new XCommand(input))`.
 */
export function send<M extends keyof Io>(
  client: DynamoDBClient,
  method: M,
  input: Io[M][0],
  abortSignal?: AbortSignal
): Promise<Io[M][1]> {
  const options = abortSignal ? {abortSignal} : undefined;
  const own = (client as unknown as Record<string, unknown>)[method];
  if (typeof own === 'function') return own.call(client, input, options);
  return client.send(new COMMANDS[method](input) as never, options);
}
