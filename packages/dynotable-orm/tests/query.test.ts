import type {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {Condition, ExpressionError, model} from '../src/index.js';

type Page = {Items?: object[]; Count?: number; ScannedCount?: number; LastEvaluatedKey?: object};
const stub = (reply: (input: any) => Page = () => ({Items: [], Count: 0, ScannedCount: 0})) => {
  const inputs: any[] = [];
  const send = vi.fn(async (command: {input: unknown}) => {
    inputs.push(command.input);
    return reply(command.input);
  });
  return {client: {send} as unknown as DynamoDBClient, inputs};
};

const schema = z.object({
  id: z.string(),
  sk: z.number(),
  status: z.string().optional(),
  n: z.number().optional(),
  at: z.string().optional(),
  email: z.string().toLowerCase().optional()
});
const define = (client: DynamoDBClient) =>
  model('Q', schema, {
    hashKey: 'id',
    rangeKey: 'sk',
    client,
    indexes: {
      status: [
        {name: 'status-index', rangeKey: 'n'},
        {name: 'status-at', rangeKey: 'at'}
      ]
    }
  });

afterEach(() => {
  vi.useRealTimers();
});

// The literals are what a dynamoose 4.x build gives with getRequest() for the same chain and schema.
describe('the request', () => {
  const request = async (build: (M: ReturnType<typeof define>) => {exec(): Promise<unknown>}) => {
    const {client, inputs} = stub();
    await build(define(client)).exec();
    return inputs;
  };

  it("moves the key conditions into KeyConditionExpression with dynamoose's placeholders", async () => {
    expect(await request((M) => M.query({id: 'x', sk: {gt: 1}}))).toStrictEqual([
      {
        TableName: 'Q',
        KeyConditionExpression: '#qha = :qhv AND #qra > :qrv',
        ExpressionAttributeNames: {'#qha': 'id', '#qra': 'sk'},
        ExpressionAttributeValues: {':qhv': {S: 'x'}, ':qrv': {N: '1'}}
      }
    ]);
    expect(await request((M) => M.query('id').eq('x').where('sk').between(1, 3))).toStrictEqual([
      {
        TableName: 'Q',
        KeyConditionExpression: '#qha = :qhv AND #qra BETWEEN :qrv_1 AND :qrv_2',
        ExpressionAttributeNames: {'#qha': 'id', '#qra': 'sk'},
        ExpressionAttributeValues: {':qhv': {S: 'x'}, ':qrv_1': {N: '1'}, ':qrv_2': {N: '3'}}
      }
    ]);
  });

  it('numbers the filter as dynamoose does, counting the moved key condition', async () => {
    expect(await request((M) => M.query('id').eq('x').where('n').ge(2))).toStrictEqual([
      {
        TableName: 'Q',
        KeyConditionExpression: '#qha = :qhv',
        FilterExpression: '#a1 >= :v1',
        ExpressionAttributeNames: {'#qha': 'id', '#a1': 'n'},
        ExpressionAttributeValues: {':qhv': {S: 'x'}, ':v1': {N: '2'}}
      }
    ]);
    expect(await request((M) => M.query('n').ge(2).where('id').eq('x'))).toStrictEqual([
      {
        TableName: 'Q',
        KeyConditionExpression: '#qha = :qhv',
        FilterExpression: '#a0 >= :v0',
        ExpressionAttributeNames: {'#qha': 'id', '#a0': 'n'},
        ExpressionAttributeValues: {':qhv': {S: 'x'}, ':v0': {N: '2'}}
      }
    ]);
  });

  it('runs the field transform on a filter value', async () => {
    expect(
      (await request((M) => M.query('id').eq('x').where('email').eq('A@B.C')))[0]
        .ExpressionAttributeValues
    ).toStrictEqual({
      ':qhv': {S: 'x'},
      ':v1': {S: 'a@b.c'}
    });
  });

  it('picks the index whose range key is in the conditions, else the first one on the hash', async () => {
    expect(await request((M) => M.query('status').eq('open'))).toStrictEqual([
      {
        TableName: 'Q',
        IndexName: 'status-index',
        KeyConditionExpression: '#qha = :qhv',
        ExpressionAttributeNames: {'#qha': 'status'},
        ExpressionAttributeValues: {':qhv': {S: 'open'}}
      }
    ]);
    expect(
      (await request((M) => M.query('status').eq('open').where('at').lt('z')))[0]
    ).toMatchObject({
      IndexName: 'status-at',
      KeyConditionExpression: '#qha = :qhv AND #qra < :qrv'
    });
  });

  it('sends the settings, reusing a key placeholder in the projection', async () => {
    const chain = (M: ReturnType<typeof define>) =>
      M.query('id')
        .eq('x')
        .limit(2)
        .sort('descending')
        .consistent()
        .attributes(['id', 'n'])
        .startAt({id: 'x', sk: 1});
    expect(await request(chain)).toStrictEqual([
      {
        TableName: 'Q',
        KeyConditionExpression: '#qha = :qhv',
        ExpressionAttributeNames: {'#qha': 'id', '#a1': 'n'},
        ExpressionAttributeValues: {':qhv': {S: 'x'}},
        Limit: 2,
        ExclusiveStartKey: {id: {S: 'x'}, sk: {N: '1'}},
        ConsistentRead: true,
        ScanIndexForward: false,
        ProjectionExpression: '#a1, #qha'
      }
    ]);
  });

  it('builds a scan: a filter only, an index, a count and one request per segment', async () => {
    expect(await request((M) => M.scan())).toStrictEqual([{TableName: 'Q'}]);
    expect(await request((M) => M.scan('n').gt(1).where('status').eq('a'))).toStrictEqual([
      {
        TableName: 'Q',
        FilterExpression: '#a0 > :v0 AND #a1 = :v1',
        ExpressionAttributeNames: {'#a0': 'n', '#a1': 'status'},
        ExpressionAttributeValues: {':v0': {N: '1'}, ':v1': {S: 'a'}}
      }
    ]);
    const segment = {
      TableName: 'Q',
      Limit: 5,
      IndexName: 'status-index',
      Select: 'COUNT',
      TotalSegments: 2
    };
    expect(
      await request((M) => M.scan().parallel(2).limit(5).using('status-index').count())
    ).toStrictEqual([
      {...segment, Segment: 0},
      {...segment, Segment: 1}
    ]);
    expect(await request((M) => M.scan().startAt({id: {S: 'x'}, sk: {N: '1'}}))).toStrictEqual([
      {TableName: 'Q', ExclusiveStartKey: {id: {S: 'x'}, sk: {N: '1'}}}
    ]);
  });

  it('starts at the beginning for an empty key, which DynamoDB rejects as ExclusiveStartKey', async () => {
    expect(await request((M) => M.scan().startAt({}))).toStrictEqual([{TableName: 'Q'}]);
  });

  it("refuses a parallel scan's lastKey array", () => {
    const {client} = stub();
    expect(() =>
      define(client)
        .scan()
        .startAt([{id: 'x'}] as never)
    ).toThrow(
      new ExpressionError(
        "startAt() takes one key: a parallel scan's lastKey array has one key per segment"
      )
    );
  });

  it('marshals a plain start key holding a Date by its storage', async () => {
    const {client, inputs} = stub();
    const Dated = model('D', z.object({id: z.string(), at: z.date()}), {
      hashKey: 'id',
      rangeKey: 'at',
      dates: {at: 'seconds'},
      client
    });
    await Dated.query('id')
      .eq('x')
      .startAt({id: 'x', at: new Date(1500)})
      .exec();
    expect(inputs[0].ExclusiveStartKey).toStrictEqual({id: {S: 'x'}, at: {N: '2'}});
  });

  it('numbers in/between filters and projections as dynamoose', async () => {
    expect(
      await request((M) =>
        M.query('id')
          .eq('x')
          .where('status')
          .in(['a', 'b'])
          .where('n')
          .between(1, 2)
          .attributes(['status', 'at', 'id'])
      )
    ).toStrictEqual([
      {
        TableName: 'Q',
        KeyConditionExpression: '#qha = :qhv',
        FilterExpression: '#a1 IN (:v1_1, :v1_2) AND #a2 BETWEEN :v2_1 AND :v2_2',
        ProjectionExpression: '#a1, #a3, #qha',
        ExpressionAttributeNames: {'#a1': 'status', '#a2': 'n', '#qha': 'id', '#a3': 'at'},
        ExpressionAttributeValues: {
          ':v1_1': {S: 'a'},
          ':v1_2': {S: 'b'},
          ':v2_1': {N: '1'},
          ':v2_2': {N: '2'},
          ':qhv': {S: 'x'}
        }
      }
    ]);
    expect(await request((M) => M.scan('status').eq('a').attributes(['n']))).toStrictEqual([
      {
        TableName: 'Q',
        FilterExpression: '#a0 = :v0',
        ProjectionExpression: '#a1',
        ExpressionAttributeNames: {'#a0': 'status', '#a1': 'n'},
        ExpressionAttributeValues: {':v0': {S: 'a'}}
      }
    ]);
  });

  it("renames a raw filter's placeholder that the key condition already uses", async () => {
    const raw = {
      ConditionExpression: '#qha = :qhv',
      ExpressionAttributeNames: {'#qha': 'n'},
      ExpressionAttributeValues: {':qhv': {N: '1'}}
    };
    expect(
      await request((M) => M.query('id').eq('x').where('n').eq(2).group(new Condition<any>(raw)))
    ).toStrictEqual([
      {
        TableName: 'Q',
        KeyConditionExpression: '#qha = :qhv',
        FilterExpression: '#a1 = :v1 AND (#a3 = :v2)',
        ExpressionAttributeNames: {'#qha': 'id', '#a1': 'n', '#a3': 'n'},
        ExpressionAttributeValues: {':qhv': {S: 'x'}, ':v1': {N: '2'}, ':v2': {N: '1'}}
      }
    ]);
  });
});

describe('a query no index can serve', () => {
  const rejects = async (build: (M: any) => {exec(): Promise<unknown>}, message: string) => {
    const {client, inputs} = stub();
    await expect(build(define(client)).exec()).rejects.toThrow(new ExpressionError(message));
    expect(inputs).toStrictEqual([]);
  };

  it('throws before sending without an equality on a hash key', async () => {
    await rejects(
      (M) => M.query('n').eq(1),
      'no index fits the query: it needs an equality on a hash key'
    );
  });

  it('throws before sending when the key conditions are joined with OR', async () => {
    await rejects(
      (M) => M.query('id').eq('x').or().where('n').eq(1),
      'no index fits the query: it needs an equality on a hash key'
    );
  });

  it('throws before sending when the named index has no equality on its hash key', async () => {
    await rejects(
      (M) => M.query('id').eq('x').using('status-at'),
      "the query needs an equality on the hash key 'status'"
    );
  });

  it('throws before sending on an index the model does not declare', async () => {
    await rejects(
      (M) => M.query('id').eq('x').using('nope'),
      "'nope' is not an index of the model"
    );
  });
});

describe('the result', () => {
  it('counts with ScannedCount, which dynamoose reads as an undefined QueriedCount', async () => {
    const {client} = stub(() => ({Count: 2, ScannedCount: 5}));
    expect(await define(client).query('id').eq('x').count().exec()).toStrictEqual({
      count: 2,
      queriedCount: 5
    });
  });

  it("gives a parallel scan's last key as one key, or one per unfinished segment", async () => {
    const lastAt = (segments: number[]) =>
      stub((input) => ({
        Items: [],
        Count: 0,
        ScannedCount: 0,
        ...(segments.includes(input.Segment) && {
          LastEvaluatedKey: {id: {S: `s${input.Segment}`}, sk: {N: '1'}}
        })
      })).client;
    expect(
      (
        await define(lastAt([1]))
          .scan()
          .parallel(3)
          .exec()
      ).lastKey
    ).toStrictEqual({id: 's1', sk: 1});
    expect(
      (
        await define(lastAt([0, 2]))
          .scan()
          .parallel(3)
          .exec()
      ).lastKey
    ).toStrictEqual([
      {id: 's0', sk: 1},
      {id: 's2', sk: 1}
    ]);
  });

  it('waits the all() delay before each next page', async () => {
    vi.useFakeTimers();
    const {client, inputs} = stub((input) => ({
      Items: [],
      Count: 0,
      ScannedCount: 0,
      ...(!input.ExclusiveStartKey && {LastEvaluatedKey: {id: {S: 'x'}, sk: {N: '1'}}})
    }));
    const done = define(client).query('id').eq('x').all(100).exec();
    await vi.advanceTimersByTimeAsync(99);
    expect(inputs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await done).timesQueried).toBe(2);
  });
});
