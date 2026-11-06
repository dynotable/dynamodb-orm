import {PutItemCommand} from '@aws-sdk/client-dynamodb';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {allowlist} from '../../equivalence/allowlist.js';
import {corpus} from '../../equivalence/corpus.js';
import {runCase, scan, verdict} from '../../equivalence/harness.js';
import {createTable, deleteTable, localClient, uniqueTableName} from './setup.js';

beforeEach(() => {
  // Only Date is frozen, at …999 ms so a seconds timestamp (floor) and a seconds Date (round) differ.
  vi.useFakeTimers({toFake: ['Date'], now: new Date('2026-01-02T03:04:05.999Z')});
});
afterEach(() => {
  vi.useRealTimers();
});

it('has unique case names', () => {
  const names = corpus.map((c) => c.name);
  expect(new Set(names).size).toBe(names.length);
});

it('names only corpus cases in the allowlist', () => {
  const names = new Set(corpus.map((c) => c.name));
  expect(allowlist.filter((e) => !names.has(e.case))).toStrictEqual([]);
});

it('compares every page of a table, past the 1 MB a Scan page holds', async () => {
  const client = localClient();
  const TableName = uniqueTableName('scan_pages');
  await createTable(client, {
    TableName,
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [{AttributeName: 'id', KeyType: 'HASH'}],
    AttributeDefinitions: [{AttributeName: 'id', AttributeType: 'N'}]
  });
  try {
    // A page stops at the first item that takes it past 1 MB: three items of 390 KB fill it, the fourth is on page two.
    const big = {S: 'x'.repeat(390_000)};
    for (const id of ['1', '2', '3', '4'])
      await client.send(new PutItemCommand({TableName, Item: {id: {N: id}, big}}));
    expect((await scan(client, TableName, ['id'])).map((i) => i.id)).toStrictEqual([
      {N: '1'},
      {N: '2'},
      {N: '3'},
      {N: '4'}
    ]);
  } finally {
    await deleteTable(client, TableName);
  }
});

it.each(corpus.map((c) => [c.name, c] as const))('%s', async (_, testCase) => {
  expect(verdict(testCase, await runCase(testCase), allowlist)).toStrictEqual([]);
});
