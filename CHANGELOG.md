# Changelog

All notable changes to `dynotable-orm` and `dynotable-orm-codemod` are recorded here.

## 0.1.2

### dynotable-orm

- Docs only. The package description and README call the library a dynamoose alternative.
- The README speed claim covers create and update only. On reads, dynamoose type-checks each attribute and
  dynotable-orm runs no check, so those numbers compare different work.

## 0.1.1

### dynotable-orm

- A schema from Zod's `z.compile()` (Zod 4.5 or later) is supported as a model schema, with its field marks.
  A test now covers it.

### dynotable-orm-codemod

- No changes. Released with the library through the tag workflow.

## 0.1.0

The first release of both packages. Pre-release: the API may still change before 1.0.

### dynotable-orm

- `model(name, schema, options)` with `get`, `create`, `delete`, `update`, `query`, `scan`, conditions,
  `transaction()` and the batch methods, in dynamoose call shapes, typed from the schema.
- Whole-item writes and top-level updates store the same bytes as dynamoose 4.2.0, as checked on DynamoDB
  Local. An update of a nested path does not. The known differences are listed in the migration guide.
- A `Date` and the timestamps are stored as epoch milliseconds by default, as dynamoose stores them. A
  model with `defaultDateStorage: 'iso'` stores ISO strings.
- Any Standard Schema validates whole items. The Zod 4 adapter (`dynotable-orm/zod`) adds keys, indexes,
  `combine`, Date storage and per-path checks on updates; `extendZod(z)` adds them as Zod methods.
- Raw-SDK escape hatches: `{raw: true}`, `{rawKey: true}`, `{return: 'request'}` and a per-call `client` and
  `abortSignal` (on `get`, `create`, `update`, `delete` and `transaction()`), and
  `TransactionCanceledException` reasons with `CancellationReasons` kept.
- Batches send 100 keys or 25 items per request, retry unprocessed items up to 5 times with full-jitter
  backoff from 50 ms, and return what is still left.
- `.extend()` adds helpers to a model. `converter`, `toJSON`, `fromStored`, `createTableInput` and
  `isConditionalCheckFailed` replace the dynamoose helpers.
- Fails loud with `ConfigError`, `ExpressionError`, `ValidationError` and `MarshallError` where dynamoose
  warns or sends an invalid request.
- Importing the package has no side effects. Node 24 or later; ESM and CJS.

### dynotable-orm-codemod

- Rewrites dynamoose call sites to dynotable-orm, using the TypeScript type checker.
- Converts dynamoose `Schema` definitions to Zod schemas plus model options.
- `--source` for modules that re-export dynamoose, `--target` for the import to write, `--zod` for the
  module the converted schemas import Zod from, `--dry-run`. The same as a function:
  `migrate({tsconfig, sources, target, zod, dryRun})`.
- Marks what it cannot convert with a TODO comment; a second run makes no change.
