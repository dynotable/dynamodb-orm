import {PutItemCommand, ScanCommand} from '@aws-sdk/client-dynamodb';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {model, transaction, ValidationError} from '../../src/index.js';
import {createTable, deleteTable, localClient, uniqueTableName} from './setup.js';

const client = localClient();
// The refinement compares two fields, so only whole-item validation can reject the item.
const schema = z
  .object({id: z.string(), min: z.number().optional(), max: z.number().optional()})
  .refine((item) => item.min === undefined || item.max === undefined || item.min <= item.max);
const M = model(uniqueTableName('transaction'), schema, {hashKey: 'id', client});

const stored = async () =>
  (await client.send(new ScanCommand({TableName: M.tableName, ConsistentRead: true}))).Items?.sort(
    (a, b) => (a.id!.S! < b.id!.S! ? -1 : 1)
  );

beforeAll(async () => {
  await createTable(client, M.createTableInput());
});
afterAll(async () => {
  await deleteTable(client, M.tableName);
  client.destroy();
});

describe('transactions and batches on DynamoDB Local', () => {
  it('re-throws the cancellation with the reason of each entry, keeping CancellationReasons', async () => {
    await M.create({id: 'taken'});
    const thrown = await transaction(
      [
        M.transaction.create({id: 't1'}),
        M.transaction.create({id: 't2'}),
        M.transaction.create({id: 'taken'})
      ],
      {client}
    ).catch((e: unknown) => e);
    expect(thrown).toMatchObject({
      name: 'TransactionCanceledException',
      reasons: ['None', 'None', 'ConditionalCheckFailed'],
      CancellationReasons: [
        {Code: 'None'},
        {Code: 'None'},
        {Code: 'ConditionalCheckFailed', Message: 'The conditional request failed'}
      ]
    });
    expect(await stored()).toStrictEqual([{id: {S: 'taken'}}]);
  });

  it('sends a transaction.create entry as a raw PutItem', async () => {
    const {Put} = await M.transaction.create({id: 'spread', min: 3});
    await client.send(new PutItemCommand({...Put}));
    expect(await M.get('spread')).toStrictEqual({id: 'spread', min: 3});
  });

  it('stores nothing when a transaction.create or a batchPut item breaks the refinement', async () => {
    const before = await stored();
    const entries = [
      M.transaction.create({id: 'ok'}),
      M.transaction.create({id: 'bad', min: 2, max: 1})
    ];
    await expect(transaction(entries, {client})).rejects.toThrow(ValidationError);
    await expect(M.batchPut([{id: 'ok'}, {id: 'bad', min: 2, max: 1}])).rejects.toThrow(
      ValidationError
    );
    expect(await stored()).toStrictEqual(before);
  });
});
