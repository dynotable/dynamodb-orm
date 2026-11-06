import type {AttributeValue, DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {model, ValidationError} from '../src/index.js';

type Stored = Record<string, AttributeValue>;
type Input = {RequestItems: Record<string, any>};
// `reply` answers each request; by default DynamoDB processes everything and finds every key.
const stub = (reply?: (input: Input, call: number) => object) => {
  const inputs: Input[] = [];
  const send = vi.fn(async (command: {input: Input}) => {
    inputs.push(command.input);
    if (reply) return reply(command.input, inputs.length);
    const request = command.input.RequestItems.B;
    return Array.isArray(request)
      ? {UnprocessedItems: {}}
      : {Responses: {B: request.Keys}, UnprocessedKeys: {}};
  });
  return {client: {send} as unknown as DynamoDBClient, inputs, send};
};
const define = (client: DynamoDBClient) =>
  model(
    'B',
    z.object({
      id: z.string(),
      n: z
        .number()
        .refine((n) => n >= 0)
        .optional()
    }),
    {hashKey: 'id', client}
  );
const ids = (count: number) => Array.from({length: count}, (_, i) => `k${i}`);
const sizes = (inputs: Input[]) =>
  inputs.map((i) =>
    Array.isArray(i.RequestItems.B) ? i.RequestItems.B.length : i.RequestItems.B.Keys.length
  );

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('chunks', () => {
  it('reads 100 keys per request', async () => {
    const one = stub();
    await define(one.client).batchGet(ids(100));
    const two = stub();
    await define(two.client).batchGet(ids(101));
    expect([sizes(one.inputs), sizes(two.inputs)]).toStrictEqual([[100], [100, 1]]);
  });

  it('writes 25 items per request', async () => {
    const one = stub();
    await define(one.client).batchPut(ids(25).map((id) => ({id})));
    const two = stub();
    await define(two.client).batchDelete(ids(26));
    expect([sizes(one.inputs), sizes(two.inputs)]).toStrictEqual([[25], [25, 1]]);
  });
});

it('sends the request with the stored keys, consistent read and a projection holding the key', async () => {
  const {client, inputs} = stub();
  await define(client).batchGet(['a', {id: 'b'}], {consistent: true, attributes: ['n']});
  expect(inputs).toStrictEqual([
    {
      RequestItems: {
        B: {
          ConsistentRead: true,
          ProjectionExpression: '#a0, #a1',
          ExpressionAttributeNames: {'#a0': 'n', '#a1': 'id'},
          Keys: [{id: {S: 'a'}}, {id: {S: 'b'}}]
        }
      }
    }
  ]);
});

it('returns the items in the order of the keys, without the missing ones', async () => {
  const {client} = stub(() => ({
    Responses: {
      B: [
        {id: {S: 'c'}, n: {N: '3'}},
        {id: {S: 'a'}, n: {N: '1'}}
      ]
    }
  }));
  const result = await define(client).batchGet(['a', 'b', 'c']);
  expect([...result]).toStrictEqual([
    {id: 'a', n: 1},
    {id: 'c', n: 3}
  ]);
  expect(result.unprocessedKeys).toStrictEqual([]);
});

it('throws before sending for a key given twice', async () => {
  const {client, send} = stub();
  const M = define(client);
  await expect(M.batchGet(['a', {id: 'a'}])).rejects.toThrow('twice');
  await expect(M.batchPut([{id: 'a'}, {id: 'a', n: 1}])).rejects.toThrow('twice');
  await expect(M.batchDelete(['a', 'a'])).rejects.toThrow('twice');
  expect(send).not.toHaveBeenCalled();
});

describe('keys as DynamoDB returns them', () => {
  // The SDK returns bytes as a Uint8Array and a number in DynamoDB's normal form, not the request's bytes.
  it('places a binary key returned as a Uint8Array', async () => {
    const {client} = stub(() => ({Responses: {B: [{id: {B: new Uint8Array([1, 2])}}]}}));
    const M = model('B', z.object({id: z.instanceof(Buffer)}), {hashKey: 'id', client});
    const result = await M.batchGet([Buffer.from([1, 2])]);
    expect([[...result], result.unprocessedKeys]).toStrictEqual([[{id: Buffer.from([1, 2])}], []]);
  });

  it('places a number key returned in another notation', async () => {
    const {client} = stub(() => ({Responses: {B: [{id: {N: '1E-7'}}]}}));
    const M = model('B', z.object({id: z.number()}), {hashKey: 'id', client});
    const result = await M.batchGet([1e-7]);
    expect([[...result], result.unprocessedKeys]).toStrictEqual([[{id: 1e-7}], []]);
  });

  it('reports a binary key left unprocessed', async () => {
    vi.useFakeTimers();
    const {client} = stub(() => ({
      UnprocessedItems: {B: [{DeleteRequest: {Key: {id: {B: new Uint8Array([1, 2])}}}}]}
    }));
    const M = model('B', z.object({id: z.instanceof(Buffer)}), {hashKey: 'id', client});
    const done = M.batchDelete([Buffer.from([1, 2])]);
    await vi.runAllTimersAsync();
    expect(await done).toStrictEqual({unprocessedItems: [{id: Buffer.from([1, 2])}]});
  });
});

describe('unprocessed items', () => {
  const unprocessedFirst = (input: Input, call: number) => {
    const request = input.RequestItems.B;
    if (call === 1)
      return {
        Responses: {B: request.Keys.slice(0, 1)},
        UnprocessedKeys: {B: {Keys: request.Keys.slice(1)}}
      };
    return {Responses: {B: request.Keys}};
  };

  it('are sent again after a full-jitter exponential backoff', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    // Unprocessed for the first 3 sends: the waits are 0.5 × 50 ms × 2^attempt.
    const {client, inputs} = stub((input, call) => {
      const {Keys} = input.RequestItems.B;
      return call <= 3
        ? {Responses: {B: []}, UnprocessedKeys: {B: {Keys}}}
        : {Responses: {B: Keys}};
    });
    const done = define(client).batchGet(['a']);
    // Sends at 0, 25, 75 and 175 ms.
    const sends: number[] = [];
    for (const ms of [0, 24, 1, 49, 1, 100]) {
      await vi.advanceTimersByTimeAsync(ms);
      sends.push(inputs.length);
    }
    expect(sends).toStrictEqual([1, 1, 2, 2, 3, 4]);
    expect([...(await done)]).toStrictEqual([{id: 'a'}]);
  });

  it('are only the ones DynamoDB left', async () => {
    vi.useFakeTimers();
    const {client, inputs} = stub(unprocessedFirst);
    const done = define(client).batchGet(['a', 'b']);
    await vi.runAllTimersAsync();
    expect([...(await done)]).toStrictEqual([{id: 'a'}, {id: 'b'}]);
    expect(inputs.map((i) => i.RequestItems.B.Keys)).toStrictEqual([
      [{id: {S: 'a'}}, {id: {S: 'b'}}],
      [{id: {S: 'b'}}]
    ]);
  });

  it('are returned in dynamoose shapes when the 5 retries run out, without throwing', async () => {
    vi.useFakeTimers();
    // DynamoDB processes 'a', 'p' and 'd', and never the others.
    const done = (av: Stored) => ['a', 'p', 'd'].includes(av.id!.S!);
    const never = (input: Input) => {
      const request = input.RequestItems.B;
      if (Array.isArray(request)) {
        return {
          UnprocessedItems: {
            B: request.filter((r) => !done(r.PutRequest?.Item ?? r.DeleteRequest.Key))
          }
        };
      }
      return {
        Responses: {B: request.Keys.filter(done)},
        UnprocessedKeys: {B: {Keys: request.Keys.filter((k: Stored) => !done(k))}}
      };
    };
    const {client, send} = stub(never);
    const M = define(client);
    const read = M.batchGet(['a', 'b']);
    const put = M.batchPut([
      {id: 'p', n: 1},
      {id: 'q', n: 2}
    ]);
    const removed = M.batchDelete(['d', 'e']);
    await vi.runAllTimersAsync();
    const result = await read;
    expect([[...result], result.unprocessedKeys]).toStrictEqual([[{id: 'a'}], [{id: 'b'}]]);
    expect(await put).toStrictEqual({unprocessedItems: [{id: 'q', n: 2}]});
    expect(await removed).toStrictEqual({unprocessedItems: [{id: 'e'}]});
    expect(send).toHaveBeenCalledTimes(18);
  });
});

describe('batchRetries', () => {
  it('0 sends each chunk once and returns what is left, as dynamoose does', async () => {
    const {client, send} = stub((input) => ({
      Responses: {B: []},
      UnprocessedKeys: {B: {Keys: input.RequestItems.B.Keys}}
    }));
    const M = model('B', z.object({id: z.string()}), {hashKey: 'id', client, batchRetries: 0});
    expect((await M.batchGet(['a'])).unprocessedKeys).toStrictEqual([{id: 'a'}]);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('rejections', () => {
  it('an SDK rejection in one chunk rejects the call', async () => {
    const error = new Error('throttled');
    const {client} = stub((input, call) => {
      if (call === 2) throw error;
      return {UnprocessedItems: {}};
    });
    await expect(define(client).batchDelete(ids(30))).rejects.toBe(error);
  });

  it('a batchPut item the schema rejects rejects the call before sending', async () => {
    const {client, send} = stub();
    await expect(
      define(client).batchPut([
        {id: 'a', n: 1},
        {id: 'b', n: -1}
      ])
    ).rejects.toThrow(ValidationError);
    expect(send).not.toHaveBeenCalled();
  });

  // A sync rejection while the array of validations is built left the earlier async one unawaited: a Node
  // process ends on its rejection.
  it('a batchPut item that throws at once leaves no unhandled rejection of an earlier async validation', async () => {
    const {client, send} = stub();
    const Async = model(
      'B',
      z.object({id: z.string(), n: z.number().refine(async (n) => n >= 0)}),
      {hashKey: 'id', client}
    );
    const unhandled: unknown[] = [];
    const record = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', record);
    try {
      await expect(
        Async.batchPut([
          {id: 'a', n: -1},
          {id: 'b', n: 'x' as unknown as number}
        ])
      ).rejects.toThrow(ValidationError);
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off('unhandledRejection', record);
    }
    expect(unhandled).toStrictEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
});
