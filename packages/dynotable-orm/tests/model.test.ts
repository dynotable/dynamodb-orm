import {DynamoDB, type DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {
  Condition,
  ConfigError,
  ExpressionError,
  getClient,
  isConditionalCheckFailed,
  model,
  setClient,
  setDefaults,
  toJSON,
  transaction
} from '../src/index.js';
import {fixtureSchema} from './fixtures/standard-schema.js';

const stub = (result: object = {}) => {
  const send = vi.fn(async () => result);
  return {client: {send} as unknown as DynamoDBClient, send};
};

const schema = z.object({
  id: z.string(),
  sk: z.number(),
  n: z.number().optional(),
  at: z.date().optional()
});
const Composite = model('T2', schema, {hashKey: 'id', rangeKey: 'sk'});
const Email = model(
  'Users',
  z.object({email: z.string().toLowerCase(), n: z.number().optional()}),
  {hashKey: 'email'}
);

afterEach(() => {
  setDefaults({});
});

// The request literals are what a dynamoose 4.x build returns for `{return: 'request'}` on the same schema.
describe('{return: "request"}', () => {
  it("builds GetItem with dynamoose's projection and consistency", async () => {
    expect(
      await Composite.get(
        {id: 'a', sk: 1},
        {return: 'request', attributes: ['id', 'n'], consistent: true}
      )
    ).toStrictEqual({
      Key: {id: {S: 'a'}, sk: {N: '1'}},
      TableName: 'T2',
      ConsistentRead: true,
      ProjectionExpression: '#a0, #a1',
      ExpressionAttributeNames: {'#a0': 'id', '#a1': 'n'}
    });
  });

  it('makes create conditional on the key unless overwrite', async () => {
    expect(await Composite.create({id: 'a', sk: 1}, {return: 'request'})).toStrictEqual({
      Item: {id: {S: 'a'}, sk: {N: '1'}},
      TableName: 'T2',
      ConditionExpression: 'attribute_not_exists(#__hash_key)',
      ExpressionAttributeNames: {'#__hash_key': 'id'}
    });
    expect(
      await Composite.create({id: 'a', sk: 1}, {return: 'request', overwrite: true})
    ).toStrictEqual({
      Item: {id: {S: 'a'}, sk: {N: '1'}},
      TableName: 'T2'
    });
  });

  it('joins a create condition with the key condition as dynamoose does', async () => {
    expect(
      await Composite.create(
        {id: 'a', sk: 1},
        {return: 'request', condition: new Condition('n').eq(1)}
      )
    ).toStrictEqual({
      Item: {id: {S: 'a'}, sk: {N: '1'}},
      TableName: 'T2',
      ConditionExpression: '(#a0 = :v0) AND (attribute_not_exists(#__hash_key))',
      ExpressionAttributeNames: {'#a0': 'n', '#__hash_key': 'id'},
      ExpressionAttributeValues: {':v0': {N: '1'}}
    });
  });

  it('builds DeleteItem with a condition', async () => {
    expect(
      await Composite.delete(
        {id: 'a', sk: 1},
        {return: 'request', condition: Composite.condition().where('n').eq(1)}
      )
    ).toStrictEqual({
      Key: {id: {S: 'a'}, sk: {N: '1'}},
      TableName: 'T2',
      ConditionExpression: '#a0 = :v0',
      ExpressionAttributeNames: {'#a0': 'n'},
      ExpressionAttributeValues: {':v0': {N: '1'}}
    });
  });

  it('accepts a raw condition object', async () => {
    const condition = {
      ConditionExpression: '#x > :y',
      ExpressionAttributeNames: {'#x': 'n'},
      ExpressionAttributeValues: {':y': {N: '0'}}
    };
    expect(await Composite.delete({id: 'a', sk: 1}, {return: 'request', condition})).toStrictEqual({
      Key: {id: {S: 'a'}, sk: {N: '1'}},
      TableName: 'T2',
      ...condition
    });
  });
});

describe('keys', () => {
  it('runs the field transform on a key, and rawKey sends it as given', async () => {
    expect((await Email.get('Jane@Example.COM', {return: 'request'})).Key).toStrictEqual({
      email: {S: 'jane@example.com'}
    });
    expect(
      (await Email.delete({email: 'Jane@Example.COM'}, {return: 'request', rawKey: true})).Key
    ).toStrictEqual({
      email: {S: 'Jane@Example.COM'}
    });
  });

  it("hands the key's field transform a copy, so it cannot change the caller's bytes", async () => {
    const Bytes = model('B', z.object({id: z.instanceof(Buffer).transform((b) => b.fill(9))}), {
      hashKey: 'id'
    });
    const id = Buffer.from([1]);
    expect((await Bytes.get({id}, {return: 'request'})).Key).toStrictEqual({
      id: {B: Buffer.from([9])}
    });
    expect([...id]).toStrictEqual([1]);
  });

  // Zod answers a throwing sync transform with a rejected Promise; a discarded one ends a Node process.
  it('rejects a key whose transform throws, with no unhandled rejection', async () => {
    const Throwing = model(
      'X',
      z.object({
        id: z.string().transform((): string => {
          throw new Error('boom');
        })
      }),
      {hashKey: 'id'}
    );
    const unhandled: unknown[] = [];
    const record = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', record);
    try {
      await expect(Throwing.get('a', {return: 'request'})).rejects.toThrow(ConfigError);
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off('unhandledRejection', record);
    }
    expect(unhandled).toStrictEqual([]);
  });

  it('stores a Date key in its storage under rawKey', async () => {
    const ByDate = model('D', z.object({id: z.string(), at: z.date()}), {
      hashKey: 'id',
      rangeKey: 'at',
      dates: {at: 'seconds'}
    });
    expect(
      (await ByDate.get({id: 'a', at: new Date(1500)}, {return: 'request', rawKey: true})).Key
    ).toStrictEqual({
      id: {S: 'a'},
      at: {N: '2'}
    });
  });

  it('runs the hook once on the whole key, as dynamoose does', async () => {
    // The hook reads both key attributes: run per attribute, it would see `id` alone and leave `sk` unprefixed.
    const Hooked = model('H', z.object({id: z.string(), sk: z.string()}), {
      hashKey: 'id',
      rangeKey: 'sk',
      set: (item: Record<string, unknown>) =>
        typeof item.id === 'string' && typeof item.sk === 'string'
          ? {...item, sk: `${item.id}#${item.sk}`}
          : item
    });
    expect((await Hooked.get({id: 'a', sk: 'x'}, {return: 'request'})).Key).toStrictEqual({
      id: {S: 'a'},
      sk: {S: 'a#x'}
    });
    const Dropping = model('H', z.object({id: z.string(), sk: z.string()}), {
      hashKey: 'id',
      rangeKey: 'sk',
      set: (item: Record<string, unknown>) => ({id: item.id})
    });
    await expect(Dropping.get({id: 'a', sk: 'x'})).rejects.toThrow(
      new ExpressionError("the set hook of 'H' removed the key attribute 'sk'")
    );
  });

  it("hands the hook a copy of the key, so it cannot change the caller's bytes", async () => {
    const Binary = model('B', z.object({id: z.instanceof(Buffer)}), {
      hashKey: 'id',
      set: (item: Record<string, unknown>) => {
        (item.id as Buffer)[0] = 9;
        return item;
      }
    });
    const id = Buffer.from([1, 2]);
    expect((await Binary.get({id}, {return: 'request'})).Key).toStrictEqual({
      id: {B: Buffer.from([9, 2])}
    });
    expect([...id]).toStrictEqual([1, 2]);
  });

  // dynamoose reads a key attribute's name as it is: `a[0]` is a valid attribute name, not a list index.
  it('takes a key attribute name as given, never as a document path', async () => {
    const {client, send} = stub({Responses: {K: []}});
    const Bracket = model('K', z.object({'a[0]': z.string(), v: z.string().optional()}), {
      hashKey: 'a[0]',
      client
    });
    const Key = {'a[0]': {S: 'x'}};
    const key = {'a[0]': 'x'};
    expect((await Bracket.get(key, {return: 'request'})).Key).toStrictEqual(Key);
    expect((await Bracket.update(key, {v: 'y'}, {return: 'request'})).Key).toStrictEqual(Key);
    expect((await Bracket.delete(key, {return: 'request'})).Key).toStrictEqual(Key);
    expect((await Bracket.transaction.update(key, {v: 'y'})).Update.Key).toStrictEqual(Key);
    await Bracket.batchGet([key]);
    expect((send.mock.calls[0] as any)[0].input.RequestItems.K.Keys).toStrictEqual([Key]);
  });

  it('throws on a key without its range key', async () => {
    await expect(Composite.get({id: 'a'} as never)).rejects.toThrow(
      new ExpressionError("the key of 'T2' has no 'sk'")
    );
  });
});

describe('a required timestamp field', () => {
  const Stamped = model(
    'S',
    z.object({id: z.string(), createdAt: z.date(), updatedAt: z.number()}),
    {hashKey: 'id', timestamps: true}
  );

  it('writes the stamps where the schema requires them, and keeps a read createdAt', async () => {
    vi.useFakeTimers({toFake: ['Date'], now: new Date(1000)});
    expect((await Stamped.create({id: 'a'}, {return: 'request'})).Item).toStrictEqual({
      id: {S: 'a'},
      createdAt: {N: '1000'},
      updatedAt: {N: '1000'}
    });
    const saved = await Stamped.create(
      {id: 'a', createdAt: new Date(0)},
      {overwrite: true, keepCreatedAt: true, return: 'request'}
    );
    expect(saved.Item).toStrictEqual({
      id: {S: 'a'},
      createdAt: {N: '0'},
      updatedAt: {N: '1000'}
    });
    const legacy = await Stamped.create(
      {id: 'a'},
      {overwrite: true, keepCreatedAt: true, return: 'request'}
    );
    expect(legacy.Item).toStrictEqual({id: {S: 'a'}, updatedAt: {N: '1000'}});
  });
});

describe('validation messages', () => {
  const M = model(
    'V',
    z.object({
      id: z.string(),
      status: z.enum(['A', 'B']).optional(),
      n: z.number().optional(),
      meta: z.object({s: z.enum(['X'])}).optional()
    }),
    {hashKey: 'id'}
  );

  // The literals are dynamoose's messages for the same writes.
  it("tells an enum and a type mismatch in dynamoose's words, on create and on update", async () => {
    const message = (write: Promise<unknown>) =>
      write.then(
        () => 'resolved',
        (e: Error) => `${e.name}: ${e.message}`
      );
    expect([
      await message(M.create({id: 'i', status: 'C' as never}, {return: 'request'})),
      await message(M.create({id: 'i', n: 'x' as never}, {return: 'request'})),
      await message(M.create({id: 'i', meta: {s: 'Y' as never}}, {return: 'request'})),
      await message(M.update({id: 'i'}, {status: 'C' as never}, {return: 'request'})),
      await message(M.update({id: 'i'}, {n: null as never}, {return: 'request'}))
    ]).toStrictEqual([
      'ValidationError: status must equal ["A","B"], but is set to C',
      'ValidationError: Expected n to be of type number, instead found type string.',
      'ValidationError: meta.s must equal ["X"], but is set to Y',
      'ValidationError: status must equal ["A","B"], but is set to C',
      'ValidationError: Expected n to be of type number, instead found type null.'
    ]);
  });
});

describe('clients and tables', () => {
  it('uses the call client, then the model client, then setClient', async () => {
    const global = stub();
    const own = stub();
    const call = stub();
    const previous = getClient();
    setClient(global.client);
    try {
      const Plain = model('P', schema, {hashKey: 'id', rangeKey: 'sk'});
      const Own = model('O', schema, {hashKey: 'id', rangeKey: 'sk', client: own.client});
      await Plain.delete({id: 'a', sk: 1});
      await Own.delete({id: 'a', sk: 1});
      await Own.delete({id: 'a', sk: 1}, {client: call.client});
      expect([
        global.send.mock.calls.length,
        own.send.mock.calls.length,
        call.send.mock.calls.length
      ]).toStrictEqual([1, 1, 1]);
    } finally {
      setClient(previous);
    }
  });

  it("calls the aggregated client's own method, so a spy on ddb.getItem sees the request", async () => {
    const ddb = new DynamoDB({
      region: 'eu-west-1',
      credentials: {accessKeyId: 'x', secretAccessKey: 'x'}
    });
    const getItem = vi
      .spyOn(ddb, 'getItem')
      .mockResolvedValue({Item: {id: {S: 'a'}, sk: {N: '1'}}} as never);
    const send = vi.spyOn(ddb, 'send');
    const M = model('M', schema, {hashKey: 'id', rangeKey: 'sk', client: ddb});
    expect(await M.get({id: 'a', sk: 1})).toStrictEqual({id: 'a', sk: 1});
    expect(getItem).toHaveBeenCalledWith(
      {Key: {id: {S: 'a'}, sk: {N: '1'}}, TableName: 'M'},
      undefined
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('sends every request through a stand-in client that has the methods and no send', async () => {
    const calls: string[] = [];
    const reply = (name: string, out: object) => async () => (calls.push(name), out);
    const client = {
      getItem: reply('getItem', {}),
      putItem: reply('putItem', {}),
      updateItem: reply('updateItem', {}),
      deleteItem: reply('deleteItem', {}),
      query: reply('query', {Items: []}),
      scan: reply('scan', {Items: []}),
      batchGetItem: reply('batchGetItem', {}),
      batchWriteItem: reply('batchWriteItem', {}),
      transactWriteItems: reply('transactWriteItems', {})
    } as unknown as DynamoDBClient;
    const M = model('M', schema, {hashKey: 'id', rangeKey: 'sk'});
    const key = {id: 'a', sk: 1};
    await M.get(key, {client});
    await M.create(key, {client});
    await M.update(key, {n: 1}, {client});
    await M.delete(key, {client});
    await M.query('id').eq('a').exec({client});
    await M.scan().exec({client});
    await M.batchGet([key], {client});
    await M.batchPut([key], {client});
    await transaction([M.transaction.delete(key)], {client});
    expect(calls).toStrictEqual([
      'getItem',
      'putItem',
      'updateItem',
      'deleteItem',
      'query',
      'scan',
      'batchGetItem',
      'batchWriteItem',
      'transactWriteItems'
    ]);
  });

  it("passes a query's call abortSignal to every page request", async () => {
    const {client, send} = stub({Items: []});
    const M = model('M', schema, {hashKey: 'id', rangeKey: 'sk', client});
    const abortSignal = new AbortController().signal;
    await M.query('id').eq('a').exec({abortSignal});
    expect((send.mock.calls[0] as unknown[])[1]).toStrictEqual({abortSignal});
  });

  it('setClient() without a client goes back to a new default client, as aws.ddb.revert()', () => {
    const previous = getClient();
    try {
      const {client} = stub();
      setClient(client);
      setClient();
      expect(getClient()).not.toBe(client);
      expect(getClient()).not.toBe(previous);
    } finally {
      setClient(previous);
    }
  });

  it('names the table from setDefaults at call time, unless the model sets its own', async () => {
    const Own = model('Orders', schema, {hashKey: 'id', rangeKey: 'sk', prefix: 'app-'});
    setDefaults({prefix: 'svc-dev-', suffix: 'Table'});
    expect([Composite.tableName, Own.tableName]).toStrictEqual([
      'svc-dev-T2Table',
      'app-OrdersTable'
    ]);
    expect((await Composite.get({id: 'a', sk: 1}, {return: 'request'})).TableName).toBe(
      'svc-dev-T2Table'
    );
  });

  it('exposes the name and keys', () => {
    expect([Composite.name, Composite.hashKey, Composite.rangeKey, Email.rangeKey]).toStrictEqual([
      'T2',
      'id',
      'sk',
      undefined
    ]);
  });
});

describe('conditions on a model', () => {
  it('checks a new Condition against the model and sends nothing', async () => {
    const {client, send} = stub();
    await expect(
      Composite.create({id: 'a', sk: 1}, {client, condition: new Condition('nope').eq(1)})
    ).rejects.toThrow(new ExpressionError("'nope' is not an attribute of the model"));
    expect(send).not.toHaveBeenCalled();
  });
});

describe('createTableInput', () => {
  it('maps keys, index projections and Date storage to a CreateTable input', () => {
    const Indexed = model(
      'T',
      z.object({
        id: z.string(),
        sk: z.number(),
        email: z.string(),
        n: z.number(),
        loc: z.string(),
        p: z.string(),
        at: z.date()
      }),
      {
        hashKey: 'id',
        rangeKey: 'sk',
        dates: {at: 'milliseconds'},
        indexes: {
          email: {name: 'emailIdx', rangeKey: 'n'},
          loc: {type: 'local', project: false},
          p: {project: ['n']},
          at: {}
        }
      }
    );
    expect(Indexed.createTableInput()).toStrictEqual({
      TableName: 'T',
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        {AttributeName: 'id', AttributeType: 'S'},
        {AttributeName: 'sk', AttributeType: 'N'},
        {AttributeName: 'email', AttributeType: 'S'},
        {AttributeName: 'n', AttributeType: 'N'},
        {AttributeName: 'p', AttributeType: 'S'},
        {AttributeName: 'at', AttributeType: 'N'},
        {AttributeName: 'loc', AttributeType: 'S'}
      ],
      KeySchema: [
        {AttributeName: 'id', KeyType: 'HASH'},
        {AttributeName: 'sk', KeyType: 'RANGE'}
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'emailIdx',
          KeySchema: [
            {AttributeName: 'email', KeyType: 'HASH'},
            {AttributeName: 'n', KeyType: 'RANGE'}
          ],
          Projection: {ProjectionType: 'ALL'}
        },
        {
          IndexName: 'pGlobalIndex',
          KeySchema: [{AttributeName: 'p', KeyType: 'HASH'}],
          Projection: {ProjectionType: 'INCLUDE', NonKeyAttributes: ['n']}
        },
        {
          IndexName: 'atGlobalIndex',
          KeySchema: [{AttributeName: 'at', KeyType: 'HASH'}],
          Projection: {ProjectionType: 'ALL'}
        }
      ],
      LocalSecondaryIndexes: [
        {
          IndexName: 'locLocalIndex',
          KeySchema: [
            {AttributeName: 'id', KeyType: 'HASH'},
            {AttributeName: 'loc', KeyType: 'RANGE'}
          ],
          Projection: {ProjectionType: 'KEYS_ONLY'}
        }
      ]
    });
  });

  it('throws when the schema cannot give a key type', () => {
    expect(() => model('F', fixtureSchema, {hashKey: 'id'}).createTableInput()).toThrow(
      ConfigError
    );
  });
});

describe('compatibility helpers', () => {
  it('new Model(obj) is a plain copy of obj', () => {
    const input = {id: 'a', sk: 1};
    const item = new Composite(input);
    expect([Object.getPrototypeOf(item), item === input, item]).toStrictEqual([
      Object.prototype,
      false,
      {id: 'a', sk: 1}
    ]);
  });

  it('new Model(obj) copies nested objects and lists, as dynamoose', () => {
    const input = {id: 'a', sk: 1, meta: Object.freeze({tags: ['x']})};
    const item = new Composite(input as never) as unknown as typeof input;
    item.meta.tags.push('y');
    // A frozen fixture still gives an item the code under test can change.
    expect(() => Object.assign(item.meta, {extra: 1})).not.toThrow();
    expect(input).toStrictEqual({id: 'a', sk: 1, meta: {tags: ['x']}});
  });

  it('new Model(obj) prints in a snapshot as a dynamoose item does: ISO dates, no undefined keys', () => {
    const item = new Composite({id: 'a', sk: 1, at: new Date(0), n: undefined});
    // dynamoose's `new M(obj)` prints this text.
    expect(item).toMatchInlineSnapshot(`
      {
        "at": "1970-01-01T00:00:00.000Z",
        "id": "a",
        "sk": 1,
      }
    `);
    // The fields are what equality, spreads and writes see.
    expect(item).toStrictEqual({id: 'a', sk: 1, at: new Date(0), n: undefined});
    expect(Object.keys(item)).toStrictEqual(['id', 'sk', 'at', 'n']);
  });

  it('withDefaults() copies the item with its missing defaults, top-level and nested, unchecked', () => {
    const M = model(
      'D',
      z.object({
        id: z.string(),
        state: z.string().default('new'),
        n: z.number().min(5).optional(),
        meta: z.object({tag: z.string().default('t'), x: z.number().optional()}).optional()
      }),
      {hashKey: 'id'}
    );
    const input = {id: 'a', n: 1, meta: {x: 2}};
    expect(M.withDefaults(input)).toStrictEqual({
      id: 'a',
      n: 1,
      state: 'new',
      meta: {x: 2, tag: 't'}
    });
    expect(input).toStrictEqual({id: 'a', n: 1, meta: {x: 2}});
  });

  it("new Model(obj) keeps the obj's own toJSON, as a dynamoose item does", () => {
    const toJSONOf = () => ({id: 'custom'});
    const item = new Composite({id: 'a', sk: 1, toJSON: toJSONOf} as never);
    expect(JSON.stringify(item)).toBe('{"id":"custom"}');
  });

  it('a read item has the toJSON of a dynamoose item too, not enumerable', async () => {
    const {client} = stub({
      Item: {id: {S: 'a'}, sk: {N: '1'}, at: {N: '0'}}
    });
    const item = await Composite.get({id: 'a', sk: 1}, {client});
    expect(item).toMatchInlineSnapshot(`
      {
        "at": "1970-01-01T00:00:00.000Z",
        "id": "a",
        "sk": 1,
      }
    `);
    expect((item as unknown as {toJSON(): unknown}).toJSON()).toStrictEqual({
      id: 'a',
      sk: 1,
      at: '1970-01-01T00:00:00.000Z'
    });
    expect(item).toStrictEqual({id: 'a', sk: 1, at: new Date(0)});
  });

  it('toJSON is a JSON round trip, as dynamoose', () => {
    expect(toJSON({at: new Date(0), tags: new Set(['a']), u: undefined})).toStrictEqual({
      at: '1970-01-01T00:00:00.000Z',
      tags: {}
    });
    expect(toJSON([{n: 1}])).toStrictEqual([{n: 1}]);
  });

  it('fromStored reads a stored item as get does', () => {
    expect(
      Composite.fromStored({
        id: {S: 'a'},
        sk: {N: '1'},
        at: {N: '0'},
        extra: {S: 'x'}
      })
    ).toStrictEqual({
      id: 'a',
      sk: 1,
      at: new Date(0)
    });
  });
});

describe('isConditionalCheckFailed', () => {
  it('matches the SDK error by name only', () => {
    const sdk = Object.assign(new Error('The conditional request failed'), {
      name: 'ConditionalCheckFailedException'
    });
    expect([
      isConditionalCheckFailed(sdk),
      isConditionalCheckFailed(new Error('x')),
      isConditionalCheckFailed({name: sdk.name})
    ]).toStrictEqual([true, false, false]);
  });
});
