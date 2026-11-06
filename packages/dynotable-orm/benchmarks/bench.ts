// CPU-only benchmark of this lib's built `dist` against the raw contender, dynamoose and the base build, on a
// stub client that never leaves the process. Run it built, under plain node (see README.md):
//
//   pnpm bench [--quick] [--rounds <n>] [--json <file>]
//   BASELINE=<base checkout>/packages/dynotable-orm pnpm bench --gate
//
// BASELINE: the package directory of the base checkout (its `dist` built). BENCH_SCALE_CURRENT=<factor>
// multiplies this lib's samples, only so a test can reach the gate's failure path.
import type {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {existsSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {basename, dirname, join, resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {
  GATE,
  isGated,
  judge,
  median,
  type RowSamples,
  rowVerdict,
  type RowVerdict
} from './gate.js';
import {benchSchemas, type Send} from './schemas.js';

type Lib = typeof import('../src/index.js');
export type ContenderName = 'lib' | 'raw' | 'dynamoose' | 'base';
export const OPERATIONS = ['create', 'get', 'update', 'update-nested', 'query'] as const;
export type Operation = (typeof OPERATIONS)[number];
export const QUERY_ITEMS = 100;

export interface Contender {
  /** A ContenderName, or a local competitor's name. */
  name: string;
  /** Not timed. */
  prepare: () => unknown;
  run: (input: any) => Promise<unknown>;
}
export interface Suite {
  schema: string;
  operation: Operation;
  contenders: Contender[];
}
export interface Result {
  schema: string;
  operation: Operation;
  /** ops/s per round, per contender. */
  samples: Record<string, number[]>;
}
interface Settings {
  rounds: number;
  roundMs: number;
  warmupMs: number;
}

export const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function loadLib(directory: string): Promise<Lib> {
  const entry = join(directory, 'dist/index.js');
  if (!existsSync(entry)) throw new Error(`${entry} is missing: build ${directory} first`);
  return import(pathToFileURL(entry).href);
}

/** The last request any contender sent, and the canned responses by table and command. */
export const stub = {
  last: undefined as {command: string; input: any} | undefined,
  responses: new Map<string, Record<string, unknown>>(),
  reply(command: string, input: {TableName?: string}): Promise<unknown> {
    stub.last = {command, input};
    return Promise.resolve(stub.responses.get(input.TableName!)![command]);
  }
};
const send: Send = (command) => stub.reply(command.constructor.name, command.input);
const client = {send} as unknown as DynamoDBClient;
// dynamoose calls the aggregated client's methods.
const dynamooseClient = {
  putItem: (input: object) => stub.reply('PutItemCommand', input),
  getItem: (input: object) => stub.reply('GetItemCommand', input),
  updateItem: (input: object) => stub.reply('UpdateItemCommand', input),
  query: (input: object) => stub.reply('QueryCommand', input)
};

// A contender that changed a canned response would change the next call's work, so the responses are frozen.
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/**
 * Every schema × operation, each with the lib, raw, dynamoose and (with `base`) the base build. dynamoose is
 * left out of `update-nested`: it writes `{$SET: {'a.b': value}}` as one top-level attribute named "a.b".
 */
export async function setup(base?: Lib): Promise<Suite[]> {
  const lib = await loadLib(PACKAGE);
  const dynamoose = createRequire(import.meta.url)('dynamoose');
  dynamoose.aws.ddb.set(dynamooseClient);
  const suites: Suite[] = [];
  for (const s of benchSchemas) {
    const table = `Bench_${s.name}`;
    const Dynamoose = dynamoose.model(table, s.dynamoose(dynamoose), {
      create: false,
      waitForActive: false
    });
    // The canned items are dynamoose's own requests: the stored form.
    const stored = async (data: Record<string, unknown>) =>
      (await Dynamoose.create(data, {return: 'request'})).Item;
    const items = [];
    for (let i = 0; i < QUERY_ITEMS; i++) items.push(await stored(s.queryData(i)));
    const item = await stored(s.data());
    stub.responses.set(
      table,
      deepFreeze({
        PutItemCommand: {},
        GetItemCommand: {Item: item},
        UpdateItemCommand: {Attributes: item},
        QueryCommand: {Items: items, Count: items.length, ScannedCount: items.length}
      })
    );

    // The ORMs share every call shape.
    const models: Array<[ContenderName, any]> = [
      ['lib', lib.model(table, s.lib.schema, {...s.lib.options, client})],
      ['dynamoose', Dynamoose],
      ...(base
        ? [
            ['base', base.model(table, s.lib.schema, {...s.lib.options, client})] as [
              ContenderName,
              any
            ]
          ]
        : [])
    ];
    const r = s.raw(send, table);
    const key = () => ({...s.key});
    const calls: Record<
      Operation,
      | {
          prepare: () => unknown;
          orm: (M: any, x: any) => Promise<unknown>;
          raw: (x: any) => Promise<unknown>;
        }
      | undefined
    > = {
      create: {prepare: s.data, orm: (M, x) => M.create(x), raw: (x) => r.create(x)},
      get: {prepare: key, orm: (M, k) => M.get(k), raw: (k) => r.get(k)},
      update: {
        prepare: () => [key(), s.update()],
        orm: (M, [k, c]) => M.update(k, c),
        raw: ([k, c]) => r.update(k, c)
      },
      'update-nested':
        s.nestedUpdate && r.updateNested
          ? {
              prepare: () => [key(), s.nestedUpdate!()],
              orm: (M, [k, c]) => M.update(k, c),
              raw: ([k, c]) => r.updateNested!(k, c)
            }
          : undefined,
      query: {
        prepare: () => s.query.value,
        orm: (M, v) => M.query(s.query.attribute).eq(v).exec(),
        raw: (v) => r.query(v)
      }
    };
    for (const operation of OPERATIONS) {
      const call = calls[operation];
      if (!call) continue;
      const [libModel, ...others] = models.filter(
        ([name]) => operation !== 'update-nested' || name !== 'dynamoose'
      );
      suites.push({
        schema: s.name,
        operation,
        contenders: [
          {name: 'lib', prepare: call.prepare, run: (x) => call.orm(libModel![1], x)},
          {name: 'raw', prepare: call.prepare, run: call.raw},
          ...others.map(([name, M]): Contender => ({
            name,
            prepare: call.prepare,
            run: (x) => call.orm(M, x)
          }))
        ]
      });
    }
  }
  return suites;
}

/** ops/s. Inputs are prepared in batches outside the timed part, so the timer is read once per batch. */
async function measure(c: Contender, ms: number, batch: number): Promise<number> {
  let ops = 0;
  let elapsed = 0;
  while (elapsed < ms) {
    const inputs = Array.from({length: batch}, () => c.prepare());
    const start = performance.now();
    for (const input of inputs) await c.run(input);
    elapsed += performance.now() - start;
    ops += batch;
  }
  return ops / (elapsed / 1000);
}

/** Warms up every contender, then measures each one per round for `roundMs`, the order alternating per round. */
export async function run(
  suites: readonly Suite[],
  settings: Settings,
  scale = 1
): Promise<Result[]> {
  const gc = (globalThis as {gc?: () => void}).gc;
  if (!gc) throw new Error('run with node --expose-gc');
  // A batch takes about a tenth of a round: slow contenders still finish several batches per round.
  const batches = new Map<Contender, number>();
  for (const suite of suites) {
    for (const c of suite.contenders) {
      const opsPerSecond = await measure(c, settings.warmupMs, 1);
      batches.set(
        c,
        Math.max(1, Math.min(20, Math.floor((opsPerSecond * settings.roundMs) / 10_000)))
      );
    }
  }
  const results: Result[] = suites.map((s) => ({
    schema: s.schema,
    operation: s.operation,
    samples: {}
  }));
  for (let round = 0; round < settings.rounds; round++) {
    for (const [i, suite] of suites.entries()) {
      for (const c of round % 2 ? [...suite.contenders].reverse() : suite.contenders) {
        gc();
        const opsPerSecond =
          (await measure(c, settings.roundMs, batches.get(c)!)) * (c.name === 'lib' ? scale : 1);
        (results[i]!.samples[c.name] ??= []).push(opsPerSecond);
      }
    }
  }
  return results;
}

const rowSamples = (r: Result): RowSamples => ({
  lib: r.samples.lib!,
  raw: r.samples.raw!,
  dynamoose: r.samples.dynamoose,
  base: r.samples.base
});

function formatRows(rows: string[][]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows
    .map((row) =>
      row
        .map((cell, column) =>
          column < 2 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!)
        )
        .join('  ')
        .trimEnd()
    )
    .join('\n');
}

const us = (samples: number[] | undefined) => (samples ? (1e6 / median(samples)).toFixed(1) : '-');
const ratio = (v: {median: number; low: number; high: number}, digits: number) =>
  `${v.median.toFixed(digits)}x${Number.isNaN(v.low) ? '' : ` [${v.low.toFixed(digits)}, ${v.high.toFixed(digits)}]`}`;

/** Medians in µs/op. lib/raw and dynamoose/lib are CPU ratios, the median of the per-round ratios with its 99% interval. */
export function printTable(
  results: readonly Result[],
  verdicts: ReadonlyMap<Result, RowVerdict> = new Map()
): void {
  const rows = [
    [
      'schema',
      'operation',
      'lib µs',
      'raw µs',
      'dynamoose µs',
      'base µs',
      'lib/raw',
      '',
      'dynamoose/lib',
      '',
      'vs base',
      'p',
      ''
    ]
  ];
  for (const r of results) {
    const v = verdicts.get(r) ?? rowVerdict(rowSamples(r));
    const gated = verdicts.has(r);
    const regression = v.regression;
    rows.push([
      r.schema,
      r.operation,
      us(r.samples.lib),
      us(r.samples.raw),
      us(r.samples.dynamoose),
      us(r.samples.base),
      ratio(v.raw, 2),
      gated ? v.raw.result : '',
      v.dynamoose ? ratio(v.dynamoose, 1) : '-',
      gated && v.dynamoose ? v.dynamoose.result : '',
      regression ? `${regression.change >= 0 ? '+' : ''}${regression.change.toFixed(1)}%` : '-',
      regression ? regression.p.toPrecision(2) : '-',
      gated && regression ? (regression.slower ? 'SLOWER' : 'ok') : ''
    ]);
  }
  console.log(formatRows(rows));
}

const label = (r: Result) => `${r.schema} ${r.operation}`;

async function gate(
  results: Result[],
  suites: readonly Suite[],
  settings: Settings,
  scale: number
): Promise<boolean> {
  const gated = results.filter((r) => isGated(r.schema, r.operation));
  console.log(
    `\ngate: lib/raw <= ${GATE.maxRawRatio}x and dynamoose/lib >= ${GATE.minDynamooseRatio}x over the whole 99% interval of the median ratio; ` +
      `vs base: no slowdown over ${GATE.maxSlowdownPercent}% with p < ${GATE.alpha} (one-sided Mann-Whitney U). A row that does not pass runs again.`
  );
  const first = gated.map((row) => ({row, verdict: rowVerdict(rowSamples(row))}));
  printTable(gated, new Map(first.map((x) => [x.row, x.verdict])));
  const failed = await judge(first, async (rows) => {
    console.log(`\n${rows.map(label).join(', ')} did not pass, running again`);
    const again = await run(
      rows.map((r) => suites.find((s) => s.schema === r.schema && s.operation === r.operation)!),
      settings,
      scale
    );
    const verdicts = again.map((r) => rowVerdict(rowSamples(r)));
    printTable(again, new Map(again.map((r, i) => [r, verdicts[i]!])));
    return verdicts;
  });
  if (failed.length) console.log(`\ngate FAILED: ${failed.map(label).join(', ')}`);
  else console.log('\ngate passed');
  return failed.length === 0;
}

async function main(args: string[]): Promise<void> {
  const option = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const gateMode = args.includes('--gate');
  const settings: Settings = args.includes('--quick')
    ? {rounds: 2, roundMs: 20, warmupMs: 20}
    : gateMode
      ? {rounds: 20, roundMs: 150, warmupMs: 300}
      : {rounds: 10, roundMs: 200, warmupMs: 500};
  if (args.includes('--rounds')) {
    const rounds = option('--rounds') ?? '';
    // Zero rounds give no samples, and a gate without samples must not pass.
    if (!/^[1-9]\d*$/.test(rounds))
      throw new Error(`--rounds must be a positive integer, got "${rounds}"`);
    settings.rounds = Number(rounds);
  }
  const scale = process.env.BENCH_SCALE_CURRENT ? Number(process.env.BENCH_SCALE_CURRENT) : 1;
  if (!(scale > 0 && Number.isFinite(scale)))
    throw new Error(
      `BENCH_SCALE_CURRENT must be a positive number, got "${process.env.BENCH_SCALE_CURRENT}"`
    );

  const baseline = process.env.BASELINE ? resolve(process.env.BASELINE) : undefined;
  // Without BASELINE the gate cannot tell a first pull request from a missing base build.
  if (gateMode && !baseline)
    throw new Error('--gate needs BASELINE=<package directory of the base checkout>');
  let base: Lib | undefined;
  if (baseline) {
    if (existsSync(join(baseline, 'benchmarks/bench.ts'))) base = await loadLib(baseline);
    else
      console.log(
        `${baseline} has no bench: the regression rule is skipped (the first pull request)`
      );
  }

  console.log(
    `lib ${PACKAGE}${base ? ` vs base ${baseline}` : ''}, node ${process.version}, ${settings.rounds} rounds of ${settings.roundMs} ms`
  );
  const suites = await setup(base);
  const results = await run(suites, settings, scale);
  printTable(results);
  const json = option('--json');
  if (json)
    writeFileSync(
      json,
      `${JSON.stringify({node: process.version, ...settings, results}, null, 2)}\n`
    );
  if (gateMode && !(await gate(results, suites, settings, scale))) process.exitCode = 1;
}

// competitors.local.ts bundles this file, so its own URL is also the main module's there.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  /^bench\.[jt]s$/.test(basename(process.argv[1]))
) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
