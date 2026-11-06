import {execFileSync, spawnSync} from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it, onTestFinished} from 'vitest';

const pkgDir = join(import.meta.dirname, '..');
const root = join(pkgDir, '../..');
let work: string;
let installed: string;

const node = (args: string[]) =>
  execFileSync(process.execPath, args, {cwd: work, encoding: 'utf8'}).trim();

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'dynotable-orm-pack-'));
  // pnpm pack runs prepack, so this also proves the tarball gets a fresh build.
  execFileSync('pnpm', ['pack', '--pack-destination', work], {cwd: pkgDir, stdio: 'ignore'});
  const tarball = readdirSync(work).find((f) => f.endsWith('.tgz'));
  if (!tarball) throw new Error('pnpm pack produced no tarball');
  execFileSync('tar', ['-xzf', tarball], {cwd: work});
  mkdirSync(join(work, 'node_modules'));
  installed = join(work, 'node_modules/dynotable-orm');
  renameSync(join(work, 'package'), installed);
  // What a consumer's install adds next to the package: the peer dependency and the dependencies.
  mkdirSync(join(work, 'node_modules/@aws-sdk'));
  for (const dep of ['@aws-sdk/client-dynamodb', '@aws-sdk/util-dynamodb', 'zod']) {
    symlinkSync(realpathSync(join(pkgDir, 'node_modules', dep)), join(work, 'node_modules', dep));
  }
}, 120_000);

afterAll(() => {
  if (work) rmSync(work, {recursive: true, force: true});
});

describe('packed tarball', () => {
  it('ships dist for both entry points', () => {
    // Shared chunks carry a content hash in their name, so only the entry files are pinned.
    const files = readdirSync(join(installed, 'dist'), {recursive: true}) as string[];
    expect(files.filter((f) => !/-[\w-]{8}\.(d\.c?ts|c?js)$/.test(f)).sort()).toEqual([
      'index.cjs',
      'index.d.cts',
      'index.d.ts',
      'index.js',
      'zod',
      'zod/index.cjs',
      'zod/index.d.cts',
      'zod/index.d.ts',
      'zod/index.js'
    ]);
  });

  it('resolves and loads both subpaths in ESM', () => {
    const out = node([
      '--input-type=module',
      '-e',
      `for (const s of ['dynotable-orm', 'dynotable-orm/zod']) { await import(s); console.log(import.meta.resolve(s)); }`
    ]);
    expect(out.split('\n').map((u) => u.slice(u.indexOf('/node_modules/')))).toEqual([
      '/node_modules/dynotable-orm/dist/index.js',
      '/node_modules/dynotable-orm/dist/zod/index.js'
    ]);
  });

  it('resolves and loads both subpaths in CJS', () => {
    const out = node([
      '-e',
      `for (const s of ['dynotable-orm', 'dynotable-orm/zod']) { require(s); console.log(require.resolve(s)); }`
    ]);
    expect(out.split('\n').map((p) => p.slice(p.indexOf('/node_modules/')))).toEqual([
      '/node_modules/dynotable-orm/dist/index.cjs',
      '/node_modules/dynotable-orm/dist/zod/index.cjs'
    ]);
  });
});

describe('a consumer library', () => {
  // A library emits declarations for its exported models, so every type they are built from must be public.
  it('emits declarations for an exported model and schema', () => {
    writeFileSync(
      join(work, 'models.ts'),
      [
        "import {model} from 'dynotable-orm';",
        "import {extendZod} from 'dynotable-orm/zod';",
        "import {z} from 'zod';",
        'extendZod(z);',
        'export const schema = z.object({id: z.string().hashKey(), at: z.date().storage("seconds")});',
        "export const Things = model('Things', schema);"
      ].join('\n')
    );
    const tsc = join(pkgDir, 'node_modules/typescript/bin/tsc');
    const args = [
      '--declaration',
      '--emitDeclarationOnly',
      '--strict',
      '--skipLibCheck',
      '--module',
      'nodenext',
      '--outDir',
      'out',
      'models.ts'
    ];
    const run = spawnSync(process.execPath, [tsc, ...args], {cwd: work, encoding: 'utf8'});
    expect(run.stdout + run.stderr).toBe('');
    expect(run.status).toBe(0);
  }, 60_000);
});

describe('a consumer without Zod', () => {
  // Zod is an optional peer: the main entry's declarations, shared chunks included, must not import it.
  it('type-checks the main entry without Zod installed and without skipLibCheck', () => {
    // Its own directory and a copy of the package: from `work`, module resolution would walk up to work/node_modules/zod.
    const dir = mkdtempSync(join(tmpdir(), 'dynotable-orm-no-zod-'));
    onTestFinished(() => rmSync(dir, {recursive: true, force: true}));
    mkdirSync(join(dir, 'node_modules/@aws-sdk'), {recursive: true});
    cpSync(installed, join(dir, 'node_modules/dynotable-orm'), {recursive: true});
    for (const dep of ['@aws-sdk/client-dynamodb', '@aws-sdk/util-dynamodb', '@types']) {
      symlinkSync(realpathSync(join(pkgDir, 'node_modules', dep)), join(dir, 'node_modules', dep));
    }
    writeFileSync(
      join(dir, 'plain.ts'),
      "import {Condition} from 'dynotable-orm';\nexport const c = new Condition('id').eq(1);\n"
    );
    const tsc = join(pkgDir, 'node_modules/typescript/bin/tsc');
    const run = spawnSync(
      process.execPath,
      [tsc, '--noEmit', '--strict', '--module', 'nodenext', '--types', 'node', 'plain.ts'],
      {
        cwd: dir,
        encoding: 'utf8'
      }
    );
    expect(run.stdout + run.stderr).toBe('');
    expect(run.status).toBe(0);
  }, 60_000);
});

describe('release manifests', () => {
  const read = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8'));
  const published = ['packages/dynotable-orm/package.json', 'packages/codemod/package.json'].map(
    read
  );

  it('keeps the root manifest private and differently named', () => {
    const rootPkg = read('package.json');
    expect(rootPkg.private).toBe(true);
    expect(published.map((p) => p.name)).not.toContain(rootPkg.name);
  });

  it('builds on prepack and never forces provenance', () => {
    for (const p of published) {
      expect(p.scripts.prepack, p.name).toBe('pnpm build');
      expect(p.publishConfig, p.name).not.toHaveProperty('provenance');
    }
    expect(readdirSync(root)).not.toContain('.npmrc');
    expect(statSync(join(root, 'CHANGELOG.md')).isFile()).toBe(true);
  });

  // npm packs a LICENSE from the package directory only, never the repository root's.
  it('gives each package a copy of the root LICENSE', () => {
    const license = readFileSync(join(root, 'LICENSE'), 'utf8');
    for (const dir of ['packages/dynotable-orm', 'packages/codemod']) {
      expect(readFileSync(join(root, dir, 'LICENSE'), 'utf8'), dir).toBe(license);
    }
  });
});
