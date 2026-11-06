// Local mode: runs every model of a codebase built on its own dynamoose build against this lib, on items
// sampled from real tables, on DynamoDB Local only. The oracle is that build, not the dynamoose 4.2.0 of the
// CI corpus. All output stays in the gitignored `.equivalence-local/`.
//
//   EQUIVALENCE_MODELS=<module exporting every model and its Zod schema>
//   EQUIVALENCE_INSTANCE=<module exporting the codebase's `dynamoose` instance>
//   EQUIVALENCE_ORACLE=<the dynamoose package directory that module resolves, e.g. under .equivalence-local/>
//   EQUIVALENCE_PROJECT=<the PROJECT the codebase's table prefix reads>  [EQUIVALENCE_STAGE=dev]
//   [EQUIVALENCE_LIB_MODELS=<module whose default export maps a table name to this lib's {schema, options}>]
//   pnpm equivalence:local [samples file]
//
// Without EQUIVALENCE_LIB_MODELS, both sides come from the codebase: this lib's side takes the same Zod
// schema and reads its options from the schema's marks. With it, this lib's side of each model is the entry
// for the dynamoose model's table, as a codebase ported to this lib defines it.
//
// With a samples file (any path, in sample.ts's format), the run reads it instead of
// `.equivalence-local/samples.json`, and writes `report-<file>.json` and `summary-<file>.md` next to the
// default report and summary.
//
// The first run writes `.equivalence-local/manifest.json` and stops. `sample.ts` then reads the tables
// it names, with read-only credentials, in a separate process. The second run compares.
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const required = (name: string) => process.env[name] ?? fail(`set ${name}`);
function fail(message: string): never {
  console.error(`equivalence:local: ${message}`);
  process.exit(1);
}

// Before any import that can build an AWS client: no real credentials, DynamoDB Local only.
const ENDPOINT = process.env.DYNAMODB_LOCAL_ENDPOINT ?? 'http://127.0.0.1:8000';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(ENDPOINT))
  fail(`${ENDPOINT} is not a local endpoint`);
for (const k of Object.keys(process.env)) if (k.startsWith('AWS_')) delete process.env[k];
Object.assign(process.env, {
  AWS_ACCESS_KEY_ID: 'local',
  AWS_SECRET_ACCESS_KEY: 'local',
  AWS_REGION: 'local',
  AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
  AWS_CONFIG_FILE: '/dev/null',
  AWS_ENDPOINT_URL_DYNAMODB: ENDPOINT,
  PROJECT: required('EQUIVALENCE_PROJECT'),
  STAGE: process.env.EQUIVALENCE_STAGE ?? 'dev'
});

// Only Date is frozen, as in the CI corpus.
const RealDate = Date;
const NOW = RealDate.parse('2026-01-02T03:04:05.999Z');
class FrozenDate extends RealDate {
  constructor(...args: unknown[]) {
    super(...((args.length === 0 ? [NOW] : args) as [number]));
  }
  static override now = () => NOW;
  // dynamoose recognizes a Date attribute type by its source text, `function Date() { [native code] }`.
  static override toString = () => RealDate.toString();
}
globalThis.Date = FrozenDate as DateConstructor;

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../../.equivalence-local');
const SAMPLES_ARG = process.argv[2];
const SAMPLES = SAMPLES_ARG ? resolve(SAMPLES_ARG) : join(OUT, 'samples.json');
const RUN = SAMPLES_ARG ? `-${basename(SAMPLES_ARG).replace(/\.json$/, '')}` : '';
const SUMMARY = join(OUT, `summary${RUN}.md`);

const {ListTablesCommand} = await import('@aws-sdk/client-dynamodb');
const {createTable, deleteTable, localClient, uniqueTableName} =
  await import('../../tests/integration/setup.js');
const {allowlist} = await import('../allowlist.js');
const {runCase, verdict} = await import('../harness.js');
const {compilePlan, resolveMetadata} = await import('../../src/plan.js');
const {optionsFromDynamoose, pairSchema} = await import('./bridge.js');
type Case = import('../harness.js').Case;
type StoredItem = Record<string, import('@aws-sdk/client-dynamodb').AttributeValue>;

const instancePath = resolve(required('EQUIVALENCE_INSTANCE'));
// The oracle is the codebase's own dynamoose build: the instance must be that package's module.
const oracle = resolve(required('EQUIVALENCE_ORACLE'));
const oracleModule = createRequire(join(oracle, 'package.json'))(oracle);
const {dynamoose: d} = await import(instancePath);
if (d.Schema !== oracleModule.Schema)
  fail("EQUIVALENCE_ORACLE is not the dynamoose package the codebase's instance comes from");
const internal = createRequire(join(oracle, 'package.json'))(join(oracle, 'dist/Internal')).default
  .General.internalProperties;

// The codebase's own instance must reach DynamoDB Local: a marker table only this run created must be listed.
const client = localClient();
const marker = uniqueTableName('equivalence_marker');
await createTable(client, {
  TableName: marker,
  AttributeDefinitions: [{AttributeName: 'id', AttributeType: 'S'}],
  KeySchema: [{AttributeName: 'id', KeyType: 'HASH'}],
  BillingMode: 'PAY_PER_REQUEST'
});
const instanceClient = d.aws.ddb();
const listed: string[] = (await instanceClient.send(new ListTablesCommand({}))).TableNames ?? [];
await deleteTable(client, marker);
if (!listed.includes(marker))
  fail("the codebase's dynamoose instance does not reach DynamoDB Local");
if ((await instanceClient.config.credentials()).accessKeyId !== 'local')
  fail('the codebase resolved real AWS credentials');

const exports: Record<string, any> = await import(resolve(required('EQUIVALENCE_MODELS')));
const models = Object.entries(exports).filter(
  ([, v]) => typeof v === 'function' && v.Model && typeof v.table === 'function'
);
type LibSide = Case['lib'];
const libModels: Record<string, LibSide> | undefined = process.env.EQUIVALENCE_LIB_MODELS
  ? (await import(resolve(process.env.EQUIVALENCE_LIB_MODELS))).default
  : undefined;

interface Entry {
  name: string;
  table: string;
  paths: string[];
  testCase?: Case;
  error?: string;
}

// Attribute paths each model must show in at least one sample: Dates, Sets, combine targets, index keys.
function coveragePaths(testCase: Case): string[] {
  const plan = compilePlan(resolveMetadata(testCase.lib.schema, testCase.lib.options));
  const paths = new Set<string>([...plan.datePaths.keys(), ...plan.combine.map((c) => c.target)]);
  for (const i of plan.indexes) for (const k of [i.hash, i.range]) if (k) paths.add(k);
  const sets = (shape: import('../../src/zod/walk.js').Shape, prefix: string) => {
    if (shape.type === 'set') paths.add(prefix);
    if (shape.type === 'object')
      for (const [k, f] of shape.fields) sets(f, prefix ? `${prefix}.${k}` : k);
  };
  if (plan.adapter) sets(plan.adapter.describe(), '');
  return [...paths].sort();
}

const entries: Entry[] = models.map(([, model]) => {
  const name: string = model.Model.name;
  const entry: Entry = {name, table: model.table().name, paths: []};
  try {
    const schema = model.Model.getInternalProperties(internal).schemas[0];
    let lib: LibSide;
    if (libModels) {
      const found = libModels[entry.table];
      if (!found) throw new Error(`EQUIVALENCE_LIB_MODELS has no model for '${entry.table}'`);
      lib = found;
    } else {
      const own = schema.getInternalProperties(internal);
      const zodSchema = pairSchema(exports, Object.keys(own.schemaObject));
      const options = optionsFromDynamoose(zodSchema, {
        hashKey: schema.hashKey,
        rangeKey: schema.rangeKey,
        timestamps: schema.getSettingValue('timestamps'),
        set: schema.getSettingValue('set')
      });
      lib = {schema: zodSchema as any, options};
    }
    entry.testCase = {name, dynamoose: () => schema, lib, steps: []};
    entry.paths = coveragePaths(entry.testCase);
  } catch (error) {
    entry.error = error instanceof Error ? error.message : String(error);
  }
  return entry;
});

mkdirSync(OUT, {recursive: true});
writeFileSync(
  join(OUT, 'manifest.json'),
  JSON.stringify(
    entries.map(({name, table, paths, error}) => ({name, table, paths, error})),
    null,
    2
  )
);

let samples: Record<string, StoredItem[]>;
try {
  // sample.ts writes B and BS as base64 strings, as DynamoDB JSON does.
  samples = JSON.parse(readFileSync(SAMPLES, 'utf8'), (key, value) =>
    key === 'B' && typeof value === 'string'
      ? Buffer.from(value, 'base64')
      : key === 'BS' && Array.isArray(value)
        ? value.map((v: string) => Buffer.from(v, 'base64'))
        : value
  );
} catch {
  if (SAMPLES_ARG) fail(`cannot read the samples file ${SAMPLES}`);
  console.log(
    `wrote ${join(OUT, 'manifest.json')}; now run sample.ts with read-only credentials, then run this again`
  );
  process.exit(2);
}

function present(item: StoredItem, path: string): boolean {
  let value: import('@aws-sdk/client-dynamodb').AttributeValue | undefined = {M: item};
  for (const seg of path.split('.')) value = value?.M?.[seg];
  return value !== undefined;
}

interface Result {
  name: string;
  items: number;
  steps: number;
  problems: string[];
  uncovered: string[];
  bothReject?: number;
  error?: string;
}
const results: Result[] = [];
for (const entry of entries) {
  const items = samples[entry.name] ?? [];
  const result: Result = {
    name: entry.name,
    items: items.length,
    steps: 0,
    problems: [],
    uncovered: [],
    ...(entry.error && {error: entry.error})
  };
  results.push(result);
  if (!entry.testCase) continue;
  result.uncovered = entry.paths.filter((p) => !items.some((item) => present(item, p)));
  try {
    // First each raw item as stored, then dynamoose's read of it written again by both sides.
    const puts: Case = {
      ...entry.testCase,
      steps: items.map((put, i) => ({label: `put ${i}`, put}))
    };
    const putRecords = await runCase(puts, d);
    const creates: Case = {...entry.testCase, steps: []};
    for (const record of putRecords) {
      const read = record.checks.find((c) => c.check === 'read')?.dynamoose as Array<{
        outcome: string;
        value?: unknown;
      }>;
      for (const r of read)
        if (r.outcome === 'resolve' && r.value)
          creates.steps.push({
            label: `create ${creates.steps.length}`,
            create: r.value as Record<string, unknown>
          });
    }
    const createRecords = await runCase(creates, d);
    // Real items the schema rejects on both sides behave the same; the guard is for curated cases.
    const write = (r: (typeof createRecords)[number]) => r.checks.find((c) => c.check === 'write')!;
    creates.failing = createRecords
      .filter((r) => (write(r).dynamoose as {outcome: string}).outcome === 'reject')
      .map((r) => r.label);
    result.bothReject = createRecords.filter(
      (r) => creates.failing!.includes(r.label) && !write(r).diff
    ).length;
    result.steps = putRecords.length + createRecords.length;
    result.problems = [
      ...verdict(puts, putRecords, allowlist),
      ...verdict(creates, createRecords, allowlist)
    ];
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  console.log(
    `${entry.name}: ${items.length} items, ${result.problems.length} problems, ${result.uncovered.length} uncovered${result.error ? `, error: ${result.error}` : ''}`
  );
}
client.destroy();
writeFileSync(join(OUT, `report${RUN}.json`), JSON.stringify(results, null, 2));

// The summary names no model, attribute or value: only counts, and the kind of each problem.
const kindOf = (problem: string) => {
  const [step = '', rest = ''] = problem.split(' › ');
  const check = rest.split(':')[0] || 'guard';
  const what = /present on one side only/.test(problem)
    ? 'an attribute on one side only'
    : /resolve vs reject/.test(problem)
      ? 'the dynamoose side resolves, this lib rejects'
      : /reject vs resolve/.test(problem)
        ? 'the dynamoose side rejects, this lib resolves'
        : /rejects on both sides/.test(problem)
          ? 'both sides reject'
          : 'a value or type differs';
  return `${step.split(' ')[0]} › ${check}: ${what}`;
};
const kinds = new Map<string, number>();
for (const r of results)
  for (const p of r.problems) kinds.set(kindOf(p), (kinds.get(kindOf(p)) ?? 0) + 1);
// Quoted and parenthesized parts can name attributes.
const errors = new Map<string, number>();
for (const r of results) {
  if (!r.error) continue;
  const kind = r.error.replace(/'[^']*'/g, "'…'").replace(/\([^)]+\)/g, '(…)');
  errors.set(kind, (errors.get(kind) ?? 0) + 1);
}
const sum = (f: (r: Result) => number) => results.reduce((n, r) => n + f(r), 0);
const lines = [
  '# Local equivalence run',
  '',
  `Run on ${new RealDate().toISOString().slice(0, 10)} against the codebase's own dynamoose build, on DynamoDB Local, over items sampled read-only from the tables of a non-production account (\`sample.ts\`: one page of up to 20 items per table, plus up to 2 items for each Date, Set, combine or index path the page does not show). Generated by \`equivalence/local/run.ts\`; model, attribute and table names are left out.`,
  ...(libModels
    ? [
        '',
        "This lib's side of each model came from `EQUIVALENCE_LIB_MODELS`: the codebase as ported to this lib."
      ]
    : []),
  '',
  `- models: ${results.length}`,
  `- models the bridge or the run could not handle: ${results.filter((r) => r.error).length}`,
  `- models with no sampled item: ${results.filter((r) => !r.error && r.items === 0).length}`,
  `- sampled items: ${sum((r) => r.items)}`,
  `- steps run: ${sum((r) => r.steps)}, of which writes both sides reject: ${sum((r) => r.bothReject ?? 0)}`,
  `- models with every step equal: ${results.filter((r) => !r.error && r.items > 0 && r.problems.length === 0).length}`,
  `- models with a difference: ${results.filter((r) => r.problems.length > 0).length} (${sum((r) => r.problems.length)} differences)`,
  `- Date, Set, combine or index paths seen in no sample: ${sum((r) => r.uncovered.length)}, in ${results.filter((r) => r.uncovered.length > 0).length} models`,
  '',
  '## Differences by kind',
  '',
  'A `stored` difference repeats on every later step of a model once one write differs, because each step compares whole tables.',
  '',
  ...(kinds.size === 0
    ? ['None.']
    : [...kinds].sort((a, b) => b[1] - a[1]).map(([k, n]) => `- ${k}: ${n}`)),
  '',
  '## Models not run',
  '',
  ...(errors.size === 0 ? ['None.'] : [...errors].map(([k, n]) => `- ${n}: ${k}`)),
  ''
];
writeFileSync(SUMMARY, lines.join('\n'));
console.log(lines.join('\n'));
const failed = results.some((r) => r.error || r.problems.length > 0 || r.uncovered.length > 0);
process.exit(failed ? 1 : 0);
