import {QueryCommand, ScanCommand} from '@aws-sdk/client-dynamodb';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {model} from '../../src/index.js';
import {createTable, deleteTable, localClient, uniqueTableName} from './setup.js';

const client = localClient();
const schema = z.object({
  id: z.string(),
  sk: z.number(),
  email: z.string().toLowerCase().optional()
});
const M = model(uniqueTableName('query'), schema, {hashKey: 'id', rangeKey: 'sk', client});
const send = vi.spyOn(client, 'send');
/** Counts the requests of one kind sent from now on. */
const sent = (Command: typeof QueryCommand | typeof ScanCommand) => {
  const count = () => send.mock.calls.filter(([command]) => command instanceof Command).length;
  const before = count();
  return () => count() - before;
};

afterAll(async () => {
  await deleteTable(client, M.tableName);
  client.destroy();
});

beforeAll(async () => {
  await createTable(client, M.createTableInput());
  for (const sk of [1, 2, 3, 4, 5]) await M.create({id: 'a', sk});
  await M.create({id: 'b', sk: 1, email: 'Jane@Example.COM'});
});

describe('query and scan on DynamoDB Local', () => {
  it('stops all() at maxPages, with no extra request', async () => {
    const queries = sent(QueryCommand);
    const result = await M.query('id').eq('a').limit(1).all(0, 2).exec();
    expect([...result]).toStrictEqual([
      {id: 'a', sk: 1},
      {id: 'a', sk: 2}
    ]);
    expect({lastKey: result.lastKey, timesQueried: result.timesQueried}).toStrictEqual({
      lastKey: {id: 'a', sk: 2},
      timesQueried: 2
    });
    expect(queries()).toBe(2);
  });

  it('scans in parallel segments', async () => {
    const scans = sent(ScanCommand);
    const result = await M.scan().parallel(2).exec();
    const key = (i: {id: string; sk: number}) => `${i.id}${i.sk}`;
    expect(result.map(key).sort()).toStrictEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'b1']);
    expect({
      count: result.count,
      scannedCount: result.scannedCount,
      timesScanned: result.timesScanned
    }).toStrictEqual({
      count: 6,
      scannedCount: 6,
      timesScanned: 2
    });
    expect(scans()).toBe(2);
  });

  it('filters on a transformed field by its stored value', async () => {
    expect([
      ...(await M.query('id').eq('b').where('email').eq('JANE@example.com').exec())
    ]).toStrictEqual([{id: 'b', sk: 1, email: 'jane@example.com'}]);
    expect([...(await M.scan('email').eq('JANE@example.com').exec())]).toHaveLength(1);
  });
});
