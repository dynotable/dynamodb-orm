import {describe, expectTypeOf, it} from 'vitest';
import {z} from 'zod';
import type {AttributeValue} from '@aws-sdk/client-dynamodb';
import {type Condition, type ItemOf, type KeyInputOf, model, transaction} from '../src/index.js';
import {hashKey} from '../src/zod/index.js';

const schema = z.object({
  id: z.string(),
  sk: z.number(),
  n: z.number().optional(),
  at: z.date().optional()
});
type Item = z.output<typeof schema>;
const HashOnly = model('Users', schema, {hashKey: 'id'});
const Composite = model('Orders', schema, {hashKey: 'id', rangeKey: 'sk'});
const Marked = model('Marked', z.object({id: hashKey(z.string()), n: z.number()}));

describe('model types', () => {
  it('types the key input', () => {
    void HashOnly.get('a');
    void HashOnly.get({id: 'a'});
    void Composite.get({id: 'a', sk: 1});
    void Marked.delete('a');
    // @ts-expect-error a composite key cannot be a scalar
    void Composite.get('a');
    // @ts-expect-error the range key is required
    void Composite.delete({id: 'a'});
    // @ts-expect-error the hash key is a string
    void HashOnly.get(1);
    expectTypeOf<KeyInputOf<typeof Composite>>().toEqualTypeOf<{id: string; sk: number}>();
  });

  it('narrows the item to the requested attributes', async () => {
    expectTypeOf(await Composite.get({id: 'a', sk: 1}, {attributes: ['id', 'n']})).toEqualTypeOf<
      Pick<Item, 'id' | 'n'> | undefined
    >();
    expectTypeOf(await Composite.get({id: 'a', sk: 1})).toEqualTypeOf<Item | undefined>();
    // @ts-expect-error not an attribute
    void Composite.get({id: 'a', sk: 1}, {attributes: ['nope']});
  });

  it('types the request and the created item', async () => {
    expectTypeOf(
      (await Composite.get({id: 'a', sk: 1}, {return: 'request'})).TableName
    ).toEqualTypeOf<string | undefined>();
    expectTypeOf(await Composite.create({id: 'a', sk: 1})).toEqualTypeOf<Item>();
    // @ts-expect-error a number attribute
    void Composite.create({id: 'a', sk: 'x'});
  });

  it('new Model(obj) gives the item type', () => {
    expectTypeOf(new Composite({id: 'a'})).toEqualTypeOf<Item>();
    expectTypeOf<ItemOf<typeof Composite>>().toEqualTypeOf<Item>();
    // @ts-expect-error a number attribute
    void new Composite({sk: 'x'});
  });

  it('keeps the name as a string literal type', () => {
    expectTypeOf(Composite.name).toEqualTypeOf<'Orders'>();
    expectTypeOf(Composite.hashKey).toEqualTypeOf<'id'>();
    expectTypeOf(Composite.rangeKey).toEqualTypeOf<'sk'>();
    expectTypeOf(HashOnly.rangeKey).toEqualTypeOf<undefined>();
    // @ts-expect-error not the model's name
    const other: 'Users' = Composite.name;
    void other;
  });

  it('types Model.condition() from the schema', () => {
    expectTypeOf(Composite.condition()).toEqualTypeOf<Condition<Item>>();
    Composite.condition().where('n').gt(1).where('at').lt(new Date());
    // @ts-expect-error a number attribute
    Composite.condition().where('n').gt('1');
    // @ts-expect-error not an attribute
    Composite.condition().where('nope');
  });

  it('types the batches, the key attributes always read', async () => {
    const result = await Composite.batchGet([{id: 'a', sk: 1}], {attributes: ['n']});
    expectTypeOf([...result]).toEqualTypeOf<Pick<Item, 'id' | 'sk' | 'n'>[]>();
    expectTypeOf(result.unprocessedKeys).toEqualTypeOf<Record<string, unknown>[]>();
    expectTypeOf([...(await HashOnly.batchGet(['a']))]).toEqualTypeOf<Item[]>();
    expectTypeOf((await Composite.batchPut([{id: 'a', sk: 1}])).unprocessedItems).toEqualTypeOf<
      Partial<Item>[]
    >();
    // @ts-expect-error a composite key cannot be a scalar
    void Composite.batchDelete(['a']);
    // @ts-expect-error not an attribute
    void Composite.batchGet([{id: 'a', sk: 1}], {attributes: ['nope']});
  });

  it('takes the schema input on writes, where a transform makes it wider than the item', async () => {
    const Flags = model(
      'Flags',
      z.object({
        id: z.string(),
        on: z.union([z.boolean(), z.literal('true')]).transform((v) => v === true || v === 'true')
      }),
      {hashKey: 'id'}
    );
    expectTypeOf(await Flags.create({id: 'a', on: 'true'})).toEqualTypeOf<{
      id: string;
      on: boolean;
    }>();
    expectTypeOf(new Flags({id: 'a', on: 'true'})).toEqualTypeOf<{id: string; on: boolean}>();
    void Flags.batchPut([{id: 'a', on: 'true'}]);
    void Flags.transaction.create({id: 'a', on: 'true'});
    // a read item goes back in where the transform's output is also its input
    void Flags.create((await Flags.get('a'))!);
    // @ts-expect-error neither the input nor the item
    void Flags.create({id: 'a', on: 'yes'});
  });

  it('types the transaction entries as raw SDK objects', async () => {
    expectTypeOf((await Composite.transaction.create({id: 'a', sk: 1})).Put.Item).toEqualTypeOf<
      Record<string, AttributeValue> | undefined
    >();
    expectTypeOf(
      await transaction([Composite.transaction.delete({id: 'a', sk: 1})])
    ).toEqualTypeOf<void>();
    // @ts-expect-error a number attribute
    void Composite.transaction.update({id: 'a', sk: 1}, {n: 'x'});
  });
});
