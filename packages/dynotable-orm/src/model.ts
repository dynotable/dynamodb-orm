import {
  type ConditionCheck,
  type CreateTableCommandInput,
  type Delete,
  type DeleteItemCommandInput,
  type GetItemCommandInput,
  type KeySchemaElement,
  type Projection,
  type PutItemCommandInput,
  type Put,
  type ScalarAttributeType,
  type Update,
  type UpdateItemCommandInput
} from '@aws-sdk/client-dynamodb';
import {batchDelete, batchGet, batchPut} from './batch.js';
import {getClient, getDefaults, send} from './client.js';
import {Condition, type ConditionKey, type ConditionObject, keyField} from './condition.js';
import {ConfigError, ExpressionError, isConditionalCheckFailed} from './errors.js';
import {compileCondition, type ExpressionInput} from './expression/compile.js';
import type {ConditionNode} from './expression/condition-ast.js';
import {isPlainObject, marshallValue} from './marshall.js';
import type {ModelOptions} from './options.js';
import {deepCopy, fromStoredItem, toStoredItem, withDefaults, withToJSON} from './pipeline.js';
import {compilePlan, type IndexPlan, type Plan, resolveMetadata} from './plan.js';
import {type ModelContext, Retriever} from './query.js';
import {putEntry, readBy} from './transaction.js';
import {splitKey, updateExpression} from './update.js';
import type {
  AnyModelTypes as Types,
  BatchGetOptions,
  BatchGetResponse,
  CallOptions,
  ConditionFailureOptions,
  ConditionInput,
  CreateOptions,
  DeleteOptions,
  GetOptions,
  InferOutput,
  KeyInputOf,
  ModelTypesOf,
  RawCondition,
  StandardSchema,
  StoredItem,
  UpdateInput,
  UpdateOptions
} from './types.js';

/** A write parses the item, so it takes the schema's input. */
type WriteItem<T extends Types> = Partial<T['input']>;
type Attribute<T extends Types> = keyof T['item'] & string;
type Key<T extends Types> = KeyInputOf<{readonly '~types'?: T}>;
type KeyObject<T extends Types> = Exclude<Key<T>, string | number | bigint | Uint8Array>;
// A `$SET` value and an appended element are parsed too, so they take the schema's input.
type Changes<T extends Types> = UpdateInput<T['input']>;
type Init<T extends Types> = ConditionObject<T['item']> | RawCondition | Condition<T['item'], any>;
type KeyOptions = ConditionFailureOptions & {condition?: ConditionInput; rawKey?: boolean};

export interface Model<Name extends string = string, T extends Types = Types> {
  readonly '~types'?: T;
  /**
   * A deep copy of `item` as a plain object, as dynamoose's `new Model(item)` in fixtures and mocks. Nothing is
   * validated or sent. Like dynamoose's item, it has a non-enumerable `toJSON`, so a test snapshot prints it as
   * dynamoose's did.
   */
  new (item: WriteItem<T>): T['item'];
  /** The name passed to `model()`. */
  readonly name: Name;
  /** `${prefix}${name}${suffix}`, read on every call, so a later `setDefaults` applies. */
  readonly tableName: string;
  readonly hashKey: T['hash'];
  readonly rangeKey: [T['range']] extends [never] ? undefined : T['range'];

  get(
    key: Key<T>,
    options: GetOptions<T['item']> & {return: 'request'}
  ): Promise<GetItemCommandInput>;
  get(
    key: Key<T>,
    options: GetOptions<T['item']> & {raw: true}
  ): Promise<Record<string, unknown> | undefined>;
  get<const A extends readonly Attribute<T>[]>(
    key: Key<T>,
    options: GetOptions<T['item']> & {attributes: A}
  ): Promise<Pick<T['item'], A[number]> | undefined>;
  get(key: Key<T>, options?: GetOptions<T['item']>): Promise<T['item'] | undefined>;

  /** Resolves to the item as `get` would read it back. */
  create(
    item: WriteItem<T>,
    options: CreateOptions & {return: 'request'}
  ): Promise<PutItemCommandInput>;
  create(item: WriteItem<T>, options?: CreateOptions): Promise<T['item']>;

  /**
   * `update(key, changes, options?)`, or `update(item)` with the key and the changes in one object. Plain
   * fields are an implicit `$SET`. Resolves to the item `returnValues` asks for (`ALL_NEW` by default).
   */
  update(
    key: Key<T>,
    changes: Changes<T>,
    options: UpdateOptions & {return: 'request'}
  ): Promise<UpdateItemCommandInput>;
  update(
    key: Key<T>,
    changes: Changes<T>,
    options: UpdateOptions & {returnValues: 'NONE'}
  ): Promise<undefined>;
  update(
    key: Key<T>,
    changes: Changes<T>,
    options: UpdateOptions & {returnValues: 'ALL_OLD' | 'UPDATED_OLD' | 'UPDATED_NEW'}
  ): Promise<Partial<T['item']> | undefined>;
  update(key: Key<T>, changes: Changes<T>, options?: UpdateOptions): Promise<T['item']>;
  /** Writes the top-level attributes the schema does not declare too, as given: the changes are untyped. */
  update(
    key: Key<T>,
    changes: Record<string, any>,
    options: UpdateOptions & {allowUndeclared: true}
  ): Promise<T['item'] | undefined>;
  update(item: KeyObject<T> & Changes<T>): Promise<T['item']>;

  delete(
    key: Key<T>,
    options: DeleteOptions & {return: 'request'}
  ): Promise<DeleteItemCommandInput>;
  delete(key: Key<T>, options?: DeleteOptions): Promise<void>;

  /**
   * `query(field).eq(v)…`, `query({field: v})`, or `query()` then `where()`. The index comes from the
   * conditions (an index whose range key is in them, else the table, else the first hash match) unless
   * `using()` names one.
   */
  query(): Retriever<'query', T>;
  query<P extends ConditionKey<T['item']>>(key: P): Retriever<'query', T, T['item'], P>;
  query(init: Init<T>): Retriever<'query', T>;
  /** The same chain as `query`, without `sort`, plus `parallel`. */
  scan(): Retriever<'scan', T>;
  scan<P extends ConditionKey<T['item']>>(key: P): Retriever<'scan', T, T['item'], P>;
  scan(init: Init<T>): Retriever<'scan', T>;

  /**
   * Reads up to 100 keys per `BatchGetItem`, the chunks in parallel. Keys DynamoDB leaves unprocessed are
   * sent again with backoff; those still unread at the end are in `unprocessedKeys`. Two equal keys throw before sending.
   */
  batchGet<const A extends readonly Attribute<T>[]>(
    keys: readonly Key<T>[],
    options: BatchGetOptions<T['item']> & {attributes: A}
  ): Promise<BatchGetResponse<Pick<T['item'], A[number] | T['hash'] | T['range']>>>;
  batchGet(
    keys: readonly Key<T>[],
    options?: BatchGetOptions<T['item']>
  ): Promise<BatchGetResponse<T['item']>>;
  /** Writes each item as `create` with `overwrite` does, 25 per `BatchWriteItem`, retried as `batchGet`. Every item is validated before anything is sent. */
  batchPut(
    items: readonly WriteItem<T>[],
    options?: CallOptions
  ): Promise<{unprocessedItems: WriteItem<T>[]}>;
  /** Deletes 25 keys per `BatchWriteItem`, retried as `batchGet`. `unprocessedItems` holds the stored keys. */
  batchDelete(
    keys: readonly Key<T>[],
    options?: CallOptions
  ): Promise<{unprocessedItems: Record<string, unknown>[]}>;

  /** Entries for `transaction([...])`: each resolves to the raw `TransactWriteItem` the request would hold. */
  readonly transaction: {
    create(
      item: WriteItem<T>,
      options?: Pick<
        CreateOptions,
        'overwrite' | 'condition' | 'keepCreatedAt' | 'returnValuesOnConditionCheckFailure'
      >
    ): Promise<{Put: Put}>;
    update(key: Key<T>, changes: Changes<T>, options?: KeyOptions): Promise<{Update: Update}>;
    update(item: KeyObject<T> & Changes<T>): Promise<{Update: Update}>;
    delete(key: Key<T>, options?: KeyOptions): Promise<{Delete: Delete}>;
    condition(
      key: Key<T>,
      condition: ConditionInput,
      options?: ConditionFailureOptions
    ): Promise<{ConditionCheck: ConditionCheck}>;
  };

  /** A `Condition` typed from the schema. */
  condition(): Condition<T['item']>;
  /** Reads a stored item, as `get` does. */
  fromStored(raw: StoredItem): T['item'];
  /**
   * A deep copy of `item` with the schema's defaults where a field is missing, as dynamoose's `item.withDefaults()`,
   * but synchronous. Nothing is checked or sent.
   */
  withDefaults(item: WriteItem<T>): T['item'];
  /** The `CreateTable` input for this model's table, keys and indexes, on demand billing. */
  createTableInput(): CreateTableCommandInput;
  /**
   * Adds `methods` to this model and returns it; `this` in each method is the model. A method added by an
   * earlier `extend()` is replaced, as dynamoose's `methods.set` does; a built-in name throws a `ConfigError`.
   * The type lists a replaced method's new signature first, then its old one (`Omit` would drop `this`).
   */
  extend<X extends object>(
    methods: X & {[K in keyof X & keyof Model<string, any>]: never} & ThisType<X & this>
  ): X & this;
}

const onFailure = (opts: ConditionFailureOptions) =>
  opts.returnValuesOnConditionCheckFailure
    ? {ReturnValuesOnConditionCheckFailure: opts.returnValuesOnConditionCheckFailure}
    : undefined;

const projection = (project: IndexPlan['project']): Projection =>
  project === true
    ? {ProjectionType: 'ALL'}
    : project === false
      ? {ProjectionType: 'KEYS_ONLY'}
      : {ProjectionType: 'INCLUDE', NonKeyAttributes: [...project]};

/** Defines a model. Keys, indexes, dates and timestamps are resolved now, so a bad definition throws here. */
export function model<
  const N extends string,
  S extends StandardSchema,
  const O extends ModelOptions<InferOutput<S>> = {}
>(name: N, schema: S, options?: O): Model<N, ModelTypesOf<S, O>>;
export function model(
  name: string,
  schema: StandardSchema,
  options: ModelOptions<any> = {}
): Model<string, any> {
  const meta = resolveMetadata(schema, options);
  const {hash, range} = meta.key;
  const keyNames = range === undefined ? [hash] : [hash, range];
  let compiled: Plan | undefined;
  const plan = () => (compiled ??= compilePlan(meta));
  const tableName = () => {
    const d = getDefaults();
    return `${options.prefix ?? d.prefix ?? ''}${name}${options.suffix ?? d.suffix ?? ''}`;
  };
  const clientOf = (call: CallOptions) => call.client ?? options.client ?? getClient();

  // The field transforms run on each key attribute, then the hook once on the whole key, as dynamoose's
  // convertKeyToObject does. `rawKey` skips both; a Date still takes its stored form.
  const keyOf = (p: Plan, key: unknown, rawKey = false): StoredItem => {
    const object =
      typeof key === 'object' && key !== null && isPlainObject(key) ? key : {[hash]: key};
    let values: Record<string, unknown> = {};
    for (const k of keyNames) {
      const v = object[k];
      if (v === undefined || v === null)
        throw new ExpressionError(`the key of '${name}' has no '${k}'`);
      values[k] = rawKey ? v : keyField(p, k).stored(v);
    }
    // A copy: a key value can be the caller's own bytes, which the hook may change.
    if (p.set && !rawKey) values = p.set(deepCopy(values) as Record<string, unknown>);
    const out: StoredItem = {};
    for (const k of keyNames) {
      const v = values[k];
      if (v === undefined || v === null)
        throw new ExpressionError(`the set hook of '${name}' removed the key attribute '${k}'`);
      out[k] = marshallValue(
        v,
        rawKey ? (p.datePaths.get(k) ?? p.defaultDateStorage) : p.defaultDateStorage
      );
    }
    return out;
  };

  const conditionNode = (p: Plan, condition: ConditionInput | undefined) =>
    condition && (condition instanceof Condition ? condition : new Condition(condition)).toNode(p);

  // dynamoose's text, so a request pinned by a test keeps matching.
  const conditionOf = (
    p: Plan,
    condition: ConditionInput | undefined,
    keyAbsent: boolean
  ): ExpressionInput => {
    let node = conditionNode(p, condition);
    if (keyAbsent) {
      const absent: ConditionNode = {
        kind: 'raw',
        raw: {
          ConditionExpression: 'attribute_not_exists(#__hash_key)',
          ExpressionAttributeNames: {'#__hash_key': hash}
        }
      };
      node = node ? {kind: 'and', items: [{kind: 'group', item: node}, absent]} : absent;
    }
    return node ? compileCondition(node) : {};
  };

  const attributeType = (p: Plan, attribute: string): ScalarAttributeType => {
    const storage = p.datePaths.get(attribute);
    const type = storage ? (storage === 'iso' ? 'S' : 'N') : p.adapter?.keyType([attribute]);
    if (type === undefined) {
      throw new ConfigError(
        `createTableInput() cannot tell whether '${attribute}' is a string or a number from the schema`
      );
    }
    return type;
  };

  // The requests are built here, not through the model's methods: a test that spies on `M.create` must not
  // change what `M.transaction.create` builds, as in dynamoose.
  const putInput = async (
    p: Plan,
    item: Record<string, unknown>,
    opts: CreateOptions
  ): Promise<PutItemCommandInput> => ({
    Item: await toStoredItem(p, item, {isNew: true, keepCreatedAt: opts.keepCreatedAt ?? false}),
    TableName: tableName(),
    ...conditionOf(p, opts.condition, !opts.overwrite),
    ...onFailure(opts)
  });
  const updateInput = async (
    p: Plan,
    keyOrItem: unknown,
    given: Record<string, unknown> | null | undefined,
    opts: UpdateOptions
  ): Promise<UpdateItemCommandInput> => {
    const {key, changes} =
      given == null ? splitKey(keyOrItem, keyNames) : {key: keyOrItem, changes: given};
    return {
      Key: keyOf(p, key, opts.rawKey),
      ReturnValues: opts.returnValues ?? 'ALL_NEW',
      TableName: tableName(),
      ...(await updateExpression(
        p,
        changes,
        conditionNode(p, opts.condition),
        opts.allowUndeclared
      )),
      ...onFailure(opts)
    };
  };
  const deleteInput = (p: Plan, key: unknown, opts: DeleteOptions): DeleteItemCommandInput => ({
    Key: keyOf(p, key, opts.rawKey),
    TableName: tableName(),
    ...conditionOf(p, opts.condition, false),
    ...onFailure(opts)
  });
  // The stored item a failed condition returns, read as `get` reads it, on the SDK error.
  const withItem = (p: Plan, error: unknown): unknown => {
    const stored = (error as {Item?: StoredItem} | undefined)?.Item;
    if (isConditionalCheckFailed(error) && stored)
      Object.assign(error as object, {item: fromStoredItem(p, stored)});
    return error;
  };

  const context: ModelContext = {
    plan,
    tableName,
    client: clientOf,
    keyNames,
    batchRetries: options.batchRetries ?? 5
  };

  // Methods added by extend(): a later extend() may replace one, as dynamoose's methods.set does.
  const extended = new Set<string>();
  const Model = function (item: Record<string, unknown>) {
    const copy = deepCopy(item);
    return typeof copy === 'object' && copy !== null && isPlainObject(copy)
      ? withToJSON(copy)
      : copy;
  } as unknown as Model;
  Object.defineProperty(Model, 'name', {value: name});
  // As dynamoose's Item class: a mocking library that mocks the model's prototype (`vi.mock` of its module)
  // mocks toJSON too, so the instances of the mocked model print as the mocked dynamoose items did.
  Object.defineProperty(Model.prototype, 'toJSON', {
    value(this: object) {
      return JSON.parse(JSON.stringify({...this}));
    },
    configurable: true,
    writable: true
  });
  Object.defineProperty(Model, 'tableName', {get: tableName, enumerable: true});
  Object.assign(Model, {
    hashKey: hash,
    rangeKey: range,

    async get(key: unknown, opts: GetOptions = {}) {
      const p = plan();
      const input: GetItemCommandInput = {Key: keyOf(p, key, opts.rawKey), TableName: tableName()};
      if (opts.consistent !== undefined) input.ConsistentRead = opts.consistent;
      if (opts.attributes) {
        input.ProjectionExpression = opts.attributes.map((_, i) => `#a${i}`).join(', ');
        input.ExpressionAttributeNames = Object.fromEntries(
          opts.attributes.map((a, i) => [`#a${i}`, a])
        );
      }
      if (opts.return === 'request') return input;
      const {Item} = await send(clientOf(opts), 'getItem', input, opts.abortSignal);
      return Item && fromStoredItem(p, Item, {raw: opts.raw ?? false});
    },

    async create(item: Record<string, unknown>, opts: CreateOptions = {}) {
      const p = plan();
      const input = await putInput(p, item, opts);
      if (opts.return === 'request') return input;
      await send(clientOf(opts), 'putItem', input, opts.abortSignal).catch((e: unknown) => {
        throw withItem(p, e);
      });
      return fromStoredItem(p, input.Item!);
    },

    async update(
      keyOrItem: unknown,
      given?: Record<string, unknown> | null,
      opts: UpdateOptions = {}
    ) {
      const p = plan();
      const input = await updateInput(p, keyOrItem, given, opts);
      if (opts.return === 'request') return input;
      const {Attributes} = await send(clientOf(opts), 'updateItem', input, opts.abortSignal).catch(
        (e: unknown) => {
          throw withItem(p, e);
        }
      );
      return Attributes && fromStoredItem(p, Attributes);
    },

    async delete(key: unknown, opts: DeleteOptions = {}) {
      const p = plan();
      const input = deleteInput(p, key, opts);
      if (opts.return === 'request') return input;
      await send(clientOf(opts), 'deleteItem', input, opts.abortSignal).catch((e: unknown) => {
        throw withItem(p, e);
      });
    },

    async batchGet(keys: readonly unknown[], opts: BatchGetOptions = {}) {
      const p = plan();
      return batchGet(
        context,
        keys.map((k) => keyOf(p, k)),
        opts
      );
    },

    async batchPut(items: readonly Record<string, unknown>[], opts: CallOptions = {}) {
      const p = plan();
      // Async, so an item that throws while the array is built rejects instead: an earlier item's pending
      // validation is still awaited by Promise.all, and its rejection is handled.
      const stored = await Promise.all(
        items.map(async (item) => toStoredItem(p, item, {isNew: true}))
      );
      return batchPut(context, items, stored, opts);
    },

    async batchDelete(keys: readonly unknown[], opts: CallOptions = {}) {
      const p = plan();
      return batchDelete(
        context,
        keys.map((k) => keyOf(p, k)),
        opts
      );
    },

    // dynamoose's entries: each method's own request, with `ReturnValues` dropped from the update.
    // Each entry remembers its model's reader, so a canceled transaction reads the items its failed conditions return.
    transaction: {
      async create(item: Record<string, unknown>, opts: CreateOptions = {}) {
        const p = plan();
        return readBy(putEntry((await putInput(p, item, opts)) as Put, keyNames), p);
      },
      async update(keyOrItem: unknown, changes?: Record<string, unknown>, opts: KeyOptions = {}) {
        const p = plan();
        const {ReturnValues: _, ...input} = await updateInput(p, keyOrItem, changes, opts);
        return readBy({Update: input as Update}, p);
      },
      async delete(key: unknown, opts: KeyOptions = {}) {
        const p = plan();
        return readBy({Delete: deleteInput(p, key, opts) as Delete}, p);
      },
      async condition(key: unknown, condition: ConditionInput, opts: ConditionFailureOptions = {}) {
        const p = plan();
        const expression = conditionOf(p, condition, false);
        // DynamoDB rejects a ConditionCheck without a ConditionExpression.
        if (expression.ConditionExpression === undefined)
          throw new ExpressionError(`transaction.condition() on '${name}' needs a condition`);
        return readBy(
          {
            ConditionCheck: {
              Key: keyOf(p, key),
              TableName: tableName(),
              ...expression,
              ...onFailure(opts)
            } as ConditionCheck
          },
          p
        );
      }
    },

    query: (init?: unknown) => new Retriever('query', context, init),
    scan: (init?: unknown) => new Retriever('scan', context, init),
    condition: () => new Condition(),
    fromStored: (raw: StoredItem) => fromStoredItem(plan(), raw),
    withDefaults: (item: Record<string, unknown>) => withDefaults(plan(), item),

    createTableInput(): CreateTableCommandInput {
      const p = plan();
      const types = new Map<string, ScalarAttributeType>();
      const keySchema = (h: string, r?: string): KeySchemaElement[] =>
        [h, r].flatMap((AttributeName, i) => {
          if (AttributeName === undefined) return [];
          if (!types.has(AttributeName)) types.set(AttributeName, attributeType(p, AttributeName));
          return [{AttributeName, KeyType: i === 0 ? 'HASH' : 'RANGE'}];
        });
      const KeySchema = keySchema(hash, range);
      const indexes = (type: IndexPlan['type']) =>
        p.indexes
          .filter((i) => i.type === type)
          .map((i) => ({
            IndexName: i.name,
            KeySchema: keySchema(i.hash, i.range),
            Projection: projection(i.project)
          }));
      const global = indexes('global');
      const local = indexes('local');
      return {
        TableName: tableName(),
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [...types].map(([AttributeName, AttributeType]) => ({
          AttributeName,
          AttributeType
        })),
        KeySchema,
        ...(global.length > 0 && {GlobalSecondaryIndexes: global}),
        ...(local.length > 0 && {LocalSecondaryIndexes: local})
      };
    },

    extend(methods: object) {
      // `in` also sees Function.prototype (`call`, `bind`, `length`…), which a method would shadow.
      const taken = Object.keys(methods).filter((k) => k in Model && !extended.has(k));
      if (taken.length > 0)
        throw new ConfigError(`extend() on '${name}' would replace ${taken.join(', ')}`);
      // Bound, as dynamoose binds custom methods: `pMap(items, M.method)` still runs with the model as `this`.
      for (const [k, v] of Object.entries(methods)) {
        extended.add(k);
        (Model as any)[k] = typeof v === 'function' ? v.bind(Model) : v;
      }
      return Model;
    }
  });
  return Model;
}
