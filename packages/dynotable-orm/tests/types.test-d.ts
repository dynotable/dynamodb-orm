import {describe, expectTypeOf, it} from 'vitest';
import {z} from 'zod';
import type {
  ItemOf,
  KeyInputOf,
  ModelOptions,
  QueryResponse,
  ScanResponse,
  StandardSchema,
  UpdateInputOf
} from '../src/index.js';
import type {InferOutput, ModelTypesOf} from '../src/types.js';

// Stands in for model() until it exists: only the type-level result matters here.
declare function typed<S extends StandardSchema, const O extends ModelOptions<InferOutput<S>>>(
  schema: S,
  options: O
): {readonly '~types'?: ModelTypesOf<S, O>};

const schema = z.object({
  id: z.string(),
  sk: z.number(),
  name: z.string().optional(),
  count: z.number(),
  tags: z.set(z.string()),
  at: z.union([z.date(), z.string()]),
  nested: z.object({when: z.date(), label: z.string()})
});
type Item = z.output<typeof schema>;
const hashOnly = typed(schema, {hashKey: 'id'});
const composite = typed(schema, {hashKey: 'id', rangeKey: 'sk'});

describe('ItemOf', () => {
  it('is the schema output', () => {
    expectTypeOf<ItemOf<typeof hashOnly>>().toEqualTypeOf<Item>();
  });
});

describe('KeyInputOf', () => {
  it('accepts a scalar only for a model with only a hash key', () => {
    expectTypeOf<KeyInputOf<typeof hashOnly>>().toEqualTypeOf<{id: string} | string>();
    expectTypeOf<KeyInputOf<typeof composite>>().toEqualTypeOf<{id: string; sk: number}>();
    // @ts-expect-error a composite key cannot be a scalar
    const scalar: KeyInputOf<typeof composite> = 'x';
    // @ts-expect-error the range key is required
    const partial: KeyInputOf<typeof composite> = {id: 'x'};
    void [scalar, partial];
  });
});

describe('UpdateInputOf', () => {
  type U = UpdateInputOf<typeof hashOnly>;
  it('accepts plain fields as an implicit $SET', () => {
    expectTypeOf<{name: string; $SET: {count: number}}>().toExtend<U>();
    // @ts-expect-error a plain field keeps its type
    const wrong: U = {count: 'x'};
    void wrong;
  });

  it('allows $ADD on numbers and Sets only', () => {
    expectTypeOf<{$ADD: {count: 1; tags: ['a']}; $DELETE: {tags: Set<string>}}>().toExtend<U>();
    // @ts-expect-error a string cannot be added to
    const add: U = {$ADD: {name: 'x'}};
    // @ts-expect-error $DELETE works on Sets only
    const del: U = {$DELETE: {count: 1}};
    void [add, del];
  });
});

describe('QueryResponse', () => {
  it('carries the query counts', () => {
    expectTypeOf<QueryResponse<Item>['queriedCount']>().toEqualTypeOf<number>();
    expectTypeOf<QueryResponse<Item>[number]>().toEqualTypeOf<Item>();
    // @ts-expect-error a query result has no scan counts
    void ({} as QueryResponse<Item>).scannedCount;
    expectTypeOf<ScanResponse<Item>['scannedCount']>().toEqualTypeOf<number>();
  });
});

describe('ModelOptions', () => {
  it('names only fields of the schema', () => {
    typed(schema, {hashKey: 'id', dates: {at: 'seconds', 'nested.when': 'milliseconds'}});
    // @ts-expect-error not a field
    typed(schema, {hashKey: 'missing'});
    // @ts-expect-error not a Date path
    typed(schema, {hashKey: 'id', dates: {'nested.label': 'iso'}});
  });
});
