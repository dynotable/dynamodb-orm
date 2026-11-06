import type {AttributeValue} from '@aws-sdk/client-dynamodb';
import {ExpressionError} from './errors.js';
import type {Comparator, ConditionNode} from './expression/condition-ast.js';
import {parsePath, type Path} from './expression/paths.js';
import {isPlainObject, marshallValue, storeDate} from './marshall.js';
import {deepCopy} from './pipeline.js';
import {type Plan, perPlan} from './plan.js';
import type {IsAny, RawCondition} from './types.js';

type Op =
  | 'eq'
  | 'ne'
  | 'lt'
  | 'le'
  | 'gt'
  | 'ge'
  | 'beginsWith'
  | 'contains'
  | 'exists'
  | 'in'
  | 'between';
const OPS: ReadonlySet<string> = new Set<Op>([
  'eq',
  'ne',
  'lt',
  'le',
  'gt',
  'ge',
  'beginsWith',
  'contains',
  'exists',
  'in',
  'between'
]);

// dynamoose's `not` table. These three have no opposite.
const NOT_NEGATABLE: ReadonlySet<Op> = new Set<Op>(['beginsWith', 'in', 'between']);
const COMPARATOR: Record<
  'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge',
  readonly [Comparator, Comparator]
> = {
  eq: ['=', '<>'],
  ne: ['<>', '='],
  lt: ['<', '>='],
  le: ['<=', '>'],
  gt: ['>', '<='],
  ge: ['>=', '<']
};

const OR = 'or';
interface OpEntry {
  readonly kind: 'op';
  readonly key: string;
  readonly op: Op;
  readonly not: boolean;
  readonly args: readonly unknown[];
}
type Entry =
  | OpEntry
  | {readonly kind: 'group'; readonly condition: Condition<any>}
  | {readonly kind: 'raw'; readonly raw: RawCondition}
  | typeof OR;

type Fields<T> = keyof T & string;
type Nested<T> = {
  [K in Fields<T>]: NonNullable<T[K]> extends Date | ReadonlySet<unknown> | Uint8Array
    ? never
    : NonNullable<T[K]> extends readonly unknown[]
      ? `${K}[${number}]${string}`
      : NonNullable<T[K]> extends object
        ? `${K}.${string}`
        : never;
}[Fields<T>];
/** A declared attribute, or a path below an object or list attribute. */
export type ConditionKey<T> = IsAny<T> extends true ? string : Fields<T> | Nested<T>;
// A Date attribute also takes its stored form (an ISO string or an epoch number), as dynamoose throws on a Date in a condition.
type Stored<V> = V extends Date ? Date | string | number : V;
export type ValueAt<T, K> =
  IsAny<T> extends true ? any : K extends keyof T ? Stored<Exclude<T[K], undefined>> : unknown;
type Element<V> =
  V extends ReadonlySet<infer E>
    ? E
    : V extends readonly (infer E)[]
      ? E
      : V extends string
        ? string
        : never;
export type ElementAt<T, K> =
  IsAny<T> extends true ? any : K extends keyof T ? Element<NonNullable<T[K]>> : unknown;

/** `{key: value}` is an equality; `{key: {lt: value}}` names the comparison, as in dynamoose. */
export type ConditionObject<T> = {
  [K in Fields<T>]?: ValueAt<T, K> | {readonly [O in Op]?: unknown};
};

type Init<T> = string | ConditionObject<T> | RawCondition | Condition<T, any>;

interface ConditionField {
  readonly path: Path;
  /** The attribute name, when the path is one. */
  readonly top: string | undefined;
  /** The lenient field transform, then Dates to their stored form: the value before the whole-item hook. */
  readonly stored: (value: unknown) => unknown;
  /** `stored`, then the whole-item hook (top-level attributes only), marshalled. */
  readonly value: (value: unknown) => AttributeValue;
}

function fieldAt(plan: Plan, path: Path, key: string): ConditionField {
  const at = plan.at(path);
  if (at === undefined) throw new ExpressionError(`'${key}' is not an attribute of the model`);
  const transform = plan.adapter?.fieldTransform(path);
  const top = path.length === 1 ? (path[0] as string) : undefined;
  const {createdAt, updatedAt} = plan.timestamps;
  // A number timestamp holds milliseconds, but its field is not a Date path.
  const millis =
    top !== undefined &&
    [createdAt, updatedAt].some((ts) => ts?.kind === 'number' && ts.name === top);
  const {toStored} = at;
  const {set} = plan;
  const stored = (value: unknown) => {
    // A copy: a transform may change its input, and `.readonly()` freezes it, but the value is the caller's.
    const v = transform ? transform(deepCopy(value)) : value;
    if (millis && v instanceof Date) return storeDate(v, 'milliseconds');
    return toStored ? toStored(v) : v;
  };
  return {
    path,
    top,
    stored,
    value(value) {
      let v = stored(value);
      // A copy: the value can be the caller's own object or bytes, which the hook may change.
      if (set && top !== undefined) v = set({[top]: deepCopy(v)})[top];
      return marshallValue(v, plan.defaultDateStorage);
    }
  };
}

/** Resolves a key against a model once. Throws for a key the model does not declare. */
export const conditionField = perPlan((plan, key) => fieldAt(plan, parsePath(key), key));
/** A key attribute: its name is an attribute name, never parsed as a document path, as in dynamoose. */
export const keyField = perPlan((plan, name) => fieldAt(plan, [name], name));

function opNode(plan: Plan, entry: OpEntry): ConditionNode {
  const {path, value} = conditionField(plan, entry.key);
  const [first, second] = entry.args;
  switch (entry.op) {
    case 'eq':
    case 'ne':
    case 'lt':
    case 'le':
    case 'gt':
    case 'ge':
      return {
        kind: 'compare',
        op: COMPARATOR[entry.op][entry.not ? 1 : 0],
        path,
        value: value(first)
      };
    case 'beginsWith':
      return {kind: 'begins_with', path, value: value(first)};
    case 'contains': {
      // An element of a list of Dates takes the element's storage, not the default one.
      const element = first instanceof Date ? plan.at([...path, 0])?.toStored : undefined;
      const node: ConditionNode = {
        kind: 'contains',
        path,
        value: value(element ? element(first) : first)
      };
      return entry.not ? {kind: 'not', item: node} : node;
    }
    case 'exists':
      return {kind: entry.not ? 'attribute_not_exists' : 'attribute_exists', path};
    case 'in':
      return {kind: 'in', path, values: (first as unknown[]).map(value)};
    case 'between':
      return {kind: 'between', path, low: value(first), high: value(second)};
  }
}

const ATTRIBUTE_TYPES: ReadonlySet<string> = new Set([
  'S',
  'N',
  'B',
  'SS',
  'NS',
  'BS',
  'M',
  'L',
  'NULL',
  'BOOL'
]);
// dynamoose's test: an object with one key that names a DynamoDB type.
const isAttributeValue = (v: unknown): boolean => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  return keys.length === 1 && ATTRIBUTE_TYPES.has(keys[0]!);
};

/** A raw condition whose plain values (`{':v': 100}`) are marshalled, as dynamoose converts them. */
function rawNode(plan: Plan, raw: RawCondition): ConditionNode {
  const values = raw.ExpressionAttributeValues;
  if (!values || Object.values(values).every(isAttributeValue)) return {kind: 'raw', raw};
  const marshalled: Record<string, AttributeValue> = {};
  for (const [k, v] of Object.entries(values))
    marshalled[k] = isAttributeValue(v) ? v : marshallValue(v, plan.defaultDateStorage);
  return {kind: 'raw', raw: {...raw, ExpressionAttributeValues: marshalled}};
}

/**
 * A condition, built with the dynamoose chain. Calls change the instance and return it, as in dynamoose.
 * Keys and values are checked and converted against a model when the condition is rendered.
 */
export class Condition<T = any, K extends string = never> {
  // ES private fields: a test snapshot prints a condition as `Condition {}`, as it printed dynamoose's.
  #entries: Entry[] = [];
  #pendingKey: string | undefined;
  #pendingNot = false;

  // A string gives no inference site, so T stays `any` and `new Condition('x').eq(1)` types as in dynamoose.
  constructor(key?: string);
  constructor(init: Init<T>);
  constructor(init?: Init<T>) {
    if (init === undefined) return;
    if (typeof init === 'string') this.#pendingKey = init;
    else if (init instanceof Condition) {
      this.#entries = [...init.#entries];
      this.#pendingKey = init.#pendingKey;
      this.#pendingNot = init.#pendingNot;
    } else if (typeof (init as RawCondition).ConditionExpression === 'string') {
      this.#entries.push({kind: 'raw', raw: init as RawCondition});
    } else {
      for (const [key, spec] of Object.entries(init)) this.fromObject(key, spec);
    }
  }

  private fromObject(key: string, spec: unknown): void {
    this.#pendingKey = key;
    const names =
      typeof spec === 'object' && spec !== null && isPlainObject(spec) ? Object.keys(spec) : [];
    if (names.length > 1) {
      throw new ExpressionError(
        `{${names.join(', ')}} on '${key}' names ${names.length} comparisons: give one, or chain them`
      );
    }
    const named = names[0];
    if (named === undefined) {
      this.add('eq', [spec]);
      return;
    }
    if (!OPS.has(named)) throw new ExpressionError(`'${named}' is not a comparison (on '${key}')`);
    const value = (spec as Record<string, unknown>)[named];
    if (named === 'exists') {
      this.#pendingNot = value === false;
      this.add('exists', []);
    } else this.add(named as Op, named === 'between' && Array.isArray(value) ? value : [value]);
  }

  private add(op: Op, args: readonly unknown[]): Condition<T> {
    const key = this.#pendingKey;
    if (key === undefined)
      throw new ExpressionError(`${op}() needs an attribute: call where() first`);
    if (this.#pendingNot && NOT_NEGATABLE.has(op))
      throw new ExpressionError(`${op}() cannot follow not()`);
    if (op === 'in' && !Array.isArray(args[0]))
      throw new ExpressionError(`in() on '${key}' takes an array of values`);
    if (op === 'between' && args.length !== 2)
      throw new ExpressionError(`between() on '${key}' takes two values`);
    const values = op === 'in' ? (args[0] as unknown[]) : args;
    if (values.includes(undefined))
      throw new ExpressionError(`${op}() on '${key}' was passed undefined`);
    this.#entries.push({kind: 'op', key, op, not: this.#pendingNot, args});
    this.#pendingKey = undefined;
    this.#pendingNot = false;
    return this as Condition<T>;
  }

  // Three names, one body, as dynamoose's one function: a spy on `where` sees no `attribute()` call.
  where<P extends ConditionKey<T>>(key: P): Condition<T, P> {
    return this.#start(key);
  }
  filter<P extends ConditionKey<T>>(key: P): Condition<T, P> {
    return this.#start(key);
  }
  attribute<P extends ConditionKey<T>>(key: P): Condition<T, P> {
    return this.#start(key);
  }
  // dynamoose drops a not() that comes before where(), so the condition would test the opposite.
  #start<P extends string>(key: P): Condition<T, P> {
    if (this.#pendingNot)
      throw new ExpressionError(`not() comes before where('${key}'): call where('${key}').not()`);
    this.#pendingKey = key;
    return this as unknown as Condition<T, P>;
  }

  /** Readability only: conditions are joined with AND by default. */
  and(): this {
    return this;
  }
  or(): Condition<T> {
    this.#entries.push(OR);
    return this as Condition<T>;
  }
  /** Negates the next comparison. `beginsWith`, `in` and `between` cannot be negated. */
  not(): this {
    this.#pendingNot = !this.#pendingNot;
    return this;
  }
  /** As in dynamoose, `group` calls `parenthesis`, so a spy on `parenthesis` sees both. */
  group(
    condition: Condition<T, any> | ((condition: Condition<T>) => Condition<T, any>)
  ): Condition<T> {
    return this.parenthesis(condition);
  }
  parenthesis(
    condition: Condition<T, any> | ((condition: Condition<T>) => Condition<T, any>)
  ): Condition<T> {
    const inner = typeof condition === 'function' ? condition(new Condition<T>()) : condition;
    this.#entries.push({kind: 'group', condition: inner});
    return this as Condition<T>;
  }

  eq(value: ValueAt<T, K>): Condition<T> {
    return this.add('eq', [value]);
  }
  ne(value: ValueAt<T, K>): Condition<T> {
    return this.add('ne', [value]);
  }
  lt(value: ValueAt<T, K>): Condition<T> {
    return this.add('lt', [value]);
  }
  le(value: ValueAt<T, K>): Condition<T> {
    return this.add('le', [value]);
  }
  gt(value: ValueAt<T, K>): Condition<T> {
    return this.add('gt', [value]);
  }
  ge(value: ValueAt<T, K>): Condition<T> {
    return this.add('ge', [value]);
  }
  beginsWith(value: Extract<ValueAt<T, K>, string>): Condition<T> {
    return this.add('beginsWith', [value]);
  }
  /** A substring of a string, or an element of a Set or a list. */
  contains(value: ElementAt<T, K>): Condition<T> {
    return this.add('contains', [value]);
  }
  exists(): Condition<T> {
    return this.add('exists', []);
  }
  attributeExists(): Condition<T> {
    return this.add('exists', []);
  }
  attributeNotExists(): Condition<T> {
    this.#pendingNot = !this.#pendingNot;
    return this.add('exists', []);
  }
  in(values: readonly ValueAt<T, K>[]): Condition<T> {
    return this.add('in', [values]);
  }
  between(low: ValueAt<T, K>, high: ValueAt<T, K>): Condition<T> {
    return this.add('between', [low, high]);
  }

  /** @internal The condition tree, or `undefined` when nothing was added. Throws on a key the model does not declare. */
  toNode(plan: Plan): ConditionNode | undefined {
    if (this.#pendingKey !== undefined) {
      throw new ExpressionError(`the condition on '${this.#pendingKey}' has no comparison`);
    }
    if (this.#pendingNot) throw new ExpressionError('not() has no comparison after it');
    // AND binds tighter than OR, so the chain `a OR b AND c` is `a OR (b AND c)`, as dynamoose's flat text reads.
    const ors: ConditionNode[] = [];
    let ands: ConditionNode[] = [];
    const flush = () => {
      if (ands.length > 0) ors.push(ands.length === 1 ? ands[0]! : {kind: 'and', items: ands});
      ands = [];
    };
    for (const entry of this.#entries) {
      if (entry === OR) flush();
      else if (entry.kind === 'op') ands.push(opNode(plan, entry));
      else if (entry.kind === 'raw') ands.push(rawNode(plan, entry.raw));
      else {
        const item = entry.condition.toNode(plan);
        if (item === undefined) throw new ExpressionError('a group needs at least one condition');
        ands.push({kind: 'group', item});
      }
    }
    flush();
    return ors.length <= 1 ? ors[0] : {kind: 'or', items: ors};
  }
}
