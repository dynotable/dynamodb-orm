import type {$ZodType} from 'zod/v4/core';
import {ConfigError} from '../errors.js';
import type {DateStorage} from '../marshall.js';
import type {IndexDefinition} from '../options.js';
import type {StandardSchema, WithMeta} from '../types.js';
import {def, type FieldMeta, getDynamoMeta, META, unwrap} from './walk.js';

export {type FieldMeta, getDynamoMeta} from './walk.js';

/** A Zod schema, cloned with a new def to carry the metadata. */
export type Schema = $ZodType & {clone(def?: object): unknown};

function mark<S extends Schema, M>(schema: S, meta: FieldMeta): WithMeta<S, M> {
  return schema.clone({
    ...schema._zod.def,
    [META]: {...getDynamoMeta(schema), ...meta}
  }) as WithMeta<S, M>;
}

export const hashKey = <S extends Schema>(s: S) => mark<S, {hashKey: true}>(s, {hashKey: true});
export const rangeKey = <S extends Schema>(s: S) => mark<S, {rangeKey: true}>(s, {rangeKey: true});

export const index = <
  S extends Schema,
  const D extends IndexDefinition | readonly IndexDefinition[] = {}
>(
  s: S,
  def?: D
) => mark<S, {index: D}>(s, {index: Array.isArray(def) ? def : [(def ?? {}) as IndexDefinition]});

export const combine = <
  S extends Schema & StandardSchema<unknown, string>,
  const F extends readonly string[]
>(
  s: S,
  sources: F,
  separator?: string
) =>
  mark<S, {combine: F}>(s, {combine: separator === undefined ? {sources} : {sources, separator}});

export const storage = <
  S extends Schema & StandardSchema<unknown, Date | undefined | null>,
  const D extends DateStorage
>(
  s: S,
  mode: D
) => mark<S, {storage: D}>(s, {storage: mode});

// A Date union stores as its Date option says: `z.union([storage(z.date(), 'seconds'), z.number()])`.
function unionStorage(field: $ZodType): DateStorage | undefined {
  const d = def(unwrap(field));
  if (d.type !== 'union') return undefined;
  for (const option of d.options as $ZodType[]) {
    const storage = getDynamoMeta(option)?.storage;
    if (storage !== undefined) return storage;
  }
  return undefined;
}

const placesOnly = (meta: FieldMeta | undefined) =>
  Boolean(meta?.hashKey || meta?.rangeKey || meta?.index || meta?.combine);

/**
 * The metadata of every declared field, by dot path, through nested objects. A Date union takes its option's
 * storage. A Date mark inside a list, a record or a union is read by the schema's shape (`describe()`), not here.
 */
export function collectFieldMeta(schema: $ZodType): Map<string, FieldMeta> {
  const found = new Map<string, FieldMeta>();
  const misplaced = (where: string) => {
    throw new ConfigError(
      `'${where}' is nested: only a top-level field can be a key, an index or a combine target`
    );
  };
  // `prefix` is undefined below a list, a Set or a record: those places have no dot path.
  const walk = (s: $ZodType, prefix: string | undefined, where: string) => {
    const d = def(unwrap(s));
    const inside = (child: $ZodType, at: string) => {
      if (placesOnly(getDynamoMeta(child))) misplaced(at);
      walk(child, undefined, at);
    };
    switch (d.type) {
      case 'object':
        for (const [key, field] of Object.entries<$ZodType>(d.shape)) {
          const at = where ? `${where}.${key}` : key;
          if (prefix === undefined) {
            inside(field, at);
            continue;
          }
          const own = getDynamoMeta(field);
          const storage = own?.storage ?? unionStorage(field);
          const meta =
            storage === undefined || own?.storage !== undefined ? own : {...own, storage};
          if (meta) {
            if (prefix && placesOnly(meta)) misplaced(at);
            found.set(prefix + key, meta);
          }
          walk(field, `${prefix}${key}.`, at);
        }
        if (d.catchall) inside(d.catchall, `${where}.*`);
        return;
      case 'array':
        return inside(d.element, `${where}[]`);
      case 'set':
        return inside(d.valueType, `${where}[]`);
      case 'tuple':
        d.items.forEach((item: $ZodType, i: number) => inside(item, `${where}[${i}]`));
        if (d.rest) inside(d.rest, `${where}[]`);
        return;
      case 'record':
        return inside(d.valueType, `${where}.*`);
      // A union option holds the same paths as the union.
      case 'union':
        for (const option of d.options as $ZodType[]) walk(option, prefix, where);
        return;
    }
  };
  walk(schema, '', '');
  return found;
}
