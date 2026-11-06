import type {
  Put,
  TransactWriteItemsCommandInput,
  TransactWriteItem
} from '@aws-sdk/client-dynamodb';
import {attributeId} from './batch.js';
import {getClient, send} from './client.js';
import {ExpressionError} from './errors.js';
import {unmarshallItem} from './marshall.js';
import {fromStoredItem} from './pipeline.js';
import type {Plan} from './plan.js';
import type {StoredItem, TransactionOptions} from './types.js';

const MAX_ITEMS = 100;

const idOf = (table: string | undefined, key: StoredItem) =>
  JSON.stringify([
    table,
    Object.keys(key)
      .sort()
      .map((k) => [k, attributeId(key[k])])
  ]);

// A raw `Put` does not say which attributes are its key, so only a model's `transaction.create` result has one here.
const putIds = new WeakMap<object, string>();
// The model plan of each model entry, to read the item a failed condition returns.
const readers = new WeakMap<object, Plan>();

/** Remembers the model an entry belongs to. */
export function readBy<E extends object>(entry: E, plan: Plan): E {
  readers.set(entry, plan);
  return entry;
}

/** The `{Put}` entry of a model's `transaction.create`, with its key remembered for the duplicate check. */
export function putEntry(put: Put, keyNames: readonly string[]): {Put: Put} {
  const entry = {Put: put};
  putIds.set(
    entry,
    idOf(put.TableName, Object.fromEntries(keyNames.map((k) => [k, put.Item![k]!])))
  );
  return entry;
}

function check(items: readonly TransactWriteItem[]): void {
  if (items.length === 0 || items.length > MAX_ITEMS) {
    throw new ExpressionError(`a transaction holds 1 to ${MAX_ITEMS} items, not ${items.length}`);
  }
  const seen = new Set<string>();
  for (const item of items) {
    const op = item.Update ?? item.Delete ?? item.ConditionCheck;
    const id = op?.Key ? idOf(op.TableName, op.Key) : putIds.get(item);
    if (id === undefined) continue;
    if (seen.has(id)) throw new ExpressionError(`the transaction writes the key ${id} twice`);
    seen.add(id);
  }
}

/**
 * Sends `TransactWriteItems` with the entries of the models' `transaction.*`, mixed with raw `TransactItems`.
 * It throws before sending for more than 100 entries or two entries on one key. The client is the
 * `client` option, else `getClient()`. A canceled transaction re-throws the SDK error unchanged, with
 * `reasons`: the `CancellationReasons` code of each entry, in order (`'None'` for the entries that passed),
 * and `items`: the stored item each entry's failed condition returned (`ReturnValuesOnConditionCheckFailure`),
 * read by its model, else `undefined`.
 */
export function transaction(
  items: ReadonlyArray<TransactWriteItem | Promise<TransactWriteItem>>,
  options: TransactionOptions & {return: 'request'}
): Promise<TransactWriteItemsCommandInput>;
export function transaction(
  items: ReadonlyArray<TransactWriteItem | Promise<TransactWriteItem>>,
  options?: TransactionOptions
): Promise<void>;
export function transaction(
  items: ReadonlyArray<TransactWriteItem | Promise<TransactWriteItem>>,
  options?: TransactionOptions
): Promise<TransactWriteItemsCommandInput | void> {
  // No empty options slot: a spy sees the call as the caller made it.
  return (
    options === undefined ? orm.transaction(items) : orm.transaction(items, options)
  ) as Promise<TransactWriteItemsCommandInput | void>;
}

/**
 * The lib's top-level calls as one object, for test spies: `vi.spyOn(orm, 'transaction')` sees every `transaction()`
 * call. A named ESM import cannot be spied on, as `vi.spyOn(dynamoose, 'transaction')` could.
 */
export const orm: {
  transaction(
    items: ReadonlyArray<TransactWriteItem | Promise<TransactWriteItem>>,
    options?: TransactionOptions
  ): Promise<unknown>;
} = {transaction: run};

async function run(
  items: ReadonlyArray<TransactWriteItem | Promise<TransactWriteItem>>,
  options: TransactionOptions = {}
): Promise<TransactWriteItemsCommandInput | void> {
  const TransactItems = await Promise.all(items);
  check(TransactItems);
  const input: TransactWriteItemsCommandInput = {TransactItems};
  if (options.return === 'request') return input;
  const client = options.client ?? getClient();
  try {
    await send(client, 'transactWriteItems', input, options.abortSignal);
  } catch (error) {
    if (error instanceof Error && error.name === 'TransactionCanceledException') {
      const reasons =
        (error as {CancellationReasons?: Array<{Code?: string; Item?: StoredItem}>})
          .CancellationReasons ?? [];
      Object.assign(error, {
        reasons: reasons.map((r) => r.Code ?? 'None'),
        // An entry's stored item, when its condition failed with ReturnValuesOnConditionCheckFailure: 'ALL_OLD'.
        items: reasons.map((r, i) => {
          if (!r.Item) return undefined;
          const plan = readers.get(TransactItems[i]!);
          return plan ? fromStoredItem(plan, r.Item) : unmarshallItem(r.Item);
        })
      });
    }
    throw error;
  }
}
