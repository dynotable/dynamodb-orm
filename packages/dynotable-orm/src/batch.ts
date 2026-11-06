import type {
  AttributeValue,
  BatchGetItemCommandInput,
  WriteRequest
} from '@aws-sdk/client-dynamodb';
import {send} from './client.js';
import {ExpressionError} from './errors.js';
import {unmarshallItem} from './marshall.js';
import {fromStoredItem} from './pipeline.js';
import type {ModelContext} from './query.js';
import type {BatchGetOptions, BatchGetResponse, CallOptions, Item, StoredItem} from './types.js';

const GET_LIMIT = 100;
const WRITE_LIMIT = 25;
const BASE_DELAY_MS = 50;

// DynamoDB returns a number key in its own normal form ("1E-7" for "1e-7") and bytes as a Uint8Array, so a key
// is compared by its value: a number as digits and exponent, bytes as base64.
function numberId(n: string): string {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(n.trim());
  if (m === null) return n;
  const [, sign, int = '', frac = '', exp = '0'] = m;
  let digits = (int + frac).replace(/^0+/, '');
  if (digits === '') return '0';
  let e = Number(exp) - frac.length;
  const zeros = digits.length - digits.replace(/0+$/, '').length;
  digits = digits.slice(0, digits.length - zeros);
  e += zeros;
  return `${sign === '-' ? '-' : ''}${digits}e${e}`;
}
export const attributeId = (v: AttributeValue | undefined): string => {
  if (v?.S !== undefined) return `S${v.S}`;
  if (v?.N !== undefined) return `N${numberId(v.N)}`;
  if (v?.B !== undefined)
    return `B${Buffer.from(v.B.buffer, v.B.byteOffset, v.B.byteLength).toString('base64')}`;
  return JSON.stringify(v);
};
const idOf = (keyNames: readonly string[], item: StoredItem) =>
  JSON.stringify(keyNames.map((k) => attributeId(item[k])));

// DynamoDB rejects a whole batch that names one key twice, so the call fails before anything is sent.
function ids(keyNames: readonly string[], items: readonly StoredItem[]): string[] {
  const out = items.map((item) => idOf(keyNames, item));
  const seen = new Set<string>();
  for (const id of out) {
    if (seen.has(id)) throw new ExpressionError(`the batch holds the key ${id} twice`);
    seen.add(id);
  }
  return out;
}

// Each chunk is sent again, after a full-jitter exponential backoff, until DynamoDB has processed all of
// it or the retries run out. Chunks run in parallel; resolves to the ids still unprocessed.
async function sendChunks(
  {keyNames, batchRetries}: ModelContext,
  items: readonly StoredItem[],
  size: number,
  send: (chunk: StoredItem[]) => Promise<StoredItem[]>
): Promise<Set<string>> {
  const chunks: StoredItem[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  const left = await Promise.all(
    chunks.map(async (chunk) => {
      let pending = chunk;
      for (let attempt = 0; ; attempt++) {
        pending = await send(pending);
        if (pending.length === 0 || attempt >= batchRetries) return pending;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.random() * BASE_DELAY_MS * 2 ** attempt)
        );
      }
    })
  );
  return new Set(left.flat().map((item) => idOf(keyNames, item)));
}

export async function batchGet(
  context: ModelContext,
  keys: StoredItem[],
  options: BatchGetOptions
): Promise<BatchGetResponse<Item>> {
  const {keyNames} = context;
  const plan = context.plan();
  const table = context.tableName();
  const client = context.client(options);
  const keyIds = ids(keyNames, keys);
  const request: Omit<NonNullable<BatchGetItemCommandInput['RequestItems']>[string], 'Keys'> = {};
  if (options.consistent !== undefined) request.ConsistentRead = options.consistent;
  if (options.attributes) {
    // The key attributes are always read: they place each item at its key's position.
    const names = [...new Set([...options.attributes, ...keyNames])];
    request.ProjectionExpression = names.map((_, i) => `#a${i}`).join(', ');
    request.ExpressionAttributeNames = Object.fromEntries(names.map((a, i) => [`#a${i}`, a]));
  }
  const found = new Map<string, StoredItem>();
  const unprocessed = await sendChunks(context, keys, GET_LIMIT, async (Keys) => {
    const {Responses, UnprocessedKeys} = await send(
      client,
      'batchGetItem',
      {RequestItems: {[table]: {...request, Keys}}},
      options.abortSignal
    );
    for (const item of Responses?.[table] ?? []) found.set(idOf(keyNames, item), item);
    return UnprocessedKeys?.[table]?.Keys ?? [];
  });
  const items: Item[] = [];
  const unprocessedKeys: Item[] = [];
  keys.forEach((key, i) => {
    const item = found.get(keyIds[i]!);
    if (item) items.push(fromStoredItem(plan, item));
    else if (unprocessed.has(keyIds[i]!)) unprocessedKeys.push(unmarshallItem(key));
  });
  return Object.assign(items, {unprocessedKeys});
}

async function batchWrite(
  context: ModelContext,
  items: StoredItem[],
  toRequest: (item: StoredItem) => WriteRequest,
  options: CallOptions
): Promise<boolean[]> {
  const {keyNames} = context;
  const table = context.tableName();
  const client = context.client(options);
  const itemIds = ids(keyNames, items);
  const unprocessed = await sendChunks(context, items, WRITE_LIMIT, async (chunk) => {
    const {UnprocessedItems} = await send(
      client,
      'batchWriteItem',
      {RequestItems: {[table]: chunk.map(toRequest)}},
      options.abortSignal
    );
    return (UnprocessedItems?.[table] ?? []).map(
      (r) => (r.PutRequest?.Item ?? r.DeleteRequest?.Key)!
    );
  });
  return itemIds.map((id) => unprocessed.has(id));
}

/** `unprocessedItems` holds the caller's items that are still unwritten, so they can be passed again. */
export async function batchPut<T>(
  context: ModelContext,
  inputs: readonly T[],
  stored: StoredItem[],
  options: CallOptions
): Promise<{unprocessedItems: T[]}> {
  const left = await batchWrite(context, stored, (Item) => ({PutRequest: {Item}}), options);
  return {unprocessedItems: inputs.filter((_, i) => left[i])};
}

/** `unprocessedItems` holds the stored keys, as `batchGet`'s `unprocessedKeys` and dynamoose's results do. */
export async function batchDelete(
  context: ModelContext,
  keys: StoredItem[],
  options: CallOptions
): Promise<{unprocessedItems: Item[]}> {
  const left = await batchWrite(context, keys, (Key) => ({DeleteRequest: {Key}}), options);
  return {unprocessedItems: keys.filter((_, i) => left[i]).map(unmarshallItem)};
}
