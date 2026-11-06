// The benchmark schemas and the raw contender.
import {
  type AttributeValue,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand
} from '@aws-sdk/client-dynamodb';
import {marshall, unmarshall} from '@aws-sdk/util-dynamodb';
import {z} from 'zod';
import {order, orderData} from '../equivalence/corpus.js';
import type {Dynamoose} from '../equivalence/harness.js';
import type {ModelOptions} from '../src/options.js';

export {order, orderData};

type StoredItem = Record<string, AttributeValue>;
type Item = Record<string, unknown>;

/**
 * The raw contender: what a hand-written raw SDK caller does for the same stored item. A whole-item Zod
 * `parse` plus `marshall` on write, with ISO timestamps; `unmarshall` on read, with no validation, as this lib.
 */
export const raw = {
  write(schema: z.ZodType, input: unknown): StoredItem {
    const now = new Date().toISOString();
    return marshall(
      {...(schema.parse(input) as object), createdAt: now, updatedAt: now},
      {removeUndefinedValues: true}
    );
  },
  read(stored: StoredItem): Item {
    return unmarshall(stored);
  }
};

/** Takes an SDK command, as `DynamoDBClient.send`. */
export type Send = (command: {input: object}) => Promise<any>;

/** Hand-written SDK code for each benchmark call, with the same validation and the same stored item as the ORMs. */
export interface RawOps {
  create(item: Item): Promise<unknown>;
  get(key: Item): Promise<Item | undefined>;
  update(key: Item, changes: Item): Promise<Item>;
  updateNested?(key: Item, changes: {$SET: Item}): Promise<Item>;
  query(value: string): Promise<Item[]>;
}

export interface BenchSchema {
  name: string;
  /** The dynamoose schema. */
  dynamoose: (d: Dynamoose) => unknown;
  lib: {schema: z.ZodObject; options: ModelOptions<any>};
  data: () => Item;
  key: Item;
  update: () => Item;
  nestedUpdate?: () => {$SET: Item};
  /** `query(attribute).eq(value)` matches the 100 items of the canned response, through `index`. */
  query: {attribute: string; value: string; index: string};
  /** Distinct inputs whose stored forms make the canned query response. */
  queryData: (i: number) => Item;
  raw: (send: Send, table: string) => RawOps;
}

const createdIfAbsent = {
  ConditionExpression: 'attribute_not_exists(#id)',
  ExpressionAttributeNames: {'#id': 'id'}
} as const;

const zodOrder = order.lib.schema as unknown as z.ZodObject<Record<string, z.ZodType>>;
const orderUpdate = zodOrder.pick({
  status: true,
  statusCode: true,
  statusMessage: true,
  notification: true
});
const notificationStatus = (
  (zodOrder.shape.notification as z.ZodOptional<z.ZodObject>).unwrap().shape as Record<
    string,
    z.ZodType
  >
).status!;

const orderBench: BenchSchema = {
  name: 'order',
  dynamoose: order.dynamoose,
  lib: {schema: zodOrder, options: order.lib.options!},
  data: () => orderData(),
  key: {id: orderData().id},
  // The calls of the order benchmark fixture.
  update: () => ({
    status: 'SHIPPED',
    statusCode: 'S000',
    statusMessage: 'Shipped',
    notification: {status: 'PENDING'}
  }),
  nestedUpdate: () => ({$SET: {'notification.status': 'SENT', 'details.refundedAmount': 4250}}),
  query: {
    attribute: 'customerId',
    value: orderData().customerId as string,
    index: 'externalOrderId-index'
  },
  queryData: (i) => orderData(i.toString(16).padStart(40, '0')),
  raw: (send, TableName) => ({
    create: (item) =>
      send(new PutItemCommand({TableName, Item: raw.write(zodOrder, item), ...createdIfAbsent})),
    async get(key) {
      const {Item} = await send(new GetItemCommand({TableName, Key: marshall(key)}));
      return Item && raw.read(Item);
    },
    async update(key, changes) {
      const v = orderUpdate.parse(changes);
      const {Attributes} = await send(
        new UpdateItemCommand({
          TableName,
          Key: marshall(key),
          UpdateExpression:
            'SET #updatedAt = :updatedAt, #status = :status, #statusCode = :statusCode, #statusMessage = :statusMessage, #notification = :notification',
          ExpressionAttributeNames: {
            '#updatedAt': 'updatedAt',
            '#status': 'status',
            '#statusCode': 'statusCode',
            '#statusMessage': 'statusMessage',
            '#notification': 'notification'
          },
          ExpressionAttributeValues: marshall(
            {
              ':updatedAt': new Date().toISOString(),
              ':status': v.status,
              ':statusCode': v.statusCode,
              ':statusMessage': v.statusMessage,
              ':notification': v.notification
            },
            {removeUndefinedValues: true}
          ),
          ReturnValues: 'ALL_NEW'
        })
      );
      return raw.read(Attributes);
    },
    async updateNested(key, {$SET}) {
      // `details` is a record of unknown values: only the notification status has a check.
      const status = notificationStatus.parse($SET['notification.status']);
      const {Attributes} = await send(
        new UpdateItemCommand({
          TableName,
          Key: marshall(key),
          UpdateExpression:
            'SET #updatedAt = :updatedAt, #notification.#status = :status, #details.#refundedAmount = :refundedAmount',
          ExpressionAttributeNames: {
            '#updatedAt': 'updatedAt',
            '#notification': 'notification',
            '#status': 'status',
            '#details': 'details',
            '#refundedAmount': 'refundedAmount'
          },
          ExpressionAttributeValues: marshall({
            ':updatedAt': new Date().toISOString(),
            ':status': status,
            ':refundedAmount': $SET['details.refundedAmount']
          }),
          ReturnValues: 'ALL_NEW'
        })
      );
      return raw.read(Attributes);
    },
    async query(value) {
      const {Items} = await send(
        new QueryCommand({
          TableName,
          IndexName: 'externalOrderId-index',
          KeyConditionExpression: '#customerId = :customerId',
          ExpressionAttributeNames: {'#customerId': 'customerId'},
          ExpressionAttributeValues: {':customerId': {S: value}}
        })
      );
      return Items.map(raw.read);
    }
  })
};

// The `small` benchmark schema, with a global index on `email` so a query
// can return many items. No nested attribute, so no `update-nested`; no timestamps.
const zodSmall = z.object({
  id: z.string(),
  name: z.string().optional(),
  email: z.string().optional(),
  age: z.number().optional(),
  active: z.boolean().optional()
});
const smallUpdate = zodSmall.pick({name: true}).required();

const smallBench: BenchSchema = {
  name: 'small',
  dynamoose: (d) =>
    new d.Schema({
      id: {type: String, hashKey: true},
      name: String,
      email: {type: String, index: {name: 'email-index', type: 'global'}},
      age: Number,
      active: Boolean
    }),
  lib: {
    schema: zodSmall,
    options: {hashKey: 'id', indexes: {email: {name: 'email-index', type: 'global'}}}
  },
  data: () => ({
    id: 'small-1',
    name: 'Test User',
    email: 'test@example.com',
    age: 25,
    active: true
  }),
  key: {id: 'small-1'},
  update: () => ({name: 'Updated Name'}),
  query: {attribute: 'email', value: 'test@example.com', index: 'email-index'},
  queryData: (i) => ({
    id: `small-${i}`,
    name: 'Test User',
    email: 'test@example.com',
    age: 25,
    active: true
  }),
  raw: (send, TableName) => ({
    create: (item) =>
      send(
        new PutItemCommand({TableName, Item: marshall(zodSmall.parse(item)), ...createdIfAbsent})
      ),
    async get(key) {
      const {Item} = await send(new GetItemCommand({TableName, Key: marshall(key)}));
      return Item && unmarshall(Item);
    },
    async update(key, changes) {
      const {name} = smallUpdate.parse(changes);
      const {Attributes} = await send(
        new UpdateItemCommand({
          TableName,
          Key: marshall(key),
          UpdateExpression: 'SET #name = :name',
          ExpressionAttributeNames: {'#name': 'name'},
          ExpressionAttributeValues: {':name': {S: name}},
          ReturnValues: 'ALL_NEW'
        })
      );
      return unmarshall(Attributes);
    },
    async query(value) {
      const {Items} = await send(
        new QueryCommand({
          TableName,
          IndexName: 'email-index',
          KeyConditionExpression: '#email = :email',
          ExpressionAttributeNames: {'#email': 'email'},
          ExpressionAttributeValues: {':email': {S: value}}
        })
      );
      return Items.map((item: StoredItem) => unmarshall(item));
    }
  })
};

export const benchSchemas: readonly BenchSchema[] = [orderBench, smallBench];
