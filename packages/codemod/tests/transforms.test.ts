import {spawnSync} from 'node:child_process';
import {cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {Project} from 'ts-morph';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {main} from '../src/cli.js';
import {migrate} from '../src/index.js';

// Each fixture is a project: `input/` is dynamoose code, `output/` the expected result, which must compile
// against the built dynotable-orm (`#models` resolves to dynamoose models for input, dynotable-orm ones for output).
// `@acme/dynamoose` stands for a scoped dynamoose package: the fixture tsconfigs map it to dynamoose 4.2.0.
const fixtures = join(import.meta.dirname, 'fixtures');
const runs = {
  direct: {},
  // `#models` is a source too: its own models still get the model rewrites.
  wrapper: {sources: ['#db', '#built', '#models'], target: '#db'},
  schema: {},
  // Each file names the bug it catches.
  'zod-module': {zod: '@acme/shared/zod'}
} as const;

const SAVE =
  "save(): only new M(...).save() and x.save() on a const x = new M(...) or x = await M.get(...) or await M.<method>(...) typed as M's item, of the same function, with M a const or an import, are converted: use M.create(item, {overwrite: true}), plus keepCreatedAt: true for an item that was read";
const CALLBACK = (name: string) =>
  `methods.set('${name}'): the last parameter is a callback, which dynamoose passes when the caller gives none and a dynotable-orm method never gets: return a Promise instead, then run again`;
const BATCH = (name: string) =>
  `${name}(): dynotable-orm takes no return setting and always sends the request: drop return, or build the request by hand`;
const tsconfig = (name: string, side: 'input' | 'output') =>
  join(fixtures, name, `tsconfig.${side}.json`);
const expected = (name: string) =>
  Object.fromEntries(
    readdirSync(join(fixtures, name, 'output')).map((f) => [
      f,
      readFileSync(join(fixtures, name, 'output', f), 'utf8')
    ])
  );
const byName = (changed: {file: string; text: string}[]) =>
  Object.fromEntries(changed.map((c) => [c.file.slice(c.file.lastIndexOf('/') + 1), c.text]));
const diagnostics = (path: string) => {
  const project = new Project({tsConfigFilePath: path});
  return project.formatDiagnosticsWithColorAndContext(project.getPreEmitDiagnostics());
};

describe.each(Object.entries(runs))('fixture %s', (name, options) => {
  it('turns each input into its output, with no TODO', async () => {
    const result = await migrate({tsconfig: tsconfig(name, 'input'), dryRun: true, ...options});
    expect(result.todos).toEqual([]);
    expect(byName(result.changed)).toEqual(expected(name));
  });

  it('the input compiles against dynamoose, and the output against the built dynotable-orm', () => {
    expect(diagnostics(tsconfig(name, 'input'))).toBe('');
    expect(diagnostics(tsconfig(name, 'output'))).toBe('');
  });

  it('a second run changes nothing', async () => {
    const result = await migrate({tsconfig: tsconfig(name, 'output'), dryRun: true, ...options});
    expect(result.changed).toEqual([]);
    expect(result.todos).toEqual([]);
  });
});

describe('unknown shapes', () => {
  it('get a TODO marker each, once', async () => {
    const first = await migrate({tsconfig: tsconfig('todo', 'input'), dryRun: true});
    expect(byName(first.changed)).toEqual(expected('todo'));
    expect(first.todos.map((t) => [t.line, t.message])).toEqual([
      // clashes.ts: a read reached through then(), a plain item, a chain that stops before toJSON, and names
      // the file already holds.
      // A later methods.set of the same name replaces the earlier one: none of the model's methods moves.
      [
        28,
        "methods.set('label'): set more than once on TwiceModel, and the last one wins: keep one, then run again"
      ],
      [
        29,
        "methods.set('label'): set more than once on TwiceModel, and the last one wins: keep one, then run again"
      ],
      [30, 'methods.set: convert to extend({...}) with the other methods of this model'],
      [10, SAVE],
      // Destructuring (with another model's default), a loop, a fallback between two reads, a let.
      [17, SAVE],
      [18, SAVE],
      [20, SAVE],
      [23, SAVE],
      [
        33,
        "conformToSchema: only new M(x).conformToSchema({type: 'fromDynamo'}) with the settings of a read, with M a const or an import and x typed as a record of AttributeValue, is converted, to M.fromStored(x)"
      ],
      [
        36,
        'x?.toJSON(): only a variable, a property or a literal index at the end of the chain is converted, to (x == null ? undefined : toJSON(x))'
      ],
      [
        41,
        'transaction: this file already has its own transaction and ormTransaction: rename one, then run again'
      ],
      [2, 'UpdateOptions: this file already has its own UpdateOptions: rename it, then run again'],
      // names.ts: save() on a model a let, a shadowing binding, a parameter or an exported let holds; two schemas whose options
      // names are the same; an instanceof check that cannot be rewritten keeps its import.
      [10, SAVE],
      [16, SAVE],
      [20, SAVE],
      // An imported model that its module exports as a let.
      [35, SAVE],
      [26, 'model(): its schema does not convert'],
      [24, 'new Schema(): no free name for the options of foo'],
      [
        32,
        'isConditionalCheckFailed: this file already has its own isConditionalCheckFailed and ormIsConditionalCheckFailed: rename one, then run again'
      ],
      // A schema or a model() with any part that does not convert stays whole, and so does what depends on it.
      [7, 'model(): its schema does not convert'],
      [9, "model(): 'parent': dynamoose.type.THIS has no dynotable-orm equivalent"],
      [10, 'model(): the model setting expires has no dynotable-orm equivalent'],
      [14, 'model(): its schema does not convert'],
      // dynamoose awaits an async set hook; the dynotable-orm one would get a Promise as the item.
      [
        17,
        'model(): the schema setting set returns a Promise: the dynotable-orm set hook is synchronous'
      ],
      // The model() call would read the parameter, not the generated options.
      [
        21,
        'model(): shadowOptions is bound to something else here: rename that binding, then run again'
      ],
      // dynamoose awaits an async default, and gives a Date's validate the stored number or string.
      [
        24,
        "model(): 'token': the default returns a Promise, which dynamoose awaits: a Zod default is synchronous"
      ],
      [
        25,
        "model(): 'at': validate on a Date gets the stored number or string in dynamoose, and a Date in a refinement: convert it by hand"
      ],
      // dynamoose's required check refuses a $SET to undefined, and a $REMOVE when the default is falsy; a Zod default allows both.
      [
        27,
        "model(): 'n': required with a default: dynamoose refuses an update that sets it to undefined, or that removes it when the default is falsy (it writes a truthy default), and a Zod default allows both: convert it by hand"
      ],
      // dynamoose stores Date.now's number; a z.date() default must give a Date.
      [
        29,
        "model(): 'at': the default of a Date gives no Date, and dynamoose stores what it gives: convert it by hand"
      ],
      // dynamoose reads any truthy required as required, so only a literal converts.
      [32, "model(): 's': required is not a literal"],
      [
        38,
        "model(): 'grade': only an enum of string or number literals, or Object.values() of a string enum, converts"
      ],
      [3, "new Schema(): 'email' has a set modifier, which has no dynotable-orm equivalent"],
      [
        12,
        "new Schema(): saveUnknown '*': only '**' and '<Object attribute>.**' convert; 'lines': an Array converts only with a schema of one element type; logSchema is used other than as model()'s schema: logSchema.getHashKey"
      ],
      [20, 'new Schema(): a model() of this schema does not convert'],
      // shadowed.ts: a local type takes the dynotable-orm name at one use of the import.
      [1, 'GetOptions: this file already has its own GetOptions: rename it, then run again'],
      // type-imports.ts: a type-only import gives no value to the rewritten code.
      [
        2,
        'Condition: imported as a type only, but the rewritten code needs its value: drop "type", then run again'
      ],
      [
        3,
        'z: imported as a type only, but the converted schemas need its value: drop "type", then run again'
      ],
      // A registration that may run later or not at all, or reads a const not set yet, stays where it is.
      [
        57,
        'methods.set: answer is not set yet where Gated is declared, so it cannot move to its declaration'
      ],
      [
        59,
        'methods.set: the call is not a top-level statement, so it may run later or not at all: convert to extend({...}) by hand'
      ],
      [
        62,
        'methods.set: the call is not a top-level statement, so it may run later or not at all: convert to extend({...}) by hand'
      ],
      // A nested function's `this` is not the model, so neither method of the model moves.
      [23, "methods.set('names'): LaterModel is used where this does not refer to the model"],
      [21, 'methods.set: convert to extend({...}) with the other methods of this model'],
      [
        38,
        'methods.set: Overridden is read at module load before this call, so the methods cannot move to its declaration'
      ],
      // A callback-style method: typed as one, and called in the body.
      [69, CALLBACK('label')],
      [70, CALLBACK('relay')],
      // An optional callback parameter of a function declared without a body.
      [90, CALLBACK('described')],
      [13, SAVE],
      [14, 'populate has no dynotable-orm equivalent'],
      [16, 'transaction get has no equivalent: read the item with get() or batchGet()'],
      [
        34,
        'x?.toJSON(): only a variable, a property or a literal index at the end of the chain is converted, to (x == null ? undefined : toJSON(x))'
      ],
      // Read by one of two models: save() cannot tell which table to write.
      [48, SAVE],
      [
        50,
        'x?.save(): only a variable, a property or a literal index at the end of the chain is converted, to (x == null ? undefined : M.create(x, …))'
      ],
      [51, 'get(): dynotable-orm takes no callback and returns a Promise: await the call instead'],
      // A helper typed as another model's item.
      [81, SAVE],
      // A request-only batch call: dynotable-orm's would send the request.
      [94, BATCH('batchPut')],
      [95, BATCH('batchDelete')],
      [104, BATCH('batchGet')],
      [
        65,
        "(e as {code?: string}).code === 'ConditionalCheckFailedException': the SDK error has no code, so this never matched; if a failed condition is meant, use isConditionalCheckFailed(e)"
      ],
      [6, 'dynamoose.type.THIS has no dynotable-orm equivalent: declare the field in the schema'],
      [8, 'unknown dynamoose use: dynamoose.logger'],
      [
        15,
        'dynamoose.Table.defaults.set: only prefix and suffix have an equivalent, setDefaults({prefix, suffix})'
      ],
      // A comment is one line: the source text in the message is collapsed.
      [30, "unknown dynamoose use: Reflect.get( dynamoose, 'transaction' )"],
      [
        86,
        'transaction(): dynotable-orm takes no callback and returns a Promise: await the call instead'
      ],
      [2, 'no dynotable-orm type for ModelType (@acme/dynamoose/dist/General)'],
      // A scoped dynamoose that is not installed: without its types, a model is not recognised.
      [
        3,
        'cannot resolve @unresolved/dynamoose: install it and check that the tsconfig resolves it, then run again'
      ],
      // zod-binding.ts: z is imported from zod, but it is not the zod namespace.
      [6, 'model(): z is bound to something other than zod in this file']
    ]);
    // The output still uses dynamoose, so its tsconfig resolves the dynamoose models.
    const second = await migrate({tsconfig: tsconfig('todo', 'output'), dryRun: true});
    expect(second.changed).toEqual([]);
    // Less the 2 of type-imports.ts: the rewrite that needed the value is done, and its marker stays.
    expect(second.todos).toHaveLength(64);
  });

  it('make the CLI exit 1 and list them', async () => {
    const lines: string[] = [];
    expect(await main([tsconfig('todo', 'input'), '--dry-run'], (l) => lines.push(l))).toBe(1);
    expect(lines).toContain('66 TODO(s) left in the code:');
    expect(
      lines.filter((l) => l.includes('unknown.ts:8 unknown dynamoose use: dynamoose.logger'))
    ).toHaveLength(1);
  });
});

describe('--zod', () => {
  // z from zod itself is not the --zod module's: reading it keeps the import the project forbids, and adding
  // the module's z beside it binds z twice.
  it('leaves a TODO, and adds no import, where z is bound to another module', async () => {
    const result = await migrate({
      tsconfig: tsconfig('zod-clash', 'input'),
      dryRun: true,
      zod: '@acme/shared/zod'
    });
    expect(byName(result.changed)).toEqual(expected('zod-clash'));
    expect(result.todos.map((t) => [t.line, t.message])).toEqual([
      [6, 'model(): z is bound to something other than @acme/shared/zod in this file']
    ]);
  });
});

// A consumer's linter reads the output, and the comparison with `output/` accepts whatever the fixture holds: a
// JSDoc block moved from a statement onto a method meets jsdoc/require-param there, a merged import sort-imports,
// an import used only in types consistent-type-imports.
it('every output passes the lint rules that moved comments and rewritten imports meet', () => {
  const oxlint = join(import.meta.dirname, '../../../node_modules/.bin/oxlint');
  const outputs = readdirSync(fixtures).filter((f) => existsSync(join(fixtures, f, 'output')));
  const r = spawnSync(
    oxlint,
    [
      '-c',
      join(fixtures, 'lint.oxlintrc.json'),
      ...outputs.map((f) => join(fixtures, f, 'output'))
    ],
    {encoding: 'utf8'}
  );
  expect(outputs).toContain('wrapper');
  expect(r.status, r.stdout + r.stderr).toBe(0);
});

describe('cli', () => {
  // Inside the package, so the copied fixtures resolve dynamoose and dynotable-orm from its node_modules.
  const work = mkdtempSync(join(import.meta.dirname, '.work-'));
  beforeAll(() => cpSync(fixtures, work, {recursive: true}));
  afterAll(() => rmSync(work, {recursive: true, force: true}));

  it('writes the changes, with --source and --target, and exits 0 without a TODO', async () => {
    const lines: string[] = [];
    const code = await main(
      [join(work, 'wrapper/tsconfig.input.json'), '--source', '#db', '--target', '#db'],
      (l) => lines.push(l)
    );
    expect(code).toBe(0);
    // `#built` is not a --source, but it exports dynamoose under a name built.ts imports: that binding moves too.
    expect(lines[0]).toBe('changed 3 file(s)');
    expect(readFileSync(join(work, 'wrapper/input/settle.ts'), 'utf8')).toBe(
      expected('wrapper')['settle.ts']
    );
    expect(readFileSync(join(work, 'wrapper/input/built.ts'), 'utf8')).toBe(
      expected('wrapper')['built.ts']
    );
  });

  it('passes --zod to the import it adds', async () => {
    const code = await main(
      [join(work, 'zod-module/tsconfig.input.json'), '--zod', '@acme/shared/zod'],
      () => {}
    );
    expect(code).toBe(0);
    expect(readFileSync(join(work, 'zod-module/input/fresh.ts'), 'utf8')).toBe(
      expected('zod-module')['fresh.ts']
    );
  });

  it('--dry-run writes nothing', async () => {
    const before = readFileSync(join(work, 'direct/input/items.ts'), 'utf8');
    expect(await main([join(work, 'direct/tsconfig.input.json'), '--dry-run'], () => {})).toBe(0);
    expect(readFileSync(join(work, 'direct/input/items.ts'), 'utf8')).toBe(before);
  });

  it('rejects a command line without exactly one tsconfig', async () => {
    const lines: string[] = [];
    expect(await main([], (l) => lines.push(l))).toBe(2);
    expect(lines).toEqual([
      'usage: dynotable-orm-codemod <tsconfig> [--dry-run] [--source <module>]... [--target <module>] [--zod <module>]'
    ]);
  });
});

describe('report', () => {
  it('lists the SDK value imports left, with the replacement for each known bypass', async () => {
    const result = await migrate({tsconfig: tsconfig('direct', 'input'), dryRun: true});
    // ConditionalCheckFailedException is gone: every use was an instanceof check.
    expect(
      result.sdkImports.map(({file, ...rest}) => ({
        file: file.slice(file.lastIndexOf('/') + 1),
        ...rest
      }))
    ).toEqual([
      {
        file: 'client.ts',
        line: 1,
        module: '@aws-sdk/client-dynamodb',
        name: 'DynamoDB',
        replacement: 'setClient(client), or the per-call {client, abortSignal} options'
      }
    ]);
  });
});
