# Migrating from dynamoose

dynotable-orm keeps dynamoose 4.x's call shapes, and the stored bytes of whole items and top-level updates.
This guide lists what changes. The codemod does most of the work, and marks the rest with a TODO.

The stored bytes are checked against dynamoose 4.2.0 from npm. An update of a nested path does not store the
same item (see [Updates](#updates)), and a table whose Dates are not in milliseconds needs a setting (see
[the Date storage trap](#the-date-storage-trap)). Every known difference is in the
[allowlisted differences](#allowlisted-differences).

## What stays the same

- **Stored items.** For the same schema and input, a whole-item write (`create`, `save`, `batchPut`, a
  transaction put) and a top-level update store the same bytes as dynamoose 4.2.0. An equivalence suite writes
  each case through both libraries on DynamoDB Local, compares the raw items, and has each library read the
  other's items. An update of a nested path does not store the same item: dynamoose 4.2.0 writes `{$SET:
{'a.b': 1}}` as a top-level attribute named `a.b` (D3, D4 and D10 in the
  [allowlisted differences](#allowlisted-differences)). So a table that dynamoose code updated by nested paths
  can hold such attributes: look for them before you move. While old and new code share a table, make
  nested-path updates on one side only.
- **Table names.** `${prefix}${name}${suffix}`.
- **Call shapes.** `get(key)`, `create(item)`, `update(key, changes)` and `update(item)`, `delete(key)`, the
  query and scan chains, the `Condition` chain (with `ne`), raw `{ConditionExpression, …}` objects,
  `Model.transaction.*`, `batchGet`, `batchPut` and `batchDelete`. A model with only a hash key also takes a
  bare key: `User.get('u1')`.
- **Result fields.** Query results carry `lastKey`, `count`, `queriedCount` and `timesQueried`; scan results
  carry `scannedCount` and `timesScanned`.
- **`{return: 'request'}`** on `get`, `create`, `update`, `delete` and `transaction()` gives the SDK input
  instead of sending it. Queries and scans have no equivalent (see [Removed](#removed)).
- **Placeholders.** Expressions use dynamoose's numbering: one number per condition term and per update path
  name, `#aN_0.#aN_1` for a nested condition path, `:vN_1, :vN_2` for `in` and `between` values, the update
  after the condition. A test that pins the request text or parses it keeps passing. Where dynamoose sends a
  broken request (a condition on `list[0]` names an attribute called `list[0]`), this lib addresses the element.
- **Client calls.** A client that has the method of a request (the SDK's aggregated `DynamoDB` class, or a test
  stand-in) gets that method call, `ddb.getItem(input)`, as dynamoose made it. Any other client gets
  `send(new GetItemCommand(input))`. A spy on `ddb.getItem` and `mockClient(DynamoDB)` keep seeing the requests.

## Steps

1. Install `dynotable-orm`, `@aws-sdk/client-dynamodb` and `zod`, and the codemod as a dev dependency.
2. Run the codemod with `--dry-run`, then without it.
3. Fix each TODO it leaves.
4. Check the [Date storage](#the-date-storage-trap) of every model that reads an existing table.
5. Run your type check and your tests. Read [tests that change](#tests-that-change).

## The codemod

```sh
npm install --save-dev dynotable-orm-codemod
npx dynotable-orm-codemod tsconfig.json --dry-run   # lists the files it would change
npx dynotable-orm-codemod tsconfig.json
```

It rewrites the files of the TypeScript project you name. It uses the type checker, so the project must
resolve `dynamoose` and its types when you run it: remove dynamoose only after the last run. A second run
makes no change.

- `--source <module>` adds a module that re-exports dynamoose, for example your own wrapper package. Repeat
  it for each one. `dynamoose` and any scoped dynamoose package (`@<scope>/dynamoose`) are always sources.
- `--target <module>` is the module the rewritten code imports from. The default is `dynotable-orm`. When your
  wrapper will re-export dynotable-orm, name the wrapper, so call sites keep their import:

```sh
npx dynotable-orm-codemod tsconfig.json --source @acme/db --target @acme/db
```

- `--zod <module>` is the module the converted schemas read Zod from, for a project that allows Zod only through
  its own module. Each Zod import the codemod adds is then `import * as z from '<module>'`, not
  `import {z} from 'zod'`. A file that already imports `z` from that module keeps its import. A file whose `z` is
  something else gets a TODO.

```sh
npx dynotable-orm-codemod tsconfig.json --zod @acme/shared/zod
```

The exit code is 0 when nothing is left to do, 1 when a TODO is left, and 2 for a bad command line. Each
TODO is a comment above the statement, and the run lists them all:

```text
// TODO(dynotable-orm-codemod): transaction get has no equivalent: read the item with get() or batchGet()
```

The run also lists direct imports of the DynamoDB SDK. Where the reason for one is known, it names the
dynotable-orm feature that replaces it.

### What it converts

A dynamoose model:

```ts
import dynamoose from 'dynamoose';

const userSchema = new dynamoose.Schema(
  {
    id: {type: String, hashKey: true},
    email: {type: String, required: true, index: {name: 'byEmail'}},
    plan: {type: String, enum: ['free', 'team'], default: 'free'},
    tags: {type: Set, schema: [String]},
    lastSeen: Date
  },
  {timestamps: true}
);

export const User = dynamoose.model('User', userSchema);

export async function rename(id: string, email: string) {
  const user = await User.get({id});
  if (!user) return undefined;
  user.email = email;
  await user.save();
  return user.toJSON();
}
```

becomes:

```ts
import {model, toJSON} from 'dynotable-orm';
import {z} from 'zod';

const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  plan: z.enum(['free', 'team']).default('free'),
  tags: z.set(z.string()).optional(),
  lastSeen: z.date().optional(),
  createdAt: z.date().optional(),
  updatedAt: z.date().optional()
});
const userOptions = {
  hashKey: 'id',
  indexes: {email: {name: 'byEmail'}},
  timestamps: true
} as const;

export const User = model('User', userSchema, userOptions);

export async function rename(id: string, email: string) {
  const user = await User.get({id});
  if (!user) return undefined;
  user.email = email;
  await User.create(user, {overwrite: true, keepCreatedAt: true});
  return toJSON(user);
}
```

The schema conversion:

- keeps each Date's storage: milliseconds is the default on both sides, so only a `seconds` or `iso`
  attribute gets a `dates` entry (a timestamp gets its own `storage`);
- declares the timestamp fields and the combine targets in the Zod shape, so Zod keeps them;
- always names the hash key: the marked attribute, else the first one (dynamoose's default);
- converts Sets, Buffers, nested objects and arrays, multiple types, `saveUnknown`, keys, indexes,
  `default`, `required`, `enum` (a list of literals, or `Object.values()` of a string enum, which becomes
  `z.enum(E)`), `validate`, `dynamoose.type.NULL` and `dynamoose.type.COMBINE`;
- leaves a schema whole, with a TODO, when any part of it does not convert: `get` and `set` modifiers, custom
  types, a schemaless `Array`, a `saveUnknown` pattern other than `true`, `'**'` or `'<Object attribute>.**'`,
  a `default` that returns a Promise (a Zod default is synchronous), a `validate` function on a Date (dynamoose
  gives it the stored number or string, a refinement gets the Date), `required: true` with a `default`
  (dynamoose refuses an update that sets the attribute to `undefined`, or that removes it when the default is
  falsy, and writes a truthy default on a remove; a Zod default allows both),
  a `required` other than a literal `true` or `false`, a Date `default` that gives no Date, such as
  `Date.now` (dynamoose stores the number it gives; a `z.date()` default must give a Date),
  and table settings other than `prefix`, `suffix`, `create` and `waitForActive`. A model whose schema is
  imported from another file also gets a TODO;
- drops an index's `throughput`, without a TODO: only table creation reads it, and the lib creates no table;
- converts a Set attribute to `z.set()`, which takes only a Set. dynamoose also takes an array for a Set on
  `create` and `$SET`. Pass a Set there (`new Set(array)`); `$ADD` and `$DELETE` still take an array.

The call-site transforms:

- move the dynamoose names of an import to `--target`, and keep its other names on the source module. A
  project module that exports dynamoose itself (`export const dynamoose = …`) counts as a source for that
  name, so `import {dynamoose} from '../utils/dynamoose'` converts without a `--source`;
- turn each `dynamoose.X` member into a named import (`Condition`, `transaction`, `setClient`, …);
- rewrite `item.save()` only where the model is certain: `new M(...).save()` and `x.save()` on a
  `const x = new M(...)` of the same function become `M.create(x, {overwrite: true})`; `x.save()` on a
  `const x = await M.get(...)` (or `await M.<method>(…)` whose type is `M`'s item, the type `M.get` resolves to)
  of the same function also gets `keepCreatedAt: true`. `M` must be a const or an import that no other binding hides at the call. Every
  other item gets a TODO: one from destructuring, a loop, a branch or a fallback, a `let`, a parameter, a
  callback or a query result, and a model held by a `let`, a parameter or an object's property. `item?.save()` becomes
  `(item == null ? undefined : M.create(item, …))`;
- convert `M.methods.set('name', fn)` to `.extend({name() {…}})`, with the model in the body replaced by
  `this`. An arrow function becomes a method first; a `this` parameter goes (`extend()` types `this`). A call that is not a top-level statement (in a branch or a
  function), that passes a const declared after the model, that sets a name set before on the same model, or
  whose function takes a callback as its last parameter (typed as a function, an optional one too, or called in
  the body), gets a TODO;
- rewrite test shapes that treat an item as an instance of its model: `expect.any(M)` and `toBeInstanceOf(M)`
  become `Object`; `spyOn(item, 'save')` and `spyOn(M.prototype, 'save')` become `spyOn(M, 'create')`, where
  every value assigned to `item` comes from one model; `spyOn(M.prototype, 'withDefaults')` becomes
  `spyOn(M, 'withDefaults')`; `spyOn(dynamoose, 'transaction')` becomes `spyOn(orm, 'transaction')`, and
  `dynamoose.transaction` used as a value (`expect(dynamoose.transaction)`) becomes `orm.transaction`;
- rewrite `x.withDefaults()` to `M.withDefaults(x)`, where every value assigned to `x` comes from one model;
- rewrite `dynamoose.aws.ddb.revert()` to `setClient()`, `dynamoose.aws.ddb` held as a value (also through a
  cast) to a function with `set` and `revert`, `new dynamoose.aws.ddb.DynamoDB(…)` to the SDK's `DynamoDB`, and
  `dynamoose.type.UNDEFINED` to `undefined` (an update removes the attribute);
- drop `extends Item` from a class without a constructor or an interface, with its `dynamoose/dist/Item` import;
- rewrite the rest of the [changed APIs](#changed-apis).

These get a TODO: transaction `get`, `dynamoose.type.*` (except `NULL` and `COMBINE` in a schema, and
`UNDEFINED`),
`populate`, `serializer`, a `batchGet`/`batchPut`/`batchDelete` with a `return` setting (dynotable-orm has no request-only batch), a call that passes a callback (a model method or `transaction(items, callback)`), `e.code === 'ConditionalCheckFailedException'` (the SDK
error has no `code`), `toJSON()` after an optional chain that starts before it (`a?.b.toJSON()`), `conformToSchema` on a value not typed as a record of `AttributeValue` (`fromStored` takes
only a stored item), deep type imports with other type parameters (`ModelType`, `Item` other than as a base, `Query<T>`), an
`import type` of `z` or of a dynotable-orm name whose value the rewritten code needs, and any shape it does not
know.

A name the codemod imports that the file already uses for its own binding is imported as `orm<Name>`
(`toJSON as ormToJSON`). When the file uses `orm<Name>` too, or already declares the type a deep import
becomes (in any scope that holds a use of the import), the use gets a TODO. A schema's options const is `<name>Options` (`fooSchema` → `fooOptions`), or
`<schema>Options`; when another binding or another schema's options hold both names, the schema gets a TODO.
The converted schemas read Zod through `z`: an `import * as z` or `import {z}` from `zod`, else a new
`import {z}`. When `z` is bound to anything else, even another export of `zod`, they get a TODO. An
`instanceof ConditionalCheckFailedException` that gets a TODO keeps its SDK import.

## Changed APIs

| dynamoose                                              | dynotable-orm                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `new dynamoose.Schema(def, settings)`                  | a Zod object (or any Standard Schema) plus model options                       |
| `dynamoose.model(name, schema)`                        | `model(name, schema, options)`                                                 |
| `dynamoose.X`                                          | named imports: `Condition`, `transaction`, `setClient`, `converter`, …         |
| `dynamoose.aws.ddb()`, `dynamoose.aws.ddb.set(client)` | `getClient()`, `setClient(client)`                                             |
| `dynamoose.aws.ddb.revert()`                           | `setClient()`: the next call gets a new default client                         |
| `vi.spyOn(dynamoose, 'transaction')`                   | `vi.spyOn(orm, 'transaction')`: `transaction()` calls go through `orm`         |
| `dynamoose.aws.converter()`                            | `converter`: `marshall`, `unmarshall`, `convertToAttr` with the SDK's options  |
| `dynamoose.Table.defaults.set({prefix, suffix})`       | `setDefaults({prefix, suffix})`                                                |
| `new M(obj)`                                           | a deep copy typed as the item, with a non-enumerable `toJSON`. Nothing is sent |
| `item.save()`                                          | `M.create(item, {overwrite: true})`, plus `keepCreatedAt: true` for a read     |
| `item.toJSON()`                                        | `toJSON(item)`                                                                 |
| `item.withDefaults()`                                  | `M.withDefaults(item)`: a copy with the missing defaults, unchecked, sync      |
| `new M(raw).conformToSchema({type: 'fromDynamo'})`     | `M.fromStored(raw)`, synchronous                                               |
| `M.methods.set(name, fn)`                              | `M.extend({name() {…}})`, see [extend()](#extend)                              |
| `M.table().name`                                       | `M.tableName`                                                                  |
| `M.table().hashKey`, `M.table().rangeKey`              | `M.hashKey`, `M.rangeKey` (attribute names)                                    |
| `M.table().create({return: 'request'})`                | `M.createTableInput()` (on-demand billing)                                     |
| `new dynamoose.Condition(…)` passed to a model         | `M.condition()…`, typed from the schema                                        |
| `InstanceType<typeof dynamoose.Condition>`             | `Condition`                                                                    |
| `e instanceof ConditionalCheckFailedException`         | `isConditionalCheckFailed(e)`                                                  |
| deep imports from `dynamoose/dist/*`                   | the exported types: `QueryResponse<T>`, `UpdateOptions`, `ItemOf<M>`, …        |

## Removed

- **Item instances.** An item is a plain object (with a non-enumerable `toJSON`, see [tests that change](#tests-that-change)): there is no `item.save()`, `item.delete()` (use
  `M.delete(key)`), `item.original()` or `item.populate()`.
- **Callbacks.** Every method returns a Promise.
- **`populate` and serializers.**
- **`dynamoose.type.*`.** Declare the field in the schema. `COMBINE` becomes the `combine` option.
- **Attribute `get` and `set` modifiers, and `forceDefault`.** A Zod transform does the work of a `set`
  modifier, and it runs on keys and condition values too. Nothing transforms a value on read: a field whose
  transform returns another type (`z.date().transform((d) => d.toISOString())`) reads back as stored, not as a
  `Date`. A transform piped into an output schema (`.transform(f).pipe(schema)`) reads back as that output
  schema describes it. On a create, a `.default()` at any depth goes through the field's checks and transforms
  before it is stored, as a dynamoose default goes through its `set` modifier. As in dynamoose, a null takes the
  default too where the field accepts null (`z.string().nullable().default('new')`), unlike a plain Zod parse; an
  update writes the null as given.
- **Transaction `get`.** Read with `get()` or `batchGet()`.
- **`query(…).getRequest()` and `scan(…).getRequest()`.** Queries and scans have no `{return: 'request'}`.
- **Table management.** The lib never creates or changes a table: the `create`, `update` and
  `waitForActive` settings are gone. Pass `M.createTableInput()` to your own `CreateTable` call.
- **The first attribute as the default hash key.** A model must name its hash key, by a model option or a
  `hashKey()` mark, or `model()` throws a `ConfigError`.

## The Date storage trap

dynamoose and dynotable-orm both store a `Date` as a number of milliseconds by default, timestamps included.
A table written with another storage needs a setting. Without one, a model writes numbers next to the old
strings. On read, a stored value whose type does not match the path's storage is returned as stored: an old
item gives a string where the type says `Date`. Nothing throws; dynamoose 4.2.0 rejects such a read (D11).

Set the storage for the whole model with `defaultDateStorage`, or per field with `dates` or a `storage()`
mark. Timestamps follow `defaultDateStorage` unless their own `storage` says otherwise. A codebase whose
items hold ISO strings (for example, written through its own Zod→dynamoose converter that marks every Date
`iso`) sets `defaultDateStorage: 'iso'` on each model.

```ts
import {model} from 'dynotable-orm';
import {z} from 'zod';

export const Payment = model(
  'Payment',
  z.object({
    id: z.string(),
    paidAt: z.date(),
    dueAt: z.date().optional(),
    createdAt: z.date().optional(),
    updatedAt: z.date().optional()
  }),
  {
    hashKey: 'id',
    timestamps: true,
    defaultDateStorage: 'iso', // the table holds ISO strings
    dates: {dueAt: 'seconds'} // an attribute declared with storage: 'seconds'
  }
);
```

The codemod reads each attribute's storage from the dynamoose schema, so its output needs no
`defaultDateStorage`. As in dynamoose, a timestamp whose field is a number stores milliseconds, a
timestamp in seconds is rounded down, and a Date attribute in seconds is rounded to the nearest second. A
number timestamp with a `storage` setting throws a `ConfigError` at `model()`: it is always milliseconds.

A `storage` mark also works inside a list, a record value or a union option:
`z.array(z.object({at: storage(z.date(), 'seconds')}))` stores each `at` in seconds.

## Timestamps

`timestamps: true`, or `{createdAt: {name, storage}, updatedAt: {name, storage}}`.

- **Declare the timestamp fields in the schema.** The lib sets their values, so a value from `.default()` is
  discarded, and they are not validated, as in dynamoose. With the Zod adapter a field can be required
  (`createdAt: z.date()`), so the item type keeps it required; a required field that takes no `Date` (no number,
  for a number field) throws a `ConfigError` at `model()`. With another Standard Schema, make them optional: a
  required one fails the first write.
- `createdAt` is set on `create`, and replaces a value the input carries. `create(item, {keepCreatedAt:
true})` keeps the input's value: use it to write back an item you read, as `item.save()` did.
- `updatedAt` is set on every write. So on a model with timestamps, `update(key, {})` only sets `updatedAt`.
  An `updatedAt` in the changes is ignored: an item you read and write back (`update(item)`) gets a new stamp.
  dynamoose writes both values, and DynamoDB rejects the update.
- Timestamp fields are not validated, as in dynamoose.

## Updates

```ts
import {ifNotExists, model} from 'dynotable-orm';
import {z} from 'zod';

const Cart = model(
  'Cart',
  z.object({
    id: z.string(),
    tags: z.set(z.string()).optional(),
    lines: z.array(z.string()).optional(),
    total: z.number().optional(),
    note: z.string().optional(),
    openedAt: z.date().optional()
  }),
  {hashKey: 'id'}
);

await Cart.update(
  {id: 'c1'},
  {
    note: 'gift', // a plain field is a $SET
    $ADD: {tags: ['sale'], lines: ['sku-1'], total: 5}, // Set elements, a list append, a number
    $SET: {openedAt: ifNotExists(new Date())}
  }
);
await Cart.update({id: 'c1'}, {$REMOVE: {note: null}}); // or $REMOVE: ['note']
```

- **`$ADD` with an array** is allowed on a Set field (the elements are added) and on a list field (they are
  appended). dynamoose accepts this at runtime; now the types do too.
- `$ADD` and `$DELETE` on a Set field need a Set or an array. A bare element throws.
- **`ifNotExists(value)`** in a `$SET` writes the value only when the attribute is not stored yet. It is
  refused on a combine source: the stored value may stay, so the combined attribute cannot be computed.
- An update that writes one path twice, or a path and a path inside it (`meta` and `meta.n`), throws an
  `ExpressionError`. DynamoDB rejects it.
- With the Zod adapter, each `$SET` value is checked against its field's schema, and transformed by it. As
  in dynamoose, a `$SET` of a parent writes it without the defaults of the nested fields it leaves out. Each
  element a `$ADD` appends to a list is checked against the list's element schema (the input element, for a list with a transform), and its undeclared keys
  are dropped. As in dynamoose, it is then stored as given: its transforms and defaults do not run. A number or Set operand of `$ADD` or `$DELETE` is a delta, so it is not checked. A
  refinement on the whole item does not run on an update.
- **A nested path changes the nested field.** `$SET`, `$ADD`, `$DELETE` and `$REMOVE` of `a.b` change `b`
  inside `a`, and a nested `Date` is stored in the storage of its path. dynamoose 4.2.0 writes or removes a
  top-level attribute named `a.b` instead (D3, D4), and rejects a nested `Date` (D5) or a key inside a list
  element (D6).
- **A nested value is checked** against its field: enum, `validate`, type (D7). dynamoose 4.2.0 checks
  nothing there. A nested write under a parent with its own check or transform is refused: write the whole
  parent. An undeclared nested key is dropped (D8). A truthy default that replaces a nested `$REMOVE` is
  checked, transformed and passed to the `set` hook as a `$SET` of it; a top-level one is written as given, as
  in dynamoose. A falsy default is not written, so its checks do not run on a remove.
- Without the Zod adapter, updates are not checked against the schema. Standard Schema can only validate a
  whole value.
- An update with nothing to write throws an `ExpressionError` before sending. dynamoose sends an empty
  expression, which DynamoDB rejects.
- An update that writes none of a combine attribute's sources keeps the combine attribute as stored.
  dynamoose 4.2.0 refuses it (D9).
- `returnValues` takes all five DynamoDB values.

## Conditions

```ts
import {Condition, model} from 'dynotable-orm';
import {z} from 'zod';

const Invoice = model(
  'Invoice',
  z.object({id: z.string(), status: z.string(), dueAt: z.date(), lines: z.array(z.string())}),
  {hashKey: 'id'}
);

// A Date is converted to the path's storage: here, a number of milliseconds.
await Invoice.update(
  {id: 'i1'},
  {status: 'late'},
  {condition: Invoice.condition().where('dueAt').lt(new Date()).and().where('status').ne('paid')}
);

// Lists and maps compare as whole values.
await Invoice.delete({id: 'i1'}, {condition: new Condition('lines').eq(['a', 'b'])});
```

- **A `Date` is now allowed** in a condition or a query. It is converted to the path's stored form.
  dynamoose throws "Unsupported type passed" there. Stored-form values (ISO strings, epoch numbers) still
  work.
- **List and map equality** compares marshalled values, so an equal list in another order does not match.
- `attributeExists()` and `attributeNotExists()` are in the chain. The object form `{x: {exists: false}}`
  renders `attribute_not_exists`; dynamoose rendered `attribute_exists` for it.
- `M.condition()` is typed from the schema: an unknown key or a wrong value type does not compile. A
  `new Condition(…)` is checked against the model when the request is built, and an unknown key throws.
- These throw an `ExpressionError` before sending. dynamoose 4.2.0 sends something else:
  - an `undefined` value: dynamoose warns, and sends a placeholder with no value;
  - a `where()` with no comparison: dynamoose sends no condition at all;
  - an empty group, or `in()` with an empty array: dynamoose sends `AND ()` or `IN ()`;
  - an object form with two operators (`{n: {gt: 1, lt: 5}}`): dynamoose reads it as `gt` alone. Chain them
    instead;
  - a `not()` before `where()`, or at the end of the chain: dynamoose drops it, so the condition tests the
    opposite. Write `where('n').not().eq(1)`.
- `in()` without an array and an unknown operator in the object form throw an `ExpressionError`. dynamoose
  4.2.0 throws its own error there (a `TypeError`, an `InvalidFilterComparison`).
- A raw condition's placeholders must start with `#` (names) or `:` (values). Its plain values
  (`{':n': 100}`) are marshalled, as dynamoose does; `AttributeValue`s pass as given.
- **`returnValuesOnConditionCheckFailure: 'ALL_OLD'`** on `create`, `update`, `delete` and every
  `M.transaction.*` entry (`M.transaction.condition(key, condition, options)`) asks DynamoDB for the stored item
  when the condition fails. The SDK error is thrown with its class unchanged, and carries that item, read as
  `get` reads it, in `error.item`. A canceled `transaction()` carries one per entry in `error.items`
  (`undefined` for an entry with no item), each read by its model; an item of a raw entry is unmarshalled only.

## The whole-item set hook

The `set` model option replaces dynamoose's schema-level `set` setting. It takes an object and returns the
object to store.

- On a whole-item write it gets the stored-form item: validated, Dates in their stored form, timestamps set.
- On an update it runs once per `$SET` path, on the value wrapped in objects (`{meta: {name: 'x'}}` for
  `meta.name`); the value is read back from its output. A value the hook drops becomes a `$REMOVE`.
- On a key it runs once, on the whole key (`{id, sk}`), so it can read every key attribute. A key attribute
  the hook drops throws an `ExpressionError`.
- On a condition value it runs once per top-level attribute.
- It gets a deep copy, so changing its argument never changes your input.

## Unknown keys

Undeclared keys are dropped on write and on read, at every depth, except where the schema opens an object.
The `unknownKeys` option chooses which schemas open one:

- **`'zod'` (the default)** follows Zod. A `z.looseObject()` or `.catchall()` keeps its unknown keys. A
  `z.record()` keeps its own entries, and its siblings' unknown keys are dropped. A `z.object()` drops them.
  A `z.strictObject()` rejects them with a `ValidationError`.
- **`'dynamoose'`** follows the rule of a Zod→dynamoose converter that writes `saveUnknown`: a `z.record()`,
  `z.any()` or `z.custom()` field opens its parent object at every depth below it (`parent.**`), and a
  `z.looseObject()` or `.catchall()` is closed. A `$SET` value or an element a `$ADD` appends keeps the
  unknown keys of an opened object and drops those of a closed one, as a whole-item write does.

The codemod writes a `saveUnknown` schema for the default mode: the opened objects become `z.looseObject()`.
Use `'dynamoose'` when you convert schemas yourself from code that already maps Zod to dynamoose. In both
modes, a top-level `$SET` of an undeclared attribute is dropped, as in dynamoose. Without the Zod adapter,
reads keep every stored attribute.

To write an undeclared top-level attribute on purpose (a lease or a lock the schema does not model), pass
`{allowUndeclared: true}` to `update`. Its changes are then untyped, and each undeclared attribute is written as
given: no check, Dates in the default storage. A condition on it takes a raw condition object, `$REMOVE`
removes it without the option, and `get(key, {raw: true})` reads it. Declaring the field in the schema is
the better fix when you can change the schema.

```ts
import {model} from 'dynotable-orm';
import {z} from 'zod';

const Member = model('Member', z.object({id: z.string()}), {hashKey: 'id'});
const now = Date.now();
await Member.update(
  {id: 'm1'},
  {lockedUntil: now + 60_000},
  {
    allowUndeclared: true,
    condition: {
      ConditionExpression: 'attribute_not_exists(#lock) OR #lock < :now',
      ExpressionAttributeNames: {'#lock': 'lockedUntil'},
      ExpressionAttributeValues: {':now': {N: String(now)}}
    }
  }
);
```

## extend()

`M.extend({...})` replaces `M.methods.set()`.

```ts
import {model} from 'dynotable-orm';
import {z} from 'zod';

export const Account = model('Account', z.object({id: z.string(), email: z.string()}), {
  hashKey: 'id'
}).extend({
  async mustGet(id: string) {
    const account = await this.get(id);
    if (!account) throw new Error(`${this.name} ${id} not found`);
    return account;
  }
});

const ids = ['a1', 'a2'];
await Promise.all(ids.map(Account.mustGet)); // methods are bound to the model
```

- `this` is the model, with its types and the other methods.
- `extend()` adds the methods to the model and returns the same model.
- Each method is bound to the model, so you can pass it as a callback.
- A later `extend()` replaces a method an earlier one added, as `methods.set` does. A built-in name (`get`,
  `query`, …) throws a `ConfigError`.
- A method is called as written. It gets no callback argument, and a synchronous method is not wrapped in a
  Promise.

## Queries and scans

- **`queriedCount` is DynamoDB's `ScannedCount`.** dynamoose reads a `QueriedCount` field that DynamoDB never
  returns, so its `queriedCount` is always `undefined`.
- A query with no equality on a hash key throws before sending, as in dynamoose 4.2.0 ("Index can't be found
  for query.").
- These throw before sending, where dynamoose 4.2.0 sends an invalid request or crashes: key conditions under
  an `or()` (a `TypeError`), `using()` of an undeclared index (sent as named) or of an index without an equality
  on its hash key (sent with no key condition), and `parallel()` on a query (a `TypeError`). `sort()` on a scan
  does not compile.
- `attributes([...])` narrows the item type to the named fields. A list whose names are not known at compile
  time (a `string[]`) types each item as a `Partial` of the item.
- `consistent()` and `count()` turn their setting on. They do not toggle it.
- `all(delay)` waits only before each next page.
- When a global and a local index both fit the conditions, the global one is chosen.
- `exec({client, abortSignal})` sets the client and the abort signal of every request of that call. Without
  them, `query` and `scan` use the model's client or `setClient()`.
- `startAt({})` and `startAt(undefined)` start at the beginning. A `parallel()` scan's `lastKey` can be an
  array, one key per unfinished segment (its type says so; a plain scan's `lastKey` is one key). `startAt()`
  does not take it, because one request takes one key.

## Transactions

```ts
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {model, transaction} from 'dynotable-orm';
import {z} from 'zod';

const Stock = model('Stock', z.object({sku: z.string(), count: z.number()}), {hashKey: 'sku'});

try {
  await transaction(
    [
      Stock.transaction.update({sku: 'a'}, {$ADD: {count: -1}}),
      Stock.transaction.create({sku: 'b', count: 1})
    ],
    {client: new DynamoDBClient({region: 'eu-west-1'})}
  );
} catch (e) {
  // The SDK error, unchanged (CancellationReasons included), with `reasons`: one code per entry.
  console.log((e as {reasons?: string[]}).reasons); // e.g. ['ConditionalCheckFailed', 'None']
}
```

- `M.transaction.create`, `update`, `delete` and `condition` return a Promise of the raw
  `{Put}`/`{Update}`/`{Delete}`/`{ConditionCheck}` object, as in dynamoose. `transaction([...])` takes them
  mixed with raw `TransactItems`.
- `transaction()` resolves to `undefined`. dynamoose resolves to `null`.
- `transaction()` uses its own `client` option, else `getClient()`. A model's `client` option does not reach
  it, because the entries are raw objects.
- It throws an `ExpressionError` before sending for no entries or more than 100, or for two model entries on
  one key. A raw `{Put}` does not say which attributes are its key, so it is not in that check.
- `M.transaction.condition(key, condition)` with an empty condition throws: DynamoDB rejects a
  `ConditionCheck` without one.

## Batches

- `batchGet` keeps the order of the keys. With `attributes`, it also reads the key attributes, so each item
  can take its place. dynamoose drops an item whose key it did not read.
- `batchPut` checks every item before it sends anything. A failed check rejects the call.
- Keys and items DynamoDB leaves unprocessed are sent again with backoff. Those left at the end do not throw:
  `batchGet` returns them in `.unprocessedKeys`, as stored keys; `batchPut` in `unprocessedItems`, as the items
  you passed, so you can pass them again; `batchDelete` in `unprocessedItems`, as stored keys.
- An SDK error rejects the call. Two equal keys throw an `ExpressionError` before sending.
- Each `BatchGetItem` reads up to 100 keys and each `BatchWriteItem` writes up to 25 items; the requests
  run in parallel. What is left unprocessed is sent again up to 5 times, after a full-jitter exponential
  backoff from 50 ms. The model option `batchRetries` sets how many times; `batchRetries: 0` returns it at
  once, as dynamoose does (for code that retries on its own).
- `batchGet(keys, {client, abortSignal})`, `batchPut(items, {…})` and `batchDelete(keys, {…})` take a per-call
  client and abort signal. Without them, they use the model's client or `setClient()`.

## Stricter checks

dynotable-orm throws where dynamoose skipped, warned or sent a bad request.

- **Whole-item validation.** Every write of a whole item runs the full schema, with its refinements and
  formats such as `z.uuid()`. So old data or test fixtures that dynamoose stored can fail when you write them
  again. Fix the data, or loosen the schema (for example `z.guid()` for ids that are not RFC UUIDs).
- **Paths.** An empty name (`a..b`, `.a`, `a.`), `a.b[0]c`, `[0].a`, and a `__proto__`, `constructor` or
  `prototype` segment throw. In an update, dynamoose 4.2.0 writes `a.` and `a.b[0]c` as top-level attributes
  and throws a `TypeError` on `a..b`, `.a` and `[0].a`. In a condition, it splits each path at its dots and
  sends the parts as written, an empty name too.
- **Values.** `NaN`, `Infinity` and numbers outside the safe integer range throw, as in dynamoose. A `Map`, a
  function, a class instance, an empty Set and a Set of mixed types throw. A stored integer too large for a
  number reads as a `bigint`, and a `bigint` is written as a number, so an item you read can be written back.
  Bytes read as a `Buffer`.
- **Undeclared fields.** With the Zod adapter, a hash key, range key, index field or combine field that the
  schema does not declare throws a `ConfigError` at `model()`: Zod would strip it.
- **Write types.** `create`, `new M()`, `batchPut`, `transaction.create` and the values of `update` take the
  schema's input type, and `$REMOVE` takes only declared paths.
- **Errors.** A schema failure is a `ValidationError` with `issues` and `path`. A value outside an enum and a
  value of the wrong type keep dynamoose's message (`status must equal ["A","B"], but is set to C`,
  `Expected n to be of type number, instead found type string.`), though the wrong type is a `ValidationError`,
  not dynamoose's `TypeMismatch`. Any other issue has the schema's message and the path. A bad model definition is a `ConfigError`, and so is a key, condition or query value whose
  field has an async check or transform, or one that throws (thrown by the first call that parses it). A bad path, update,
  condition, key or batch is an `ExpressionError`. A value that cannot be stored is a `MarshallError`.
  `update(item)` with an argument that is not an object throws a `TypeError`. SDK errors are re-thrown
  unchanged.

## Tests that change

- `expect(item).toBeInstanceOf(M)` and `expect.any(M)` fail: items are plain objects. Compare the fields.
- `create()` resolves to the item with `Date` objects. dynamoose 4.2.0 resolves to the stored form, an ISO
  string or a number (D2). A test that compares the result with stored values changes.
- `vi.spyOn(item, 'save')` has nothing to spy on. Spy on `M.create`.
- `vi.spyOn(dynamoose, 'transaction')` becomes `vi.spyOn(orm, 'transaction')`: a named ESM import cannot be
  spied on, so `transaction()` calls go through the exported `orm` object. `vi.spyOn(Condition.prototype, …)`
  still works, because `M.condition()` returns a `Condition`.
- A snapshot of an item prints as dynamoose's item did (ISO strings, no `undefined` keys): an item made with
  `new M(x)` and an item a read returns have a non-enumerable `toJSON`, as dynamoose's had. `item.toJSON()`
  works on them at run time; the item type does not declare it, so typed code uses `toJSON(item)`.
- A `Condition` prints as `Condition {}` in a snapshot, as dynamoose's did: its state is in private fields.
- A model module mocked with `vi.mock()` makes instances (`new M(x)`) that print as `undefined`, as an automocked
  dynamoose item did: the model's prototype holds a `toJSON`, which the automock mocks.

## Allowlisted differences

The equivalence suite runs each case through dynamoose 4.2.0 from npm and through dynotable-orm on DynamoDB
Local. It compares what each call returns, the raw stored items, and what each library reads from the other's
items. These are the known differences on the same input, numbered as the entries of
`equivalence/allowlist.ts` cite them. The suite fails on any other difference, and on an entry that no longer
differs. The [stricter checks](#stricter-checks) are differences too: each one throws where dynamoose did
something else.

Whole-item writes (`create`, `save`, a put, batches, transactions) and top-level updates store the same
bytes. An update of a nested path does not: D3, D4 and D10 store something else for the same call, and D5 to
D9 are calls that one library refuses and the other writes. While old and new code share a table, keep
nested-path updates on one side.

1. **D1. Date storage.** With no storage setting, both store a `Date` and the timestamps as epoch
   milliseconds. `defaultDateStorage` sets the storage of a whole model; dynamoose sets it per attribute. No
   entry: the default is equal.
2. **D2. `create()` and `save()` resolve to Dates.** dynotable-orm resolves to the item with `Date` objects.
   dynamoose 4.2.0 resolves to the stored form: an ISO string or an epoch number. The stored items are equal.
3. **D3. A nested `$SET`, `$ADD` or `$DELETE` writes the nested field.** `{$SET: {'a.b': 1}}` sets `b` inside
   `a`. dynamoose 4.2.0 writes a top-level attribute named `a.b` and leaves `a` as it was. Its set modifiers
   and hook run on that top-level value.
4. **D4. A nested `$REMOVE` removes the nested field**, also a nested path set to `undefined` and a list
   element (`tags[1]`). dynamoose 4.2.0 removes a top-level attribute named by the path, so nothing is
   removed.
5. **D5. A `Date` in a nested update** is stored in the storage of its path. dynamoose 4.2.0 rejects the
   update ("Unsupported type passed", or a `TypeError`).
6. **D6. An update of a key inside a list element or inside a schemaless object** is written. dynamoose
   4.2.0 throws a `TypeError`.
7. **D7. Nested values are checked.** dynotable-orm refuses a nested value outside its enum or one that fails
   its `validate` or its type, a nested write under a parent or a record with its own check or transform, a
   nested object whose own keys fail their checks, and a `__proto__` or `constructor` segment. dynamoose 4.2.0
   runs none of these checks, and writes the path as a top-level attribute (D3).
8. **D8. An undeclared nested key is dropped**, and an update with nothing left throws "Nothing to update".
   dynamoose 4.2.0 writes the key as a top-level attribute named by the path.
9. **D9. An update that writes no combine source** keeps the combine attribute as stored. dynamoose 4.2.0
   refuses it ("You must update all or none of the combine attributes"), even when it writes no source.
10. **D10. A `$REMOVE` of a Set attribute and a `$SET` of a list in one update** store the list as a list
    (`L`). dynamoose 4.2.0 stores it as a string set (`SS`), and then cannot read the item.
11. **D11. A stored value of the wrong type is read as stored**: a number on an ISO Date path, a list on a Set
    path. dynamoose 4.2.0 rejects the read (`TypeMismatch`).
12. **D12. A top-level attribute named `a.b`** (one that dynamoose wrote, D3) is dropped on read with the Zod
    adapter. dynamoose 4.2.0 returns it.
13. **D13. `queriedCount` holds DynamoDB's `ScannedCount`.** dynamoose 4.2.0's is always `undefined`.
14. **D14. An update that carries `updatedAt` on a timestamped model** writes the lib's stamp only. dynamoose
    4.2.0 writes both values, and DynamoDB rejects the update.
15. **D15. An element that `$ADD` appends to a list with a transform** is stored as given on both sides.
    dynotable-orm reads the list by the transform's output schema; dynamoose 4.2.0 reads it by the declared
    schema.
16. **D16. The [whole-item `set` hook](#the-whole-item-set-hook) runs after validation**, and its output is
    not validated again. dynamoose validates after the hook. Zod cannot run its transforms without its checks.
    No entry: no case of the suite shows it.
17. **D17. An update with nothing to write** throws before sending. dynamoose 4.2.0 sends an empty
    `UpdateExpression`, and DynamoDB rejects it. No entry: both calls fail.
