# dynamodb-orm — Dev Guide

pnpm workspace for `dynotable-orm` (core + `dynotable-orm/zod`, in `packages/dynotable-orm`) and `dynotable-orm-codemod` (`packages/codemod`). Public repo, MIT, owned by DynoTable (spell it exactly). User docs: `README.md`, `docs/migration-from-dynamoose.md`, `docs/benchmarks.md`.

## Commands (root)

```sh
pnpm lint              # oxlint
pnpm format            # oxfmt (pnpm check: verify only, as CI does)
pnpm typecheck         # tsc --noEmit per package
pnpm test              # unit + type tests, the snippet gate, the packed-tarball test; real network is blocked
pnpm test:integration  # needs DynamoDB Local on 127.0.0.1:8000:
                       #   docker run --rm -p 8000:8000 amazon/dynamodb-local:3.3.2
pnpm check:package     # build + publint + attw (--profile node16)
pnpm bench             # CPU benchmark on a stub client (builds dist, runs a bundle under plain node)
pnpm test:bench        # benchmark smoke + gate tests
pnpm equivalence:local # local mode only, see below
```

Run `pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm check:package` after every change. Run `pnpm test:integration` after any change to a write, read, update, query, transaction or batch path.

## Rules

- **Private-code boundary.** This repo is public. Never commit the schemas, model, table or service names, account ids, sampled items or test files of a private consumer codebase. CI fixtures are synthetic. Gitignored and never committed: `docs/plans/`, `.equivalence-local/`. Before a push, grep `git ls-files` for private names.
- **The oracle is dynamoose 4.2.0 from npm, pinned exactly in `devDependencies`.** Stored items must stay byte-identical to it, except for the entries in `equivalence/allowlist.ts`. Each entry cites a numbered difference (`D3: …`) of the migration guide's "Allowlisted differences" and the guide section that describes it (`tests/equivalence-guards.test.ts` checks both). Codemod fixtures import it as `@acme/dynamoose`, a stand-in for a scoped dynamoose package, which their tsconfig `paths` map to `dynamoose`. A private codebase's own dynamoose build is compared only in the local mode below, never in tracked files.
- **Equivalence first.** A behaviour change starts as a corpus case in `equivalence/corpus.ts` (or `update-corpus.ts`), run on both sides. An accepted difference needs an allowlist entry with a numbered reason and a guide section; a stale entry fails.
- **Expected test values are literals** from the DynamoDB API reference or from bytes dynamoose 4.2.0 produced. Never compute them with this lib's own code. No tautological or redundant tests.
- **Integration tests check raw stored items** (a raw SDK `GetItem`/`Scan`), not only what the lib returns. They use DynamoDB Local only; never point a test at real AWS.
- **Snippet gate.** Every `ts` block in `README.md` and the migration guide compiles (`tests/docs-snippets.test.ts`): lib blocks against the source entry points, dynamoose blocks against dynamoose 4.2.0's types. Any other fence language must be `sh` or `text`.
- **No import side effects.** Importing either entry point changes no global, prototype or env, and builds no client (`tests/plan.test.ts`). So `src/` never imports `zod` at runtime (it writes Zod globals): type imports only, and `extendZod(z)` takes the caller's Zod.
- **Fail loud** where dynamoose warns, guesses or sends an invalid request: `ConfigError` (model setup, or the first key/condition/query value whose field validates asynchronously), `ExpressionError` (paths, conditions, updates, keys, batches, transactions), `ValidationError` (schema), `MarshallError` (a value that cannot be stored). Only `update(item)` with a non-object throws a `TypeError`.
- **Release traps:** the root manifest stays private and named `dynotable-orm-workspace`; each package builds on `prepack` and ships `dist` + `README.md`; `provenance` lives only on the `release.yml` publish flag, never in `publishConfig` or `.npmrc`. `tests/package-exports.test.ts` guards them.
- **Release:** set the package's `version` and its `CHANGELOG.md` entry, then push a tag `<package-name>@<version>`; `release.yml` publishes that one package. Never publish by hand from an agent session.

## Benchmark gate

`pnpm bench --gate` (CI, every PR, `BASELINE` = the base commit's build). Gated rows: `create`, `get`, `update` on `order`. Pass = the whole 99% interval meets lib/raw ≤ 1.5× and dynamoose/lib ≥ 10× (dynamoose 4.2.0, pinned exactly), and no regression > 15% vs base (p < 0.01). A straddling interval reruns once, then fails. Method and numbers: `packages/dynotable-orm/benchmarks/README.md`, `docs/benchmarks.md`.

## Local modes (private consumer codebase)

Scripts that run a private consumer codebase against this lib. They write only to gitignored dirs (the codemod scripts refuse to start when theirs is not gitignored). Results stay in `.equivalence-local/`, and none is committed.

- **Equivalence local mode** (`packages/dynotable-orm/equivalence/local/`). `run.ts` (env `EQUIVALENCE_MODELS`, `EQUIVALENCE_INSTANCE`, `EQUIVALENCE_ORACLE`, `EQUIVALENCE_PROJECT`) writes a manifest; `pnpm equivalence:sample` reads those tables; a second `run.ts` compares every model on DynamoDB Local. `pnpm equivalence:local <samples file>` compares another sample set and writes `report-<file>.json` and `summary-<file>.md` into `.equivalence-local/` only. With `EQUIVALENCE_LIB_MODELS` (a module mapping a table name to `{schema, options}`), this lib's side of each model comes from the codebase as ported to this lib instead of from its dynamoose-built one.
  - The oracle is the codebase's own dynamoose build, not 4.2.0. `EQUIVALENCE_ORACLE` is the directory of that package (install it under `.equivalence-local/`, with its own `package.json` and `pnpm install --ignore-workspace`); `run.ts` stops when it is unset or is not the package `EQUIVALENCE_INSTANCE` resolves.
  - `run.ts` deletes every `AWS_*` env var, sets dummy credentials, and refuses a non-local endpoint.
  - `sample.ts` sends `Scan` only, in its own process, and stops unless the credentials' STS account equals `EQUIVALENCE_ACCOUNT`. Read-only credentials of a non-production account only.
- **Codemod dry runs** (`packages/codemod/scripts/`). `scratch-common.ts` (env `SOURCE_REPO`, `PORT_PATCH`) builds a migrated copy of a dependency codebase; `dry-run-local.ts` (env `SERVICES`, `DYNAMODB_ENDPOINT`) runs each consumer's `tsc` and tests before and after the codemod. They copy from each repo's origin default branch and never write to the source repos. Tests run with dummy AWS credentials and DynamoDB Local.
