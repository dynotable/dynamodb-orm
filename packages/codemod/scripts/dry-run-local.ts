/**
 * Dry-runs the codemod on local copies of projects that use a dynamoose codebase as a dependency, and
 * runs each copy's `tsc`, `lint` script and test suite twice: on the unported dependency (control) and after
 * the codemod on the ported one (port). Writes nowhere but the copies, which must be gitignored in this repo.
 *
 *   SERVICES           comma-separated git repos; each is copied from its origin default branch (required)
 *   SCRATCH_DIR        where the copies go (default: .equivalence-local/services in this repo)
 *   CONTROL_DEPS       name=spec pairs, comma-separated, set before the codemod (the unported baseline)
 *   PORT_DEPS          name=spec pairs set after the codemod (the ported dependencies)
 *                      Each spec is an exact version or a file: tarball, and is checked after the install.
 *   CODEMOD_ARGS       extra codemod arguments, split on spaces
 *   DYNAMODB_ENDPOINT  local DynamoDB endpoint for the tests (required)
 *
 *   node packages/codemod/scripts/dry-run-local.ts          clone, control, codemod, port
 *   node packages/codemod/scripts/dry-run-local.ts --port   back to each copy's control commit, then control
 *                                                           lint, codemod, port
 */
import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {basename, join, resolve} from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const scratch = resolve(process.env.SCRATCH_DIR ?? join(root, '.equivalence-local/services'));
const endpoint = process.env.DYNAMODB_ENDPOINT;
if (!endpoint) throw new Error('DYNAMODB_ENDPOINT is not set');

// The copies hold private code: they must never be committable here.
if (spawnSync('git', ['check-ignore', '-q', join(scratch, 'x')], {cwd: root}).status !== 0) {
  throw new Error(`${scratch} is not gitignored in ${root}`);
}

// Dummy credentials, no profile, and every AWS service but DynamoDB on a closed local port: a test that
// is not mocked fails here instead of reaching AWS.
const env: NodeJS.ProcessEnv = {...process.env, HUSKY: '0', CI: '1'};
for (const k of Object.keys(env)) if (k.startsWith('AWS_')) delete env[k];
Object.assign(env, {
  AWS_ACCESS_KEY_ID: 'local',
  AWS_SECRET_ACCESS_KEY: 'local',
  AWS_REGION: 'eu-west-1',
  AWS_CONFIG_FILE: '/dev/null',
  AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
  AWS_EC2_METADATA_DISABLED: 'true',
  AWS_ENDPOINT_URL: 'http://127.0.0.1:9',
  AWS_ENDPOINT_URL_DYNAMODB: endpoint
});

const git = (args: string[], cwd: string) =>
  execFileSync('git', args, {cwd, env, encoding: 'utf8'}).trim();
const commit = (dir: string, message: string) => {
  git(['add', '-A'], dir);
  git(
    [
      '-c',
      'user.name=dry-run',
      '-c',
      'user.email=dry-run@localhost',
      'commit',
      '-q',
      '--no-verify',
      '--allow-empty',
      '-m',
      message
    ],
    dir
  );
};
const pairs = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .filter(Boolean)
    .map((p) => p.split(/=(.*)/s, 2) as [string, string]);

// pnpm looks up the directory tree for a workspace: a copy without its own would be installed as part of this repo.
const envIn = (dir: string): NodeJS.ProcessEnv => ({...env, NPM_CONFIG_WORKSPACE_DIR: dir});

function install(dir: string, log: string, frozen: boolean): void {
  const r = spawnSync('pnpm', ['install', frozen ? '--frozen-lockfile' : '--no-frozen-lockfile'], {
    cwd: dir,
    env: envIn(dir),
    encoding: 'utf8'
  });
  writeFileSync(log, r.stdout + r.stderr);
  if (r.status !== 0) throw new Error(`pnpm install failed in ${dir}; see ${log}`);
}

/**
 * Sets each dependency's spec where the manifest declares it (dependencies or devDependencies), and in the
 * workspace's pnpm `overrides`, which win over the manifest (pnpm takes no file: spec through a catalog there).
 */
function setDeps(dir: string, deps: [string, string][]): void {
  const path = join(dir, 'package.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  for (const [name, spec] of deps) {
    const field =
      ['dependencies', 'devDependencies'].find((f) => manifest[f]?.[name]) ?? 'dependencies';
    manifest[field] = {...manifest[field], [name]: spec};
  }
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  const workspace = join(dir, 'pnpm-workspace.yaml');
  if (!existsSync(workspace)) return;
  let inOverrides = false;
  const lines = readFileSync(workspace, 'utf8')
    .split('\n')
    .map((line) => {
      if (/^\S/.test(line)) inOverrides = /^overrides:\s*$/.test(line);
      const entry = /^(\s+)['"]?([^'":]+)['"]?:/.exec(line);
      const dep = inOverrides && entry && deps.find(([name]) => name === entry[2]);
      return dep ? `${entry[1]}'${dep[0]}': '${dep[1]}'` : line;
    });
  writeFileSync(workspace, lines.join('\n'));
}

/** Fails when the install did not put the requested spec in place: an override can win over the manifest. */
function checkDeps(dir: string, deps: [string, string][]): void {
  for (const [name, spec] of deps) {
    const installed = realpathSync(join(dir, 'node_modules', name));
    const {version} = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
    // pnpm keeps a file: dependency under a `@file+…` store name.
    const fromFile = installed.includes('@file+');
    if (spec.startsWith('file:') ? !fromFile : fromFile || version !== spec)
      throw new Error(`${name} in ${dir} is ${version} at ${installed}, not ${spec}`);
  }
}

type LintResult =
  | {exit: number | null; errors: number; warnings: number; errorsByRule: Record<string, number>}
  | {exit: number | null; error: string};

/**
 * The copy's own `lint` script, or `undefined` when it has none. `--fix` and `--cache` are dropped (a dry run
 * reports and must not read the other stage's cache), and an oxlint or eslint run at the end of the script
 * reports JSON, so errors are counted per rule.
 */
function lint(dir: string, logs: string, name: string): LintResult | undefined {
  const script: string | undefined = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    .scripts?.lint;
  if (!script) return undefined;
  const tool = /\b(oxlint|eslint)\b[^&;|]*$/.exec(script)?.[1];
  const cmd = `${script
    .replace(/\s--(fix|cache)\b/g, '')
    .replace(/\s(-f|--format)(=|\s+)\S+/g, '')}${tool ? ' --format json' : ''}`;
  const r = spawnSync('pnpm', ['exec', 'sh', '-c', cmd], {
    cwd: dir,
    env: envIn(dir),
    encoding: 'utf8',
    timeout: 15 * 60_000,
    maxBuffer: 1 << 28
  });
  writeFileSync(join(logs, `${name}-lint.txt`), `$ ${cmd}\n${r.stdout}\n--- stderr\n${r.stderr}`);
  if (!tool) return {exit: r.status, error: 'not oxlint or eslint: exit status only'};
  const start = r.stdout.search(/^[[{]/m);
  let report: unknown;
  try {
    report = JSON.parse(r.stdout.slice(start));
  } catch {
    return {exit: r.status, error: `no JSON report (signal ${r.signal})`};
  }
  // oxlint: {diagnostics: [{code, severity}]}; eslint: [{messages: [{ruleId, severity: 1 | 2}]}].
  const found =
    tool === 'oxlint'
      ? (report as {diagnostics: {code: string; severity: string}[]}).diagnostics.map((d) => ({
          rule: d.code,
          error: d.severity === 'error'
        }))
      : (report as {messages: {ruleId: string | null; severity: number}[]}[]).flatMap((f) =>
          f.messages.map((m) => ({rule: m.ruleId ?? 'parse', error: m.severity === 2}))
        );
  const errorsByRule: Record<string, number> = {};
  for (const d of found) if (d.error) errorsByRule[d.rule] = (errorsByRule[d.rule] ?? 0) + 1;
  return {
    exit: r.status,
    errors: found.filter((d) => d.error).length,
    warnings: found.filter((d) => !d.error).length,
    errorsByRule
  };
}

interface StageResult {
  tscErrors: number;
  lint?: LintResult;
  tests:
    | {
        files: number;
        total: number;
        passed: number;
        failed: number;
        skipped: number;
        failedFiles: number;
      }
    | {error: string};
}

function stage(dir: string, logs: string, name: string): StageResult {
  // Vite's caches outlive a reinstall: a module cached from the other stage's dependency drops `vi.mock`.
  for (const cache of ['.vite', '.vitest-cache'])
    rmSync(join(dir, 'node_modules', cache), {recursive: true, force: true});
  const tsc = spawnSync('pnpm', ['exec', 'tsc', '--noEmit'], {
    cwd: dir,
    env: envIn(dir),
    encoding: 'utf8'
  });
  const tscText = tsc.stdout + tsc.stderr;
  writeFileSync(join(logs, `${name}-tsc.txt`), tscText);
  const json = join(logs, `${name}-tests.json`);
  rmSync(json, {force: true});
  const t = spawnSync('pnpm', ['run', 'test', '--reporter=json', `--outputFile=${json}`], {
    cwd: dir,
    env: envIn(dir),
    encoding: 'utf8',
    timeout: 45 * 60_000,
    maxBuffer: 1 << 28
  });
  writeFileSync(join(logs, `${name}-tests.txt`), t.stdout + t.stderr);
  const tscErrors = (tscText.match(/error TS\d+/g) ?? []).length;
  const lintResult = lint(dir, logs, name);
  if (!existsSync(json))
    return {
      tscErrors,
      lint: lintResult,
      tests: {error: `no report (exit ${t.status}, signal ${t.signal})`}
    };
  const r = JSON.parse(readFileSync(json, 'utf8'));
  return {
    tscErrors,
    lint: lintResult,
    tests: {
      files: r.numTotalTestSuites,
      total: r.numTotalTests,
      passed: r.numPassedTests,
      failed: r.numFailedTests,
      skipped: r.numPendingTests + r.numTodoTests,
      // A file that fails to load reports no test, so its count is separate.
      failedFiles: r.testResults.filter(
        (f: {status: string; assertionResults: unknown[]}) =>
          f.status === 'failed' && f.assertionResults.length === 0
      ).length
    }
  };
}

function dryRun(source: string, portOnly: boolean): object {
  const name = basename(resolve(source));
  const dir = join(scratch, name);
  const logs = join(scratch, 'logs', name);
  mkdirSync(logs, {recursive: true});
  let control: StageResult | {lint?: LintResult};
  if (portOnly) {
    git(['reset', '-q', '--hard', 'control'], dir);
    git(['clean', '-fdq'], dir);
    install(dir, join(logs, 'install-control.txt'), true);
    control = {lint: lint(dir, logs, 'control')};
  } else {
    // The default branch as last fetched from its remote, not the local branch of that name, which may lag.
    const ref = git(['symbolic-ref', 'refs/remotes/origin/HEAD'], source);
    rmSync(dir, {recursive: true, force: true});
    mkdirSync(dir, {recursive: true});
    git(['init', '-q'], dir);
    git(['fetch', '-q', '--no-tags', '--update-shallow', resolve(source), ref], dir);
    git(['checkout', '-q', '-b', 'dry-run', 'FETCH_HEAD'], dir);
    git(['config', 'core.hooksPath', '/dev/null'], dir);
    const controlDeps = pairs(process.env.CONTROL_DEPS);
    setDeps(dir, controlDeps);
    install(dir, join(logs, 'install-control.txt'), controlDeps.length === 0);
    checkDeps(dir, controlDeps);
    commit(dir, 'control');
    git(['tag', '-f', 'control'], dir);
    control = stage(dir, logs, 'control');
  }
  const base = git(['rev-parse', 'control~1'], dir);

  // The codemod reads the unported dependency's types: it runs before the ported one is installed.
  const args = (process.env.CODEMOD_ARGS ?? '').split(' ').filter(Boolean);
  const codemod = spawnSync(
    process.execPath,
    [join(root, 'packages/codemod/dist/bin.js'), 'tsconfig.json', ...args],
    {cwd: dir, encoding: 'utf8'}
  );
  const codemodText = codemod.stdout + codemod.stderr;
  writeFileSync(join(logs, 'codemod.txt'), codemodText);
  // Exit 1 means TODOs were left, which the log lists; anything else is a failure.
  if (codemod.status !== 0 && codemod.status !== 1)
    throw new Error(`codemod exited ${codemod.status} in ${dir}`);
  commit(dir, 'codemod');
  const portDeps = pairs(process.env.PORT_DEPS);
  setDeps(dir, portDeps);
  install(dir, join(logs, 'install-port.txt'), false);
  checkDeps(dir, portDeps);
  commit(dir, 'port');
  const port = stage(dir, logs, 'port');
  const count = (re: RegExp) => Number(re.exec(codemodText)?.[1] ?? 0);
  const result = {
    name,
    base,
    codemod: {changedFiles: count(/changed (\d+) file/), todos: count(/(\d+) TODO\(s\)/)},
    control,
    port
  };
  writeFileSync(join(logs, 'summary.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

const services = (process.env.SERVICES ?? '').split(',').filter(Boolean);
if (services.length === 0) throw new Error('SERVICES is not set');
execFileSync('pnpm', ['--filter', 'dynotable-orm-codemod', 'build'], {
  cwd: root,
  env,
  stdio: 'inherit'
});
for (const s of services) console.log(JSON.stringify(dryRun(s, process.argv.includes('--port'))));
