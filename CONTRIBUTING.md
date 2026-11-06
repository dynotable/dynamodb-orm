# Contributing

Thanks for helping. This file says how to run the checks that CI runs. Open an issue before a large change,
so we can agree on the shape first.

## Setup

You need Node 24 or later, pnpm (the version in the root `package.json` `packageManager` field) and Docker.

```sh
pnpm install
```

The repository is a pnpm workspace with two packages:

- `packages/dynotable-orm`: the library (`dynotable-orm` and `dynotable-orm/zod`).
- `packages/codemod`: `dynotable-orm-codemod`.

## The gate

Run this from the repository root after every change. CI runs the same steps, with `pnpm check` in place
of `pnpm format`.

```sh
pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm check:package
```

- `pnpm format` formats with oxfmt. `pnpm check` only verifies.
- `pnpm lint` runs oxlint.
- `pnpm typecheck` runs `tsc --noEmit` in each package.
- `pnpm test` runs the unit and type tests, the snippet gate (every `ts` block in `README.md` and the
  migration guide compiles) and the packed-tarball test. Tests cannot reach the network.
- `pnpm check:package` builds both packages and runs publint and attw.

## Integration tests and DynamoDB Local

Integration tests run against DynamoDB Local only. They never call real AWS. Start DynamoDB Local, then run
them:

```sh
docker run --rm -p 8000:8000 amazon/dynamodb-local:3.3.2
pnpm test:integration
```

When port 8000 is taken, map another port and set `DYNAMODB_LOCAL_ENDPOINT`:

```sh
docker run --rm -p 8127:8000 amazon/dynamodb-local:3.3.2
DYNAMODB_LOCAL_ENDPOINT=http://127.0.0.1:8127 pnpm test:integration
```

Run them after any change to a write, read, update, query, transaction or batch path. An integration test
checks the raw stored item (a raw SDK `GetItem` or `Scan`), not only what the library returns.

## The equivalence suite

The library stores the same bytes as dynamoose 4.2.0 from npm, which is pinned exactly in
`devDependencies`. The equivalence suite checks this on DynamoDB Local. It is part of
`pnpm test:integration` (`packages/dynotable-orm/tests/integration/equivalence.test.ts`).

- Each case in `packages/dynotable-orm/equivalence/corpus.ts` (and `update-corpus.ts`) runs on both
  libraries. The suite compares the stored items and what each library returns.
- A behaviour change starts as a corpus case.
- An accepted difference needs an entry in `equivalence/allowlist.ts`. Its `reason` starts with the
  number of a difference in the migration guide's "Allowlisted differences" (`D3: …`), and its `ref` names
  the guide section that describes it. A stale entry fails the suite.
- Expected values in tests are literals: from the DynamoDB API reference, or bytes that dynamoose 4.2.0
  produced. Never compute them with this library's own code.

## The benchmark gate

```sh
pnpm bench          # CPU benchmark on a stub client
pnpm test:bench     # the benchmark's smoke and gate tests
```

On every pull request, CI runs `pnpm bench --gate` against the build of the base commit. It gates
`create`, `get` and `update` on the `order` schema. A row passes when its whole 99% interval meets
lib/raw ≤ 1.5× (against hand-written SDK code) and dynamoose/lib ≥ 10× (against dynamoose 4.2.0), and the
library is not more than 15% slower than the base (p < 0.01). The method is in
`packages/dynotable-orm/benchmarks/README.md`, the latest numbers in `docs/benchmarks.md`.

To run the gate locally, check out the base commit in a second directory, build it, and point `BASELINE` at
its package:

```sh
BASELINE=<base checkout>/packages/dynotable-orm pnpm bench --gate
```

## Rules

- Importing either entry point has no side effects: it changes no global, prototype or env, and builds no
  client. `src/` never imports `zod` at run time.
- Fail loud with `ConfigError`, `ExpressionError`, `ValidationError` or `MarshallError` where dynamoose warns,
  guesses or sends an invalid request.
- Test fixtures are synthetic. Do not commit schemas, table names or items from a private codebase.

## Releases

A maintainer sets the package's `version` and its `CHANGELOG.md` entry, then pushes a tag
`<package-name>@<version>` (for example `dynotable-orm@0.2.0`). `.github/workflows/release.yml` publishes
that one package to npm with provenance.
