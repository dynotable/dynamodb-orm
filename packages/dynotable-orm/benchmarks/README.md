# Benchmarks

`bench.ts` measures the CPU cost of a call. Every contender sends its requests to the same stub client, which
returns canned responses and never leaves the process. So the numbers contain no network time.

## Running

```sh
# in packages/dynotable-orm
pnpm bench                       # 10 rounds of 200 ms
pnpm bench --rounds 20           # more rounds, for a tighter interval
pnpm bench --quick               # 2 rounds of 20 ms: checks the run, the numbers are noise
pnpm bench --json results.json   # also writes every round's samples
BASELINE=<base checkout>/packages/dynotable-orm pnpm bench --gate   # the CI gate, see below
pnpm test:bench                  # smoke.test.ts and gate.test.ts
pnpm bench:competitors           # local only: dynamoose, ElectroDB and dynamodb-toolbox in one run, see below
```

`pnpm bench` builds `dist` and bundles the benchmark to `.bench/`, then runs it under plain
`node --expose-gc`. A TypeScript loader such as `tsx` hooks every `require`, and dynamoose calls `require`
inline in its hot paths, so under a loader dynamoose looks slower than it is.

## Contenders

| name        | what it runs                                                                                        |
| ----------- | --------------------------------------------------------------------------------------------------- |
| `lib`       | this lib's built `dist`                                                                             |
| `raw`       | hand-written SDK code: a Zod `parse` of the same input plus `@aws-sdk/util-dynamodb` (`schemas.ts`) |
| `dynamoose` | dynamoose from npm, pinned exactly in devDependencies, the same calls (not on `update-nested`)      |
| `base`      | the `dist` in `BASELINE`, the same calls                                                            |

## Operations

Each schema (`order` and `small`, in `schemas.ts`) runs these calls. The canned responses are dynamoose's
own stored items.

| operation       | call                                                       | stub response                 |
| --------------- | ---------------------------------------------------------- | ----------------------------- |
| `create`        | `Model.create(data)`                                       | `PutItem`: `{}`               |
| `get`           | `Model.get(key)`                                           | `GetItem`: the stored item    |
| `update`        | `Model.update(key, {…top-level fields})`                   | `UpdateItem`: the stored item |
| `update-nested` | `Model.update(key, {$SET: {'a.b': value}})` (`order` only) | `UpdateItem`: the stored item |
| `query`         | `Model.query(field).eq(value).exec()` on a global index    | `Query`: 100 stored items     |

`smoke.test.ts` checks, before any timing means anything, that each write contender sends the literal
request (`Item`, `UpdateExpression`, the maps), that each read contender returns the expected items, and
that a run reports every schema × operation row for every contender.

`update-nested` has no `dynamoose` contender: dynamoose writes `{$SET: {'notification.status': value}}` as
one top-level attribute named `notification.status`, not as a change to the nested field. That is
different work, so it is not timed.

## Method

- Every contender warms up. Then each round measures each contender for a fixed time, with `gc()` before
  each measurement. The order of the contenders reverses every round.
- The inputs are made outside the timed part, in batches, so the timer is read once per batch.
- A contender's sample is its ops/s in one round. The table shows the median µs/op over the rounds.
- `lib/raw` is the lib's CPU over raw's, `dynamoose/lib` dynamoose's CPU over the lib's. Each is the median of the
  per-round ratios, with its 99% confidence interval in brackets (binomial order statistics; 8 rounds or
  more).

## CI gate

The `bench` job of `.github/workflows/ci.yml` runs on every pull request. It checks out the pull request and
`pull_request.base.sha` side by side, installs both, builds the base, then runs `pnpm bench --gate` with
`BASELINE` set to the base package. `--gate` refuses to run without `BASELINE`. When the base has no
`benchmarks/bench.ts` (the first pull request), the regression rule is skipped. The `ci` job runs
`pnpm test:bench` on every pull request and every push to `main`.

`--gate` runs 20 rounds of 150 ms. Only `create`, `get` and `update` on `order` are gated; every other row is
report only. A gated row passes when all three hold:

- **lib/raw ≤ 1.5×** over the whole 99% interval of the median ratio;
- **dynamoose/lib ≥ 10×** over the whole 99% interval;
- **no regression**: the lib's median ops/s is not more than 15% below the base's with p < 0.01 (one-sided
  Mann-Whitney U over the round samples).

An interval that straddles a target is too noisy to call. A row that does not pass runs again (20 new
rounds), and the gate fails when the re-run does not pass either. So a target never passes by default:
`--gate --quick` (2 rounds, too few for an interval) always fails. `BENCH_SCALE_CURRENT=<factor>` multiplies
the lib's samples, only so `gate.test.ts` can reach the failure path.

## Competitors (local only)

`competitors.local.ts` runs `small` through dynamoose, ElectroDB and dynamodb-toolbox (devDependencies)
beside the lib and raw, all five in one run, so their numbers compare. It is report only and not in CI.
ElectroDB and dynamodb-toolbox talk to a DocumentClient; their stub does the DocumentClient's own conversion
(it marshalls the input and unmarshalls the output), so every contender pays for it. Before timing, it checks that each competitor reads back the expected items. ElectroDB stores the
item in its own form (its key templates and entity attributes); dynamodb-toolbox runs with its entity
attribute and timestamps off.
