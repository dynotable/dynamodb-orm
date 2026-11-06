import type {$ZodType} from 'zod/v4/core';
import {ConfigError} from './errors.js';
import type {DateStorage} from './marshall.js';
import type {
  CombineDefinition,
  IndexDefinition,
  IndexType,
  ModelOptions,
  TimestampDefinition,
  UnknownKeys
} from './options.js';
import type {StandardSchema} from './types.js';
import {collectFieldMeta, type FieldMeta} from './zod/meta.js';
import {type SchemaAdapter, unwrap, zodAdapter} from './zod/walk.js';
import {buildConverters, type Converters} from './pipeline.js';

export interface IndexPlan {
  name: string;
  type: IndexType;
  hash: string;
  range?: string;
  project: boolean | readonly string[];
}
export interface CombinePlan {
  target: string;
  sources: readonly string[];
  separator: string;
  /** The target is the table's hash or range key. */
  isKey: boolean;
}
export interface TimestampPlan {
  name: string;
  /** A `number` timestamp is stored in milliseconds and read back as a number. */
  kind: 'date' | 'number';
  storage: DateStorage;
  /** The field rejects absence: a whole-item write validates it with the stamp (a Date, or milliseconds for a number). */
  required?: true;
}

export interface ModelMetadata {
  schema: StandardSchema;
  key: {hash: string; range?: string};
  indexes: IndexPlan[];
  dates: Map<string, DateStorage>;
  combine: CombinePlan[];
  timestamps: {createdAt?: TimestampPlan; updatedAt?: TimestampPlan};
  set?: (item: Record<string, unknown>) => Record<string, unknown>;
  defaultDateStorage: DateStorage;
  unknownKeys: UnknownKeys;
  adapter?: SchemaAdapter;
}

export interface Plan extends ModelMetadata, Converters {
  validate: StandardSchema['~standard']['validate'];
}

const json = JSON.stringify;

// A setting given both on the field and in the options must agree, or the model is ambiguous.
function settle<T>(
  path: string,
  option: string,
  field: T | undefined,
  fromOption: T | undefined
): T | undefined {
  if (field !== undefined && fromOption !== undefined && json(field) !== json(fromOption)) {
    throw new ConfigError(
      `'${path}' has ${json(field)} in its field metadata but ${json(fromOption)} in options.${option}`
    );
  }
  return field ?? fromOption;
}

function oneKey(
  kind: 'hash' | 'range',
  option: string | undefined,
  marked: string[]
): string | undefined {
  const sources = [
    ...(option === undefined ? [] : [`'${option}' (options.${kind}Key)`]),
    ...marked.map((p) => `'${p}' (field)`)
  ];
  if (new Set([option, ...marked].filter((k) => k !== undefined)).size > 1) {
    throw new ConfigError(`two ${kind} keys: ${sources.join(' and ')}`);
  }
  return option ?? marked[0];
}

const asList = <T>(v: T | readonly T[] | undefined): readonly T[] | undefined =>
  v === undefined ? undefined : Array.isArray(v) ? v : [v as T];

// Zod 3 also reports vendor 'zod' but has no `_zod`; it takes the generic path.
const isZod4 = (schema: StandardSchema) => schema['~standard'].vendor === 'zod' && '_zod' in schema;

/** Resolves keys, indexes, combine, dates and timestamps. Runs at `model()`, so a bad definition fails there. */
export function resolveMetadata(
  schema: StandardSchema,
  options: ModelOptions<any> = {}
): ModelMetadata {
  const unknownKeys = options.unknownKeys ?? 'zod';
  const ts = options.timestamps;
  const zod = isZod4(schema);
  const adapter = zod ? zodAdapter(schema, unknownKeys) : undefined;
  const fieldMeta: ReadonlyMap<string, FieldMeta> = zod
    ? collectFieldMeta(schema as unknown as $ZodType)
    : new Map();
  const fields = [...fieldMeta];
  const marked = (flag: keyof FieldMeta) => fields.filter(([, m]) => m[flag]).map(([p]) => p);
  const paths = (fromOptions: object | undefined, flag: keyof FieldMeta) =>
    new Set([...Object.keys(fromOptions ?? {}), ...marked(flag)]);
  const hash = oneKey('hash', options.hashKey, marked('hashKey'));
  if (hash === undefined)
    throw new ConfigError('the model has no hash key: set options.hashKey or mark a field');
  const range = oneKey('range', options.rangeKey, marked('rangeKey'));

  const toIndex = (field: string, def: IndexDefinition): IndexPlan => {
    // Defaults as in dynamoose Schema.getIndexes.
    const type = def.type ?? 'global';
    if (type === 'local' && range === undefined) {
      throw new ConfigError(`the local index on '${field}' needs a table range key`);
    }
    return {
      name: def.name ?? `${field}${type === 'global' ? 'GlobalIndex' : 'LocalIndex'}`,
      type,
      ...(type === 'global'
        ? {hash: field, ...(def.rangeKey === undefined ? {} : {range: def.rangeKey})}
        : {hash, range: field}),
      project: def.project ?? true
    };
  };
  const indexes: IndexPlan[] = [];
  for (const field of paths(options.indexes, 'index')) {
    const toPlans = (defs: readonly IndexDefinition[] | undefined) =>
      defs?.map((d) => toIndex(field, d));
    indexes.push(
      ...settle(
        field,
        'indexes',
        toPlans(fieldMeta.get(field)?.index),
        toPlans(asList(options.indexes?.[field]))
      )!
    );
  }

  const combine: CombinePlan[] = [];
  for (const target of paths(options.combine, 'combine')) {
    // dynamoose joins with Array#join, whose default separator is ','.
    const norm = (c: CombineDefinition | undefined) =>
      c && {sources: [...c.sources], separator: c.separator ?? ','};
    const fromField = norm(fieldMeta.get(target)?.combine);
    const {sources, separator} = settle(
      target,
      'combine',
      fromField,
      norm(options.combine?.[target])
    )!;
    if (sources.includes(target))
      throw new ConfigError(`the combine target '${target}' is also one of its sources`);
    combine.push({target, sources, separator, isKey: target === hash || target === range});
  }

  // A Zod schema strips an undeclared field, so a key, an index or a combine field it does not declare would be lost.
  if (adapter) {
    const fieldsNamed: Array<[string, string]> = [
      [hash, 'the hash key'],
      ...(range === undefined ? [] : [[range, 'the range key'] as [string, string]]),
      ...indexes.flatMap((i): Array<[string, string]> => [
        [i.hash, `index ${i.name}`],
        ...(i.range === undefined ? [] : [[i.range, `index ${i.name}`] as [string, string]])
      ]),
      ...combine.flatMap(({target, sources}): Array<[string, string]> =>
        [target, ...sources].map((f) => [f, `the combine of ${target}`])
      )
    ];
    const timestampNames = new Set(
      ts === undefined || ts === false
        ? []
        : (['createdAt', 'updatedAt'] as const).flatMap((k) =>
            ts === true ? [k] : ts[k] ? [ts[k]!.name ?? k] : []
          )
    );
    for (const [field, role] of fieldsNamed) {
      if (!timestampNames.has(field) && adapter.subSchema([field]) === undefined) {
        throw new ConfigError(`'${field}' (${role}) is not declared in the schema`);
      }
    }
  }

  const optionDates: Partial<Record<string, DateStorage>> = options.dates ?? {};
  const dates = new Map<string, DateStorage>();
  for (const path of paths(optionDates, 'storage')) {
    dates.set(path, settle(path, 'dates', fieldMeta.get(path)?.storage, optionDates[path])!);
  }

  const defaultDateStorage = options.defaultDateStorage ?? 'milliseconds';
  const timestamp = (kind: 'createdAt' | 'updatedAt'): TimestampPlan | undefined => {
    const def: TimestampDefinition | undefined = ts === true ? {} : ts ? ts[kind] : undefined;
    if (def === undefined) return undefined;
    const name = def.name ?? kind;
    // Writes hold timestamps out of validation (dynamoose's converter drops them too). A field that rejects
    // absence is validated with the stamp instead, so it must take a Date (or a number, for a number field).
    const field = adapter?.subSchema([name]);
    const check = (value: unknown, what: string) => {
      const r = field?.['~standard'].validate(value);
      if (r instanceof Promise) {
        // Zod also answers with a Promise when a sync transform throws; left unhandled, its rejection ends the process.
        r.catch(() => {});
        throw new ConfigError(
          `the timestamp field '${name}' validates asynchronously, so model() cannot check that it accepts ${what}: make its checks sync`
        );
      }
      return r?.issues === undefined;
    };
    const isNumber =
      field !== undefined &&
      '_zod' in field &&
      unwrap(field as unknown as $ZodType)._zod.def.type === 'number';
    const required = !check(undefined, 'absence');
    if (required && !check(isNumber ? 0 : new Date(0), isNumber ? 'a number' : 'a Date')) {
      throw new ConfigError(
        `the timestamp field '${name}' must accept absence or ${isNumber ? 'a number' : 'a Date'}: the lib sets its value`
      );
    }
    const storage = settle(
      name,
      `timestamps.${kind}.storage`,
      fieldMeta.get(name)?.storage,
      def.storage
    );
    // A Zod→dynamoose converter gives a number timestamp `type: Number`, which dynamoose stamps with getTime().
    if (isNumber) {
      if (storage !== undefined) {
        throw new ConfigError(
          `the timestamp field '${name}' is a number, always stored in milliseconds: remove its storage setting`
        );
      }
      return {name, kind: 'number', storage: 'milliseconds', ...(required && {required})};
    }
    return {
      name,
      kind: 'date',
      storage: storage ?? defaultDateStorage,
      ...(required && {required})
    };
  };
  const createdAt = timestamp('createdAt');
  const updatedAt = timestamp('updatedAt');

  return {
    schema,
    key: range === undefined ? {hash} : {hash, range},
    indexes,
    dates,
    combine,
    timestamps: {...(createdAt && {createdAt}), ...(updatedAt && {updatedAt})},
    ...(options.set && {set: options.set}),
    defaultDateStorage,
    unknownKeys,
    ...(adapter && {adapter})
  };
}

/** Builds the converters. `model()` calls it on first use, once per model. */
export function compilePlan(meta: ModelMetadata): Plan {
  const standard = meta.schema['~standard'];
  return {...meta, ...buildConverters(meta), validate: (value) => standard.validate(value)};
}

const CACHE_LIMIT = 1024;

/**
 * Memoizes `build` per plan and key. Paths into records carry data (`meta.<id>`), so each plan's cache is
 * bounded: it starts over at 1024 keys.
 */
export function perPlan<V>(build: (plan: Plan, key: string) => V): (plan: Plan, key: string) => V {
  const caches = new WeakMap<Plan, Map<string, V>>();
  return (plan, key) => {
    let byKey = caches.get(plan);
    if (byKey === undefined) caches.set(plan, (byKey = new Map()));
    let value = byKey.get(key);
    if (value !== undefined) return value;
    if (byKey.size >= CACHE_LIMIT) byKey.clear();
    value = build(plan, key);
    byKey.set(key, value);
    return value;
  };
}
