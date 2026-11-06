import type {$ZodType} from 'zod/v4/core';
import {ConfigError} from '../errors.js';
import {formatPath} from '../expression/paths.js';
import type {DateStorage, PathSegment as Segment} from '../marshall.js';
import type {CombineDefinition, IndexDefinition, UnknownKeys} from '../options.js';
import type {StandardResult, StandardSchema} from '../types.js';

/**
 * What an item holds at one place. A `value` is kept as stored. A `date` carries the storage its field marks.
 * An object with `rest` keeps undeclared keys, shaped by `rest`.
 *
 * Every container (object, list, tuple) that a transform makes has the same rule. `transformed` marks it. Its
 * `fields`, `element` or `items` shape the input: undeclared keys are dropped and nested defaults put in by them,
 * before validation. `output` shapes the stored value: Dates are stored and read back, and update paths resolve,
 * by it. It is the transform's output pipe, else the input shape with the keys the transform adds kept. Nothing
 * that matches the output against the input (restore, undefault) goes below a transformed container.
 * A transform that takes any value (`z.preprocess`) has no input shape: `anyInput` marks it. Its input is kept whole,
 * and its output is what it declares: an update path and an appended element resolve by it, as dynamoose's by its schema.
 */
export type Shape =
  | {readonly type: 'value'}
  | {readonly type: 'date'; readonly storage?: DateStorage}
  | {readonly type: 'set'}
  | {
      readonly type: 'list';
      readonly element: Shape;
      readonly transformed?: true;
      readonly output?: Shape;
    }
  | {
      readonly type: 'tuple';
      readonly items: readonly Shape[];
      readonly rest?: Shape;
      readonly transformed?: true;
      readonly output?: Shape;
    }
  /** `strict`: undeclared keys are kept for the schema to reject (`z.strictObject`). */
  | {
      readonly type: 'object';
      readonly fields: ReadonlyMap<string, Shape>;
      readonly rest?: Shape;
      readonly strict?: true;
      readonly transformed?: true;
      readonly output?: Shape;
      readonly anyInput?: true;
    };

export interface SchemaAdapter {
  /** The field schema at a path, wrappers included. Several union options that match are tried in order. */
  subSchema(path: readonly Segment[]): StandardSchema | undefined;
  /** Parses a value with the field schema at `path`. A value that fails the parse is returned as given. */
  fieldTransform(path: readonly Segment[]): (value: unknown) => unknown;
  /**
   * Returns a fresh default value on each call. `undefined` below a union with more than one option that can hold
   * the value, unless `anyOption`: then the first option's default at `path`.
   */
  defaults(path: readonly Segment[], anyOption?: boolean): (() => unknown) | undefined;
  /**
   * The field schema at `path` for a value written as given (an update): a nested default with checks of its own
   * puts in nothing for a key the value leaves out, and checks only a value given, as dynamoose checks only the keys given.
   * `input`: a transformed container's input side, as an appended element is written before the transform. A
   * preprocess has none: its output, which it declares.
   */
  asGiven(path: readonly Segment[], input?: boolean): StandardSchema | undefined;
  /** The field schema at `path` accepts null, so a null there takes the default, as in dynamoose. */
  nullable(path: readonly Segment[]): boolean;
  /** The schema at `path` has its own checks or transform, so it can only judge a whole value: a partial write under it is refused. */
  hasRule(path: readonly Segment[]): boolean;
  /** The DynamoDB scalar type a key attribute at `path` has, when the schema gives exactly one. */
  keyType(path: readonly Segment[]): 'S' | 'N' | undefined;
  describe(): Shape;
}

// The def shape differs per Zod type; this walker reads only the documented fields of each.
type Def = any;
export const def = (s: $ZodType): Def => s._zod.def;

export const WRAPPERS: ReadonlySet<string> = new Set([
  'optional',
  'nullable',
  'default',
  'prefault',
  'nonoptional',
  'catch',
  'readonly'
]);

/** Metadata attached to one field. */
export interface FieldMeta {
  hashKey?: boolean;
  rangeKey?: boolean;
  index?: readonly IndexDefinition[];
  combine?: CombineDefinition;
  storage?: DateStorage;
}

// Kept in the def, under a symbol: Zod's own derivations (`.min()`, `.describe()`…) and an extension that
// annotates a copy with `clone({...def})` all carry it, and a marked clone gets its own def, so its base stays unmarked.
export const META = Symbol.for('dynotable-orm.meta');

/**
 * The metadata of a field schema: its own (kept by `.min()`, `.describe()`, def copies…), else its inner schema's.
 * Typed structurally: this module is shared with the main entry, whose declarations must not import Zod.
 */
export function getDynamoMeta(schema: {
  readonly _zod: {readonly def: object};
}): FieldMeta | undefined {
  const d: any = schema._zod.def;
  if (d[META]) return d[META];
  if (WRAPPERS.has(d.type)) return getDynamoMeta(d.innerType);
  if (d.type === 'pipe') return getDynamoMeta(d.in) ?? getDynamoMeta(d.out);
  return undefined;
}

const VALUE: Shape = {type: 'value'};
const DATE: Shape = {type: 'date'};
const SET: Shape = {type: 'set'};

type Container = Shape & {type: 'object' | 'list' | 'tuple'};
const isContainer = (s: Shape): s is Container =>
  s.type === 'object' || s.type === 'list' || s.type === 'tuple';

/** What a transform without an output pipe stores: the input's shape, keeping the keys the transform adds. */
function unpiped(s: Container): Shape {
  if (s.type === 'object') return {type: 'object', fields: s.fields, rest: s.rest ?? VALUE};
  if (s.type === 'list') return {type: 'list', element: s.element};
  return {type: 'tuple', items: s.items, ...(s.rest && {rest: s.rest})};
}

/** `shape` made by a transform: `output` is its output pipe's shape, if any. */
const transformed = (shape: Container, output: Shape | undefined): Shape => ({
  ...shape,
  transformed: true,
  output: output ?? unpiped(shape)
});

/**
 * The schema itself, then each wrapper's inner schema. A pipe continues on its output, unless that is a bare
 * transform. `input`: a pipe whose input side transforms continues on that side, which the caller's value is shaped
 * for. `declared`: a preprocess (a pipe whose input is a bare transform) declares no input, so it continues on its output.
 */
function* layers(s: $ZodType, input = false, declared = false): Generator<$ZodType> {
  for (;;) {
    yield s;
    const d = def(s);
    if (WRAPPERS.has(d.type)) s = d.innerType;
    else if (d.type === 'pipe')
      s =
        def(d.out).type === 'transform' ||
        (input && transforms(d.in) && !(declared && def(d.in).type === 'transform'))
          ? d.in
          : d.out;
    else return;
  }
}
/** @internal Kept out of the declarations, which the main entry shares and which must not import Zod. */
export const unwrap = (s: $ZodType): $ZodType => {
  let last = s;
  for (last of layers(s));
  return last;
};

// `input`: through the input side of a pipe whose input transforms, as `describe` shapes a write's value.
function childrenAt(schema: $ZodType, seg: Segment, input: boolean, declared = false): $ZodType[] {
  const d = def(input ? inputEnd(schema, declared) : unwrap(schema));
  switch (d.type) {
    case 'object':
      if (typeof seg !== 'string') return [];
      if (Object.hasOwn(d.shape, seg)) return [d.shape[seg]];
      return d.catchall && def(d.catchall).type !== 'never' ? [d.catchall] : [];
    case 'record':
      return typeof seg === 'string' ? [d.valueType] : [];
    case 'array':
      return typeof seg === 'number' ? [d.element] : [];
    case 'tuple': {
      const item = typeof seg === 'number' ? (d.items[seg] ?? d.rest) : undefined;
      return item ? [item] : [];
    }
    case 'union':
      return d.options.flatMap((o: $ZodType) => childrenAt(o, seg, input, declared));
    default:
      return [];
  }
}

// As z.union: the first schema that accepts the value wins; otherwise the first one's issues.
function anyOf(schemas: readonly StandardSchema[]): StandardSchema {
  type Result = StandardResult<unknown>;
  const from = (value: unknown, i: number, first?: Result): Result | Promise<Result> => {
    const next = (r: Result) =>
      !r.issues ? r : i + 1 < schemas.length ? from(value, i + 1, first ?? r) : (first ?? r);
    const r = schemas[i]!['~standard'].validate(value);
    return r instanceof Promise ? r.then(next) : next(r);
  };
  return {'~standard': {version: 1, vendor: 'dynotable-orm', validate: (value) => from(value, 0)}};
}

function merge(a: Shape, b: Shape): Shape {
  let input: Container;
  if (a.type === 'object' && b.type === 'object') {
    const fields = new Map(a.fields);
    for (const [k, s] of b.fields) fields.set(k, fields.has(k) ? merge(fields.get(k)!, s) : s);
    const rest = a.rest && b.rest ? merge(a.rest, b.rest) : (a.rest ?? b.rest);
    // Either option strict: the union gets the undeclared keys, so Zod rejects or strips them as it would the caller's value.
    const strict = a.strict || b.strict;
    input = {type: 'object', fields, ...(rest && {rest}), ...(strict && {strict})};
  } else if (a.type === 'list' && b.type === 'list') {
    input = {type: 'list', element: merge(a.element, b.element)};
  } else return a.type === b.type && a.type !== 'tuple' ? a : VALUE;
  return a.transformed || b.transformed
    ? transformed(input, merge(a.output ?? a, b.output ?? b))
    : input;
}

// dynamoose's `parent.**` keeps undeclared keys at every depth below the parent.
function openDeep(s: Shape): Shape {
  switch (s.type) {
    case 'object':
      return {
        type: 'object',
        fields: new Map([...s.fields].map(([k, f]) => [k, openDeep(f)])),
        rest: VALUE,
        ...(s.transformed && {transformed: true}),
        ...(s.output && {output: openDeep(s.output)}),
        ...(s.anyInput && {anyInput: true})
      };
    case 'list':
      return {
        type: 'list',
        element: openDeep(s.element),
        ...(s.transformed && {transformed: true}),
        ...(s.output && {output: openDeep(s.output)})
      };
    case 'tuple':
      return {
        type: 'tuple',
        items: s.items.map(openDeep),
        ...(s.rest && {rest: openDeep(s.rest)}),
        ...(s.transformed && {transformed: true}),
        ...(s.output && {output: openDeep(s.output)})
      };
    default:
      return s;
  }
}

// The kind a union option counts as when a Zod→dynamoose converter decides whether a union is a Date.
function kindOf(s: $ZodType): string {
  const d = def(unwrap(s));
  if (d.type === 'literal') return typeof d.values[0];
  if (d.type === 'enum') return typeof Object.values(d.entries)[0];
  return d.type === 'template_literal' ? 'string' : d.type;
}

const scalarKinds = (s: $ZodType): string[] => {
  const d = def(unwrap(s));
  return d.type === 'union' ? d.options.flatMap(scalarKinds) : [kindOf(s)];
};

// A Zod→dynamoose converter: a record, any or custom field adds its parent to saveUnknown, looking through these wrappers only.
function opensParent(s: $ZodType): boolean {
  let d = def(s);
  while (d.type === 'optional' || d.type === 'nullable' || d.type === 'default')
    d = def(d.innerType);
  return d.type === 'record' || d.type === 'any' || d.type === 'custom';
}

// A transform before a pipe (`z.preprocess`) is a layer of its own.
function transforms(s: $ZodType): boolean {
  return [...layers(s, true)].some((l) => {
    const d = def(l);
    return d.type === 'transform' || (d.type === 'pipe' && def(d.out).type === 'transform');
  });
}

const inputEnd = (s: $ZodType, declared = false): $ZodType => {
  let last = s;
  for (last of layers(s, true, declared));
  return last;
};

/** The shape of the value a write gives: a pipe whose input transforms is described by that input. */
function describe(schema: $ZodType, unknownKeys: UnknownKeys): Shape {
  const dynamoose = unknownKeys === 'dynamoose';
  // A transform makes the stored value, shaped by its output pipe when it has one. A container follows the rule on
  // `Shape`; any other value without an output pipe is kept as the transform returns it: a Date that becomes a
  // string is not read back as a Date. A Date marked with a storage stays one.
  const shapeOf = (s: $ZodType, root = false): Shape => {
    const shape = shapeOfInput(s, root);
    if (!transforms(s)) return shape;
    const piped = unwrap(s);
    let output = piped === inputEnd(s) ? undefined : shapeOf(piped);
    const storage = getDynamoMeta(s)?.storage;
    if (output?.type === 'date' && output.storage === undefined && storage !== undefined)
      output = {type: 'date', storage};
    if (isContainer(shape)) return transformed(shape, output);
    // Any input (`z.preprocess`) to a container: the input is kept whole (nothing dropped, no nested default), the
    // output shapes the stored value.
    if (output && isContainer(output))
      return {
        type: 'object',
        fields: new Map(),
        rest: VALUE,
        transformed: true,
        output,
        anyInput: true
      };
    if (shape.type === 'date' && shape.storage !== undefined && (output ?? shape).type === 'date')
      return shape;
    return output ?? VALUE;
  };
  const shapeOfInput = (s: $ZodType, root: boolean): Shape => {
    const d = def(inputEnd(s));
    switch (d.type) {
      case 'date': {
        const storage = getDynamoMeta(s)?.storage;
        return storage === undefined ? DATE : {type: 'date', storage};
      }
      case 'set':
        return SET;
      case 'array':
        return {type: 'list', element: shapeOf(d.element)};
      case 'tuple':
        return {
          type: 'tuple',
          items: d.items.map((i: $ZodType) => shapeOf(i)),
          ...(d.rest && {rest: shapeOf(d.rest)})
        };
      case 'record':
        return dynamoose ? VALUE : {type: 'object', fields: new Map(), rest: shapeOf(d.valueType)};
      case 'object': {
        const entries = Object.entries<$ZodType>(d.shape);
        const fields = new Map(entries.map(([k, f]) => [k, shapeOf(f)]));
        if (dynamoose) {
          const object: Shape = {type: 'object', fields};
          // At the root, the converter opens the record field itself (`key.**`), not the item.
          return !root && entries.some(([, f]) => opensParent(f)) ? openDeep(object) : object;
        }
        const open = d.catchall && def(d.catchall).type !== 'never';
        if (d.catchall && !open) return {type: 'object', fields, strict: true};
        return {type: 'object', fields, ...(open && {rest: shapeOf(d.catchall)})};
      }
      case 'union': {
        const shapes: Shape[] = d.options.map((o: $ZodType) => shapeOf(o, root));
        // A Zod→dynamoose converter's rule: a union of a Date and exactly one other type is a Date.
        const date = shapes.find((x) => x.type === 'date');
        if (date && new Set(d.options.map(kindOf)).size === 2) return date;
        return shapes.reduce(merge);
      }
      default:
        return VALUE;
    }
  };
  return shapeOf(schema, true);
}

function acceptsNull(s: $ZodType): boolean {
  return [...layers(s)].some((l) => {
    const d = def(l);
    if (d.type === 'union') return d.options.some(acceptsNull);
    return d.type === 'nullable' || d.type === 'null' || d.type === 'any' || d.type === 'unknown';
  });
}

/** The options of `s` (one, unless it is a union) that can hold a value with the key or index `seg`. */
function holders(s: $ZodType, seg: Segment): number {
  const d = def(inputEnd(s));
  if (d.type === 'union')
    return d.options.reduce((n: number, o: $ZodType) => n + holders(o, seg), 0);
  const kinds = typeof seg === 'string' ? ['object', 'record'] : ['array', 'tuple'];
  return kinds.includes(d.type) ? 1 : 0;
}

/** The default an absent value takes. A pipe gets the value on its input side first, so a default there comes first. */
function defaultOf(s: $ZodType): (() => unknown) | undefined {
  for (;;) {
    const d = def(s);
    if (d.type === 'default') return () => d.defaultValue;
    if (WRAPPERS.has(d.type)) s = d.innerType;
    else if (d.type === 'pipe') return defaultOf(d.in) ?? defaultOf(d.out);
    else return undefined;
  }
}

/** A copy of a def that keeps its getters (a default's `defaultValue` makes a fresh value on each read). */
const copyDef = (d: Def, changes: object): Def =>
  Object.defineProperties(
    {},
    {...Object.getOwnPropertyDescriptors(d), ...Object.getOwnPropertyDescriptors(changes)}
  );
const rebuild = (s: $ZodType, changes: object): $ZodType =>
  new (s._zod as any).constr(copyDef(def(s), changes));

// Zod skips a check without `when` once an issue aborts the value.
const aborted = (p: {issues: readonly {continue?: boolean}[]}) =>
  p.issues.some((i) => i.continue !== true);

const asGivenCache = new WeakMap<$ZodType, $ZodType>();
/**
 * `s` with each `.default()` that has checks of its own made to put in nothing and to skip those checks for an
 * absent value. A default without checks needs nothing: Zod gives its value unchecked, and undefault takes it out.
 */
function asGivenSchema(s: $ZodType): $ZodType {
  const cached = asGivenCache.get(s);
  if (cached) return cached;
  const d = def(s);
  const each = (list: readonly $ZodType[]) => {
    const out = list.map(asGivenSchema);
    return out.some((o, i) => o !== list[i]) ? out : undefined;
  };
  let changes: Record<string, unknown> | undefined;
  if (WRAPPERS.has(d.type)) {
    const inner = asGivenSchema(d.innerType);
    if (inner !== d.innerType) changes = {innerType: inner};
    if (d.type === 'default' && d.checks?.length > 0) {
      const checks = d.checks.map((ch: $ZodType) => {
        const when = def(ch).when;
        return rebuild(ch, {
          when: (p: any) => p.value !== undefined && (when ? when(p) : !aborted(p))
        });
      });
      changes = {...changes, defaultValue: undefined, checks};
    }
  } else if (d.type === 'pipe') {
    const [i, o] = [asGivenSchema(d.in), asGivenSchema(d.out)];
    const piped = i !== d.in || o !== d.out ? rebuild(s, {in: i, out: o}) : s;
    // A default before a pipe gives its value to the checks after it: an absent value gets nothing and no check.
    let inner = i;
    while (def(inner).type !== 'default' && WRAPPERS.has(def(inner).type))
      inner = def(inner).innerType;
    const out =
      def(inner).type === 'default'
        ? rebuild(inner, {innerType: piped, defaultValue: undefined, checks: []})
        : piped;
    asGivenCache.set(s, out);
    return out;
  } else if (d.type === 'object') {
    const keys = Object.keys(d.shape);
    const fields = each(keys.map((k) => d.shape[k]));
    const catchall = d.catchall && asGivenSchema(d.catchall);
    if (fields) changes = {shape: Object.fromEntries(keys.map((k, i) => [k, fields[i]]))};
    if (catchall !== d.catchall) changes = {...changes, catchall};
  } else if (d.type === 'array') {
    const element = asGivenSchema(d.element);
    if (element !== d.element) changes = {element};
  } else if (d.type === 'tuple') {
    const items = each(d.items);
    const rest = d.rest && asGivenSchema(d.rest);
    if (items) changes = {items};
    if (rest !== d.rest) changes = {...changes, rest};
  } else if (d.type === 'record') {
    const valueType = asGivenSchema(d.valueType);
    if (valueType !== d.valueType) changes = {valueType};
  } else if (d.type === 'union') {
    const options = each(d.options);
    if (options) changes = {options};
  }
  const out = changes ? rebuild(s, changes) : s;
  asGivenCache.set(s, out);
  return out;
}

/** `schema` must be a Zod 4 schema. */
export function zodAdapter(standard: StandardSchema, unknownKeys: UnknownKeys): SchemaAdapter {
  const schema = standard as unknown as $ZodType;
  const candidates = (path: readonly Segment[], input = false, declared = false) => {
    let found = [schema];
    for (const seg of path)
      found = [...new Set(found.flatMap((s) => childrenAt(s, seg, input, declared)))];
    return found;
  };
  const oneOf = (found: $ZodType[]) => {
    const schemas = found as unknown as StandardSchema[];
    return schemas.length > 1 ? anyOf(schemas) : schemas[0];
  };
  const subSchema = (path: readonly Segment[]) => oneOf(candidates(path));
  return {
    subSchema,
    asGiven: (path, input = false) => oneOf(candidates(path, input, input).map(asGivenSchema)),
    fieldTransform(path) {
      const field = subSchema(path);
      if (field === undefined) return (value) => value;
      return (value) => {
        const result = field['~standard'].validate(value);
        if (result instanceof Promise) {
          // Zod also answers with a Promise when a sync transform throws; left unhandled, its rejection ends the process.
          result.catch(() => {});
          throw new ConfigError(
            `'${formatPath(path)}' has an async check or transform, or one that throws; a key or condition value needs a sync one`
          );
        }
        return result.issues ? value : result.value;
      };
    },
    // Defaults go into the input, before validation. Below a union with more than one option that can hold the
    // value, the option Zod takes is known only after the parse: Zod puts in that option's defaults itself.
    defaults(path, anyOption = false) {
      let found = [schema];
      for (const seg of path) {
        if (!anyOption && found.some((s) => holders(s, seg) > 1)) return undefined;
        found = [...new Set(found.flatMap((s) => childrenAt(s, seg, true)))];
      }
      for (const s of found) {
        const make = defaultOf(s);
        if (make) return make;
      }
      return undefined;
    },
    nullable: (path) => candidates(path, true).some(acceptsNull),
    hasRule(path) {
      for (const s of candidates(path)) {
        for (const layer of layers(s)) {
          const d = def(layer);
          if (d.checks?.length > 0 || d.type === 'pipe' || d.type === 'transform') return true;
        }
      }
      return false;
    },
    keyType(path) {
      const kinds = new Set(candidates(path).flatMap(scalarKinds));
      const [kind] = kinds;
      if (kinds.size !== 1) return undefined;
      return kind === 'string' ? 'S' : kind === 'number' || kind === 'bigint' ? 'N' : undefined;
    },
    describe: () => describe(schema, unknownKeys)
  };
}
