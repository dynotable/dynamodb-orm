import type {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {Condition, ExpressionError, model, orm, transaction} from '../src/index.js';

const stub = () => {
  const send = vi.fn(async () => ({}));
  return {client: {send} as unknown as DynamoDBClient, send};
};
const M = model(
  'T',
  z.object({id: z.string(), email: z.string().toLowerCase().optional(), n: z.number().optional()}),
  {
    hashKey: 'id'
  }
);

afterEach(() => {
  vi.restoreAllMocks();
});

// The literals are what a dynamoose 4.x build's Model.transaction.* resolve to for the same schema.
describe('the entries', () => {
  it('resolve to the raw TransactWriteItem of each method', async () => {
    expect(await M.transaction.create({id: 'a', email: 'X@Y', n: 1})).toStrictEqual({
      Put: {
        Item: {id: {S: 'a'}, email: {S: 'x@y'}, n: {N: '1'}},
        TableName: 'T',
        ConditionExpression: 'attribute_not_exists(#__hash_key)',
        ExpressionAttributeNames: {'#__hash_key': 'id'}
      }
    });
    expect(await M.transaction.create({id: 'a', n: 1}, {overwrite: true})).toStrictEqual({
      Put: {Item: {id: {S: 'a'}, n: {N: '1'}}, TableName: 'T'}
    });
    expect(await M.transaction.update({id: 'a'}, {n: 2})).toStrictEqual({
      Update: {
        Key: {id: {S: 'a'}},
        ExpressionAttributeNames: {'#a0': 'n'},
        ExpressionAttributeValues: {':v0': {N: '2'}},
        UpdateExpression: 'SET #a0 = :v0',
        TableName: 'T'
      }
    });
    expect(await M.transaction.delete('a', {condition: new Condition('n').exists()})).toStrictEqual(
      {
        Delete: {
          Key: {id: {S: 'a'}},
          TableName: 'T',
          ConditionExpression: 'attribute_exists (#a0)',
          ExpressionAttributeNames: {'#a0': 'n'}
        }
      }
    );
    expect(await M.transaction.condition({id: 'a'}, new Condition('n').eq(1))).toStrictEqual({
      ConditionCheck: {
        Key: {id: {S: 'a'}},
        TableName: 'T',
        ConditionExpression: '#a0 = :v0',
        ExpressionAttributeNames: {'#a0': 'n'},
        ExpressionAttributeValues: {':v0': {N: '1'}}
      }
    });
  });

  // A test that stubs a model method (vi.spyOn(M, 'create')) must still get real entries, as with dynamoose.
  it('do not go through the stubbable model methods', async () => {
    const spies = (['create', 'update', 'delete'] as const).map((m) =>
      vi.spyOn(M, m).mockResolvedValue(undefined as never)
    );
    expect(await M.transaction.create({id: 'a', n: 1}, {overwrite: true})).toStrictEqual({
      Put: {Item: {id: {S: 'a'}, n: {N: '1'}}, TableName: 'T'}
    });
    expect((await M.transaction.update({id: 'a'}, {n: 2})).Update.Key).toStrictEqual({
      id: {S: 'a'}
    });
    expect((await M.transaction.delete('a')).Delete.Key).toStrictEqual({id: {S: 'a'}});
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('refuse a ConditionCheck without a condition, which DynamoDB rejects', async () => {
    await expect(M.transaction.condition('a', new Condition())).rejects.toThrow(
      new ExpressionError("transaction.condition() on 'T' needs a condition")
    );
  });
});

describe('transaction()', () => {
  it('goes through orm.transaction, so a test spy sees every call', async () => {
    const spy = vi.spyOn(orm, 'transaction').mockResolvedValue(undefined);
    try {
      const entry = {Delete: {TableName: 'T', Key: {id: {S: 'a'}}}};
      await transaction([entry]);
      expect(spy.mock.calls).toStrictEqual([[[entry]]]);
    } finally {
      spy.mockRestore();
    }
  });

  const raw = {
    ConditionCheck: {
      TableName: 'Other',
      Key: {pk: {S: 'p'}},
      ConditionExpression: 'attribute_exists(pk)'
    }
  };

  it('takes the entries mixed with raw items, in order', async () => {
    expect(await transaction([M.transaction.delete('a'), raw], {return: 'request'})).toStrictEqual({
      TransactItems: [{Delete: {Key: {id: {S: 'a'}}, TableName: 'T'}}, raw]
    });
  });

  it('throws before sending for no entries or more than 100', async () => {
    const {client, send} = stub();
    const entries = Array.from({length: 101}, (_, i) => M.transaction.delete(`k${i}`));
    await expect(transaction(entries, {client})).rejects.toThrow(
      new ExpressionError('a transaction holds 1 to 100 items, not 101')
    );
    await expect(transaction([], {client})).rejects.toThrow(
      new ExpressionError('a transaction holds 1 to 100 items, not 0')
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('throws before sending for two entries on one key', async () => {
    const {client, send} = stub();
    await expect(
      transaction([M.transaction.update('a', {n: 1}), M.transaction.delete('a')], {client})
    ).rejects.toThrow('twice');
    // A create's key is known only from the model, as a raw Put does not say which attributes are its key.
    const exists = {ConditionExpression: 'attribute_exists(id)'};
    await expect(
      transaction([M.transaction.create({id: 'b'}), M.transaction.condition('b', exists)], {client})
    ).rejects.toThrow('twice');
    expect(send).not.toHaveBeenCalled();
  });

  // DynamoDB compares key values, so a raw entry must match a model entry however its value is written.
  it('throws for one key written as a Buffer and a Uint8Array, or as two number notations', async () => {
    const {client, send} = stub();
    const del = (Key: Record<string, unknown>) => ({Delete: {TableName: 'T', Key}}) as never;
    await expect(
      transaction([del({id: {B: Buffer.from('k')}}), del({id: {B: new Uint8Array([107])}})], {
        client
      })
    ).rejects.toThrow('twice');
    await expect(
      transaction([del({id: {N: '1E1'}}), del({id: {N: '10'}})], {client})
    ).rejects.toThrow('twice');
    expect(send).not.toHaveBeenCalled();
  });
});
