import {type AttributeValue, GetItemCommand, PutItemCommand} from '@aws-sdk/client-dynamodb';
import {afterAll, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {
  ExpressionError,
  ifNotExists,
  isConditionalCheckFailed,
  model,
  ValidationError
} from '../../src/index.js';
import type {ModelOptions} from '../../src/options.js';
import type {StandardSchema} from '../../src/types.js';
import {createTable, deleteTable, localClient, uniqueTableName} from './setup.js';

// Capabilities dynamoose lacks, and error paths where the stored item must stay as it was.
const client = localClient();
const created: string[] = [];

async function table<const S extends StandardSchema, const O extends ModelOptions<any>>(
  schema: S,
  options: O
) {
  const M = model(uniqueTableName('update'), schema, {...options, client} as O);
  await createTable(client, M.createTableInput());
  created.push(M.tableName);
  return M;
}

const put = (TableName: string, Item: Record<string, AttributeValue>) =>
  client.send(new PutItemCommand({TableName, Item}));
const stored = async (TableName: string, id: string) =>
  (await client.send(new GetItemCommand({TableName, Key: {id: {S: id}}, ConsistentRead: true})))
    .Item;
const rejection = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e
  );

afterAll(async () => {
  await Promise.all(created.map((name) => deleteTable(client, name)));
  client.destroy();
});

describe('update on DynamoDB Local', () => {
  it('writes an ifNotExists value only where the attribute is absent', async () => {
    const M = await table(
      z.object({id: z.string(), n: z.number().optional(), m: z.number().optional()}),
      {hashKey: 'id'}
    );
    await put(M.tableName, {id: {S: 'a'}, n: {N: '1'}});
    await M.update('a', {n: ifNotExists(5), $SET: {m: ifNotExists(7)}});
    expect(await stored(M.tableName, 'a')).toStrictEqual({id: {S: 'a'}, n: {N: '1'}, m: {N: '7'}});
  });

  it('honours attributeNotExists in the condition', async () => {
    const M = await table(z.object({id: z.string(), n: z.number().optional()}), {hashKey: 'id'});
    const condition = M.condition().where('id').attributeNotExists();
    await M.update('a', {n: 1}, {condition});
    const error = await rejection(M.update('a', {n: 2}, {condition}));
    expect(isConditionalCheckFailed(error)).toBe(true);
    expect(await stored(M.tableName, 'a')).toStrictEqual({id: {S: 'a'}, n: {N: '1'}});
  });

  it('compares lists and maps as stored values in a condition', async () => {
    const M = await table(
      z.object({
        id: z.string(),
        n: z.number().optional(),
        list: z.array(z.string()).optional(),
        map: z.object({a: z.string(), b: z.number()}).optional()
      }),
      {hashKey: 'id'}
    );
    await put(M.tableName, {
      id: {S: 'a'},
      list: {L: [{S: 'x'}, {S: 'y'}]},
      map: {M: {a: {S: 'p'}, b: {N: '1'}}}
    });
    await M.update('a', {n: 1}, {condition: M.condition().where('list').eq(['x', 'y'])});
    await M.update('a', {n: 2}, {condition: M.condition().where('map').eq({b: 1, a: 'p'})});
    const error = await rejection(
      M.update('a', {n: 3}, {condition: M.condition().where('list').eq(['y', 'x'])})
    );
    expect(isConditionalCheckFailed(error)).toBe(true);
    expect((await stored(M.tableName, 'a'))?.n).toStrictEqual({N: '2'});
  });

  it('matches a condition on a transformed field against the normalized stored value', async () => {
    const M = await table(
      z.object({
        id: z.string(),
        alias: z.string().toLowerCase().optional(),
        n: z.number().optional()
      }),
      {hashKey: 'id'}
    );
    await put(M.tableName, {id: {S: 'a'}, alias: {S: 'jane@example.com'}});
    await M.update('a', {n: 1}, {condition: M.condition().where('alias').eq('Jane@EXAMPLE.com')});
    expect(await stored(M.tableName, 'a')).toStrictEqual({
      id: {S: 'a'},
      alias: {S: 'jane@example.com'},
      n: {N: '1'}
    });
  });

  it('rejects a bare element on a Set field and leaves the item as it was', async () => {
    const M = await table(z.object({id: z.string(), tags: z.set(z.string()).optional()}), {
      hashKey: 'id'
    });
    const item = {id: {S: 'a'}, tags: {SS: ['x']}};
    await put(M.tableName, item);
    expect(await rejection(M.update('a', {$ADD: {tags: 'y' as never}}))).toBeInstanceOf(
      ExpressionError
    );
    expect(await rejection(M.update('a', {$DELETE: {tags: 'x' as never}}))).toBeInstanceOf(
      ExpressionError
    );
    expect(await stored(M.tableName, 'a')).toStrictEqual(item);
  });

  it('rejects an update that breaks a refinement and leaves the item as it was', async () => {
    const M = await table(
      z.object({
        id: z.string(),
        count: z.number().nonnegative().optional(),
        meta: z.object({code: z.string().length(2)}).optional()
      }),
      {hashKey: 'id'}
    );
    const item = {id: {S: 'a'}, count: {N: '1'}, meta: {M: {code: {S: 'ES'}}}};
    await put(M.tableName, item);
    expect(await rejection(M.update('a', {count: -1}))).toBeInstanceOf(ValidationError);
    const nested = await rejection(M.update('a', {$SET: {'meta.code': 'ESP'}}));
    expect(nested).toBeInstanceOf(ValidationError);
    expect((nested as ValidationError).path).toStrictEqual(['meta', 'code']);
    expect(await stored(M.tableName, 'a')).toStrictEqual(item);
  });
});
