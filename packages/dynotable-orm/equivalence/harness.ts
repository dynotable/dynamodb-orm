import {
  type AttributeValue,
  type CreateTableCommandInput,
  DynamoDBClient,
  PutItemCommand,
  type ReturnValue,
  ScanCommand
} from '@aws-sdk/client-dynamodb';
import {createRequire} from 'node:module';
import {Condition} from '../src/condition.js';
import {unmarshallItem} from '../src/marshall.js';
import {type Model, model} from '../src/model.js';
import type {ModelOptions} from '../src/options.js';
import {transaction} from '../src/transaction.js';
import type {ModelTypes, StandardSchema} from '../src/types.js';
import {createTable, deleteTable, LOCAL, uniqueTableName} from '../tests/integration/setup.js';
import type {AllowlistEntry} from './allowlist.js';
import {difference} from './comparator.js';

export type Dynamoose = typeof import('dynamoose');
// dynamoose's own typings reject valid definitions (a Date storage type), and the local mode's instance comes from another install.
type DynamooseSchema = unknown;
type DynamooseModel = any;
type StoredItem = Record<string, AttributeValue>;
type LibModel = Model<string, ModelTypes<Record<string, unknown>, string, never>>;

/** The oracle, dynamoose 4.2.0 from npm, pinned in devDependencies. One module instance per process, bound to DynamoDB Local. */
export const dynamoose: Dynamoose = createRequire(import.meta.url)('dynamoose');
dynamoose.aws.ddb.set(new dynamoose.aws.ddb.DynamoDB(LOCAL));

type Input = Record<string, unknown>;
export type Step =
  /** Each side writes its own clone of the input as a new item (`Model.create`). */
  | {label: string; create: Input; overwrite?: boolean}
  /** Each side saves its clone as an item that was read: dynamoose's `item.save()`, this lib's `create` with `overwrite` and `keepCreatedAt`. */
  | {label: string; save: Input}
  /** Each side reads its own table with a clone of the key, an object or a scalar hash key. */
  | {label: string; get: Input | string}
  /** Each side updates its own table: `[key, changes]`, or `[item]` holding both. */
  | {label: string; update: [Input | string | number, Input] | [Input]; returnValues?: ReturnValue}
  /** Each side deletes from its own table with a clone of the key. */
  | {label: string; delete: Input | string}
  /** The same raw item is put into both tables (a legacy item). */
  | {label: string; put: StoredItem}
  /** Each side builds the same query or scan chain on its own model, then runs `exec()`. */
  | {label: string; retrieve: (model: any) => {exec(): Promise<unknown>}}
  /**
   * Each side builds the same entries with its own model's `transaction.*` and its own `Condition` class,
   * then sends them with its own `transaction()`.
   */
  | {label: string; transaction: (model: any, condition: (init: object) => any) => unknown[]}
  /** Each side writes its own clones of the items with `batchPut`. */
  | {label: string; batchPut: Input[]}
  /** Each side deletes clones of the keys from its own table with `batchDelete`. */
  | {label: string; batchDelete: Array<Input | string>}
  /** Each side reads its own table with clones of the keys and `batchGet`. */
  | {label: string; batchGet: Array<Input | string>};

export interface Case {
  name: string;
  /** The dynamoose `Schema` of the dynamoose side. */
  dynamoose: (d: Dynamoose) => DynamooseSchema;
  lib: {schema: StandardSchema; options: ModelOptions<any>};
  steps: Step[];
  /** Steps whose write rejects on the dynamoose side. A step that rejects on both sides must be listed. */
  failing?: string[];
}

/**
 * - `write`: whether the write resolved or rejected (error messages differ between the libs, so only the outcome is
 *   compared), and the resolved value, except for a transaction (dynamoose resolves to `null`, this lib to `undefined`);
 * - `get`: the `get` or `batchGet` step's result on each side (both rejecting counts as equal);
 * - `retrieve`: the items and the response fields (`lastKey`, counts) of a query or scan result, or the counts of `count()`, except:
 * - `scannedCount`: the result's `queriedCount` or `scannedCount`, alone, so an allowlist entry on it hides nothing else;
 * - `stored`: every raw item of the two tables;
 * - `read`: for every item of the dynamoose table that the step added or changed, `fromStoredItem` against dynamoose's `get`;
 * - `strictRead`: dynamoose's `get` with `readStrict: true` on the item this lib wrote, against its `get` of its own item;
 * - `input`: the caller's input after the step.
 */
export type Check =
  | 'write'
  | 'get'
  | 'retrieve'
  | 'scannedCount'
  | 'stored'
  | 'read'
  | 'strictRead'
  | 'input';

export interface CheckResult {
  check: Check;
  dynamoose: unknown;
  lib: unknown;
  diff?: string;
}

export interface StepRecord {
  label: string;
  checks: CheckResult[];
}

type Outcome = {outcome: 'resolve'; value?: unknown} | {outcome: 'reject'; message: string};

async function settle(run: () => unknown): Promise<Outcome> {
  try {
    return {outcome: 'resolve', value: await run()};
  } catch (error) {
    return {
      outcome: 'reject',
      message: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    };
  }
}

/** A deep copy that keeps Date, Set, Map, Buffer and typed arrays, so a side that changes its input cannot reach the other. */
export function clone<T>(value: T): T {
  if (Buffer.isBuffer(value)) return Buffer.from(value) as T;
  if (value instanceof Uint8Array) return new Uint8Array(value) as T;
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (value instanceof Set) return new Set([...value].map(clone)) as T;
  if (value instanceof Map) return new Map([...value].map(([k, v]) => [clone(k), clone(v)])) as T;
  if (Array.isArray(value)) return value.map(clone) as T;
  if (typeof value === 'object' && value !== null) {
    if (Object.getPrototypeOf(value) !== Object.prototype)
      throw new Error('clone copies plain objects only');
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)])) as T;
  }
  return value;
}

// A dynamoose Item's own enumerable properties are its attributes.
const plain = (item: unknown) => (item === undefined ? undefined : {...(item as object)});

const SCANNED = ['queriedCount', 'scannedCount'];
const RESPONSE_FIELDS = ['lastKey', 'count', 'timesQueried', 'timesScanned'];
// The items and the response fields (dynamoose's `populate` and `toJSON` functions left out), and the scanned count apart.
function response(result: unknown): {main: unknown; scanned: unknown} {
  const r = result as Record<string, unknown>;
  const scanned = Object.fromEntries(SCANNED.filter((k) => k in r).map((k) => [k, r[k]]));
  if (!Array.isArray(result))
    return {
      main: Object.fromEntries(Object.entries(r).filter(([k]) => !SCANNED.includes(k))),
      scanned
    };
  const fields = RESPONSE_FIELDS.filter((k) => k in r).map((k) => [k, r[k]]);
  return {main: {items: result.map(plain), ...Object.fromEntries(fields)}, scanned};
}
const part = (o: Outcome, key: 'main' | 'scanned'): Outcome =>
  o.outcome === 'resolve'
    ? {outcome: 'resolve', value: (o.value as Record<string, unknown>)[key]}
    : o;

/** Every item of the table, every page, sorted by key. */
export async function scan(
  client: DynamoDBClient,
  table: string,
  keyNames: string[]
): Promise<StoredItem[]> {
  const Items: StoredItem[] = [];
  let ExclusiveStartKey: StoredItem | undefined;
  do {
    const page = await client.send(
      new ScanCommand({TableName: table, ConsistentRead: true, ExclusiveStartKey})
    );
    Items.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  const keyOf = (item: StoredItem) => JSON.stringify(keyNames.map((k) => item[k]));
  return Items.sort((x, y) => (keyOf(x) < keyOf(y) ? -1 : keyOf(x) > keyOf(y) ? 1 : 0));
}

const pick = (item: StoredItem, names: string[]) =>
  unmarshallItem(
    Object.fromEntries(names.filter((k) => item[k] !== undefined).map((k) => [k, item[k]!]))
  );

function compared(check: Check, dyn: unknown, lib: unknown, compare = difference): CheckResult {
  const diff = compare(dyn, lib);
  return {check, dynamoose: dyn, lib, ...(diff && {diff})};
}

const sameOutcome = (a: unknown, b: unknown): string | undefined => {
  const x = a as Outcome;
  const y = b as Outcome;
  if (x.outcome === y.outcome) return undefined;
  const rejected = x.outcome === 'reject' ? x : (y as Outcome & {outcome: 'reject'});
  return `${x.outcome} vs ${y.outcome} (${rejected.message})`;
};

async function tableRequest(model: DynamooseModel, schema: any): Promise<CreateTableCommandInput> {
  try {
    return await model.table().create({return: 'request'});
  } catch (error) {
    // dynamoose cannot build an index on a multi-type attribute (a nullish field); the items still need the primary key only.
    console.warn(
      `dynamoose has no CreateTable request (${(error as Error).message}); creating the primary key only`
    );
    const keys = [schema.hashKey, schema.rangeKey].filter(Boolean) as string[];
    return {
      TableName: model.table().name,
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: keys.map((AttributeName, i) => ({
        AttributeName,
        KeyType: i === 0 ? 'HASH' : 'RANGE'
      })),
      AttributeDefinitions: keys.map((AttributeName) => ({
        AttributeName,
        AttributeType: schema.getAttributeType(AttributeName)
      }))
    };
  }
}

// The same outcome, and when both resolve, the same resolved value.
const writeDifference = (a: unknown, b: unknown): string | undefined => {
  const d = sameOutcome(a, b);
  if (d) return d;
  const x = a as Outcome;
  return x.outcome === 'resolve' ? difference(x.value, (b as {value?: unknown}).value) : undefined;
};

// Two read outcomes match when both resolve to equal values, or both reject (the messages differ between the libs).
function readDifference(a: unknown, b: unknown): string | undefined {
  const x = a as Outcome;
  const y = b as Outcome;
  if (x.outcome !== y.outcome) return `${x.outcome} vs ${y.outcome}`;
  return x.outcome === 'resolve' ? difference(x.value, (y as {value?: unknown}).value) : undefined;
}

function readsDifference(a: unknown, b: unknown): string | undefined {
  const x = a as Outcome[];
  const y = b as Outcome[];
  if (x.length !== y.length) return `${x.length} vs ${y.length} reads`;
  for (let i = 0; i < x.length; i++) {
    const d = readDifference(x[i], y[i]);
    if (d) return `$[${i}]${d.startsWith('$') ? d.slice(1) : `: ${d}`}`;
  }
  return undefined;
}

/**
 * Runs one case on DynamoDB Local. Each side has its own table, created from dynamoose's own
 * CreateTable request, and each side is driven by its own `Model`. `d` is the dynamoose instance the
 * case's `Schema` belongs to (the local mode passes the instance of the codebase it loads).
 */
export async function runCase(testCase: Case, d: Dynamoose = dynamoose): Promise<StepRecord[]> {
  const client = new DynamoDBClient(LOCAL);
  const settings = {create: false, waitForActive: false};
  const dynModel: DynamooseModel = d.model(
    uniqueTableName(`${testCase.name}_dynamoose`),
    testCase.dynamoose(d) as any,
    settings
  );
  const strictModel: DynamooseModel = d.model(
    uniqueTableName(`${testCase.name}_lib`),
    testCase.dynamoose(d) as any,
    // A build with a lenient read takes readStrict; dynamoose 4.2.0 has no such setting and always reads strictly.
    {...settings, readStrict: true} as {}
  );
  // The table prefix and suffix of `d` apply, so the names come from the models.
  const dynTable: string = dynModel.table().name;
  const libTable: string = strictModel.table().name;
  const request = await tableRequest(dynModel, testCase.dynamoose(d));
  const keyNames = (request.KeySchema ?? []).map((k) => k.AttributeName!);
  await createTable(client, {...request, TableName: dynTable});
  await createTable(client, {...request, TableName: libTable});
  // Named by the table, with no prefix or suffix, so each lib model reaches exactly that table.
  const libModel = (table: string) =>
    model(table, testCase.lib.schema, {
      ...testCase.lib.options,
      prefix: '',
      suffix: '',
      client
    } as {}) as unknown as LibModel;
  const libWriter = libModel(libTable);
  const libReader = libModel(dynTable);

  const records: StepRecord[] = [];
  const seen = new Set<string>();
  try {
    for (const step of testCase.steps) {
      const checks: CheckResult[] = [];
      // The stored key of the item this step wrote, for the strict read.
      let writtenKey: StoredItem | undefined;
      if ('create' in step || 'save' in step) {
        const input = 'create' in step ? step.create : step.save;
        const dynInput = clone(input);
        const libInput = clone(input);
        const dyn = await settle(async () =>
          plain(
            'save' in step
              ? await new dynModel(dynInput, {type: 'fromDynamo'}).save()
              : await dynModel.create(
                  dynInput,
                  step.overwrite === undefined ? {} : {overwrite: step.overwrite}
                )
          )
        );
        const lib = await settle(() =>
          libWriter.create(
            libInput,
            'save' in step
              ? {overwrite: true, keepCreatedAt: true}
              : {overwrite: step.overwrite ?? false}
          )
        );
        checks.push(
          compared('write', dyn, lib, writeDifference),
          compared('input', dynInput, libInput)
        );
        if (lib.outcome === 'resolve')
          writtenKey = (await libWriter.get(lib.value, {return: 'request', rawKey: true})).Key;
      } else if ('update' in step) {
        const dynArgs = clone(step.update);
        const libArgs = clone(step.update);
        const options = step.returnValues === undefined ? [] : [{returnValues: step.returnValues}];
        const dyn = await settle(async () => plain(await dynModel.update(...dynArgs, ...options)));
        const lib = await settle(() =>
          (libWriter.update as (...args: unknown[]) => Promise<unknown>)(...libArgs, ...options)
        );
        checks.push(
          compared('write', dyn, lib, writeDifference),
          compared('input', dynArgs, libArgs)
        );
        if (lib.outcome === 'resolve')
          writtenKey = (await libWriter.get(step.update[0] as Input, {return: 'request'})).Key;
      } else if ('get' in step) {
        const dynKey = clone(step.get);
        const libKey = clone(step.get);
        const dyn = await settle(async () => plain(await dynModel.get(dynKey)));
        const lib = await settle(() => libWriter.get(libKey));
        checks.push(compared('get', dyn, lib, readDifference), compared('input', dynKey, libKey));
      } else if ('delete' in step) {
        const dynKey = clone(step.delete);
        const libKey = clone(step.delete);
        const dyn = await settle(() => dynModel.delete(dynKey));
        const lib = await settle(() => libWriter.delete(libKey));
        checks.push(
          compared('write', dyn, lib, writeDifference),
          compared('input', dynKey, libKey)
        );
      } else if ('retrieve' in step) {
        const dyn = await settle(async () => response(await step.retrieve(dynModel).exec()));
        const lib = await settle(async () => response(await step.retrieve(libReader).exec()));
        checks.push(
          compared('retrieve', part(dyn, 'main'), part(lib, 'main'), readDifference),
          compared('scannedCount', part(dyn, 'scanned'), part(lib, 'scanned'), readDifference)
        );
      } else if ('transaction' in step) {
        const dyn = await settle(() =>
          d.transaction(step.transaction(dynModel, (init) => new d.Condition(init as any)) as any)
        );
        const lib = await settle(() =>
          transaction(step.transaction(libWriter, (init) => new Condition(init)) as never[], {
            client
          })
        );
        checks.push(compared('write', dyn, lib, sameOutcome));
      } else if ('batchPut' in step || 'batchDelete' in step) {
        const put = 'batchPut' in step;
        const dynInput = clone(put ? step.batchPut : step.batchDelete);
        const libInput = clone(dynInput);
        const dyn = await settle(() =>
          put ? dynModel.batchPut(dynInput) : dynModel.batchDelete(dynInput)
        );
        const lib = await settle(() =>
          put ? libWriter.batchPut(libInput as Input[]) : libWriter.batchDelete(libInput)
        );
        checks.push(
          compared('write', dyn, lib, writeDifference),
          compared('input', dynInput, libInput)
        );
      } else if ('batchGet' in step) {
        const dynKeys = clone(step.batchGet);
        const libKeys = clone(step.batchGet);
        const items = (r: unknown[] & {unprocessedKeys: unknown[]}) => ({
          items: r.map(plain),
          unprocessedKeys: r.unprocessedKeys
        });
        const dyn = await settle(async () => items(await dynModel.batchGet(dynKeys)));
        const lib = await settle(async () => items(await libWriter.batchGet(libKeys)));
        checks.push(compared('get', dyn, lib, readDifference), compared('input', dynKeys, libKeys));
      } else {
        for (const TableName of [dynTable, libTable])
          await client.send(new PutItemCommand({TableName, Item: clone(step.put)}));
      }

      const dynItems = await scan(client, dynTable, keyNames);
      checks.push(
        compared('stored', dynItems, await scan(client, libTable, keyNames), (a, b) =>
          difference(a, b, '$', 'stored')
        )
      );

      // Only the items this step added or changed are read again.
      const changed = dynItems.filter((raw) => {
        const json = JSON.stringify(raw);
        return !seen.has(json) && Boolean(seen.add(json));
      });
      const dynReads: Outcome[] = [];
      const libReads: Outcome[] = [];
      for (const raw of changed) {
        dynReads.push(await settle(async () => plain(await dynModel.get(pick(raw, keyNames)))));
        // The stored key exactly, as dynamoose's set modifiers leave a stored key as it is.
        libReads.push(await settle(() => libReader.get(pick(raw, keyNames), {rawKey: true})));
      }
      checks.push(compared('read', dynReads, libReads, readsDifference));

      if (writtenKey) {
        const key = unmarshallItem(writtenKey);
        const strict = await settle(async () => plain(await strictModel.get(key)));
        const own = await settle(async () => plain(await dynModel.get(key)));
        checks.push(compared('strictRead', own, strict, readDifference));
      }
      records.push({label: step.label, checks});
    }
  } finally {
    await Promise.all([deleteTable(client, dynTable), deleteTable(client, libTable)]);
    client.destroy();
  }
  return records;
}

/**
 * The guards: a step that rejects on both sides must be
 * listed in `failing`, a listed step must really reject on the dynamoose side, and an allowlist entry must
 * name a step that really differs on that check, with a reason and a reference. Returns the problems.
 */
export function verdict(
  testCase: Case,
  records: StepRecord[],
  entries: readonly AllowlistEntry[]
): string[] {
  const problems: string[] = [];
  const failing = new Set(testCase.failing ?? []);
  const own = entries.filter((e) => e.case === testCase.name);
  const labels = records.map((r) => r.label);
  if (new Set(labels).size !== labels.length) problems.push('step labels are not unique');

  for (const e of own) {
    if (!/\S/.test(e.reason) || !/\S/.test(e.ref))
      problems.push(`allowlist ${e.step} › ${e.check}: needs a reason and a reference`);
    if (!labels.includes(e.step)) problems.push(`allowlist ${e.step} › ${e.check}: no such step`);
  }
  for (const label of failing)
    if (!labels.includes(label)) problems.push(`failing ${label}: no such step`);

  for (const {label, checks} of records) {
    const write = checks.find(
      (c) => c.check === 'write' || c.check === 'get' || c.check === 'retrieve'
    );
    const dynRejects = (write?.dynamoose as Outcome | undefined)?.outcome === 'reject';
    const lib = write?.lib as Outcome | undefined;
    const libRejects = lib?.outcome === 'reject';
    // Error messages differ between the libs, but this lib refuses with its own error classes: a built-in one is a bug.
    const builtIn = libRejects
      ? /^(TypeError|ReferenceError|RangeError|SyntaxError):/.exec(lib.message)?.[1]
      : undefined;
    if (builtIn)
      problems.push(`${label}: this lib rejects with a ${builtIn}, a bug rather than a refusal`);
    if (dynRejects && libRejects && !failing.has(label))
      problems.push(`${label}: rejects on both sides but is not listed in failing`);
    if (failing.has(label) && !dynRejects)
      problems.push(`${label}: listed in failing but dynamoose does not reject`);

    for (const c of checks) {
      const allowed = own.some((e) => e.step === label && e.check === c.check);
      if (c.diff && !allowed) problems.push(`${label} › ${c.check}: ${c.diff}`);
      if (!c.diff && allowed)
        problems.push(`${label} › ${c.check}: allowlisted but does not differ (stale entry)`);
    }
    for (const e of own) {
      if (e.step === label && !checks.some((c) => c.check === e.check)) {
        problems.push(`${label} › ${e.check}: allowlisted but the check does not run`);
      }
    }
  }
  return problems;
}
