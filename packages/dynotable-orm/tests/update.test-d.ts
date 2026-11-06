import type {UpdateItemCommandInput} from '@aws-sdk/client-dynamodb';
import {describe, expectTypeOf, it} from 'vitest';
import {z} from 'zod';
import {type IfNotExists, ifNotExists, model, type UpdateInputOf} from '../src/index.js';

// The update cases of a dynamoose user's own type tests, rewritten on a synthetic schema.
const schema = z.object({
  id: z.string(),
  name: z.string(),
  count: z.number(),
  tags: z.set(z.string()),
  numbers: z.array(z.number()),
  matrix: z.array(z.array(z.number())),
  nested: z.object({
    value: z.string(),
    score: z.number(),
    categories: z.set(z.number()),
    items: z.array(z.string()).optional()
  }),
  objects: z.array(z.object({name: z.string(), value: z.number()})),
  optionalList: z.array(z.string()).optional()
});
type Item = z.output<typeof schema>;
const M = model('Items', schema, {hashKey: 'id'});
const Composite = model('Pairs', schema, {hashKey: 'id', rangeKey: 'count'});
type U = UpdateInputOf<typeof M>;
type Set$ = NonNullable<U['$SET']>;
type Add = NonNullable<U['$ADD']>;
type Delete = NonNullable<U['$DELETE']>;

describe('$SET', () => {
  it('takes attributes and dot paths, each with its own type', () => {
    expectTypeOf<Set$['name']>().toEqualTypeOf<string | IfNotExists<string> | undefined>();
    expectTypeOf<Set$['nested.score']>().toEqualTypeOf<number | IfNotExists<number> | undefined>();
    expectTypeOf<{'nested.value': string; count: number}>().toExtend<Set$>();
    // @ts-expect-error a nested path keeps its type
    const wrong: Set$ = {'nested.score': 'x'};
    // @ts-expect-error not a path of the item
    const unknown: Set$ = {'nested.nope': 'x'};
    void [wrong, unknown];
  });

  it('takes list element paths, and paths into list elements', () => {
    expectTypeOf<NonNullable<Set$['numbers[0]']>>().toEqualTypeOf<number | IfNotExists<number>>();
    expectTypeOf<{
      'numbers[5]': number;
      'nested.items[0]': string;
      'objects[0]': {name: string; value: number};
      'objects[2].name': string;
      'optionalList[1]': string;
    }>().toExtend<Set$>();
    // @ts-expect-error not a key of a list element
    const unknown: Set$ = {'objects[0].unknownProp': 'x'};
    // @ts-expect-error a list element keeps its type
    const wrong: Set$ = {'objects[0].value': 'x'};
    // @ts-expect-error a Set has no element paths
    const element: Set$ = {'tags[0]': 'x'};
    void [unknown, wrong, element];
  });

  it('takes ifNotExists of the attribute type', () => {
    expectTypeOf<{count: IfNotExists<number>}>().toExtend<Set$>();
    // @ts-expect-error a number attribute
    const wrong: Set$ = {count: ifNotExists('x')};
    void wrong;
  });

  it('takes plain fields as an implicit $SET', () => {
    expectTypeOf<{
      name: string;
      $SET: {'nested.value': string};
      $ADD: {count: number};
    }>().toExtend<U>();
    // @ts-expect-error a plain field keeps its type
    const wrong: U = {name: 1};
    void wrong;
  });
});

describe('$ADD', () => {
  it('takes numbers, Set elements as a Set or an array, and list elements', () => {
    expectTypeOf<NonNullable<Add['count']>>().toEqualTypeOf<number>();
    expectTypeOf<NonNullable<Add['tags']>>().toEqualTypeOf<Set<string> | readonly string[]>();
    expectTypeOf<NonNullable<Add['nested.categories']>>().toEqualTypeOf<
      Set<number> | readonly number[]
    >();
    // An intentional change from those type tests, which forbade it: dynamoose appends an array to a list at runtime.
    expectTypeOf<NonNullable<Add['numbers']>>().toEqualTypeOf<readonly number[]>();
    // @ts-expect-error a string cannot be added to
    const name: Add = {name: 'x'};
    // @ts-expect-error a bare element is not a Set operand
    const bare: Add = {tags: 'x'};
    void [name, bare];
  });
});

describe('$DELETE', () => {
  it('takes Set elements only', () => {
    expectTypeOf<NonNullable<Delete['tags']>>().toEqualTypeOf<Set<string> | readonly string[]>();
    expectTypeOf<{'nested.categories': [1]}>().toExtend<Delete>();
    // @ts-expect-error a number is not a Set
    const count: Delete = {count: 1};
    // @ts-expect-error a list is not a Set
    const list: Delete = {numbers: [1]};
    void [count, list];
  });
});

describe('$REMOVE', () => {
  it('takes paths as an array or as an object of nulls', () => {
    expectTypeOf<{
      $REMOVE: ['name', 'nested.value', 'tags', 'numbers[0]', 'matrix[0][0]', 'objects[1].name'];
    }>().toExtend<U>();
    expectTypeOf<{$REMOVE: {name: null; 'nested.items[2]': null}}>().toExtend<U>();
    // @ts-expect-error not a path of the item
    const unknown: U = {$REMOVE: ['nope']};
    // @ts-expect-error the object form takes nulls
    const value: U = {$REMOVE: {name: 'x'}};
    void [unknown, value];
  });
});

describe('update()', () => {
  it('resolves to the item returnValues asks for', async () => {
    expectTypeOf(await M.update('a', {name: 'x'})).toEqualTypeOf<Item>();
    expectTypeOf(
      await M.update('a', {name: 'x'}, {returnValues: 'NONE'})
    ).toEqualTypeOf<undefined>();
    expectTypeOf(await M.update('a', {name: 'x'}, {returnValues: 'UPDATED_NEW'})).toEqualTypeOf<
      Partial<Item> | undefined
    >();
    expectTypeOf(
      await M.update('a', {name: 'x'}, {return: 'request'})
    ).toEqualTypeOf<UpdateItemCommandInput>();
    // @ts-expect-error not a DynamoDB ReturnValue
    void M.update('a', {name: 'x'}, {returnValues: 'ALL'});
  });

  it('takes the key and the changes in one object', async () => {
    expectTypeOf(
      await Composite.update({id: 'a', count: 1, name: 'x', $ADD: {tags: ['t']}})
    ).toEqualTypeOf<Item>();
    // @ts-expect-error the range key is part of the key
    void Composite.update({id: 'a', name: 'x'});
    // @ts-expect-error a composite key cannot be a scalar
    void Composite.update('a', {name: 'x'});
  });
});

describe('values the schema parses', () => {
  // A $SET value and an appended element go through the field schema, which takes its input type.
  const Parsed = model(
    'Parsed',
    z.object({
      id: z.string(),
      n: z.string().transform(Number),
      list: z.array(z.string().transform(Number))
    }),
    {hashKey: 'id'}
  );
  type P = UpdateInputOf<typeof Parsed>;

  it('take the schema input', () => {
    expectTypeOf<NonNullable<P['n']>>().toEqualTypeOf<string | IfNotExists<string>>();
    void Parsed.update('a', {n: '12', $SET: {'list[0]': '1'}, $ADD: {list: ['2']}});
    // @ts-expect-error the schema output is not what the check accepts
    void Parsed.update('a', {n: 12});
    // @ts-expect-error an appended element is parsed too
    void Parsed.update('a', {$ADD: {list: [2]}});
  });
});
