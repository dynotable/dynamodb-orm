import type {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import type {DateStorage} from './marshall.js';
import type {Prev} from './types.js';

export type IndexType = 'global' | 'local';
export type UnknownKeys = 'zod' | 'dynamoose';

/** A dynamoose index definition. A global index is hashed on its field; a local one uses its field as range key. */
export interface IndexDefinition<Field extends string = string> {
  name?: string;
  type?: IndexType;
  rangeKey?: Field;
  /** `true` projects all attributes, `false` only the keys, an array the listed attributes. */
  project?: boolean | readonly Field[];
}

export interface CombineDefinition<Field extends string = string> {
  sources: readonly Field[];
  separator?: string;
}

export interface TimestampDefinition {
  name?: string;
  storage?: DateStorage;
}

export type Timestamps =
  | boolean
  | {createdAt?: TimestampDefinition; updatedAt?: TimestampDefinition};

type Field<Item> = keyof Item & string;
// Values a DatePath does not go below: it goes through plain objects only, not lists.
type Leaf = Date | Set<unknown> | Uint8Array | readonly unknown[] | ((...args: never[]) => unknown);

/** Dot paths, through plain objects only, to every value that can be a `Date` (Date unions included). */
export type DatePath<T, D extends number = 4> = [D] extends [never]
  ? never
  : [T] extends [never]
    ? never
    : {
        [K in Field<T>]:
          | (Date extends NonNullable<T[K]> ? K : never)
          | `${K}.${DatePath<Exclude<Extract<NonNullable<T[K]>, object>, Leaf>, Prev[D]>}`;
      }[Field<T>];

export interface ModelOptions<Item = Record<string, unknown>> {
  hashKey?: Field<Item>;
  rangeKey?: Field<Item>;
  indexes?: {
    [K in Field<Item>]?: IndexDefinition<Field<Item>> | readonly IndexDefinition<Field<Item>>[];
  };
  dates?: {[P in DatePath<Item>]?: DateStorage};
  combine?: {[K in Field<Item>]?: CombineDefinition<Field<Item>>};
  timestamps?: Timestamps;
  /**
   * The whole-item hook, on a deep copy. It runs on the stored-form item of a write, once on each `$SET` path of
   * an update (wrapped in objects; a value it drops is removed), once on the whole key, and on each top-level
   * condition value.
   */
  set?: (item: Record<string, unknown>) => Record<string, unknown>;
  /** Overrides `setDefaults` for this model. */
  prefix?: string;
  suffix?: string;
  /** Overrides `setClient` for this model. A call's own `client` overrides both. */
  client?: DynamoDBClient;
  /**
   * How many times `batchGet`, `batchPut` and `batchDelete` send again what DynamoDB left unprocessed, with
   * backoff. `0` returns it at once, as dynamoose does. @default 5
   */
  batchRetries?: number;
  /** The storage of a Date that `dates` and the field's own storage leave unset, timestamps included. @default 'milliseconds', as dynamoose */
  defaultDateStorage?: DateStorage;
  /**
   * `'zod'` follows Zod's own meaning of unknown keys. `'dynamoose'` follows a Zod→dynamoose converter's
   * `saveUnknown` rule: a record, `any` or `custom` field opens its parent at every depth. @default 'zod'
   */
  unknownKeys?: UnknownKeys;
}
