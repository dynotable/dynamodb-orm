// Local only, report only: dynamoose, ElectroDB and dynamodb-toolbox against this lib and raw, in one run on
// the `small` schema, CPU only. Not in the CI gate. Run: pnpm bench:competitors [--quick]
//
// The lib, raw and dynamoose come from bench.ts's setup(), on its stub; each marshalls by itself. ElectroDB
// and dynamodb-toolbox talk to a DynamoDB DocumentClient. Their stub does what the DocumentClient's
// middleware does before and after the wire (marshall the input, unmarshall the output), so every contender
// pays for the same conversion. Each one stores the item in its own form: ElectroDB adds its key templates and
// entity attributes; dynamodb-toolbox runs with its entity attribute and timestamps off and stores the same item.
import {marshall, unmarshall} from '@aws-sdk/util-dynamodb';
import {Entity as ElectroEntity} from 'electrodb';
import {
  boolean,
  Entity,
  GetItemCommand,
  item,
  number,
  PutItemCommand,
  QueryCommand,
  string,
  Table,
  UpdateItemCommand
} from 'dynamodb-toolbox';
import {isDeepStrictEqual} from 'node:util';
import {median} from './gate.js';
import {type Contender, QUERY_ITEMS, run, setup, stub, type Suite} from './bench.js';

const data = (i: number) => ({
  id: `small-${i}`,
  name: 'Test User',
  email: 'test@example.com',
  age: 25,
  active: true
});

const wire: Record<string, string> = {
  PutCommand: 'PutItemCommand',
  GetCommand: 'GetItemCommand',
  UpdateCommand: 'UpdateItemCommand',
  QueryCommand: 'QueryCommand'
};
/** A DocumentClient over the canned responses of `table`. */
function documentClient(table: string) {
  return {
    async send(command: {constructor: {name: string}; input: Record<string, any>}) {
      const {Item, Key, ExpressionAttributeValues, ExclusiveStartKey, ...rest} = command.input;
      const input = {
        ...rest,
        TableName: table,
        ...(Item && {Item: marshall(Item)}),
        ...(Key && {Key: marshall(Key)}),
        ...(ExpressionAttributeValues && {
          ExpressionAttributeValues: marshall(ExpressionAttributeValues)
        }),
        ...(ExclusiveStartKey && {ExclusiveStartKey: marshall(ExclusiveStartKey)})
      };
      const out: any = await stub.reply(wire[command.constructor.name]!, input);
      return {
        ...out,
        ...(out.Item && {Item: unmarshall(out.Item)}),
        ...(out.Attributes && {Attributes: unmarshall(out.Attributes)}),
        ...(out.Items && {Items: out.Items.map((x: any) => unmarshall(x))})
      };
    }
  };
}

/** Writes each item through `create` and keeps the stored forms as the canned responses of `table`. */
async function cannedFrom(table: string, create: (x: Record<string, unknown>) => Promise<unknown>) {
  const stored = [];
  stub.responses.set(table, {PutItemCommand: {}});
  for (let i = 0; i < QUERY_ITEMS; i++) {
    await create(data(i));
    stored.push(stub.last!.input.Item);
  }
  await create(data(1));
  const one = stub.last!.input.Item;
  stub.responses.set(table, {
    PutItemCommand: {},
    GetItemCommand: {Item: one},
    UpdateItemCommand: {Attributes: one},
    QueryCommand: {Items: stored, Count: stored.length, ScannedCount: stored.length}
  });
}

const electro = new ElectroEntity(
  {
    model: {entity: 'small', version: '1', service: 'bench'},
    attributes: {
      id: {type: 'string', required: true},
      name: {type: 'string'},
      email: {type: 'string'},
      age: {type: 'number'},
      active: {type: 'boolean'}
    },
    indexes: {
      primary: {pk: {field: 'pk', composite: ['id']}, sk: {field: 'sk', composite: []}},
      byEmail: {
        index: 'gsi1',
        pk: {field: 'gsi1pk', composite: ['email']},
        sk: {field: 'gsi1sk', composite: ['id']}
      }
    }
  },
  {client: documentClient('Bench_electrodb'), table: 'Bench_electrodb'}
);
await cannedFrom('Bench_electrodb', (x) => electro.create(x as any).go());

const toolboxTable = new Table({
  name: 'Bench_toolbox',
  partitionKey: {name: 'id', type: 'string'},
  indexes: {'email-index': {type: 'global', partitionKey: {name: 'email', type: 'string'}}},
  documentClient: documentClient('Bench_toolbox') as any
});
const toolbox = new Entity({
  name: 'small',
  table: toolboxTable,
  schema: item({
    id: string().key(),
    name: string().optional(),
    email: string().optional(),
    age: number().optional(),
    active: boolean().optional()
  }),
  entityAttribute: false,
  timestamps: false
});
const ifAbsent = {condition: {attr: 'id', exists: false}} as const;
await cannedFrom('Bench_toolbox', (x) =>
  toolbox
    .build(PutItemCommand)
    .item(x as any)
    .options(ifAbsent)
    .send()
);

const competitors: Record<string, Record<string, Contender['run']>> = {
  electrodb: {
    create: (x) => electro.create(x).go(),
    get: (k) =>
      electro
        .get(k)
        .go()
        .then((r) => r.data),
    update: ([k, c]) =>
      electro
        .update(k)
        .set(c)
        .go({response: 'all_new'})
        .then((r) => r.data),
    query: (email) =>
      electro.query
        .byEmail({email})
        .go()
        .then((r) => r.data)
  },
  toolbox: {
    create: (x) => toolbox.build(PutItemCommand).item(x).options(ifAbsent).send(),
    get: (k) =>
      toolbox
        .build(GetItemCommand)
        .key(k)
        .send()
        .then((r) => r.Item),
    update: ([k, c]) =>
      toolbox
        .build(UpdateItemCommand)
        .item({...k, ...c})
        .options({returnValues: 'ALL_NEW'})
        .send()
        .then((r) => r.Attributes),
    query: (email) =>
      toolboxTable
        .build(QueryCommand)
        .entities(toolbox)
        .query({index: 'email-index', partition: email})
        .send()
        .then((r) => r.Items)
  }
};

const suites: Suite[] = (await setup())
  .filter((s) => s.schema === 'small')
  .map((s) => ({
    ...s,
    contenders: [
      ...s.contenders,
      ...Object.entries(competitors).map(
        ([name, ops]) =>
          ({name, prepare: s.contenders[0]!.prepare, run: ops[s.operation]!}) as Contender
      )
    ]
  }));

// Each competitor must do the same work as this lib before its timing means anything.
const expected: Record<string, unknown> = {
  get: data(1),
  update: data(1),
  query: Array.from({length: QUERY_ITEMS}, (_, i) => data(i))
};
for (const suite of suites) {
  for (const c of suite.contenders) {
    const result = await c.run(c.prepare());
    const want = expected[suite.operation];
    if (want && !isDeepStrictEqual(JSON.parse(JSON.stringify(result)), want)) {
      throw new Error(
        `${c.name} ${suite.operation} returned ${JSON.stringify(result).slice(0, 300)}`
      );
    }
  }
}

const quick = process.argv.includes('--quick');
const results = await run(
  suites,
  quick ? {rounds: 2, roundMs: 20, warmupMs: 20} : {rounds: 10, roundMs: 200, warmupMs: 500}
);
const names = suites[0]!.contenders.map((c) => c.name);
console.log(`small, ${process.version}, median µs/op (${QUERY_ITEMS} items per query)`);
console.log(['operation', ...names].map((x) => x.padStart(10)).join(''));
for (const r of results) {
  console.log(
    [r.operation, ...names.map((n) => String(Number((1e6 / median(r.samples[n]!)).toPrecision(3))))]
      .map((x) => x.padStart(10))
      .join('')
  );
}
