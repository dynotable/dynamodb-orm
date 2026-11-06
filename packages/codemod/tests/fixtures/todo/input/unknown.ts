import dynamoose from '@acme/dynamoose';
import type {ModelType} from '@acme/dynamoose/dist/General';
import upstream from '@unresolved/dynamoose';
import {createOrderModel, type Customer, type Order, OrderModel} from '#models';

export const self = dynamoose.type.THIS;

export const log = dynamoose.logger;

export const notInstalled = new upstream.Condition('status').eq('open');

export async function touch(order: Order, model: ModelType<Order>) {
  await order.save();
  await order.populate();
  dynamoose.Table.defaults.set({prefix: 'shop-', throughput: 5});
  return [model, await OrderModel.transaction.get({id: order.id})];
}

export const LaterModel = createOrderModel();

LaterModel.methods.set('all', async () => LaterModel.scan().exec());

LaterModel.methods.set('names', async function () {
  return [1].map(function () {
    return LaterModel.name;
  });
});

export const spy = Reflect.get(
  dynamoose,
  'transaction'
);

export const statusOf = async (id: string) => (await OrderModel.get({id}))?.toJSON().status;

export const Overridden = createOrderModel();
const firstGet = Overridden.get.bind(Overridden);
Overridden.methods.set('get', async function (key: {id: string}) {
  return firstGet(key);
});

export const untyped = (rows: any[]) => rows.map((r: any) => r.toJSON());

export const OtherModel = createOrderModel();

export async function either(read: boolean, cb: (e: unknown) => void) {
  const item = read ? await OrderModel.get({id: 'a'}) : await OtherModel.get({id: 'a'});
  await item.save();
  const one = await OrderModel.get({id: 'b'});
  await one?.save().then(() => cb(undefined));
  OrderModel.get({id: 'a'}, cb);
}

export const Gated = createOrderModel();
export const gated = Math.random() > 0.5;
const answer = () => 42;
Gated.methods.set('answer', answer);
if (gated) {
  Gated.methods.set('gated', () => 1);
}
export function later() {
  Gated.methods.set('later', () => 2);
}

export const codeOf = (e: unknown) => (e as {code?: string}).code === 'ConditionalCheckFailedException';

// dynamoose passes a callback when the caller gives none; a dynotable-orm method never gets one.
export const Called = createOrderModel();
Called.methods.set('label', (id: string, cb: (e: unknown, v?: string) => void) => cb(null, id));
Called.methods.set('relay', function (id, done) {
  setTimeout(() => done(null, id));
});

// A helper's name says nothing of the table its item comes from: this one reads another model's item.
export const Helped = createOrderModel() as ReturnType<typeof createOrderModel> & {
  foreignGet(id: string): Promise<Customer>;
};
export async function renameCustomer(id: string) {
  const customer = await Helped.foreignGet(id);
  customer.name = 'renamed';
  await customer.save();
}

// dynamoose calls the callback when the transaction settles.
export const settle = (id: string, done: (e: unknown) => void) =>
  dynamoose.transaction([OrderModel.transaction.delete({id})], done);

// An optional callback is a callback too: dynamoose passes one when the caller gives none.
declare function described(this: unknown, id: string, cb?: (e: unknown) => void): void;
Called.methods.set('described', described);

// dynamoose builds a request-only call without sending it; dynotable-orm's batch calls always send it.
export async function requests(id: string) {
  const put = await OrderModel.batchPut([{id, status: 'open', total: 1}], {return: 'request'});
  const removed = await OrderModel.batchDelete([{id}], {return: 'request'});
  // dynotable-orm builds these requests too.
  const single = await OrderModel.delete({id}, {return: 'request'});
  const transact = await dynamoose.transaction([OrderModel.transaction.delete({id})], {return: 'request'});
  return [put, removed, single, transact];
}

// Only one member of the union asks for the request: still marked.
export async function maybeRequest(id: string, settings: {return: 'request'; consistent: true} | {consistent: false}) {
  return OrderModel.batchGet([{id}], settings);
}
