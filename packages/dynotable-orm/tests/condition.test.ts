import {describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {Condition} from '../src/condition.js';
import {ExpressionError} from '../src/errors.js';
import {compileCondition} from '../src/expression/compile.js';
import type {ModelOptions} from '../src/options.js';
import {compilePlan, type Plan, resolveMetadata} from '../src/plan.js';
import type {StandardSchema} from '../src/types.js';
import {storage} from '../src/zod/index.js';
import {fixtureSchema} from './fixtures/standard-schema.js';

const planOf = (schema: StandardSchema, options: ModelOptions<any>) =>
  compilePlan(resolveMetadata(schema, options));
// What a model sends for the condition.
const render = (c: Condition<any, any>, p: Plan) => {
  const node = c.toNode(p);
  return node === undefined ? {} : compileCondition(node);
};

const schema = z.object({
  id: z.string(),
  email: z.string().transform((s) => s.toLowerCase()),
  status: z.string().optional(),
  n: z.number().optional(),
  tags: z.set(z.string()).optional(),
  at: z.date().optional(),
  sec: z.date().optional(),
  address: z.object({city: z.string(), when: z.date().optional()}).optional(),
  items: z.array(z.object({sku: z.string()})).optional(),
  createdAt: z.number().optional()
});
const plan = planOf(schema, {hashKey: 'id', dates: {sec: 'seconds'}, timestamps: {createdAt: {}}});

describe('Condition', () => {
  it('prints in a snapshot as a dynamoose condition does, whatever it holds', () => {
    expect({condition: new Condition().where('id').eq('x')}).toMatchInlineSnapshot(`
      {
        "condition": Condition {},
      }
    `);
  });

  it('renders a simple chain with the text that tests pinned on dynamoose expect', () => {
    expect(
      render(new Condition().where('id').eq('x').and().where('status').eq('paid'), plan)
    ).toStrictEqual({
      ConditionExpression: '#a0 = :v0 AND #a1 = :v1',
      ExpressionAttributeNames: {'#a0': 'id', '#a1': 'status'},
      ExpressionAttributeValues: {':v0': {S: 'x'}, ':v1': {S: 'paid'}}
    });
  });

  it('maps every chain operator, and not() to its opposite', () => {
    const c = new Condition()
      .where('n')
      .eq(1)
      .where('n')
      .ne(2)
      .where('n')
      .lt(3)
      .where('n')
      .le(4)
      .where('n')
      .gt(5)
      .where('n')
      .ge(6)
      .where('status')
      .beginsWith('p')
      .where('tags')
      .contains('t')
      .where('status')
      .exists()
      .where('n')
      .in([7, 8])
      .where('n')
      .between(9, 10)
      .where('n')
      .not()
      .eq(11)
      .where('n')
      .not()
      .lt(12)
      .where('n')
      .not()
      .ge(13)
      .where('n')
      .not()
      .ne(14)
      .where('n')
      .not()
      .le(15)
      .where('n')
      .not()
      .gt(16)
      .where('status')
      .not()
      .contains('q')
      .where('status')
      .not()
      .exists()
      .where('status')
      .attributeNotExists()
      .where('status')
      .attributeExists();
    const {ConditionExpression, ExpressionAttributeNames} = render(c, plan);
    expect(ConditionExpression).toBe(
      '#a0 = :v0 AND #a1 <> :v1 AND #a2 < :v2 AND #a3 <= :v3 AND #a4 > :v4 AND #a5 >= :v5 AND ' +
        'begins_with (#a6, :v6) AND contains (#a7, :v7) AND attribute_exists (#a8) AND ' +
        '#a9 IN (:v9_1, :v9_2) AND #a10 BETWEEN :v10_1 AND :v10_2 AND ' +
        '#a11 <> :v11 AND #a12 >= :v12 AND #a13 < :v13 AND #a14 = :v14 AND #a15 > :v15 AND #a16 <= :v16 AND ' +
        'NOT contains (#a17, :v17) AND attribute_not_exists (#a18) AND attribute_not_exists (#a19) AND attribute_exists (#a20)'
    );
    expect(ExpressionAttributeNames).toStrictEqual({
      '#a0': 'n',
      '#a1': 'n',
      '#a2': 'n',
      '#a3': 'n',
      '#a4': 'n',
      '#a5': 'n',
      '#a6': 'status',
      '#a7': 'tags',
      '#a8': 'status',
      '#a9': 'n',
      '#a10': 'n',
      '#a11': 'n',
      '#a12': 'n',
      '#a13': 'n',
      '#a14': 'n',
      '#a15': 'n',
      '#a16': 'n',
      '#a17': 'status',
      '#a18': 'status',
      '#a19': 'status',
      '#a20': 'status'
    });
  });

  it.each([
    ['beginsWith', (c: Condition) => c.where('status').not().beginsWith('p')],
    ['in', (c: Condition) => c.where('n').not().in([1])],
    ['between', (c: Condition) => c.where('n').not().between(1, 2)]
  ])('refuses not() before %s', (op, build) => {
    expect(() => build(new Condition())).toThrow(
      new ExpressionError(`${op}() cannot follow not()`)
    );
  });

  it('binds AND tighter than OR, and renders groups, nested', () => {
    const c = new Condition()
      .where('id')
      .eq('a')
      .or()
      .where('status')
      .eq('b')
      .where('n')
      .eq(1)
      .group((g) =>
        g
          .where('status')
          .not()
          .exists()
          .or()
          .group(new Condition().where('n').gt(2).where('n').lt(3))
      );
    expect(render(c, plan).ConditionExpression).toBe(
      '#a0 = :v0 OR #a1 = :v1 AND #a2 = :v2 AND (attribute_not_exists (#a3) OR (#a4 > :v4 AND #a5 < :v5))'
    );
  });

  it('builds from the dynamoose object form', () => {
    expect(
      render(new Condition({status: 'paid', n: {gt: 1}, at: {exists: false}}), plan)
    ).toStrictEqual({
      ConditionExpression: '#a0 = :v0 AND #a1 > :v1 AND attribute_not_exists (#a2)',
      ExpressionAttributeNames: {'#a0': 'status', '#a1': 'n', '#a2': 'at'},
      ExpressionAttributeValues: {':v0': {S: 'paid'}, ':v1': {N: '1'}}
    });
    expect(() => new Condition({n: {gte: 1}})).toThrow(
      new ExpressionError(`'gte' is not a comparison (on 'n')`)
    );
  });

  it('refuses an object form naming two comparisons, which dynamoose reads as the first one only', () => {
    expect(() => new Condition({n: {gt: 1, lt: 5}})).toThrow(
      new ExpressionError(`{gt, lt} on 'n' names 2 comparisons: give one, or chain them`)
    );
  });

  it('passes a raw condition object through', () => {
    const raw = {
      ConditionExpression: 'attribute_not_exists(#groups) OR #groups = :current',
      ExpressionAttributeNames: {'#groups': 'groups'},
      ExpressionAttributeValues: {':current': {L: [{S: 'g'}]}}
    };
    expect(render(new Condition(raw), plan)).toStrictEqual(raw);
  });

  it("marshals a raw condition's plain values, as dynamoose does", () => {
    const raw = {
      ConditionExpression: '#n = :n AND #s = :s',
      ExpressionAttributeNames: {'#n': 'n', '#s': 's'},
      ExpressionAttributeValues: {':n': 100, ':s': {S: 'x'}}
    };
    expect(render(new Condition(raw as never), plan)).toStrictEqual({
      ConditionExpression: '#n = :n AND #s = :s',
      ExpressionAttributeNames: {'#n': 'n', '#s': 's'},
      ExpressionAttributeValues: {':n': {N: '100'}, ':s': {S: 'x'}}
    });
  });

  it('calls one method per chain name, as dynamoose: where for where only, parenthesis for group too', () => {
    const where = vi.spyOn(Condition.prototype, 'where');
    const parenthesis = vi.spyOn(Condition.prototype, 'parenthesis');
    try {
      new Condition()
        .attribute('n')
        .eq(1)
        .filter('id')
        .eq('x')
        .group((c) => c.where('n').gt(0));
      expect([where.mock.calls, parenthesis.mock.calls.length]).toStrictEqual([[['n']], 1]);
    } finally {
      where.mockRestore();
      parenthesis.mockRestore();
    }
  });

  it('accepts declared nested paths and list indexes, and throws on a key the model does not declare', () => {
    expect(
      render(new Condition().where('address.city').eq('x').where('items[0].sku').eq('y'), plan)
    ).toStrictEqual({
      ConditionExpression: '#a0_0.#a0_1 = :v0 AND #a1_0[0].#a1_1 = :v1',
      ExpressionAttributeNames: {
        '#a0_0': 'address',
        '#a0_1': 'city',
        '#a1_0': 'items',
        '#a1_1': 'sku'
      },
      ExpressionAttributeValues: {':v0': {S: 'x'}, ':v1': {S: 'y'}}
    });
    for (const key of ['nope', 'address.zip', 'tags.x', 'items.sku']) {
      expect(() => render(new Condition().where(key as 'id').eq('x'), plan)).toThrow(
        new ExpressionError(`'${key}' is not an attribute of the model`)
      );
    }
  });

  it('turns a Date into the stored form of its path, and keeps a stored-form value as given', () => {
    const d = new Date('2026-01-02T03:04:05.678Z');
    const c = new Condition()
      .where('at')
      .eq(d)
      .where('sec')
      .between(d, '1767323046')
      .where('address.when')
      .lt(d)
      .where('createdAt')
      .gt(d)
      .where('at')
      .eq('2026-01-02T03:04:05.678Z');
    expect(render(c, plan).ExpressionAttributeValues).toStrictEqual({
      ':v0': {N: '1767323045678'},
      ':v1_1': {N: '1767323046'},
      ':v1_2': {S: '1767323046'},
      ':v2': {N: '1767323045678'},
      ':v3': {N: '1767323045678'},
      ':v4': {S: '2026-01-02T03:04:05.678Z'}
    });
  });

  it('runs the field transform and then the whole-item hook on a top-level value', () => {
    const hooked = planOf(schema, {
      hashKey: 'id',
      set: (item) => ('status' in item ? {status: `${item.status}!`} : item)
    });
    const c = new Condition().where('email').eq('A@B.COM').where('status').eq('paid');
    expect(render(c, hooked).ExpressionAttributeValues).toStrictEqual({
      ':v0': {S: 'a@b.com'},
      ':v1': {S: 'paid!'}
    });
  });

  it("hands the hook a copy, so it cannot change the caller's condition value", () => {
    const hooked = planOf(z.object({id: z.string(), meta: z.any()}), {
      hashKey: 'id',
      set: (item) => {
        if ('meta' in item) (item.meta as Record<string, unknown>).touched = true;
        return item;
      }
    });
    const meta = {a: 1};
    expect(
      render(new Condition().where('meta').eq(meta), hooked).ExpressionAttributeValues
    ).toStrictEqual({':v0': {M: {a: {N: '1'}, touched: {BOOL: true}}}});
    expect(meta).toStrictEqual({a: 1});
  });

  it("hands the field transform a copy, so it cannot change or freeze the caller's condition value", () => {
    const changing = planOf(
      z.object({
        id: z.string(),
        meta: z.any().transform((v) => Object.assign(v, {touched: true})),
        frozen: z.any().readonly()
      }),
      {hashKey: 'id'}
    );
    const meta = {a: 1};
    const frozen = {b: 2};
    expect(
      render(new Condition().where('meta').eq(meta).where('frozen').eq(frozen), changing)
        .ExpressionAttributeValues
    ).toStrictEqual({':v0': {M: {a: {N: '1'}, touched: {BOOL: true}}}, ':v1': {M: {b: {N: '2'}}}});
    expect(meta).toStrictEqual({a: 1});
    expect(Object.isFrozen(frozen)).toBe(false);
  });

  it("stores a contains() Date by the list element's storage", () => {
    const listed = planOf(
      z.object({id: z.string(), at: z.array(storage(z.date(), 'seconds')).optional()}),
      {hashKey: 'id'}
    );
    expect(
      render(new Condition().where('at').contains(new Date(1500)), listed).ExpressionAttributeValues
    ).toStrictEqual({
      ':v0': {N: '2'}
    });
  });

  it('compares lists and maps as marshalled values', () => {
    const c = new Condition()
      .where('items')
      .eq([{sku: 'a'}])
      .where('address')
      .eq({city: 'c'});
    expect(render(c, plan).ExpressionAttributeValues).toStrictEqual({
      ':v0': {L: [{M: {sku: {S: 'a'}}}]},
      ':v1': {M: {city: {S: 'c'}}}
    });
  });

  it('accepts any key without an adapter, and stores a Date by the dates option', () => {
    const generic = planOf(fixtureSchema, {hashKey: 'id', dates: {at: 'seconds'}});
    const c = new Condition()
      .where('anything')
      .eq(1)
      .where('at')
      .eq(new Date('2026-01-02T03:04:05.678Z'));
    expect(render(c, generic).ExpressionAttributeValues).toStrictEqual({
      ':v0': {N: '1'},
      ':v1': {N: '1767323046'}
    });
  });

  it('renders nothing for an empty condition', () => {
    expect(render(new Condition(), plan)).toStrictEqual({});
  });

  // dynamoose 4.2.0 drops such a not() and sends `#a0 = :v0`: the condition tests the opposite of what was written.
  it('refuses a not() that no comparison of its own attribute follows', () => {
    expect(() => new Condition().not().where('id').eq('x')).toThrow(
      new ExpressionError(`not() comes before where('id'): call where('id').not()`)
    );
    expect(() => new Condition().where('id').eq('x').and().not().filter('status')).toThrow(
      new ExpressionError(`not() comes before where('status'): call where('status').not()`)
    );
    expect(() => render(new Condition().where('id').eq('x').not(), plan)).toThrow(
      new ExpressionError('not() has no comparison after it')
    );
  });

  it('fails loud on an incomplete or malformed chain', () => {
    expect(() => render(new Condition().where('id'), plan)).toThrow(
      new ExpressionError(`the condition on 'id' has no comparison`)
    );
    expect(() => new Condition().eq('x')).toThrow(
      new ExpressionError('eq() needs an attribute: call where() first')
    );
    expect(() => new Condition().where('id').eq(undefined as never)).toThrow(
      new ExpressionError(`eq() on 'id' was passed undefined`)
    );
    expect(() => new Condition().where('n').in(1 as never)).toThrow(
      new ExpressionError(`in() on 'n' takes an array of values`)
    );
    expect(() => render(new Condition().where('n').in([]), plan)).toThrow(
      new ExpressionError('an "in" condition needs at least one value')
    );
    expect(() => new Condition({n: {between: [1]}})).toThrow(
      new ExpressionError(`between() on 'n' takes two values`)
    );
    expect(() => render(new Condition().group(new Condition()), plan)).toThrow(
      new ExpressionError('a group needs at least one condition')
    );
  });
});
