// Before any timing means anything, every contender must do the same work: send the expected request and
// return the expected item. Runs against the built dist and the built .bench/ (`pnpm test:bench` builds both).
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';
import {type ContenderName, PACKAGE, setup, stub, type Suite} from './bench.js';
import {orderData} from './schemas.js';

const NOW = '2026-01-02T03:04:05.999Z';
// dynamoose's PutItem request for orderData() at NOW.
const orderItem = JSON.parse(
  readFileSync(new URL('./fixtures/order-item.json', import.meta.url), 'utf8')
);
const smallItem = {
  id: {S: 'small-1'},
  name: {S: 'Test User'},
  email: {S: 'test@example.com'},
  age: {N: '25'},
  active: {BOOL: true}
};
const orderKey = {id: {S: '0123456789abcdef0123456789abcdef01234567'}};
const ifAbsent = {
  ConditionExpression: 'attribute_not_exists(#__hash_key)',
  ExpressionAttributeNames: {'#__hash_key': 'id'}
};
const rawIfAbsent = {
  ConditionExpression: 'attribute_not_exists(#id)',
  ExpressionAttributeNames: {'#id': 'id'}
};

let suites: Suite[];
beforeAll(async () => {
  vi.useFakeTimers({toFake: ['Date'], now: new Date(NOW)});
  suites = await setup();
});
afterAll(() => {
  vi.useRealTimers();
});

async function call(schema: string, operation: string, name: ContenderName) {
  const c = suites
    .find((s) => s.schema === schema && s.operation === operation)!
    .contenders.find((x) => x.name === name)!;
  stub.last = undefined;
  const result = await c.run(c.prepare());
  return {request: stub.last, result};
}
// dynamoose returns Item instances; their own properties are the item (toJSON would turn a Set into {}).
const plain = (x: any) => ({...x});

describe('write contenders send the expected request', () => {
  it('order create', async () => {
    for (const name of ['lib', 'dynamoose'] as const) {
      expect((await call('order', 'create', name)).request).toStrictEqual({
        command: 'PutItemCommand',
        input: {TableName: 'Bench_order', Item: orderItem, ...ifAbsent}
      });
    }
    expect((await call('order', 'create', 'raw')).request).toStrictEqual({
      command: 'PutItemCommand',
      input: {TableName: 'Bench_order', Item: orderItem, ...rawIfAbsent}
    });
  });

  it('order update', async () => {
    const values = {
      ':v0': {S: NOW},
      ':v1': {S: 'SHIPPED'},
      ':v2': {S: 'S000'},
      ':v3': {S: 'Shipped'},
      ':v4': {M: {status: {S: 'PENDING'}}}
    };
    for (const name of ['lib', 'dynamoose'] as const) {
      expect((await call('order', 'update', name)).request).toStrictEqual({
        command: 'UpdateItemCommand',
        input: {
          TableName: 'Bench_order',
          Key: orderKey,
          UpdateExpression: 'SET #a0 = :v0, #a1 = :v1, #a2 = :v2, #a3 = :v3, #a4 = :v4',
          ExpressionAttributeNames: {
            '#a0': 'updatedAt',
            '#a1': 'status',
            '#a2': 'statusCode',
            '#a3': 'statusMessage',
            '#a4': 'notification'
          },
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW'
        }
      });
    }
    expect((await call('order', 'update', 'raw')).request).toStrictEqual({
      command: 'UpdateItemCommand',
      input: {
        TableName: 'Bench_order',
        Key: orderKey,
        UpdateExpression:
          'SET #updatedAt = :updatedAt, #status = :status, #statusCode = :statusCode, #statusMessage = :statusMessage, #notification = :notification',
        ExpressionAttributeNames: {
          '#updatedAt': 'updatedAt',
          '#status': 'status',
          '#statusCode': 'statusCode',
          '#statusMessage': 'statusMessage',
          '#notification': 'notification'
        },
        ExpressionAttributeValues: {
          ':updatedAt': {S: NOW},
          ':status': {S: 'SHIPPED'},
          ':statusCode': {S: 'S000'},
          ':statusMessage': {S: 'Shipped'},
          ':notification': {M: {status: {S: 'PENDING'}}}
        },
        ReturnValues: 'ALL_NEW'
      }
    });
  });

  // dynamoose has no contender here: it writes a top-level attribute named "notification.status".
  it('order update-nested', async () => {
    expect((await call('order', 'update-nested', 'lib')).request).toStrictEqual({
      command: 'UpdateItemCommand',
      input: {
        TableName: 'Bench_order',
        Key: orderKey,
        UpdateExpression: 'SET #a0 = :v0, #a1.#a2 = :v1, #a3.#a4 = :v3',
        ExpressionAttributeNames: {
          '#a0': 'updatedAt',
          '#a1': 'notification',
          '#a2': 'status',
          '#a3': 'details',
          '#a4': 'refundedAmount'
        },
        ExpressionAttributeValues: {':v0': {S: NOW}, ':v1': {S: 'SENT'}, ':v3': {N: '4250'}},
        ReturnValues: 'ALL_NEW'
      }
    });
    expect((await call('order', 'update-nested', 'raw')).request).toStrictEqual({
      command: 'UpdateItemCommand',
      input: {
        TableName: 'Bench_order',
        Key: orderKey,
        UpdateExpression:
          'SET #updatedAt = :updatedAt, #notification.#status = :status, #details.#refundedAmount = :refundedAmount',
        ExpressionAttributeNames: {
          '#updatedAt': 'updatedAt',
          '#notification': 'notification',
          '#status': 'status',
          '#details': 'details',
          '#refundedAmount': 'refundedAmount'
        },
        ExpressionAttributeValues: {
          ':updatedAt': {S: NOW},
          ':status': {S: 'SENT'},
          ':refundedAmount': {N: '4250'}
        },
        ReturnValues: 'ALL_NEW'
      }
    });
  });

  it('small create and update', async () => {
    for (const name of ['lib', 'dynamoose'] as const) {
      expect((await call('small', 'create', name)).request).toStrictEqual({
        command: 'PutItemCommand',
        input: {TableName: 'Bench_small', Item: smallItem, ...ifAbsent}
      });
      expect((await call('small', 'update', name)).request).toStrictEqual({
        command: 'UpdateItemCommand',
        input: {
          TableName: 'Bench_small',
          Key: {id: {S: 'small-1'}},
          UpdateExpression: 'SET #a0 = :v0',
          ExpressionAttributeNames: {'#a0': 'name'},
          ExpressionAttributeValues: {':v0': {S: 'Updated Name'}},
          ReturnValues: 'ALL_NEW'
        }
      });
    }
    expect((await call('small', 'create', 'raw')).request).toStrictEqual({
      command: 'PutItemCommand',
      input: {TableName: 'Bench_small', Item: smallItem, ...rawIfAbsent}
    });
    expect((await call('small', 'update', 'raw')).request).toStrictEqual({
      command: 'UpdateItemCommand',
      input: {
        TableName: 'Bench_small',
        Key: {id: {S: 'small-1'}},
        UpdateExpression: 'SET #name = :name',
        ExpressionAttributeNames: {'#name': 'name'},
        ExpressionAttributeValues: {':name': {S: 'Updated Name'}},
        ReturnValues: 'ALL_NEW'
      }
    });
  });
});

describe('read contenders return the expected items', () => {
  // The ORMs read the iso timestamps as Dates; raw unmarshalls, so it keeps the strings.
  const read = (name: ContenderName, data: Record<string, unknown>, timestamps: boolean) =>
    timestamps
      ? {
          ...data,
          createdAt: name === 'raw' ? NOW : new Date(NOW),
          updatedAt: name === 'raw' ? NOW : new Date(NOW)
        }
      : data;
  const small = (id: string) => ({
    id,
    name: 'Test User',
    email: 'test@example.com',
    age: 25,
    active: true
  });

  it.each(['lib', 'raw', 'dynamoose'] as const)('get, %s', async (name) => {
    expect(plain((await call('order', 'get', name)).result)).toStrictEqual(
      read(name, orderData(), true)
    );
    expect(plain((await call('small', 'get', name)).result)).toStrictEqual(small('small-1'));
  });

  it.each(['lib', 'raw', 'dynamoose'] as const)('query of 100 items, %s', async (name) => {
    const order = (await call('order', 'query', name)) as {request: any; result: unknown[]};
    expect(order.request.input.IndexName).toBe('externalOrderId-index');
    expect([...order.result].map(plain)).toStrictEqual(
      Array.from({length: 100}, (_, i) =>
        read(name, orderData(i.toString(16).padStart(40, '0')), true)
      )
    );
    const smallRows = (await call('small', 'query', name)) as {request: any; result: unknown[]};
    expect(smallRows.request.input.IndexName).toBe('email-index');
    expect([...smallRows.result].map(plain)).toStrictEqual(
      Array.from({length: 100}, (_, i) => small(`small-${i}`))
    );
  });
});

// A dropped row or contender would make a comparison silently incomplete.
describe('pnpm bench --quick', () => {
  it('reports every schema × operation row, with every contender measured', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dynotable-bench-'));
    try {
      const file = join(directory, 'results.json');
      execFileSync(
        process.execPath,
        [
          '--expose-gc',
          join(PACKAGE, '.bench/bench.js'),
          '--quick',
          '--rounds',
          '1',
          '--json',
          file
        ],
        {stdio: 'pipe'}
      );
      const {results} = JSON.parse(readFileSync(file, 'utf8')) as {
        results: Array<{schema: string; operation: string; samples: Record<string, number[]>}>;
      };
      expect(results.map((r) => `${r.schema} ${r.operation}`)).toStrictEqual([
        'order create',
        'order get',
        'order update',
        'order update-nested',
        'order query',
        'small create',
        'small get',
        'small update',
        'small query'
      ]);
      for (const r of results) {
        expect(Object.keys(r.samples).sort()).toStrictEqual(
          r.operation === 'update-nested' ? ['lib', 'raw'] : ['dynamoose', 'lib', 'raw']
        );
        for (const samples of Object.values(r.samples))
          expect(samples.every((x) => Number.isFinite(x) && x > 0)).toBe(true);
      }
    } finally {
      rmSync(directory, {recursive: true, force: true});
    }
  }, 120_000);
});
