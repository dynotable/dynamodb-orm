import dynamoose from '@acme/dynamoose';
import type {ModelUpdateSettings as Settings} from '@acme/dynamoose/dist/Model';
import {createOrderModel, type Order, OrderModel} from '#models';

export const ThenModel = createOrderModel();

// then() may return another model's item: save() cannot tell which table to write.
export async function chained() {
  const item = await OrderModel.get({id: 'a'}).then(() => ThenModel.get({id: 'a'}));
  await item.save();
}

// save() writes to the table of a model it can name for sure, else it gets a TODO: an item from destructuring
// (a default can be another model's item), a loop, a fallback between two reads, or a let.
export async function untraced(id: string) {
  const [first = new ThenModel({id})] = await OrderModel.query('status').eq('open').exec();
  await first.save();
  for (const each of await OrderModel.scan().exec()) await each.save();
  const either = (await OrderModel.get({id})) ?? (await OrderModel.get({id: `${id}-copy`}));
  await either!.save();
  let later = await OrderModel.get({id});
  later = await ThenModel.get({id});
  await later.save();
}

// A later methods.set replaces an earlier one, which an object literal cannot hold.
export const TwiceModel = createOrderModel();
TwiceModel.methods.set('label', () => 'first');
TwiceModel.methods.set('label', () => 'second');
TwiceModel.methods.set('other', () => 'kept');

// A plain item, not a stored one: fromStored would refuse it.
export const plain = () => new OrderModel({id: 'k'}).conformToSchema({type: 'fromDynamo'});

// The chain stops at x before toJSON.
export const nested = (x: {item: Order} | undefined) => x?.item.toJSON();

const transaction = 1;
const ormTransaction = 2;
export const taken = [transaction, ormTransaction];
export const run = () => dynamoose.transaction([]);

interface UpdateOptions {
  local: true;
}
export const settings: Settings | UpdateOptions | undefined = undefined;
