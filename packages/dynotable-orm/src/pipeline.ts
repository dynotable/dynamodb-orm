import {ValidationError, valueAt} from './errors.js';
import {
  type DateStorage,
  guardKey,
  isPlainObject,
  marshallItem,
  type PathSegment,
  storeDate,
  unmarshallItem
} from './marshall.js';
import type {ModelMetadata, Plan, TimestampPlan} from './plan.js';
import type {Item, StandardResult, StoredItem} from './types.js';
import type {SchemaAdapter, Shape} from './zod/walk.js';

type Walk = (value: unknown) => unknown;
type Restore = (out: unknown, source: unknown) => unknown;

// A Shape whose Date places all carry a storage, and whose objects markDate can change. A container a transform
// makes follows the rule on `Shape`: the input side (`fields`, `element`, `items`) drives drop and nested defaults,
// `output` drives the stored form, the read and the paths, and restore and undefault stop at it. `anyInput`: a
// preprocess, whose output is also what an update path and an appended element resolve by.
type Node =
  | {type: 'value'}
  /** A Set holds no path below it. */
  | {type: 'set'}
  | {type: 'date'; storage: DateStorage}
  | {type: 'list'; element: Node; transformed?: true; output?: Node}
  | {type: 'tuple'; items: Node[]; rest?: Node; transformed?: true; output?: Node}
  | {
      type: 'object';
      fields: Map<string, Node>;
      rest?: Node;
      strict?: true;
      transformed?: true;
      output?: Node;
      anyInput?: true;
    };

export interface Converters {
  /**
   * Every Date path reachable through objects, with its storage: options, field marks, the schema's Dates,
   * timestamps. `ModelMetadata.dates` holds only the options and field marks.
   */
  datePaths: Map<string, DateStorage>;
  /** Top-level defaults, applied before combine. `true`: a null takes the default too. */
  defaults: ReadonlyArray<readonly [string, () => unknown, boolean]>;
  /** Puts the defaults of nested fields into a copy, in place, where the parent is present. */
  nestedDefaults?: (item: unknown) => void;
  /** Drops undeclared keys from an input, into a copy as `deepCopy` makes. Absent when every key is kept. */
  drop?: Walk;
  /** Puts back into the validated item the undeclared keys of open objects that the schema stripped (`unknownKeys: 'dynamoose'`). */
  restore?: Restore;
  /** Turns Dates into their stored form. */
  toStored?: Walk;
  /** Drops undeclared keys and turns stored Dates back, in place. */
  fromStored?: Walk;
  /**
   * `undefined` when the item cannot hold `path`. Otherwise what it holds there, the walk that drops the undeclared
   * keys at and below it, the walk that turns Dates at and below it into their stored form, and the `restore` for the
   * value at it, if any. `input`: what a value holds there before a transform runs, as an appended element is
   * stored as given.
   */
  at(
    path: readonly PathSegment[],
    input?: boolean
  ):
    | {
        type: Node['type'];
        drop?: Walk;
        toStored?: Walk;
        restore?: Restore;
        /** Takes out of the validated value the nested defaults of the keys its source leaves out. */
        undefault?: Restore;
      }
    | undefined;
}

const VALUE: Node = {type: 'value'};
const SET: Node = {type: 'set'};
const isObject = (v: unknown): v is Item => typeof v === 'object' && v !== null && isPlainObject(v);

function toNode(s: Shape, storage: DateStorage): Node {
  switch (s.type) {
    case 'date':
      return {type: 'date', storage: s.storage ?? storage};
    case 'set':
      return SET;
    case 'list':
      return {
        type: 'list',
        element: toNode(s.element, storage),
        ...(s.transformed && {transformed: true}),
        ...(s.output && {output: toNode(s.output, storage)})
      };
    case 'tuple':
      return {
        type: 'tuple',
        items: s.items.map((i) => toNode(i, storage)),
        ...(s.rest && {rest: toNode(s.rest, storage)}),
        ...(s.transformed && {transformed: true}),
        ...(s.output && {output: toNode(s.output, storage)})
      };
    case 'object':
      return {
        type: 'object',
        fields: new Map([...s.fields].map(([k, f]) => [k, toNode(f, storage)])),
        ...(s.rest && {rest: toNode(s.rest, storage)}),
        ...(s.strict && {strict: true}),
        ...(s.transformed && {transformed: true}),
        ...(s.output && {output: toNode(s.output, storage)}),
        ...(s.anyInput && {anyInput: true})
      };
    default:
      return VALUE;
  }
}

const openObject = (): Node => ({type: 'object', fields: new Map(), rest: VALUE});

const isTransformed = (node: Node): node is Node & {output: Node} =>
  'output' in node && node.output !== undefined;
// A preprocess declares its output only.
const declares = (node: Node): boolean => node.type === 'object' && node.anyInput === true;

// dynamoose gives a default for null too, where the field's type accepts null.
const missing = (v: unknown, orNull: boolean) => v === undefined || (orNull && v === null);

// A dates entry makes its path a Date, so a Date union the schema cannot tell apart is still converted. Below a
// transformed object, it marks the output too, which the stored value has.
function markDate(
  node: Node & {type: 'object'},
  path: readonly string[],
  storage: DateStorage
): void {
  const [seg, ...below] = path as [string, ...string[]];
  if (below.length === 0) node.fields.set(seg, {type: 'date', storage});
  else {
    let child = node.fields.get(seg);
    if (child?.type !== 'object') node.fields.set(seg, (child = openObject()));
    markDate(child as Node & {type: 'object'}, below, storage);
  }
  if (node.output?.type === 'object') markDate(node.output, path, storage);
}

function collectDates(node: Node, prefix: string, out: Map<string, DateStorage>): void {
  if (node.type === 'date') out.set(prefix, node.storage);
  if (node.type !== 'object') return;
  for (const [k, f] of node.fields) collectDates(f, prefix ? `${prefix}.${k}` : k, out);
}

const childWalks = <W>(fields: Map<string, Node>, compile: (n: Node) => W | undefined) =>
  new Map([...fields].map(([k, f]) => [k, compile(f)] as const));

// A list or a tuple, walked into a new array. A list keeps the plain map, its hot path.
function arrayWalk(
  node: Node & {type: 'list' | 'tuple'},
  compile: (n: Node) => Walk | undefined
): Walk | undefined {
  if (node.type === 'list') {
    const element = compile(node.element);
    return element && ((v) => (Array.isArray(v) ? v.map(element) : v));
  }
  const items = node.items.map(compile);
  const rest = node.rest && compile(node.rest);
  if (!rest && !items.some(Boolean)) return undefined;
  return (v) =>
    Array.isArray(v)
      ? v.map((e, i) => {
          const walk = i < items.length ? items[i] : rest;
          return walk ? walk(e) : e;
        })
      : v;
}

// Also copies each value it keeps, as `deepCopy`: the schema and the hook get the copy, never a caller's object.
// `undefined` when no key is dropped at or below the node, so `deepCopy` does the whole work.
function compileDrop(node: Node): Walk | undefined {
  switch (node.type) {
    case 'list': {
      const element = compileDrop(node.element);
      return element && ((v) => (Array.isArray(v) ? v.map(element) : deepCopy(v)));
    }
    case 'tuple': {
      const items = node.items.map(compileDrop);
      const rest = node.rest && compileDrop(node.rest);
      if (!rest && !items.some(Boolean)) return undefined;
      return (v) =>
        Array.isArray(v)
          ? v.map((e, i) => {
              const walk = i < items.length ? items[i] : rest;
              return walk ? walk(e) : deepCopy(e);
            })
          : deepCopy(v);
    }
    case 'object': {
      const fields = childWalks(node.fields, compileDrop);
      const rest = node.rest && compileDrop(node.rest);
      // A strict object keeps its undeclared keys, so the schema rejects them as Zod means it to.
      const open = node.rest !== undefined || node.strict === true;
      if (open && !rest && ![...fields.values()].some(Boolean)) return undefined;
      return (v) => {
        if (!isObject(v)) return deepCopy(v);
        const out: Item = {};
        for (const k of Object.keys(v)) {
          if (fields.has(k)) {
            const walk = fields.get(k);
            out[k] = walk ? walk(v[k]) : deepCopy(v[k]);
          } else if (open) {
            guardKey(k);
            out[k] = rest ? rest(v[k]) : deepCopy(v[k]);
          }
        }
        return out;
      };
    }
    default:
      return undefined;
  }
}

// Returns `out`, or a copy of it at each level that gains a key: Zod freezes a `.readonly()` output.
function compileRestore(node: Node): Restore | undefined {
  // The transform's output need not line up with its input.
  if (isTransformed(node)) return undefined;
  switch (node.type) {
    case 'list':
    case 'tuple': {
      const items = node.type === 'list' ? [] : node.items.map(compileRestore);
      const rest =
        node.type === 'list'
          ? compileRestore(node.element)
          : node.rest && compileRestore(node.rest);
      if (!rest && !items.some(Boolean)) return undefined;
      return (out, source) => {
        if (!Array.isArray(out) || !Array.isArray(source) || out.length !== source.length)
          return out;
        let res = out;
        for (let i = 0; i < out.length; i++) {
          const walk = i < items.length ? items[i] : rest;
          if (!walk) continue;
          const v = walk(out[i], source[i]);
          if (v === out[i]) continue;
          if (res === out) res = [...out];
          res[i] = v;
        }
        return res;
      };
    }
    case 'object': {
      const fields = [...childWalks(node.fields, compileRestore)].filter(
        (e): e is [string, Restore] => e[1] !== undefined
      );
      const open = node.rest !== undefined;
      if (!open && fields.length === 0) return undefined;
      const declared = node.fields;
      return (out, source) => {
        if (!isObject(out) || !isObject(source)) return out;
        let res = out;
        const put = (k: string, v: unknown) => {
          if (res === out) res = {...out};
          res[k] = v;
        };
        for (const [k, walk] of fields) {
          if (!Object.hasOwn(out, k)) continue;
          const v = walk(out[k], source[k]);
          if (v !== out[k]) put(k, v);
        }
        if (open)
          for (const k of Object.keys(source))
            if (!declared.has(k) && !Object.hasOwn(out, k)) put(k, source[k]);
        return res;
      };
    }
    default:
      return undefined;
  }
}

function compileToStored(node: Node, input = false): Walk | undefined {
  const walk = (n: Node) => compileToStored(n, input);
  if (isTransformed(node) && !input) return walk(node.output);
  switch (node.type) {
    case 'date': {
      const {storage} = node;
      return (v) => (v instanceof Date ? storeDate(v, storage) : v);
    }
    case 'list':
    case 'tuple':
      return arrayWalk(node, walk);
    case 'object': {
      const fields = [...childWalks(node.fields, walk)].filter(
        (e): e is [string, Walk] => e[1] !== undefined
      );
      const rest = node.rest && walk(node.rest);
      if (!rest && fields.length === 0) return undefined;
      const declared = node.fields;
      return (v) => {
        if (!isObject(v)) return v;
        const out: Item = {...v};
        for (const [k, walk] of fields) if (Object.hasOwn(v, k)) out[k] = walk(v[k]);
        if (rest) for (const k of Object.keys(v)) if (!declared.has(k)) out[k] = rest(v[k]);
        return out;
      };
    }
    default:
      return undefined;
  }
}

// dynamoose's Date fromDynamo. A stored type that does not match the storage is kept as stored.
function readDate(v: unknown, storage: DateStorage): unknown {
  if (storage === 'iso') return typeof v === 'string' ? new Date(v) : v;
  if (typeof v !== 'number') return v;
  return new Date(storage === 'seconds' ? v * 1000 : v);
}

// The value comes from unmarshallItem, so the walk owns it and changes it in place.
function compileFromStored(node: Node): Walk | undefined {
  if (isTransformed(node)) return compileFromStored(node.output);
  switch (node.type) {
    case 'date': {
      const {storage} = node;
      return (v) => readDate(v, storage);
    }
    case 'list':
    case 'tuple': {
      const items = node.type === 'list' ? [] : node.items.map(compileFromStored);
      const rest =
        node.type === 'list'
          ? compileFromStored(node.element)
          : node.rest && compileFromStored(node.rest);
      if (!rest && !items.some(Boolean)) return undefined;
      return (v) => {
        if (!Array.isArray(v)) return v;
        for (let i = 0; i < v.length; i++) {
          const walk = i < items.length ? items[i] : rest;
          if (walk) v[i] = walk(v[i]);
        }
        return v;
      };
    }
    case 'object': {
      const fields = childWalks(node.fields, compileFromStored);
      const rest = node.rest && compileFromStored(node.rest);
      const open = node.rest !== undefined;
      if (open && !rest && ![...fields.values()].some(Boolean)) return undefined;
      return (v) => {
        if (!isObject(v)) return v;
        for (const k of Object.keys(v)) {
          if (fields.has(k)) {
            const walk = fields.get(k);
            if (walk) v[k] = walk(v[k]);
          } else if (!open) delete v[k];
          else if (rest) v[k] = rest(v[k]);
        }
        return v;
      };
    }
    default:
      return undefined;
  }
}

type Fill = (value: unknown) => void;

// A parent's default goes in before its fields', which it may hold. Not on the root: `defaults` holds its fields'.
function compileDefaults(
  node: Node,
  path: readonly PathSegment[],
  adapter: SchemaAdapter
): Fill | undefined {
  if (node.type === 'list') {
    const element = compileDefaults(node.element, [...path, 0], adapter);
    return element && ((v) => Array.isArray(v) && v.forEach(element));
  }
  if (node.type === 'tuple') {
    const items = node.items.map((n, i) => compileDefaults(n, [...path, i], adapter));
    const rest = node.rest && compileDefaults(node.rest, [...path, items.length], adapter);
    if (!rest && !items.some(Boolean)) return undefined;
    return (v) =>
      Array.isArray(v) && v.forEach((e, i) => (i < items.length ? items[i] : rest)?.(e));
  }
  if (node.type !== 'object') return undefined;
  const own: Array<readonly [string, () => unknown, boolean]> = [];
  const below: Array<readonly [string, Fill]> = [];
  for (const [k, field] of node.fields) {
    const at = [...path, k];
    const make = path.length > 0 ? adapter.defaults(at) : undefined;
    if (make) own.push([k, make, adapter.nullable(at)]);
    const fill = compileDefaults(field, at, adapter);
    if (fill) below.push([k, fill]);
  }
  if (own.length === 0 && below.length === 0) return undefined;
  return (v) => {
    if (!isObject(v)) return;
    for (const [k, make, orNull] of own) if (missing(v[k], orNull)) v[k] = deepCopy(make());
    for (const [k, fill] of below) fill(v[k]);
  };
}

// Returns `out`, or a copy of it at each level that loses a key: Zod freezes a `.readonly()` output. A transformed
// object, list or tuple is left as its transform made it.
function compileUndefault(
  node: Node,
  path: readonly PathSegment[],
  defaultOf: (path: readonly PathSegment[]) => (() => unknown) | undefined
): Restore | undefined {
  if (node.type === 'list' || node.type === 'tuple') {
    if (node.transformed) return undefined;
    const items =
      node.type === 'list'
        ? []
        : node.items.map((n, i) => compileUndefault(n, [...path, i], defaultOf));
    const rest =
      node.type === 'list'
        ? compileUndefault(node.element, [...path, 0], defaultOf)
        : node.rest && compileUndefault(node.rest, [...path, items.length], defaultOf);
    if (!rest && !items.some(Boolean)) return undefined;
    return (out, source) => {
      if (!Array.isArray(out) || !Array.isArray(source) || out.length !== source.length) return out;
      let res = out;
      for (let i = 0; i < out.length; i++) {
        const walk = i < items.length ? items[i] : rest;
        const v = walk ? walk(out[i], source[i]) : out[i];
        if (v === out[i]) continue;
        if (res === out) res = [...out];
        res[i] = v;
      }
      return res;
    };
  }
  if (node.type !== 'object' || node.transformed) return undefined;
  const own: string[] = [];
  const below: Array<readonly [string, Restore]> = [];
  for (const [k, field] of node.fields) {
    if (defaultOf([...path, k])) own.push(k);
    const walk = compileUndefault(field, [...path, k], defaultOf);
    if (walk) below.push([k, walk]);
  }
  if (own.length === 0 && below.length === 0) return undefined;
  return (out, source) => {
    if (!isObject(out) || !isObject(source)) return out;
    let res = out;
    for (const k of own) {
      if (source[k] !== undefined || !Object.hasOwn(res, k)) continue;
      if (res === out) res = {...out};
      delete res[k];
    }
    for (const [k, walk] of below) {
      if (!Object.hasOwn(res, k)) continue;
      const v = walk(res[k], source[k]);
      if (v === res[k]) continue;
      if (res === out) res = {...out};
      res[k] = v;
    }
    return res;
  };
}

// A `value` holds anything below it, so the walk stops there and every deeper path is accepted.
function nodeAt(root: Node, path: readonly PathSegment[], input = false): Node | undefined {
  let node = root;
  for (const seg of path) {
    // The stored value below a transformed container has the shape of its output.
    while (isTransformed(node) && (!input || declares(node))) node = node.output;
    let next: Node | undefined;
    if (node.type === 'value') return node;
    if (node.type === 'object')
      next = typeof seg === 'string' ? (node.fields.get(seg) ?? node.rest) : undefined;
    else if (node.type === 'list') next = typeof seg === 'number' ? node.element : undefined;
    else if (node.type === 'tuple')
      next = typeof seg === 'number' ? (node.items[seg] ?? node.rest) : undefined;
    if (next === undefined) return undefined;
    node = next;
  }
  return node;
}

/** Builds the write and read converters from the adapter's shape, the dates option and the timestamps. */
export function buildConverters(meta: ModelMetadata): Converters {
  const described = meta.adapter
    ? toNode(meta.adapter.describe(), meta.defaultDateStorage)
    : undefined;
  // Without an adapter every key is kept, and Dates come from the values plus the dates option.
  const root = described?.type === 'object' ? described : (openObject() as Node & {type: 'object'});
  const timestampNames = new Set<string>();
  const declaredTop = [...root.fields.keys()];
  for (const [path, storage] of meta.dates) markDate(root, path.split('.'), storage);
  for (const ts of [meta.timestamps.createdAt, meta.timestamps.updatedAt]) {
    if (!ts) continue;
    timestampNames.add(ts.name);
    if (ts.kind === 'date') markDate(root, [ts.name], ts.storage);
    else if (!root.fields.has(ts.name)) root.fields.set(ts.name, VALUE);
  }
  const datePaths = new Map<string, DateStorage>();
  collectDates(root, '', datePaths);

  const defaults: Array<readonly [string, () => unknown, boolean]> = [];
  for (const key of declaredTop) {
    const make = timestampNames.has(key) ? undefined : meta.adapter?.defaults([key]);
    if (make) defaults.push([key, make, meta.adapter!.nullable([key])]);
  }

  // Zod's .default() skips the field's own checks and transforms; given before validation, the value goes through them, as in dynamoose.
  const nestedDefaults = meta.adapter && compileDefaults(root, [], meta.adapter);
  const drop = meta.adapter && compileDrop(root);
  // Zod strips undeclared keys that dynamoose's `parent.**` keeps.
  const restore =
    meta.adapter && meta.unknownKeys === 'dynamoose' ? compileRestore(root) : undefined;
  const toStored = compileToStored(root);
  const fromStored = compileFromStored(root);
  const at = (path: readonly PathSegment[], input = false) => {
    const node = nodeAt(root, path, input);
    if (node === undefined) return undefined;
    const cut = drop && compileDrop(node);
    const walk = compileToStored(node, input);
    const back = restore && compileRestore(node);
    const {adapter} = meta;
    const undefault = adapter && compileUndefault(node, path, (p) => adapter.defaults(p, true));
    return {
      type: isTransformed(node) && declares(node) ? node.output.type : node.type,
      ...(cut && {drop: cut}),
      ...(walk && {toStored: walk}),
      ...(back && {restore: back}),
      ...(undefault && {undefault})
    };
  };
  return {
    at,
    datePaths,
    defaults,
    ...(nestedDefaults && {nestedDefaults}),
    ...(drop && {drop}),
    ...(restore && {restore}),
    ...(toStored && {toStored}),
    ...(fromStored && {fromStored})
  };
}

/**
 * A copy of every plain object, list, Set, Map (its values; keys are kept), Date, ArrayBuffer and ArrayBuffer view,
 * as dynamoose's `deep_copy`, so a hook or a transform that changes its argument cannot reach a value the caller
 * passed by reference. Any other object (a class instance) is passed as it is.
 */
export function deepCopy(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.map(deepCopy);
  if (value instanceof Date) return new Date(value.getTime());
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  // Marshalling takes any ArrayBuffer view as bytes, so each is copied with its own type.
  if (ArrayBuffer.isView(value)) {
    if (value instanceof DataView)
      return new DataView(
        value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
      );
    return (value as Uint8Array).slice();
  }
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (value instanceof Set) return new Set([...value].map(deepCopy));
  if (value instanceof Map) return new Map([...value].map(([k, v]) => [k, deepCopy(v)]));
  if (!isPlainObject(value)) return value;
  const out: Item = {};
  for (const k of Object.keys(value)) {
    guardKey(k);
    out[k] = deepCopy(value[k]);
  }
  return out;
}

// dynamoose's timestamp rule: seconds floor, unlike a Date attribute.
export function stamp(ts: TimestampPlan, d: Date): string | number {
  if (ts.storage === 'iso') return d.toISOString();
  return ts.storage === 'seconds' ? Math.floor(d.getTime() / 1000) : d.getTime();
}

export interface WriteMode {
  /** The item is not stored yet, so `createdAt` is computed. */
  isNew: boolean;
  /** Keep the input's `createdAt` (`save()` of an item that was read). */
  keepCreatedAt?: boolean;
}

/**
 * Builds the stored item, in dynamoose's write order: drop undeclared keys, hold the timestamps aside,
 * defaults, combine, validate, Dates to stored form, the whole-item hook, marshal. Never changes `input`.
 * Returns a Promise only when the schema validates asynchronously.
 */
export function toStoredItem(
  plan: Plan,
  input: Item,
  {isNew, keepCreatedAt = false}: WriteMode
): StoredItem | Promise<StoredItem> {
  // A schema may change its input or return it by reference (a transform, `.readonly()`, z.any()), and the
  // hook may change its argument: both get a copy.
  const item = (plan.drop ? plan.drop(input) : deepCopy(input)) as Item;

  const held = new Map<string, unknown>();
  const {createdAt, updatedAt} = plan.timestamps;
  // One clock read for both, as dynamoose: a write never stores two different times.
  const now = createdAt || updatedAt ? new Date() : undefined;
  for (const [ts, computed] of [
    [createdAt, isNew && !keepCreatedAt],
    [updatedAt, true]
  ] as const) {
    if (!ts) continue;
    const given = item[ts.name];
    if (computed) held.set(ts.name, stamp(ts, now!));
    else if (given !== undefined)
      held.set(ts.name, given instanceof Date ? stamp(ts, given) : given);
    // Held out of validation (timestamps are not validated, as in dynamoose), so a bare z.date() timestamp field and a
    // strictObject both accept the item. A field that rejects absence sees the clock instead; finish() puts the held value back.
    if (ts.required) item[ts.name] = ts.kind === 'number' ? now!.getTime() : now;
    else if (Object.hasOwn(item, ts.name)) delete item[ts.name];
  }

  for (const [key, make, orNull] of plan.defaults) {
    if (missing(item[key], orNull)) item[key] = deepCopy(make());
  }
  plan.nestedDefaults?.(item);

  for (const {target, sources, separator} of plan.combine) {
    const parts: unknown[] = [];
    for (const source of sources) {
      let v = held.has(source) ? held.get(source) : item[source];
      if (v instanceof Date)
        v = storeDate(v, plan.datePaths.get(source) ?? plan.defaultDateStorage);
      if (v !== undefined && v !== null) parts.push(v);
    }
    item[target] = parts.join(separator);
  }

  const result = plan.validate(item);
  return result instanceof Promise
    ? result.then((r) => finish(plan, r, item, held))
    : finish(plan, result, item, held);
}

function finish(
  plan: Plan,
  result: StandardResult<unknown>,
  source: Item,
  held: Map<string, unknown>
): StoredItem {
  if (result.issues) throw new ValidationError(result.issues, valueAt(source));
  const valid = (plan.restore ? plan.restore(result.value, source) : result.value) as Item;
  let out = (plan.toStored ? plan.toStored(valid) : valid) as Item;
  const {createdAt, updatedAt} = plan.timestamps;
  if (createdAt || updatedAt) {
    if (out === valid) out = {...valid};
    // A timestamp value from the schema's output (a .default()) is discarded.
    for (const ts of [createdAt, updatedAt]) if (ts) delete out[ts.name];
    for (const [k, v] of held) out[k] = v;
  }
  if (plan.set) out = plan.set(out);
  return marshallItem(out, plan.defaultDateStorage);
}

/** A deep copy of `item` with the schema's defaults put in where a field is missing, as a write does. Nothing is checked. */
export function withDefaults(plan: Plan, item: Item): Item {
  const out = deepCopy(item) as Item;
  for (const [key, make, orNull] of plan.defaults) {
    if (missing(out[key], orNull)) out[key] = deepCopy(make());
  }
  plan.nestedDefaults?.(out);
  return out;
}

/** Unmarshalls a stored item, drops undeclared keys and turns stored Dates back. `raw` returns the stored values. */
export function fromStoredItem(
  plan: Plan,
  stored: StoredItem,
  {raw = false}: {raw?: boolean} = {}
): Item {
  const unmarshalled = unmarshallItem(stored);
  const item = raw || !plan.fromStored ? unmarshalled : (plan.fromStored(unmarshalled) as Item);
  return withToJSON(item);
}

// One descriptor for every item: defineProperty then reads no fresh object.
const TO_JSON: PropertyDescriptor = {
  value(this: object): unknown {
    return JSON.parse(JSON.stringify({...this}));
  },
  configurable: true,
  enumerable: false,
  writable: true
};

/**
 * Gives an item dynamoose's `toJSON` (a JSON round trip), not enumerable: a test snapshot and `item.toJSON()` print it
 * as they printed a dynamoose item. Equality, spreads, copies and writes see the fields only.
 */
export function withToJSON<T>(item: T): T {
  // An item's own toJSON (a fixture's) stays, as it shadowed the dynamoose item's.
  if (typeof item === 'object' && item !== null && !Object.hasOwn(item, 'toJSON'))
    Object.defineProperty(item, 'toJSON', TO_JSON);
  return item;
}
