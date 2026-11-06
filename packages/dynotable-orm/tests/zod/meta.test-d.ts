import {describe, expectTypeOf, it} from 'vitest';
import {z} from 'zod';
import type {ItemOf, KeyInputOf, ModelOptions, StandardSchema} from '../../src/index.js';
import type {InferOutput, ModelTypesOf} from '../../src/types.js';
import {combine, hashKey, rangeKey, storage} from '../../src/zod/index.js';

// Stands in for model() until it exists: only the type-level result matters here.
declare function typed<S extends StandardSchema, const O extends ModelOptions<InferOutput<S>>>(
  schema: S,
  options: O
): {readonly '~types'?: ModelTypesOf<S, O>};

const marked = z.object({id: hashKey(z.string()), sk: rangeKey(z.number()), n: z.string()});
const plain = z.object({id: z.string(), sk: z.number(), n: z.string()});
const byFields = typed(marked, {});
const byOptions = typed(plain, {hashKey: 'id', rangeKey: 'sk'});

describe('field metadata types', () => {
  it('gives the same key as the options', () => {
    expectTypeOf<KeyInputOf<typeof byFields>>().toEqualTypeOf<{id: string; sk: number}>();
    expectTypeOf<KeyInputOf<typeof byFields>>().toEqualTypeOf<KeyInputOf<typeof byOptions>>();
    // @ts-expect-error the marked range key is required
    const partial: KeyInputOf<typeof byFields> = {id: 'x'};
    void partial;
  });

  it('keeps the item type unbranded', () => {
    expectTypeOf<ItemOf<typeof byFields>>().toEqualTypeOf<{id: string; sk: number; n: string}>();
  });

  it('finds the mark through pick', () => {
    const picked = typed(marked.pick({id: true, n: true}), {});
    expectTypeOf<KeyInputOf<typeof picked>>().toEqualTypeOf<{id: string} | string>();
    // @ts-expect-error a scalar key keeps the hash key's type
    const wrong: KeyInputOf<typeof picked> = 1;
    void wrong;
  });

  it('finds the mark through checks and wrappers', () => {
    const wrapped = typed(
      z.object({
        id: hashKey(z.string()).min(1).describe('id').default('a'),
        sk: rangeKey(z.number()).optional()
      }),
      {}
    );
    expectTypeOf<KeyInputOf<typeof wrapped>>().toEqualTypeOf<{id: string; sk: number}>();
    // @ts-expect-error the range key keeps its type
    const wrong: KeyInputOf<typeof wrapped> = {id: 'a', sk: 'b'};
    void wrong;
  });

  it('limits combine to strings and storage to Dates', () => {
    combine(z.string(), ['a', 'b']);
    storage(z.date().optional(), 'seconds');
    // @ts-expect-error combine builds a string
    combine(z.number(), ['a']);
    // @ts-expect-error storage applies to Dates
    storage(z.string(), 'iso');
    // @ts-expect-error not a storage mode
    storage(z.date(), 'unix');
  });
});
