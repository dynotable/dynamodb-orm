import type {DynamoDBClient, QueryCommandInput, ScanCommandInput} from '@aws-sdk/client-dynamodb';
import {send as sendRequest} from './client.js';
import {Condition, type ConditionKey, type ElementAt, type ValueAt} from './condition.js';
import {ExpressionError} from './errors.js';
import {ExpressionContext} from './expression/compile.js';
import {type ConditionNode, renderCondition, renderOperand} from './expression/condition-ast.js';
import {findBestIndex, type TableKey} from './find-best-index.js';
import {isPlainObject, marshallValue, unmarshallItem} from './marshall.js';
import {fromStoredItem} from './pipeline.js';
import type {IndexPlan, Plan} from './plan.js';
import type {
  AnyModel,
  AnyModelTypes as Types,
  CallOptions,
  IndexTypes,
  ItemOf,
  QueryResponse,
  ParallelScanResponse,
  ScanResponse,
  StoredItem,
  TypesOf
} from './types.js';

// `parallel` is a scan, in type only: its `lastKey` can hold one key per segment.
type Kind = 'query' | 'scan' | 'parallel';

/** @internal What a model gives its queries, scans and batches. Read at call time, so a later `setDefaults` or `setClient` applies. */
export interface ModelContext {
  plan(): Plan;
  tableName(): string;
  /** The call's client, else the model's, else `getClient()`. */
  client(call: CallOptions): DynamoDBClient;
  keyNames: readonly string[];
  /** The model's `batchRetries`. */
  batchRetries: number;
}

interface Settings {
  index?: string;
  limit?: number;
  startAt?: Record<string, unknown>;
  descending?: boolean;
  consistent?: boolean;
  attributes?: readonly string[];
  count?: boolean;
  all?: {delay: number; max: number};
  parallel?: number;
}

type Response<Kd extends Kind, Out> = Kd extends 'query'
  ? QueryResponse<Out>
  : Kd extends 'scan'
    ? ScanResponse<Out>
    : ParallelScanResponse<Out>;
type Counted<Kd extends Kind> = Kd extends 'query'
  ? {count: number; queriedCount: number}
  : {count: number; scannedCount: number};
type Included<P> = P extends readonly (infer A extends string)[] ? A : never;
/** The item an index returns: all of it, or the table and index keys plus the projected attributes. */
type Projected<T extends Types, E> = E extends {readonly project: true}
  ? T['item']
  : Pick<
      T['item'],
      (
        | T['hash']
        | T['range']
        | (E extends IndexTypes ? E['keys'] | Included<E['project']> : never)
      ) &
        keyof T['item']
    >;
type Group<Item> = Condition<Item, any> | ((condition: Condition<Item>) => Condition<Item, any>);
type KeyNode = Extract<
  ConditionNode,
  {kind: 'compare'} | {kind: 'between'} | {kind: 'begins_with' | 'contains'}
>;

const attributeOf = (n: ConditionNode): string | undefined => {
  if (n.kind === 'not') return attributeOf(n.item);
  if (!('path' in n) || n.path.length !== 1) return undefined;
  const [a] = n.path;
  return typeof a === 'string' ? a : undefined;
};
const KEY_COMPARATORS: ReadonlySet<string> = new Set(['=', '<', '<=', '>', '>=']);
const isKeyNode = (n: ConditionNode): n is KeyNode =>
  (n.kind === 'compare' && KEY_COMPARATORS.has(n.op)) ||
  n.kind === 'between' ||
  n.kind === 'begins_with';

// dynamoose's key condition text, with fixed placeholders: `#qha`/`:qhv` for the hash key, `#qra`/`:qrv` for the range key.
// They go into the context first, so a raw filter's own `#qha` is renamed rather than overwritten.
function keyTerm(n: KeyNode, p: 'qh' | 'qr', {names, values}: ExpressionContext): string {
  const a = `#${p}a`;
  const v = `:${p}v`;
  names[a] = n.path[0] as string;
  switch (n.kind) {
    case 'compare':
      values[v] = n.value;
      return `${a} ${n.op} ${v}`;
    case 'between':
      values[`${v}_1`] = n.low;
      values[`${v}_2`] = n.high;
      return `${a} BETWEEN ${v}_1 AND ${v}_2`;
    case 'begins_with':
    case 'contains':
      values[v] = n.value;
      return `${n.kind} (${a}, ${v})`;
  }
}

// A key a previous page returned is already marshalled; a plain key is marshalled as given, as dynamoose does.
const isStored = (key: Record<string, unknown>) =>
  Object.values(key).every((v) => typeof v === 'object' && v !== null && isPlainObject(v));
const isEmptyKey = (key: Record<string, unknown>) => Object.keys(key).length === 0;

/**
 * A query or a scan, built with the dynamoose chain. Calls change the instance and return it.
 * Nothing is sent until `exec()`.
 */
export class Retriever<
  Kd extends Kind,
  T extends Types,
  Out = T['item'],
  K extends string = never,
  C extends boolean = false
> {
  private readonly kind: 'query' | 'scan';
  private readonly context: ModelContext;
  private readonly condition: Condition<any>;
  private readonly settings: Settings = {};

  /** @internal */
  constructor(kind: Kd & ('query' | 'scan'), context: ModelContext, init?: unknown) {
    this.kind = kind;
    this.context = context;
    this.condition = init === undefined ? new Condition() : new Condition(init as string);
  }

  where<P extends ConditionKey<T['item']>>(key: P): Retriever<Kd, T, Out, P, C> {
    this.condition.where(key);
    return this as never;
  }
  filter<P extends ConditionKey<T['item']>>(key: P): Retriever<Kd, T, Out, P, C> {
    return this.where(key);
  }
  attribute<P extends ConditionKey<T['item']>>(key: P): Retriever<Kd, T, Out, P, C> {
    return this.where(key);
  }
  and(): this {
    return this;
  }
  or(): Retriever<Kd, T, Out, never, C> {
    this.condition.or();
    return this as never;
  }
  not(): this {
    this.condition.not();
    return this;
  }
  group(condition: Group<T['item']>): Retriever<Kd, T, Out, never, C> {
    this.condition.group(condition);
    return this as never;
  }
  parenthesis(condition: Group<T['item']>): Retriever<Kd, T, Out, never, C> {
    return this.group(condition);
  }

  eq(value: ValueAt<T['item'], K>): Retriever<Kd, T, Out, never, C> {
    this.condition.eq(value);
    return this as never;
  }
  ne(value: ValueAt<T['item'], K>): Retriever<Kd, T, Out, never, C> {
    this.condition.ne(value);
    return this as never;
  }
  lt(value: ValueAt<T['item'], K>): Retriever<Kd, T, Out, never, C> {
    this.condition.lt(value);
    return this as never;
  }
  le(value: ValueAt<T['item'], K>): Retriever<Kd, T, Out, never, C> {
    this.condition.le(value);
    return this as never;
  }
  gt(value: ValueAt<T['item'], K>): Retriever<Kd, T, Out, never, C> {
    this.condition.gt(value);
    return this as never;
  }
  ge(value: ValueAt<T['item'], K>): Retriever<Kd, T, Out, never, C> {
    this.condition.ge(value);
    return this as never;
  }
  beginsWith(value: Extract<ValueAt<T['item'], K>, string>): Retriever<Kd, T, Out, never, C> {
    this.condition.beginsWith(value);
    return this as never;
  }
  contains(value: ElementAt<T['item'], K>): Retriever<Kd, T, Out, never, C> {
    this.condition.contains(value);
    return this as never;
  }
  exists(): Retriever<Kd, T, Out, never, C> {
    this.condition.exists();
    return this as never;
  }
  attributeExists(): Retriever<Kd, T, Out, never, C> {
    this.condition.attributeExists();
    return this as never;
  }
  attributeNotExists(): Retriever<Kd, T, Out, never, C> {
    this.condition.attributeNotExists();
    return this as never;
  }
  in(values: readonly ValueAt<T['item'], K>[]): Retriever<Kd, T, Out, never, C> {
    this.condition.in(values);
    return this as never;
  }
  between(
    low: ValueAt<T['item'], K>,
    high: ValueAt<T['item'], K>
  ): Retriever<Kd, T, Out, never, C> {
    this.condition.between(low, high);
    return this as never;
  }

  /** Reads this index. The item type narrows to what the index projects. */
  using<N extends T['indexes']['name']>(
    name: N
  ): Retriever<Kd, T, Projected<T, Extract<T['indexes'], {readonly name: N}>>, K, C> {
    this.settings.index = name;
    return this as never;
  }
  limit(count: number): this {
    this.settings.limit = count;
    return this;
  }
  /**
   * Starts after this key: a previous result's `lastKey`, or a key object. `undefined` or `{}` starts at the
   * beginning. A parallel scan's `lastKey` array has one key per segment, which one request cannot take.
   */
  startAt(key: Record<string, unknown> | undefined): this {
    if (Array.isArray(key)) {
      throw new ExpressionError(
        "startAt() takes one key: a parallel scan's lastKey array has one key per segment"
      );
    }
    if (key === undefined || isEmptyKey(key)) delete this.settings.startAt;
    else this.settings.startAt = key;
    return this;
  }
  sort(
    this: Retriever<'query', T, Out, K, C>,
    order: 'ascending' | 'descending'
  ): Retriever<'query', T, Out, K, C> {
    if (this.kind !== 'query') throw new ExpressionError('a scan has no sort order');
    this.settings.descending = order === 'descending';
    return this;
  }
  consistent(): this {
    this.settings.consistent = true;
    return this;
  }
  attributes<const A extends readonly (keyof Out & string)[]>(
    attributes: A
  ): Retriever<Kd, T, Pick<Out, A[number]>, K, C>;
  /** A list whose names are not known at compile time (`string[]`): each item holds some of the fields. */
  attributes<const A extends readonly string[]>(
    attributes: A & (string extends A[number] ? unknown : never)
  ): Retriever<Kd, T, Partial<Out>, K, C>;
  attributes(attributes: readonly string[]): Retriever<Kd, T, any, K, C> {
    this.settings.attributes = attributes;
    return this as never;
  }
  /** `exec()` then resolves to the counts only. */
  count(): Retriever<Kd, T, Out, K, true> {
    this.settings.count = true;
    return this as never;
  }
  /** Fetches every page, one after the other: `delay` ms apart, and at most `maxPages` requests (0: no limit). */
  all(delay = 0, maxPages = 0): this {
    this.settings.all = {delay, max: maxPages};
    return this;
  }
  /** Scans in this many segments at once. */
  parallel(
    this: Retriever<'scan', T, Out, K, C>,
    segments: number
  ): Retriever<'parallel', T, Out, K, C> {
    if (this.kind !== 'scan') throw new ExpressionError('only a scan runs in parallel segments');
    this.settings.parallel = segments;
    return this as never;
  }

  /** @internal The request without a page's `ExclusiveStartKey` or `Segment`. */
  request(p: Plan): QueryCommandInput & ScanCommandInput {
    const s = this.settings;
    const node = this.condition.toNode(p);
    const conjuncts = node === undefined ? [] : node.kind === 'and' ? node.items : [node];
    const input: QueryCommandInput & ScanCommandInput = {TableName: this.context.tableName()};

    let index: TableKey | IndexPlan | undefined;
    if (s.index !== undefined) {
      index = p.indexes.find((i) => i.name === s.index);
      if (index === undefined)
        throw new ExpressionError(`'${s.index}' is not an index of the model`);
    } else if (this.kind === 'query') {
      const equal = new Set(
        conjuncts.flatMap((n) => (n.kind === 'compare' && n.op === '=' ? [attributeOf(n)!] : []))
      );
      index = findBestIndex(
        p.key,
        p.indexes,
        equal,
        new Set(conjuncts.map(attributeOf).filter((a) => a !== undefined))
      );
      if (index === undefined)
        throw new ExpressionError('no index fits the query: it needs an equality on a hash key');
    }
    if (index !== undefined && 'name' in index) input.IndexName = index.name;

    const ctx = new ExpressionContext();
    const {names, values} = ctx;
    const moved = new Set<number>();
    if (this.kind === 'query' && index !== undefined) {
      const {hash, range} = index;
      const hashAt = conjuncts.findIndex(
        (n) => n.kind === 'compare' && n.op === '=' && attributeOf(n) === hash
      );
      if (hashAt === -1)
        throw new ExpressionError(`the query needs an equality on the hash key '${hash}'`);
      const keys = [keyTerm(conjuncts[hashAt] as KeyNode, 'qh', ctx)];
      moved.add(hashAt);
      const rangeAt =
        range === undefined
          ? -1
          : conjuncts.findIndex((n) => isKeyNode(n) && attributeOf(n) === range);
      if (rangeAt !== -1) {
        keys.push(keyTerm(conjuncts[rangeAt] as KeyNode, 'qr', ctx));
        moved.add(rangeAt);
      }
      input.KeyConditionExpression = keys.join(' AND ');
    }

    // Numbered as dynamoose does: a condition moved into the key condition still takes its number.
    const single = conjuncts.length - moved.size === 1;
    const filters: string[] = [];
    conjuncts.forEach((n, i) => {
      if (moved.has(i)) ctx.reserve();
      else filters.push(single ? renderCondition(ctx, n) : renderOperand(ctx, n, 'and'));
    });
    if (filters.length > 0) input.FilterExpression = filters.join(' AND ');
    if (s.attributes) {
      // As dynamoose: a name the conditions hold is reused, else `#a` + one more than the highest number.
      const named = (a: string) => {
        let key = Object.keys(names).find((k) => names[k] === a);
        if (key === undefined) {
          let max = 0;
          for (const k of Object.keys(names)) {
            const n = Number.parseInt(k.slice(2), 10);
            if (k.startsWith('#a') && n > max) max = n;
          }
          key = `#a${max + 1}`;
          names[key] = a;
        }
        return key;
      };
      input.ProjectionExpression = s.attributes.map(named).sort().join(', ');
    }
    if (Object.keys(names).length > 0) input.ExpressionAttributeNames = names;
    if (Object.keys(values).length > 0) input.ExpressionAttributeValues = values;

    if (s.limit !== undefined) input.Limit = s.limit;
    if (s.startAt) {
      const key = s.startAt;
      input.ExclusiveStartKey = isStored(key)
        ? (key as StoredItem)
        : Object.fromEntries(
            Object.entries(key).map(([k, v]) => [
              k,
              marshallValue(v, p.datePaths.get(k) ?? p.defaultDateStorage)
            ])
          );
    }
    if (s.consistent) input.ConsistentRead = true;
    if (s.count) input.Select = 'COUNT';
    if (s.descending) input.ScanIndexForward = false;
    if (s.parallel) input.TotalSegments = s.parallel;
    return input;
  }

  /** `client` and `abortSignal` apply to every request of this call. */
  async exec(options: CallOptions = {}): Promise<C extends true ? Counted<Kd> : Response<Kd, Out>> {
    const p = this.context.plan();
    const input = this.request(p);
    const client = this.context.client(options);
    const {abortSignal} = options;
    const {all, count, parallel} = this.settings;
    let times = 0;
    const send = (extra: Partial<ScanCommandInput>) => {
      times++;
      return sendRequest(client, this.kind, {...input, ...extra}, abortSignal);
    };
    const pages = async (extra: Partial<ScanCommandInput>) => {
      let page = await send(extra);
      const items = [...(page.Items ?? [])];
      let counted = page.Count ?? 0;
      let scanned = page.ScannedCount ?? 0;
      for (
        let requested = 1;
        all && page.LastEvaluatedKey && (all.max === 0 || requested < all.max);
        requested++
      ) {
        if (all.delay > 0) await new Promise((resolve) => setTimeout(resolve, all.delay));
        page = await send({...extra, ExclusiveStartKey: page.LastEvaluatedKey});
        items.push(...(page.Items ?? []));
        counted += page.Count ?? 0;
        scanned += page.ScannedCount ?? 0;
      }
      return {items, counted, scanned, last: page.LastEvaluatedKey};
    };
    const segments = parallel
      ? await Promise.all(Array.from({length: parallel}, (_, Segment) => pages({Segment})))
      : [await pages({})];

    const total = segments.reduce((n, x) => n + x.counted, 0);
    const scanned = segments.reduce((n, x) => n + x.scanned, 0);
    // DynamoDB's ScannedCount: dynamoose reads a `QueriedCount` that DynamoDB never returns, so its queriedCount is undefined.
    const countName = this.kind === 'query' ? 'queriedCount' : 'scannedCount';
    if (count) return {count: total, [countName]: scanned} as never;
    // As dynamoose merges pages: one key, or one per unfinished segment of a parallel scan.
    const lastKeys = segments.flatMap((x) => (x.last ? [unmarshallItem(x.last)] : []));
    const items = segments.flatMap((x) => x.items).map((item) => fromStoredItem(p, item));
    return Object.assign(items, {
      lastKey: lastKeys.length > 1 ? lastKeys : lastKeys[0],
      count: total,
      [countName]: scanned,
      [this.kind === 'query' ? 'timesQueried' : 'timesScanned']: times
    }) as never;
  }
}

export type Query<M extends AnyModel> = Retriever<'query', TypesOf<M>, ItemOf<M>>;
export type Scan<M extends AnyModel> = Retriever<'scan', TypesOf<M>, ItemOf<M>>;
