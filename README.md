# dynotable-orm: a TypeScript DynamoDB ORM and dynamoose alternative

A type-safe, fast DynamoDB ORM for TypeScript. Define each model with Zod or any Standard Schema, and keys,
updates, conditions and queries are typed from it. It reads and writes tables that dynamoose wrote, and a
codemod moves dynamoose code over.

- **dynamoose call shapes.** `get`, `create`, `update`, `query`, `scan`, conditions, transactions and batches
  keep the shapes you know. Your schema gives the types: keys, update paths, condition values, index names.
- **The same stored bytes.** Whole-item writes and top-level updates store the same bytes as dynamoose 4.2.0,
  apart from three top-level edge cases, as an equivalence suite checks on DynamoDB Local. An update of a
  nested path does not: dynamoose writes it
  as a top-level attribute named by the path. The known differences are in the
  [migration guide](docs/migration-from-dynamoose.md#allowlisted-differences).
- **Any Standard Schema validates.** The Zod 4 adapter adds keys, indexes, Date storage and per-path checks
  on updates. Refinements run on every whole-item write.
- **Fast.** In a CPU benchmark on a stub client (measured 2026-11-06), a create or update on a schema of
  about 60 attributes is 93 to 854 times faster than dynamoose 4.2.0, and as fast as hand-written AWS SDK
  code or faster. On a 5-attribute schema, hand-written SDK code is faster on some calls. On reads,
  dynamoose type-checks each attribute and dynotable-orm runs no check, so those numbers compare different
  work. See [benchmarks](docs/benchmarks.md).
- **A codemod** moves dynamoose code over and marks what it cannot move with a TODO.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/benchmark-order-dark.svg">
  <img alt="Bar chart, calls per second on a 60-attribute schema, higher is better. Create: dynotable-orm 23,300, hand-written AWS SDK 20,100, dynamoose 256. Get: dynotable-orm 107,000, hand-written AWS SDK 84,300, dynamoose 281. Update: dynotable-orm 69,400, hand-written AWS SDK 66,800, dynamoose 78.8. Query of 100 items: dynotable-orm 1,070, hand-written AWS SDK 836, dynamoose 3.76." src="docs/assets/benchmark-order-light.svg" width="800">
</picture>

| package                 | what it is                                          |
| ----------------------- | --------------------------------------------------- |
| `dynotable-orm`         | the library                                         |
| `dynotable-orm/zod`     | the Zod 4 adapter: field metadata and `extendZod()` |
| `dynotable-orm-codemod` | migrates dynamoose code and schemas                 |

Pre-release: the API may still change before 1.0.

## Install

```sh
npm install dynotable-orm @aws-sdk/client-dynamodb zod
```

Node 24 or later. `@aws-sdk/client-dynamodb` v3 is a peer dependency. `zod` (v4) is optional.

## 30-second example

```ts
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {model, setClient} from 'dynotable-orm';
import {extendZod} from 'dynotable-orm/zod';
import {z} from 'zod';

extendZod(z); // once, before you build a schema

setClient(new DynamoDBClient({region: 'eu-west-1'}));

export const User = model(
  'User',
  z.object({
    id: z.string().hashKey(),
    email: z.email().index({name: 'byEmail'}),
    plan: z.enum(['free', 'team']).default('free'),
    logins: z.number().default(0),
    createdAt: z.date().optional(),
    updatedAt: z.date().optional()
  }),
  {timestamps: true}
);

await User.create({id: 'u1', email: 'ada@example.com'});

const user = await User.get('u1'); // the item, or undefined

await User.update(
  {id: 'u1'},
  {plan: 'team', $ADD: {logins: 1}},
  {condition: User.condition().where('plan').eq('free')}
);

const found = await User.query('email').eq('ada@example.com').exec();
console.log(user?.plan, found.count);
```

`create` writes only when the key is not stored yet; pass `{overwrite: true}` to replace. `User.update` with
a wrong path or value type does not compile.

## Types from the schema

Define the shape of an item once, as a schema. You write no interface: `model()` infers every type of the
model from the schema and its marks. The same schema validates each whole-item write at runtime, and with
the Zod adapter each update too. When you change a field, the types and the validation change together.

```ts
import {
  model,
  type CreateInputOf,
  type ItemOf,
  type KeyInputOf,
  type UpdateInputOf
} from 'dynotable-orm';
import {extendZod} from 'dynotable-orm/zod';
import {z} from 'zod';

extendZod(z);

export const Task = model(
  'Task',
  z.object({
    projectId: z.string().hashKey(),
    taskId: z.string().rangeKey(),
    status: z.enum(['open', 'done']).default('open'),
    points: z.number().int()
  })
);

export type Task = ItemOf<typeof Task>; // {projectId: string; taskId: string; status: 'open' | 'done'; points: number}
export type TaskKey = KeyInputOf<typeof Task>; // {projectId: string; taskId: string}
export type TaskChanges = UpdateInputOf<typeof Task>; // each path with its value type, plus $SET, $ADD, ...
export type NewTask = CreateInputOf<typeof Task>; // status is optional here

const key: TaskKey = {projectId: 'p1', taskId: 't1'};
const draft: NewTask = {...key, points: 3};
await Task.create(draft);
const task: Task | undefined = await Task.get(key);
console.log(task?.status);

// @ts-expect-error: the key needs taskId, the range key
await Task.get({projectId: 'p1'});

// @ts-expect-error: points is a number
await Task.update(key, {points: '3'});
```

| type                      | what it is                                                                       |
| ------------------------- | -------------------------------------------------------------------------------- |
| `ItemOf<typeof M>`        | the item a read returns: the schema's output type, as `z.infer` gives it         |
| `KeyInputOf<typeof M>`    | the key `get`, `update` and `delete` take, from the hash key and range key marks |
| `UpdateInputOf<typeof M>` | what `update` takes: each path with its value type, and the update operators     |
| `CreateInputOf<typeof M>` | what `create` takes: a `Partial` of the schema's input type                      |

A write takes the schema's input type and a read returns its output type, so a `.default()` field is
optional on `create` and always present on a read. `timestamps: true` adds no field to the types: declare
`createdAt` and `updatedAt` in the schema. Without the Zod adapter, the item type still comes from the schema,
and the keys and indexes come from the model options. The
[Zod adapter docs](https://dynotable.com/orm/zod#types-from-the-schema) have the full rules.

## Migrate from dynamoose to TypeScript and Zod

The codemod rewrites dynamoose call sites and converts each dynamoose `Schema` to a Zod schema plus model
options. It marks what it cannot convert with a TODO comment.

```sh
npm install dynotable-orm @aws-sdk/client-dynamodb zod
npm install --save-dev dynotable-orm-codemod
npx dynotable-orm-codemod tsconfig.json --dry-run   # lists the files it would change
npx dynotable-orm-codemod tsconfig.json
```

The project must still resolve `dynamoose` when the codemod runs, so remove dynamoose after the last run.
Then fix each TODO, check the [Date storage](docs/migration-from-dynamoose.md#the-date-storage-trap) of
every model that reads an existing table, and run your type check and tests. The
[migration guide](docs/migration-from-dynamoose.md) lists every changed API.

## The Zod adapter

`dynotable-orm/zod` attaches DynamoDB metadata to Zod fields. Use the functions, or call `extendZod(z)` once
to get the same marks as methods. Each mark returns a new schema and never changes the one you pass.

```ts
import {model} from 'dynotable-orm';
import {hashKey, index, rangeKey, storage} from 'dynotable-orm/zod';
import {z} from 'zod';

export const Session = model(
  'Session',
  z.object({
    userId: hashKey(z.string()),
    startedAt: rangeKey(z.number()),
    device: index(z.string(), {name: 'byDevice', rangeKey: 'startedAt'}),
    expiresAt: storage(z.date(), 'seconds')
  })
);
```

You can also give the same settings as model options (`hashKey`, `rangeKey`, `indexes`, `dates`, `combine`).
A setting that a field and an option both give, with different values, throws a `ConfigError` at `model()`.
`getDynamoMeta(schema)` reads a field's metadata, for tools that build on your schemas.

`combine(z.string(), ['a', 'b'], '#')` makes a field the join of other fields, as dynamoose's `COMBINE`
type does. The separator defaults to `,`.

A schema from `z.compile()` (Zod 4.5 or later) works as a model schema and keeps its marks. Compile the
object after you mark its fields, because a mark returns a new, uncompiled schema.

## Model options

| option                | what it does                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| `hashKey`, `rangeKey` | the key attributes, unless a field marks them                                                            |
| `indexes`             | `{field: {name, type: 'global' \| 'local', rangeKey, project}}`, or an array of them                     |
| `dates`               | `{path: 'iso' \| 'milliseconds' \| 'seconds'}`: the storage of a Date path                               |
| `defaultDateStorage`  | the storage of every other Date, timestamps included. Default `'milliseconds'`, as dynamoose             |
| `combine`             | `{target: {sources, separator}}`                                                                         |
| `timestamps`          | `true`, or `{createdAt: {name, storage}, updatedAt: {name, storage}}`                                    |
| `set`                 | the whole-item hook, see the [migration guide](docs/migration-from-dynamoose.md#the-whole-item-set-hook) |
| `prefix`, `suffix`    | the table name is `${prefix}${name}${suffix}`; overrides `setDefaults()`                                 |
| `client`              | the `DynamoDBClient` of this model; overrides `setClient()`                                              |
| `unknownKeys`         | `'zod'` (default) or `'dynamoose'`, see [unknown keys](docs/migration-from-dynamoose.md#unknown-keys)    |

Without `setClient()` or a `client` option, the first call builds `new DynamoDBClient({})`, which reads
the region and credentials from the environment.

## The API

- `model(name, schema, options)` returns the model: `get`, `create`, `update`, `delete`, `query`, `scan`,
  `batchGet`, `batchPut`, `batchDelete`, `condition()`, `fromStored(raw)`, `withDefaults(item)`,
  `createTableInput()` and `extend(methods)`.
- `M.transaction.create`, `update`, `delete` and `condition` build the entries of `transaction([...])`.
- `setClient`, `getClient`, `setDefaults({prefix, suffix})`, `Condition`, `ifNotExists`,
  `isConditionalCheckFailed`, `orm` (the spy target for `transaction()`), and the errors `ConfigError`,
  `ExpressionError`, `ValidationError` and `MarshallError`.
- Every call takes a per-call `client` and `abortSignal` (queries and scans in `exec({…})`). A client that has the
  request's method (the SDK's aggregated `DynamoDB`) gets that method call, as dynamoose made it.

Dates are stored as epoch milliseconds, as dynamoose stores them, unless you set `defaultDateStorage` or a
field's storage (`'iso'`, `'milliseconds'` or `'seconds'`). A codebase whose items hold ISO strings sets
`defaultDateStorage: 'iso'` on each model: see the
[Date storage trap](docs/migration-from-dynamoose.md#the-date-storage-trap).

## Without Zod

Any [Standard Schema](https://standardschema.dev) validates whole items. Give the keys, indexes and Date
storage as model options. Without the adapter, updates are not checked against the schema (Standard Schema
can only validate a whole value), and keys and condition values are not transformed.

## Docs

The documentation site is [dynotable.com/orm](https://dynotable.com/orm):

- [Getting started](https://dynotable.com/orm/getting-started)
- [The Zod adapter](https://dynotable.com/orm/zod)
- [Migrating from dynamoose](https://dynotable.com/orm/migrate-from-dynamoose)
- [The codemod](https://dynotable.com/orm/codemod)
- [Benchmarks](https://dynotable.com/orm/benchmarks)
- [API reference](https://dynotable.com/orm/api-model)

In this repository: the [migration guide](docs/migration-from-dynamoose.md) and the
[benchmarks](docs/benchmarks.md). The TSDoc in the package types is the API reference too.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report a security issue as [SECURITY.md](SECURITY.md) says, not in a
public issue.

## License

MIT © DynoTable
