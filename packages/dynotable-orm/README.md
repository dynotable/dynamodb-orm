# dynotable-orm

A type-safe, fast DynamoDB ORM for TypeScript and a dynamoose alternative. Define each model with Zod or any
Standard Schema, and keys, updates, conditions and queries are typed from it. Whole-item writes and top-level
updates store the same bytes as dynamoose 4.2.0, apart from three top-level edge cases; an update of a
nested path does not (see the migration guide).

```sh
npm install dynotable-orm @aws-sdk/client-dynamodb zod
```

Node 24 or later. `@aws-sdk/client-dynamodb` v3 is a peer dependency. `zod` (v4) is optional: the Zod
adapter is at `dynotable-orm/zod`.

- [Documentation](https://dynotable.com/orm)
- [README, with a 30-second example](https://github.com/dynotable/dynamodb-orm#readme)
- [Migrating from dynamoose](https://github.com/dynotable/dynamodb-orm/blob/main/docs/migration-from-dynamoose.md)
- [Benchmarks](https://github.com/dynotable/dynamodb-orm/blob/main/docs/benchmarks.md)

MIT © DynoTable
