/**
 * Builds a local scratch copy of a dynamoose codebase migrated to dynotable-orm: the source repo's default
 * branch (never its working tree), the codemod, an optional hand-written port patch, and the packed lib.
 * Writes nowhere but the scratch copy, which must be gitignored in this repo.
 *
 *   SOURCE_REPO   git repo to copy (required for a full build)
 *   SCRATCH_DIR   where the copy goes (default: .equivalence-local/scratch-common in this repo)
 *   PORT_PATCH    patch applied after the codemod: the part of the port it cannot write
 *   CODEMOD_ARGS  extra codemod arguments, split on spaces (e.g. "--source ../db --target dynotable-orm")
 *   REMOVE_DEPS   comma-separated dependencies the port drops
 *
 *   node packages/codemod/scripts/scratch-common.ts            full build
 *   node packages/codemod/scripts/scratch-common.ts --relink   repack the lib into an existing copy
 */
import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const scratch = resolve(process.env.SCRATCH_DIR ?? join(root, '.equivalence-local/scratch-common'));
const pkgDir = join(dirname(scratch), 'pkg');
const logDir = join(dirname(scratch), 'logs');
const env = {...process.env, HUSKY: '0'};

const run = (cmd: string, args: string[], cwd: string) =>
  execFileSync(cmd, args, {cwd, env, stdio: 'inherit'});
const git = (args: string[], cwd = scratch) =>
  execFileSync('git', args, {cwd, env, encoding: 'utf8'}).trim();

// The copy holds private code: it must never be committable here.
if (spawnSync('git', ['check-ignore', '-q', join(scratch, 'x')], {cwd: root}).status !== 0) {
  throw new Error(`${scratch} is not gitignored in ${root}`);
}

function relink(): void {
  rmSync(pkgDir, {recursive: true, force: true});
  mkdirSync(pkgDir, {recursive: true});
  run('pnpm', ['pack', '--pack-destination', pkgDir], join(root, 'packages/dynotable-orm'));
  // pnpm caches a file: tarball by its path, so each pack gets a new name.
  const packed = readdirSync(pkgDir).find((f) => f.endsWith('.tgz'))!;
  const name = packed.replace(/\.tgz$/, `-${Date.now()}.tgz`);
  execFileSync('mv', [join(pkgDir, packed), join(pkgDir, name)]);
  const manifestPath = join(scratch, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const dep of (process.env.REMOVE_DEPS ?? '').split(',').filter(Boolean)) {
    delete manifest.dependencies?.[dep];
    delete manifest.devDependencies?.[dep];
  }
  manifest.dependencies = {
    ...manifest.dependencies,
    'dynotable-orm': `file:${relative(scratch, join(pkgDir, name))}`
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  run('pnpm', ['install', '--no-frozen-lockfile'], scratch);
}

function build(): void {
  const source = process.env.SOURCE_REPO;
  if (!source) throw new Error('SOURCE_REPO is not set');
  // The default branch as last fetched from its remote; a fetch copies objects, so the source is only read.
  const ref = git(['symbolic-ref', 'refs/remotes/origin/HEAD'], source);
  rmSync(scratch, {recursive: true, force: true});
  mkdirSync(scratch, {recursive: true});
  git(['init', '-q']);
  git(['fetch', '-q', '--no-tags', resolve(source), ref]);
  git(['checkout', '-q', '-b', 'scratch', 'FETCH_HEAD']);
  git(['config', 'core.hooksPath', '/dev/null']);
  const base = git(['rev-parse', 'HEAD']);
  run('pnpm', ['install', '--frozen-lockfile'], scratch);

  run('pnpm', ['--filter', 'dynotable-orm-codemod', 'build'], root);
  mkdirSync(logDir, {recursive: true});
  const args = (process.env.CODEMOD_ARGS ?? '').split(' ').filter(Boolean);
  const codemod = spawnSync(
    process.execPath,
    [join(root, 'packages/codemod/dist/bin.js'), 'tsconfig.json', ...args],
    {
      cwd: scratch,
      encoding: 'utf8'
    }
  );
  writeFileSync(join(logDir, 'codemod.txt'), codemod.stdout + codemod.stderr);
  // Exit 1 means TODOs were left, which the log lists; anything else is a failure.
  if (codemod.status !== 0 && codemod.status !== 1)
    throw new Error(`codemod exited ${codemod.status}`);
  const commit = (message: string) =>
    git([
      '-c',
      'user.name=scratch',
      '-c',
      'user.email=scratch@localhost',
      'commit',
      '-q',
      '--no-verify',
      '-m',
      message
    ]);
  git(['add', '-A']);
  commit('codemod');

  const patch = process.env.PORT_PATCH;
  if (patch) {
    if (!existsSync(patch)) throw new Error(`no patch at ${patch}`);
    git(['apply', '--3way', resolve(patch)]);
    git(['add', '-A']);
    commit('port');
  }
  relink();
  console.log(
    `scratch copy of ${base} at ${scratch}; codemod log in ${join(logDir, 'codemod.txt')}`
  );
}

if (process.argv.includes('--relink')) relink();
else build();
