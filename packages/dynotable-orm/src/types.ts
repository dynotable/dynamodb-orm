import type {
  AttributeValue,
  DynamoDBClient,
  ReturnValue,
  ReturnValuesOnConditionCheckFailure
} from '@aws-sdk/client-dynamodb';
import type {Condition} from './condition.js';
import type {ModelOptions} from './options.js';
import type {IfNotExists} from './update.js';

/** The Standard Schema v1 interface (https://standardschema.dev), copied as the spec recommends. */
export interface StandardSchema<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly types?: {readonly input: Input; readonly output: Output} | undefined;
  };
}
export type StandardResult<Output> =
  | {readonly value: Output; readonly issues?: undefined}
  | {readonly issues: readonly StandardIssue[]};
export interface StandardIssue {
  readonly message: string;
  readonly path?: readonly (PropertyKey | {readonly key: PropertyKey})[] | undefined;
}
export type InferOutput<S extends StandardSchema> = NonNullable<S['~standard']['types']>['output'];
/** An item as DynamoDB stores it. */
export type StoredItem = Record<string, AttributeValue>;
/** An item as the caller gives it or a read returns it, untyped. */
export type Item = Record<string, unknown>;

type InferInput<S extends StandardSchema> = NonNullable<S['~standard']['types']>['input'];

/** A secondary index, in type only: its name, its key attributes and what it projects. */
export interface IndexTypes {
  readonly name: string;
  readonly keys: string;
  readonly project: boolean | readonly string[];
}

/** Type-only facts about a model. `Range` is `never` for a model with only a hash key. */
export interface ModelTypes<
  Item,
  Hash extends string,
  Range extends string,
  Indexes extends IndexTypes = IndexTypes,
  Input = Item
> {
  readonly item: Item;
  /** What a write parses: the schema's input, which a transform or a coercion makes wider than the item. */
  readonly input: Input;
  readonly hash: Hash;
  readonly range: Range;
  readonly indexes: Indexes;
}

/** The types of any model, for the code that serves every model. */
export type AnyModelTypes = ModelTypes<any, string, string>;

/** A schema carrying field metadata `M`, in type only. */
export type WithMeta<S, M> = S & {readonly '~dynamo': M};

// The field's own metadata, else its inner schema's, as getDynamoMeta finds it at runtime.
type MetaOf<F> = F extends {readonly '~dynamo': infer M}
  ? M
  : F extends {readonly _zod: {readonly def: {readonly innerType: infer I}}}
    ? MetaOf<I>
    : F extends {
          readonly _zod: {
            readonly def: {readonly type: 'pipe'; readonly in: infer I; readonly out: infer O};
          };
        }
      ? MetaOf<I> & MetaOf<O>
      : unknown;
type MarkedField<S, Flag extends string> = S extends {readonly shape: infer Shape}
  ? {
      [K in keyof Shape]: MetaOf<Shape[K]> extends {readonly [P in Flag]: true} ? K : never;
    }[keyof Shape] &
      string
  : never;

// An index as `model()` resolves it, with dynamoose's default name. The table keys are always projected, so only the index's own keys are listed.
type IndexEntry<F extends string, D> = D extends unknown
  ? {
      readonly name: D extends {readonly name: infer N extends string}
        ? N
        : `${F}${D extends {readonly type: 'local'} ? 'LocalIndex' : 'GlobalIndex'}`;
      readonly keys: F | (D extends {readonly rangeKey: infer R extends string} ? R : never);
      readonly project: D extends {readonly project: infer P extends boolean | readonly string[]}
        ? P
        : true;
    }
  : never;
type Defs<D> = D extends readonly (infer E)[] ? E : D;
type OptionIndexes<O> = O extends {readonly indexes: infer I}
  ? {[F in keyof I & string]-?: IndexEntry<F, Defs<NonNullable<I[F]>>>}[keyof I & string]
  : never;
type FieldIndexes<S> = S extends {readonly shape: infer Shape}
  ? {
      [F in keyof Shape & string]-?: MetaOf<Shape[F]> extends {readonly index: infer D}
        ? IndexEntry<F, Defs<D>>
        : never;
    }[keyof Shape & string]
  : never;

/** Keys and indexes come from the options, else from the fields marked with `hashKey()`/`rangeKey()`/`index()`. */
export type ModelTypesOf<
  S extends StandardSchema,
  O extends ModelOptions<InferOutput<S>>
> = ModelTypes<
  InferOutput<S>,
  O extends {hashKey: infer H extends string} ? H : MarkedField<S, 'hashKey'>,
  O extends {rangeKey: infer R extends string} ? R : MarkedField<S, 'rangeKey'>,
  OptionIndexes<O> | FieldIndexes<S>,
  InferInput<S>
>;

export interface AnyModel {
  // Type-only: never present at runtime.
  readonly '~types'?: AnyModelTypes;
}

export type TypesOf<M extends AnyModel> = NonNullable<M['~types']>;
type KeyFields<T, K> = {[P in K & keyof T]-?: Exclude<T[P], undefined>};

export type ItemOf<M extends AnyModel> = TypesOf<M>['item'];

/** A key object, or a bare scalar for a model with only a hash key. */
export type KeyInputOf<M extends AnyModel> =
  IsAny<TypesOf<M>> extends true
    ? any
    : [TypesOf<M>['range']] extends [never]
      ? KeyFields<ItemOf<M>, TypesOf<M>['hash']> | ItemOf<M>[TypesOf<M>['hash']]
      : KeyFields<ItemOf<M>, TypesOf<M>['hash'] | TypesOf<M>['range']>;

/** What `update` takes: the schema's input, which it parses. */
export type UpdateInputOf<M extends AnyModel> = UpdateInput<TypesOf<M>['input']>;

export type IsAny<T> = 0 extends 1 & T ? true : false;
// Values an update path does not go below. Lists are gone through, unlike a DatePath's leaves.
type Leaf = Date | ReadonlySet<unknown> | Uint8Array | ((...args: never[]) => unknown);
/** Depth counter for the recursive path types. */
export type Prev = [never, 0, 1, 2, 3];
/** `[path, value]` for every attribute, and for every path below an object or a list, 4 levels deep. */
type PathEntry<T, P extends string = '', D extends number = 4> = [D] extends [never]
  ? never
  : {
      [K in keyof T & string]-?: [`${P}${K}`, T[K]] | Below<NonNullable<T[K]>, `${P}${K}`, Prev[D]>;
    }[keyof T & string];
type Below<V, P extends string, D extends number> = [D] extends [never]
  ? never
  : V extends Leaf
    ? never
    : V extends readonly (infer E)[]
      ? [`${P}[${number}]`, E] | Below<NonNullable<E>, `${P}[${number}]`, Prev[D]>
      : V extends object
        ? PathEntry<V, `${P}.`, D>
        : never;
type Elements<V> = NonNullable<V> extends ReadonlySet<infer E> ? Set<E> | readonly E[] : never;
// `$ADD` takes a number, Set elements as a Set or an array, or list elements to append (dynamoose's runtime).
type Addable<V> =
  NonNullable<V> extends number
    ? number
    : NonNullable<V> extends ReadonlySet<unknown>
      ? Elements<V>
      : NonNullable<V> extends readonly (infer E)[]
        ? readonly E[]
        : never;

/** An attribute name or a path below it: `a.b`, `list[0]`, `list[0].c`. */
type UpdatePath<T> = PathEntry<T>[0];
/** Each path takes its own value type, or `ifNotExists(value)`. `undefined` removes the attribute. */
type SetInput<T> = {[E in PathEntry<T> as E[0]]?: E[1] | IfNotExists<E[1]>};

/** Plain fields are an implicit `$SET`. */
export type UpdateInput<T> =
  IsAny<T> extends true
    ? Record<string, any>
    : SetInput<T> & {
        $SET?: SetInput<T>;
        $REMOVE?: readonly UpdatePath<T>[] | {[P in UpdatePath<T>]?: null};
        $ADD?: {
          [E in PathEntry<T> as [Addable<E[1]>] extends [never] ? never : E[0]]?: Addable<E[1]>;
        };
        $DELETE?: {
          [E in PathEntry<T> as [Elements<E[1]>] extends [never] ? never : E[0]]?: Elements<E[1]>;
        };
      };

interface RetrieverResponse<T> extends Array<T> {
  count: number;
}
export interface QueryResponse<T> extends RetrieverResponse<T> {
  /** The key to pass to `startAt()` for the next page. */
  lastKey?: Record<string, unknown>;
  queriedCount: number;
  timesQueried: number;
}
export interface ScanResponse<T> extends RetrieverResponse<T> {
  /** The key to pass to `startAt()` for the next page. */
  lastKey?: Record<string, unknown>;
  scannedCount: number;
  timesScanned: number;
}
/** A `parallel()` scan's result: several unfinished segments give one key per segment. */
export interface ParallelScanResponse<T> extends Omit<ScanResponse<T>, 'lastKey'> {
  lastKey?: Record<string, unknown> | Record<string, unknown>[];
}

/** A raw condition object, passed through as is. */
export interface RawCondition {
  ConditionExpression: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, AttributeValue>;
}

export interface CallOptions {
  client?: DynamoDBClient;
  abortSignal?: AbortSignal;
}
/**
 * `'ALL_OLD'`: when the condition fails, DynamoDB returns the stored item, and the thrown SDK error (its class
 * unchanged) carries it read back as `get` reads it, in `item`.
 */
export interface ConditionFailureOptions {
  returnValuesOnConditionCheckFailure?: ReturnValuesOnConditionCheckFailure;
}
export interface GetOptions<Item = Record<string, unknown>> extends CallOptions {
  attributes?: readonly (keyof Item & string)[];
  consistent?: boolean;
  /** Return the stored values, without converting them back. */
  raw?: boolean;
  /** Send the key as given, skipping the key transforms. */
  rawKey?: boolean;
  return?: 'item' | 'request';
}
/** A dynamoose condition, checked against the model when the request is built, or a raw condition object. */
export type ConditionInput = Condition<any, any> | RawCondition;

export interface CreateOptions extends CallOptions, ConditionFailureOptions {
  /** Replace a stored item with the same key. Without it the write is conditional on the key not being stored. */
  overwrite?: boolean;
  condition?: ConditionInput;
  /** Keep the input's `createdAt`: `save()` semantics for an item that was read. */
  keepCreatedAt?: boolean;
  return?: 'item' | 'request';
}
export interface UpdateOptions extends CallOptions, ConditionFailureOptions {
  condition?: ConditionInput;
  /**
   * Writes a top-level attribute the schema does not declare as given (no check, Dates in the default storage),
   * where the default, as in dynamoose, drops it. A condition on it takes a raw condition object.
   */
  allowUndeclared?: boolean;
  returnValues?: ReturnValue;
  rawKey?: boolean;
  return?: 'item' | 'request';
}
export interface DeleteOptions extends CallOptions, ConditionFailureOptions {
  condition?: ConditionInput;
  rawKey?: boolean;
  return?: null | 'request';
}
export interface BatchGetOptions<Item = Record<string, unknown>> extends CallOptions {
  /** The key attributes are read too, so each item can take its key's position. */
  attributes?: readonly (keyof Item & string)[];
  consistent?: boolean;
}
/** The items found, in the order of the keys. `unprocessedKeys` holds the stored keys DynamoDB left unread after the retries. */
export type BatchGetResponse<T> = T[] & {unprocessedKeys: Record<string, unknown>[]};

export interface TransactionOptions extends CallOptions {
  return?: 'request';
}
