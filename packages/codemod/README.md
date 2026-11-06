# dynotable-orm-codemod

Migrates dynamoose code and schemas to [dynotable-orm](https://www.npmjs.com/package/dynotable-orm). It marks
what it cannot move with a TODO comment.

```sh
npm install --save-dev dynotable-orm-codemod
npx dynotable-orm-codemod tsconfig.json --dry-run   # lists the files it would change
npx dynotable-orm-codemod tsconfig.json
```

The project must still resolve `dynamoose` when the codemod runs. The exit code is 0 when nothing is left to
do, 1 when a TODO is left, and 2 for a bad command line. The codemod does not format what it writes: run
the project's formatter after it.

The same run is a function, for scripts:

```text
import {migrate} from 'dynotable-orm-codemod';

const {changed, todos, sdkImports} = await migrate({tsconfig: 'tsconfig.json', sources: ['@acme/db'], dryRun: true});
```

`changed` holds each file's path and new text, `todos` each TODO left (`file`, `line`, `message`), and
`sdkImports` each direct DynamoDB SDK import, with the dynotable-orm API that replaces it when one is known.
`target` sets the module the rewritten code imports from, and `zod` the module the converted schemas import
Zod from (`--zod`).

- [The codemod, `--source`, `--target` and `--zod`](https://github.com/dynotable/dynamodb-orm/blob/main/docs/migration-from-dynamoose.md#the-codemod)
- [README](https://github.com/dynotable/dynamodb-orm#readme)

MIT © DynoTable
