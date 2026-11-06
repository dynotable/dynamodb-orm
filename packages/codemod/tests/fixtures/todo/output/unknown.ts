import dynamoose from '@acme/dynamoose';
// TODO(dynotable-orm-codemod): no dynotable-orm type for ModelType (@acme/dynamoose/dist/General)
import type {ModelType} from '@acme/dynamoose/dist/General';
// TODO(dynotable-orm-codemod): cannot resolve @unresolved/dynamoose: install it and check that the tsconfig resolves it, then run again
import upstream from '@unresolved/dynamoose';
import {createOrderModel, type Customer, type Order, OrderModel} from '#models';
import {transaction} from 'dynotable-orm';

// TODO(dynotable-orm-codemod): dynamoose.type.THIS has no dynotable-orm equivalent: declare the field in the schema
export const self = dynamoose.type.THIS;

// TODO(dynotable-orm-codemod): unknown dynamoose use: dynamoose.logger
export const log = dynamoose.logger;

export const notInstalled = new upstream.Condition('status').eq('open');

export async function touch(order: Order, model: ModelType<Order>) {
  // TODO(dynotable-orm-codemod): save(): only new M(...).save() and x.save() on a const x = new M(...) or x = await M.get(...) or await M.<method>(...) typed as M's item, of the same function, with M a const or an import, are converted: use M.create(item, {overwrite: true}), plus keepCreatedAt: true for an item that was read
  await order.save();
  // TODO(dynotable-orm-codemod): populate has no dynotable-orm equivalent
  await order.populate();
  // TODO(dynotable-orm-codemod): dynamoose.Table.defaults.set: only prefix and suffix have an equivalent, setDefaults({prefix, suffix})
  dynamoose.Table.defaults.set({prefix: 'shop-', throughput: 5});
  // TODO(dynotable-orm-codemod): transaction get has no equivalent: read the item with get() or batchGet()
  return [model, await OrderModel.transaction.get({id: order.id})];
}

export const LaterModel = createOrderModel();

// TODO(dynotable-orm-codemod): methods.set: convert to extend({...}) with the other methods of this model
LaterModel.methods.set('all', async () => LaterModel.scan().exec());

// TODO(dynotable-orm-codemod): methods.set('names'): LaterModel is used where this does not refer to the model
LaterModel.methods.set('names', async function () {
  return [1].map(function () {
    return LaterModel.name;
  });
});

// TODO(dynotable-orm-codemod): unknown dynamoose use: Reflect.get( dynamoose, 'transaction' )
export const spy = Reflect.get(
  dynamoose,
  'transaction'
);

// TODO(dynotable-orm-codemod): x?.toJSON(): only a variable, a property or a literal index at the end of the chain is converted, to (x == null ? undefined : toJSON(x))
export const statusOf = async (id: string) => (await OrderModel.get({id}))?.toJSON().status;

export const Overridden = createOrderModel();
const firstGet = Overridden.get.bind(Overridden);
// TODO(dynotable-orm-codemod): methods.set: Overridden is read at module load before this call, so the methods cannot move to its declaration
Overridden.methods.set('get', async function (key: {id: string}) {
  return firstGet(key);
});

export const untyped = (rows: any[]) => rows.map((r: any) => r.toJSON());

export const OtherModel = createOrderModel();

export async function either(read: boolean, cb: (e: unknown) => void) {
  const item = read ? await OrderModel.get({id: 'a'}) : await OtherModel.get({id: 'a'});
  // TODO(dynotable-orm-codemod): save(): only new M(...).save() and x.save() on a const x = new M(...) or x = await M.get(...) or await M.<method>(...) typed as M's item, of the same function, with M a const or an import, are converted: use M.create(item, {overwrite: true}), plus keepCreatedAt: true for an item that was read
  await item.save();
  const one = await OrderModel.get({id: 'b'});
  // TODO(dynotable-orm-codemod): x?.save(): only a variable, a property or a literal index at the end of the chain is converted, to (x == null ? undefined : M.create(x, …))
  await one?.save().then(() => cb(undefined));
  // TODO(dynotable-orm-codemod): get(): dynotable-orm takes no callback and returns a Promise: await the call instead
  OrderModel.get({id: 'a'}, cb);
}

export const Gated = createOrderModel();
export const gated = Math.random() > 0.5;
const answer = () => 42;
// TODO(dynotable-orm-codemod): methods.set: answer is not set yet where Gated is declared, so it cannot move to its declaration
Gated.methods.set('answer', answer);
if (gated) {
  // TODO(dynotable-orm-codemod): methods.set: the call is not a top-level statement, so it may run later or not at all: convert to extend({...}) by hand
  Gated.methods.set('gated', () => 1);
}
export function later() {
  // TODO(dynotable-orm-codemod): methods.set: the call is not a top-level statement, so it may run later or not at all: convert to extend({...}) by hand
  Gated.methods.set('later', () => 2);
}

// TODO(dynotable-orm-codemod): (e as {code?: string}).code === 'ConditionalCheckFailedException': the SDK error has no code, so this never matched; if a failed condition is meant, use isConditionalCheckFailed(e)
export const codeOf = (e: unknown) => (e as {code?: string}).code === 'ConditionalCheckFailedException';

// dynamoose passes a callback when the caller gives none; a dynotable-orm method never gets one.
export const Called = createOrderModel();
// TODO(dynotable-orm-codemod): methods.set('label'): the last parameter is a callback, which dynamoose passes when the caller gives none and a dynotable-orm method never gets: return a Promise instead, then run again
Called.methods.set('label', (id: string, cb: (e: unknown, v?: string) => void) => cb(null, id));
// TODO(dynotable-orm-codemod): methods.set('relay'): the last parameter is a callback, which dynamoose passes when the caller gives none and a dynotable-orm method never gets: return a Promise instead, then run again
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
  // TODO(dynotable-orm-codemod): save(): only new M(...).save() and x.save() on a const x = new M(...) or x = await M.get(...) or await M.<method>(...) typed as M's item, of the same function, with M a const or an import, are converted: use M.create(item, {overwrite: true}), plus keepCreatedAt: true for an item that was read
  await customer.save();
}

// dynamoose calls the callback when the transaction settles.
// TODO(dynotable-orm-codemod): transaction(): dynotable-orm takes no callback and returns a Promise: await the call instead
export const settle = (id: string, done: (e: unknown) => void) =>
  dynamoose.transaction([OrderModel.transaction.delete({id})], done);

// An optional callback is a callback too: dynamoose passes one when the caller gives none.
declare function described(this: unknown, id: string, cb?: (e: unknown) => void): void;
// TODO(dynotable-orm-codemod): methods.set('described'): the last parameter is a callback, which dynamoose passes when the caller gives none and a dynotable-orm method never gets: return a Promise instead, then run again
Called.methods.set('described', described);

// dynamoose builds a request-only call without sending it; dynotable-orm's batch calls always send it.
export async function requests(id: string) {
  // TODO(dynotable-orm-codemod): batchPut(): dynotable-orm takes no return setting and always sends the request: drop return, or build the request by hand
  const put = await OrderModel.batchPut([{id, status: 'open', total: 1}], {return: 'request'});
  // TODO(dynotable-orm-codemod): batchDelete(): dynotable-orm takes no return setting and always sends the request: drop return, or build the request by hand
  const removed = await OrderModel.batchDelete([{id}], {return: 'request'});
  // dynotable-orm builds these requests too.
  const single = await OrderModel.delete({id}, {return: 'request'});
  const transact = await transaction([OrderModel.transaction.delete({id})], {return: 'request'});
  return [put, removed, single, transact];
}

// Only one member of the union asks for the request: still marked.
export async function maybeRequest(id: string, settings: {return: 'request'; consistent: true} | {consistent: false}) {
  // TODO(dynotable-orm-codemod): batchGet(): dynotable-orm takes no return setting and always sends the request: drop return, or build the request by hand
  return OrderModel.batchGet([{id}], settings);
}
