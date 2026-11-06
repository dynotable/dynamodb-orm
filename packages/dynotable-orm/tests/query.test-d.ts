import {describe, expectTypeOf, it} from 'vitest';
import {z} from 'zod';
import {
  model,
  type ParallelScanResponse,
  type Query,
  type QueryResponse,
  type Scan,
  type ScanResponse
} from '../src/index.js';
import {hashKey, index} from '../src/zod/index.js';

const schema = z.object({
  id: z.string(),
  sk: z.number(),
  status: z.string().optional(),
  n: z.number().optional(),
  email: z.string().optional(),
  note: z.string().optional()
});
type Item = z.output<typeof schema>;
const M = model('Q', schema, {
  hashKey: 'id',
  rangeKey: 'sk',
  indexes: {
    status: [
      {name: 'status-keys', rangeKey: 'n', project: false},
      {name: 'status-email', project: ['email']}
    ],
    email: {},
    n: {type: 'local'}
  }
});
const Plain = model('P', schema, {hashKey: 'id'});
const Marked = model(
  'Marked',
  z.object({id: hashKey(z.string()), owner: index(z.string(), {project: false}), note: z.string()})
);

describe('query and scan types', () => {
  it('takes only declared attributes, with their value types', () => {
    M.query('id').eq('x').where('n').gt(1);
    M.query({id: 'x', n: {gt: 1}});
    // @ts-expect-error not an attribute
    M.query('nope');
    // @ts-expect-error not an attribute
    M.query('id').eq('x').where('nope');
    // @ts-expect-error a string attribute
    M.query('id').eq(1);
    // @ts-expect-error a number attribute
    M.scan('n').between('a', 'b');
  });

  it('takes only declared indexes in using()', () => {
    M.query('status').eq('x').using('status-keys');
    M.query('email').eq('x').using('emailGlobalIndex');
    M.query('id').eq('x').using('nLocalIndex');
    // @ts-expect-error not an index of the model
    M.query('id').eq('x').using('nope');
    // @ts-expect-error a model without indexes
    Plain.query('id').eq('x').using('status-keys');
  });

  it("takes a previous page's lastKey in startAt()", async () => {
    const page = await M.query('id').eq('x').exec();
    expectTypeOf(page.lastKey).toEqualTypeOf<Record<string, unknown> | undefined>();
    M.query('id').eq('x').startAt(page.lastKey);
    M.scan().startAt((await M.scan().exec()).lastKey);
    const parallel = await M.scan().parallel(2).exec();
    expectTypeOf(parallel).toEqualTypeOf<ParallelScanResponse<Item>>();
    expectTypeOf(parallel.lastKey).toEqualTypeOf<
      Record<string, unknown> | Record<string, unknown>[] | undefined
    >();
    // @ts-expect-error a parallel scan's lastKey can hold one key per segment, which one request cannot take
    M.scan().startAt(parallel.lastKey);
  });

  it('narrows the item to what the index projects', async () => {
    type Keys = Pick<Item, 'id' | 'sk' | 'status' | 'n'>;
    expectTypeOf(await M.query('status').eq('x').using('status-keys').exec()).toEqualTypeOf<
      QueryResponse<Keys>
    >();
    expectTypeOf(await M.query('status').eq('x').using('status-email').exec()).toEqualTypeOf<
      QueryResponse<Pick<Item, 'id' | 'sk' | 'status' | 'email'>>
    >();
    expectTypeOf(await M.query('email').eq('x').using('emailGlobalIndex').exec()).toEqualTypeOf<
      QueryResponse<Item>
    >();
    expectTypeOf(await M.scan().using('nLocalIndex').exec()).toEqualTypeOf<ScanResponse<Item>>();
    expectTypeOf(
      await Marked.query('owner').eq('x').using('ownerGlobalIndex').exec()
    ).toEqualTypeOf<QueryResponse<{id: string; owner: string}>>();
    // @ts-expect-error a KEYS_ONLY index does not return note
    void (await M.query('status').eq('x').using('status-keys').exec())[0]!.note;
  });

  it('narrows the item to the requested attributes', async () => {
    expectTypeOf(await M.query('id').eq('x').attributes(['id', 'note']).exec()).toEqualTypeOf<
      QueryResponse<Pick<Item, 'id' | 'note'>>
    >();
    // @ts-expect-error not an attribute
    M.query('id').eq('x').attributes(['nope']);
    const names: string[] = ['id', 'note'];
    expectTypeOf(await M.query('id').eq('x').attributes(names).exec()).toEqualTypeOf<
      QueryResponse<Partial<Item>>
    >();
    // @ts-expect-error not projected by the index
    M.query('status').eq('x').using('status-keys').attributes(['note']);
  });

  it('gives the counts after count()', async () => {
    expectTypeOf(await M.query('id').eq('x').count().exec()).toEqualTypeOf<{
      count: number;
      queriedCount: number;
    }>();
    expectTypeOf(await M.scan().count().all().exec()).toEqualTypeOf<{
      count: number;
      scannedCount: number;
    }>();
    // @ts-expect-error a count has no items
    void (await M.scan().count().exec()).length;
  });

  it('has sort on a query only and parallel on a scan only', () => {
    M.query('id').eq('x').sort('descending').limit(1);
    M.scan().parallel(2).limit(1);
    // @ts-expect-error a scan has no sort
    M.scan().sort('ascending');
    // @ts-expect-error a query does not run in segments
    M.query('id').eq('x').parallel(2);
  });

  it('exports Query<M> and Scan<M> as the types of the chains', () => {
    expectTypeOf(M.query()).toEqualTypeOf<Query<typeof M>>();
    expectTypeOf(M.scan()).toEqualTypeOf<Scan<typeof M>>();
    expectTypeOf<Awaited<ReturnType<Query<typeof M>['exec']>>>().toEqualTypeOf<
      QueryResponse<Item>
    >();
  });
});
