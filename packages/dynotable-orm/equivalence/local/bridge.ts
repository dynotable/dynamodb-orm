// Local mode only. Pairs each model of a codebase built on its own dynamoose build (a Zod schema converted by
// the codebase's own model factory) with this lib's model options, read from the same Zod schema.
import type {DateStorage} from '../../src/marshall.js';
import type {IndexDefinition, ModelOptions, TimestampDefinition} from '../../src/options.js';
import {unwrap, WRAPPERS} from '../../src/zod/walk.js';

type Zod = {_zod: {def: Record<string, any>}};
/** What the codebase's Zod extension writes on `_def.dynamoose`: dynamoose attribute settings. */
interface DynamooseDef {
  hashKey?: boolean;
  rangeKey?: boolean;
  index?: true | IndexDefinition | IndexDefinition[];
  type?: {
    value: unknown;
    settings?: {attributes?: string[]; separator?: string; storage?: DateStorage};
  };
}

const isZod = (v: unknown): v is Zod => typeof v === 'object' && v !== null && '_zod' in v;

// The settings of every layer of a field: wrappers and both ends of a pipe. The extension writes on the instance it is called on.
function settingsOf(s: Zod): DynamooseDef {
  const out: DynamooseDef = {};
  const visit = (layer: Zod) => {
    const def = layer._zod.def;
    Object.assign(out, def.dynamoose);
    if (WRAPPERS.has(def.type)) visit(def.innerType);
    else if (def.type === 'pipe') {
      visit(def.in);
      visit(def.out);
    }
  };
  visit(s);
  return out;
}

const unwrapped = (s: Zod): Zod => unwrap(s as never) as unknown as Zod;

// The converter takes a Date union's type, storage included, from its Date option.
function unionStorage(field: Zod): DateStorage | undefined {
  const def = unwrapped(field)._zod.def;
  if (def.type !== 'union') return undefined;
  for (const option of def.options as Zod[]) {
    const storage = settingsOf(option).type?.settings?.storage;
    if (storage !== undefined) return storage;
  }
  return undefined;
}

// A storage mark below a list cannot be named by a dot path, and dynamoose would store it differently from the default.
function collectDates(
  shape: Record<string, Zod>,
  prefix: string,
  dates: Record<string, DateStorage>,
  underList: boolean
): void {
  for (const [key, field] of Object.entries(shape)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const storage = settingsOf(field).type?.settings?.storage ?? unionStorage(field);
    if (storage !== undefined) {
      if (underList)
        throw new Error(`a Date storage mark under a list (${path}) has no model option`);
      dates[path] = storage;
    }
    const inner = unwrapped(field)._zod.def;
    if (inner.type === 'object') collectDates(inner.shape, path, dates, underList);
    if (inner.type === 'array' && unwrapped(inner.element)._zod.def.type === 'object') {
      collectDates(unwrapped(inner.element)._zod.def.shape, `${path}[]`, dates, true);
    }
  }
}

/** The dynamoose schema settings the bridge reads: `timestamps` and `set`, as the codebase's converter passed them. */
export interface SchemaSettings {
  hashKey: string;
  rangeKey?: string;
  timestamps?: Record<string, Record<string, {type: unknown}>> | false;
  set?: (item: Record<string, unknown>) => Record<string, unknown>;
}

function timestamp(
  def: Record<string, {type: unknown}> | undefined
): TimestampDefinition | undefined {
  if (def === undefined) return undefined;
  const [name, attribute] = Object.entries(def)[0]!;
  const type = attribute.type as
    | {value?: unknown; settings?: {storage?: DateStorage}}
    | DateConstructor
    | NumberConstructor;
  if (type === Number) return {name};
  // A bare Date takes dynamoose's default storage, milliseconds.
  if (type === Date) return {name, storage: 'milliseconds'};
  return {
    name,
    ...(typeof type === 'object' && type.settings?.storage && {storage: type.settings.storage})
  };
}

/** Model options from the `_def.dynamoose` marks of a Zod object schema, with the dynamoose schema's timestamps and hook. */
export function optionsFromDynamoose(schema: unknown, settings: SchemaSettings): ModelOptions<any> {
  if (!isZod(schema) || schema._zod.def.type !== 'object')
    throw new Error('the schema is not a Zod object');
  const shape: Record<string, Zod> = schema._zod.def.shape;
  // The converter stores an unmarked z.date() as an ISO string.
  const options: ModelOptions<any> = {unknownKeys: 'dynamoose', defaultDateStorage: 'iso'};
  const indexes: Record<string, IndexDefinition[]> = {};
  const combine: Record<string, {sources: string[]; separator?: string}> = {};
  for (const [key, field] of Object.entries(shape)) {
    const s = settingsOf(field);
    if (s.hashKey) options.hashKey = key;
    if (s.rangeKey) options.rangeKey = key;
    if (s.index !== undefined)
      indexes[key] = s.index === true ? [{}] : Array.isArray(s.index) ? s.index : [s.index];
    if (s.type?.value === 'Combine') {
      const {attributes = [], separator} = s.type.settings ?? {};
      combine[key] = {sources: attributes, ...(separator !== undefined && {separator})};
    }
  }
  if (options.hashKey !== settings.hashKey || options.rangeKey !== settings.rangeKey) {
    throw new Error(
      `keys differ: marks give ${options.hashKey}/${options.rangeKey}, the dynamoose schema ${settings.hashKey}/${settings.rangeKey}`
    );
  }
  const dates: Record<string, DateStorage> = {};
  collectDates(shape, '', dates, false);
  if (Object.keys(indexes).length > 0) options.indexes = indexes;
  if (Object.keys(combine).length > 0) options.combine = combine;
  if (Object.keys(dates).length > 0) options.dates = dates;
  const ts = settings.timestamps;
  if (ts && (ts.createdAt || ts.updatedAt)) {
    const createdAt = timestamp(ts.createdAt);
    const updatedAt = timestamp(ts.updatedAt);
    options.timestamps = {...(createdAt && {createdAt}), ...(updatedAt && {updatedAt})};
  }
  if (settings.set) options.set = settings.set;
  return options;
}

/**
 * The exported Zod object whose top-level keys are the dynamoose schema's attributes. The converter leaves
 * the timestamps out of the dynamoose schema, so they are not compared. Throws unless exactly one matches.
 */
export function pairSchema(
  exports: Record<string, unknown>,
  attributes: readonly string[]
): unknown {
  const key = (keys: string[]) =>
    keys
      .filter((k) => k !== 'createdAt' && k !== 'updatedAt')
      .sort()
      .join(',');
  const wanted = key([...attributes]);
  const found = new Set(
    Object.values(exports).filter(
      (v) =>
        isZod(v) && v._zod.def.type === 'object' && key(Object.keys(v._zod.def.shape)) === wanted
    )
  );
  if (found.size !== 1)
    throw new Error(`${found.size} exported Zod objects match the dynamoose schema's attributes`);
  return [...found][0];
}
