import type {$ZodTypeInternals} from 'zod/v4/core';
import {ConfigError} from '../errors.js';
import type {DateStorage} from '../marshall.js';
import type {IndexDefinition} from '../options.js';
import type {StandardSchema, WithMeta} from '../types.js';
import {combine, hashKey, index, rangeKey, type Schema, storage} from './meta.js';

declare module 'zod' {
  interface ZodType<
    out Output = unknown,
    out Input = unknown,
    out Internals extends $ZodTypeInternals<Output, Input> = $ZodTypeInternals<Output, Input>
  > {
    hashKey(): WithMeta<this, {hashKey: true}>;
    rangeKey(): WithMeta<this, {rangeKey: true}>;
    index<const D extends IndexDefinition | readonly IndexDefinition[] = {}>(
      def?: D
    ): WithMeta<this, {index: D}>;
    combine<T extends StandardSchema<unknown, string>, const F extends readonly string[]>(
      this: T,
      sources: F,
      separator?: string
    ): WithMeta<T, {combine: F}>;
    storage<
      T extends StandardSchema<unknown, Date | undefined | null>,
      const D extends DateStorage
    >(
      this: T,
      mode: D
    ): WithMeta<T, {storage: D}>;
  }
}

const methods: Record<string, Function> = {
  hashKey(this: Schema) {
    return hashKey(this);
  },
  rangeKey(this: Schema) {
    return rangeKey(this);
  },
  index(this: Schema, def?: IndexDefinition | readonly IndexDefinition[]) {
    return index(this, def);
  },
  combine(this: Schema, sources: readonly string[], separator?: string) {
    return combine(this as Schema & StandardSchema<unknown, string>, sources, separator);
  },
  storage(this: Schema, mode: DateStorage) {
    return storage(this as Schema & StandardSchema<unknown, Date | undefined | null>, mode);
  }
};

/**
 * Adds `.hashKey()`, `.rangeKey()`, `.index()`, `.combine()` and `.storage()` to Zod schemas,
 * the method form of this module's functions. Only schemas created after the call have them.
 */
export function extendZod(z: {readonly ZodType: {readonly prototype: object}}): void {
  const proto = z.ZodType.prototype as Record<string, unknown>;
  // Checked before any write, so a conflict leaves the prototype as it was.
  for (const name of Object.keys(methods)) {
    if (name in proto && proto[name] !== methods[name]) {
      throw new ConfigError(`extendZod: ZodType already has a different '${name}' method`);
    }
  }
  Object.assign(proto, methods);
}
