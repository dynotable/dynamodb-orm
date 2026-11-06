import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  ScanCommand
} from '@aws-sdk/client-dynamodb';
import {afterAll, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {isConditionalCheckFailed, model, transaction} from '../../src/index.js';
import type {ModelOptions} from '../../src/options.js';
import type {StandardSchema} from '../../src/types.js';
import {createTable, deleteTable, LOCAL, localClient, uniqueTableName} from './setup.js';

const client = localClient();
// DynamoDB Local without -sharedDb keeps one database per access key and region.
const otherPartition = new DynamoDBClient({
  ...LOCAL,
  region: 'other',
  credentials: {accessKeyId: 'other', secretAccessKey: 'other'}
});
const created: Array<[DynamoDBClient, string]> = [];

async function table<const S extends StandardSchema, const O extends ModelOptions<any>>(
  schema: S,
  options: O,
  clients: DynamoDBClient[] = [client]
) {
  const M = model(uniqueTableName('crud'), schema, {...options, client} as O);
  for (const c of clients) {
    await createTable(c, M.createTableInput());
    created.push([c, M.tableName]);
  }
  return M;
}

const stored = async (TableName: string, c = client) =>
  (await c.send(new ScanCommand({TableName, ConsistentRead: true}))).Items;

afterAll(async () => {
  await Promise.all(created.map(([c, name]) => deleteTable(c, name)));
  client.destroy();
  otherPartition.destroy();
});

const emailSchema = z.object({email: z.string().toLowerCase(), n: z.number().optional()});

describe('single-item CRUD on DynamoDB Local', () => {
  it('returns the stored values with raw: true', async () => {
    const M = await table(z.object({id: z.string(), at: z.date(), sec: z.date()}), {
      hashKey: 'id',
      dates: {sec: 'seconds'}
    });
    await M.create({id: 'a', at: new Date(1500), sec: new Date(1500)});
    expect(await M.get('a', {raw: true})).toStrictEqual({
      id: 'a',
      at: 1500,
      sec: 2
    });
  });

  it('reaches a mixed-case legacy key with rawKey only', async () => {
    const M = await table(emailSchema, {hashKey: 'email'});
    await client.send(
      new PutItemCommand({
        TableName: M.tableName,
        Item: {email: {S: 'Jane@Example.COM'}, n: {N: '1'}}
      })
    );
    expect(await M.get({email: 'Jane@Example.COM'})).toBeUndefined();
    expect(await M.get({email: 'Jane@Example.COM'}, {rawKey: true})).toStrictEqual({
      email: 'Jane@Example.COM',
      n: 1
    });
    await M.delete({email: 'Jane@Example.COM'}, {rawKey: true});
    expect(await stored(M.tableName)).toStrictEqual([]);
  });

  it('reaches a key attribute named like a document path', async () => {
    const M = await table(z.object({'a[0]': z.string(), v: z.string().optional()}), {
      hashKey: 'a[0]'
    });
    const key = {'a[0]': 'x'};
    await M.create({...key, v: 'created'});
    await M.update(key, {v: 'updated'});
    expect(await M.get(key)).toStrictEqual({'a[0]': 'x', v: 'updated'});
    await transaction([M.transaction.update(key, {v: 'in a transaction'})], {client});
    expect([...(await M.batchGet([key]))]).toStrictEqual([{'a[0]': 'x', v: 'in a transaction'}]);
    await M.delete(key);
    expect(await stored(M.tableName)).toStrictEqual([]);
  });

  it('sends to the per-call client, a separate partition', async () => {
    const M = await table(emailSchema, {hashKey: 'email'}, [client, otherPartition]);
    await M.create({email: 'b@example.com', n: 2}, {client: otherPartition});
    expect(await M.get('b@example.com')).toBeUndefined();
    expect(await M.get('b@example.com', {client: otherPartition})).toStrictEqual({
      email: 'b@example.com',
      n: 2
    });
  });

  it('sends nothing with an already-aborted signal, on every call that takes one', async () => {
    const M = await table(emailSchema, {hashKey: 'email'});
    await M.create({email: 'kept@example.com', n: 1});
    const abortSignal = AbortSignal.abort();
    const aborted = {name: 'AbortError'};
    await expect(M.create({email: 'c@example.com'}, {abortSignal})).rejects.toMatchObject(aborted);
    await expect(M.get('kept@example.com', {abortSignal})).rejects.toMatchObject(aborted);
    await expect(
      M.update({email: 'kept@example.com'}, {n: 2}, {abortSignal})
    ).rejects.toMatchObject(aborted);
    await expect(M.delete('kept@example.com', {abortSignal})).rejects.toMatchObject(aborted);
    await expect(
      transaction([M.transaction.delete('kept@example.com')], {client, abortSignal})
    ).rejects.toMatchObject(aborted);
    expect(await stored(M.tableName)).toStrictEqual([
      {email: {S: 'kept@example.com'}, n: {N: '1'}}
    ]);
  });

  it('recognizes a failed create and a failed delete condition', async () => {
    const M = await table(emailSchema, {hashKey: 'email'});
    await M.create({email: 'd@example.com', n: 1});
    const again = await M.create({email: 'd@example.com'}).catch((e: unknown) => e);
    const del = await M.delete('d@example.com', {condition: M.condition().where('n').eq(2)}).catch(
      (e: unknown) => e
    );
    expect([isConditionalCheckFailed(again), isConditionalCheckFailed(del)]).toStrictEqual([
      true,
      true
    ]);
    expect(await stored(M.tableName)).toStrictEqual([{email: {S: 'd@example.com'}, n: {N: '1'}}]);
  });

  it('returns a request that stores the item when sent through the raw SDK', async () => {
    const M = await table(emailSchema, {hashKey: 'email'});
    const input = await M.create({email: 'Jane@Example.COM', n: 1}, {return: 'request'});
    await client.send(new PutItemCommand(input));
    const {Item} = await client.send(
      new GetItemCommand({TableName: M.tableName, Key: {email: {S: 'jane@example.com'}}})
    );
    expect(Item).toStrictEqual({email: {S: 'jane@example.com'}, n: {N: '1'}});
  });

  it('creates a working table, GSI included, from createTableInput()', async () => {
    const M = await table(z.object({id: z.string(), email: z.string(), n: z.number()}), {
      hashKey: 'id',
      indexes: {email: {name: 'byEmail', rangeKey: 'n'}}
    });
    await M.create({id: 'a', email: 'e@example.com', n: 3});
    expect(await M.get('a')).toStrictEqual({id: 'a', email: 'e@example.com', n: 3});
    const {Items} = await client.send(
      new QueryCommand({
        TableName: M.tableName,
        IndexName: 'byEmail',
        KeyConditionExpression: '#e = :e',
        ExpressionAttributeNames: {'#e': 'email'},
        ExpressionAttributeValues: {':e': {S: 'e@example.com'}}
      })
    );
    expect(Items).toStrictEqual([{id: {S: 'a'}, email: {S: 'e@example.com'}, n: {N: '3'}}]);
  });

  it('stores nothing when an async refinement fails', async () => {
    const schema = z
      .object({id: z.string(), n: z.number()})
      .refine(async (v) => v.n > 0, {message: 'n must be positive'});
    const M = await table(schema, {hashKey: 'id'});
    await expect(M.create({id: 'a', n: 0})).rejects.toThrow(
      expect.objectContaining({name: 'ValidationError', message: 'n must be positive'})
    );
    expect(await stored(M.tableName)).toStrictEqual([]);
  });
});

describe('returnValuesOnConditionCheckFailure on DynamoDB Local', () => {
  const schema = z.object({id: z.string(), n: z.number(), at: z.date()});

  it('puts the stored item, read back, on the SDK error of a failed update, create and delete', async () => {
    const M = await table(schema, {hashKey: 'id'});
    await M.create({id: 'a', n: 1, at: new Date(1500)});
    const old = {id: 'a', n: 1, at: new Date(1500)};
    const failed = (run: () => Promise<unknown>) =>
      run().then(
        () => expect.unreachable(),
        (e: unknown) => e as Error & {item?: unknown}
      );
    const condition = M.condition().where('n').eq(2);
    const update = await failed(() =>
      M.update({id: 'a'}, {n: 3}, {condition, returnValuesOnConditionCheckFailure: 'ALL_OLD'})
    );
    expect([isConditionalCheckFailed(update), update.item]).toStrictEqual([true, old]);
    const create = await failed(() =>
      M.create({id: 'a', n: 3, at: new Date(0)}, {returnValuesOnConditionCheckFailure: 'ALL_OLD'})
    );
    expect(create.item).toStrictEqual(old);
    const del = await failed(() =>
      M.delete({id: 'a'}, {condition, returnValuesOnConditionCheckFailure: 'ALL_OLD'})
    );
    expect(del.item).toStrictEqual(old);
    // Without the option, DynamoDB returns no item.
    expect((await failed(() => M.update({id: 'a'}, {n: 3}, {condition}))).item).toBeUndefined();
  });

  it("puts each failed entry's stored item, read by its model, on a canceled transaction", async () => {
    const M = await table(schema, {hashKey: 'id'});
    await M.create({id: 'a', n: 1, at: new Date(1500)});
    const error = await transaction(
      [
        M.transaction.update(
          {id: 'a'},
          {n: 3},
          {
            condition: M.condition().where('n').eq(2),
            returnValuesOnConditionCheckFailure: 'ALL_OLD'
          }
        ),
        M.transaction.create({id: 'b', n: 1, at: new Date(0)})
      ],
      {client}
    ).then(
      () => expect.unreachable(),
      (e: unknown) => e as Error & {reasons?: string[]; items?: unknown[]}
    );
    expect([error.reasons, error.items]).toStrictEqual([
      ['ConditionalCheckFailed', 'None'],
      [{id: 'a', n: 1, at: new Date(1500)}, undefined]
    ]);
  });
});

describe('allowUndeclared on DynamoDB Local', () => {
  it('runs a lease on an attribute the schema does not declare', async () => {
    const M = await table(z.object({id: z.string(), n: z.number().optional()}), {hashKey: 'id'});
    await M.create({id: 'a', n: 1});
    const take = (now: number) =>
      M.update(
        {id: 'a'},
        {lockedUntil: now + 100},
        {
          allowUndeclared: true,
          condition: {
            ConditionExpression: 'attribute_not_exists(#lock) OR #lock < :now',
            ExpressionAttributeNames: {'#lock': 'lockedUntil'},
            ExpressionAttributeValues: {':now': {N: String(now)}}
          }
        }
      );
    // The read drops the undeclared attribute, as dynamoose does.
    expect(await take(1000)).toStrictEqual({id: 'a', n: 1});
    expect(await stored(M.tableName)).toStrictEqual([
      {id: {S: 'a'}, n: {N: '1'}, lockedUntil: {N: '1100'}}
    ]);
    await expect(take(1050)).rejects.toSatisfy(isConditionalCheckFailed);
    await M.update({id: 'a'}, {$REMOVE: ['lockedUntil']} as never);
    expect(await stored(M.tableName)).toStrictEqual([{id: {S: 'a'}, n: {N: '1'}}]);
  });
});
