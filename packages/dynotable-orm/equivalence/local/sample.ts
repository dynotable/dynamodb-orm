// Local mode, step 2: samples raw items from the tables `run.ts` listed in the manifest, in its own
// process with the caller's read-only credentials. It sends Scan only, and loads no codebase.
//
//   EQUIVALENCE_ACCOUNT=<the AWS account id the credentials must belong to>  [SAMPLE_SIZE=20]
//   pnpm equivalence:sample
import {
  type AttributeValue,
  DynamoDBClient,
  ScanCommand,
  type ScanCommandInput
} from '@aws-sdk/client-dynamodb';
import {GetCallerIdentityCommand, STSClient} from '@aws-sdk/client-sts';
import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

type StoredItem = Record<string, AttributeValue>;
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../../.equivalence-local');
const SIZE = Number(process.env.SAMPLE_SIZE ?? 20);
// Pages read per path that the first sample does not show; each page holds up to 100 items.
const PAGES = 5;

const account = process.env.EQUIVALENCE_ACCOUNT;
if (!account)
  throw new Error('set EQUIVALENCE_ACCOUNT to the account the credentials must belong to');
const sts = new STSClient({});
const {Account} = await sts.send(new GetCallerIdentityCommand({}));
sts.destroy();
if (Account !== account)
  throw new Error(`the credentials belong to account ${Account}, not ${account}`);

const manifest: Array<{name: string; table: string; paths: string[]}> = JSON.parse(
  readFileSync(join(OUT, 'manifest.json'), 'utf8')
);
const client = new DynamoDBClient({});

async function scan(input: ScanCommandInput, pages: number, want: number): Promise<StoredItem[]> {
  const items: StoredItem[] = [];
  let ExclusiveStartKey: StoredItem | undefined;
  for (let page = 0; page < pages && items.length < want; page++) {
    const out = await client.send(
      new ScanCommand({...input, ...(ExclusiveStartKey && {ExclusiveStartKey})})
    );
    items.push(...(out.Items ?? []));
    if (!(ExclusiveStartKey = out.LastEvaluatedKey)) break;
  }
  return items.slice(0, want);
}

function present(item: StoredItem, path: string): boolean {
  let value: AttributeValue | undefined = {M: item};
  for (const seg of path.split('.')) value = value?.M?.[seg];
  return value !== undefined;
}

const samples: Record<string, StoredItem[]> = {};
for (const {name, table, paths} of manifest) {
  try {
    const items = await scan({TableName: table, Limit: SIZE}, 1, SIZE);
    for (const path of paths.filter((p) => !items.some((i) => present(i, p)))) {
      const segments = path.split('.');
      const names = Object.fromEntries(segments.map((s, i) => [`#p${i}`, s]));
      const found = await scan(
        {
          TableName: table,
          Limit: 100,
          FilterExpression: `attribute_exists(${Object.keys(names).join('.')})`,
          ExpressionAttributeNames: names
        },
        PAGES,
        2
      );
      items.push(
        ...found.filter((f) => !items.some((i) => JSON.stringify(i) === JSON.stringify(f)))
      );
    }
    samples[name] = items;
    console.log(`${name}: ${items.length} items`);
  } catch (error) {
    console.log(`${name}: not sampled (${error instanceof Error ? error.name : String(error)})`);
  }
}
client.destroy();
// B and BS as base64, as DynamoDB JSON writes them.
writeFileSync(
  join(OUT, 'samples.json'),
  JSON.stringify(samples, (_, v) =>
    v instanceof Uint8Array ? Buffer.from(v).toString('base64') : v
  )
);
