import {describe, expectTypeOf, it} from 'vitest';
import {z} from 'zod';
import type {KeyInputOf, ModelOptions, StandardSchema} from '../../src/index.js';
import type {InferOutput, ModelTypesOf} from '../../src/types.js';
import {combine, hashKey, index, rangeKey, storage} from '../../src/zod/index.js';

// Stands in for model() until it exists: only the type-level result matters here.
declare function typed<S extends StandardSchema, const O extends ModelOptions<InferOutput<S>>>(
  schema: S,
  options: O
): {readonly '~types'?: ModelTypesOf<S, O>};

describe('method form types', () => {
  it('gives the same model types as the function form', () => {
    const byMethods = typed(
      z.object({
        id: z.string().hashKey().index(),
        sk: z.number().rangeKey().optional(),
        n: z.string()
      }),
      {}
    );
    const byFunctions = typed(
      z.object({
        id: index(hashKey(z.string())),
        sk: rangeKey(z.number()).optional(),
        n: z.string()
      }),
      {}
    );
    expectTypeOf<NonNullable<(typeof byMethods)['~types']>>().toEqualTypeOf<
      NonNullable<(typeof byFunctions)['~types']>
    >();
    expectTypeOf<KeyInputOf<typeof byMethods>>().toEqualTypeOf<{id: string; sk: number}>();
    // @ts-expect-error the marked range key is required
    const partial: KeyInputOf<typeof byMethods> = {id: 'x'};
    void partial;
  });

  it('returns the same branded schema types', () => {
    expectTypeOf(z.string().combine(['a', 'b'], '#')).toEqualTypeOf(
      combine(z.string(), ['a', 'b'], '#')
    );
    expectTypeOf(z.date().optional().storage('seconds')).toEqualTypeOf(
      storage(z.date().optional(), 'seconds')
    );
    expectTypeOf(z.string().index({name: 'byX'})).toEqualTypeOf(index(z.string(), {name: 'byX'}));
  });

  it('limits combine to strings and storage to Dates', () => {
    // @ts-expect-error combine builds a string
    z.number().combine(['a']);
    // @ts-expect-error storage applies to Dates
    z.string().storage('iso');
    // @ts-expect-error not a storage mode
    z.date().storage('unix');
  });
});
