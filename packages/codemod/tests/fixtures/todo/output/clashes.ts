import dynamoose from '@acme/dynamoose';
// TODO(dynotable-orm-codemod): UpdateOptions: this file already has its own UpdateOptions: rename it, then run again
import type {ModelUpdateSettings as Settings} from '@acme/dynamoose/dist/Model';
import {createOrderModel, type Order, OrderModel} from '#models';

export const ThenModel = createOrderModel();

// then() may return another model's item: save() cannot tell which table to write.
export async function chained() {
  const item = await OrderModel.get({id: 'a'}).then(() => ThenModel.get({id: 'a'}));
  // TODO(dynotable-orm-codemod): save(): only new M(...).save() and x.save() on a const x = new M(...) or x = await M.get(...) or await M.<method>(...) typed as M's item, of the same function, with M a const or an import, are converted: use M.create(item, {overwrite: true}), plus keepCreatedAt: true for an item that was read
  await item.save();
}

// save() writes to the table of a model it can name for sure, else it gets a TODO: an item from destructuring
// (a default can be another model's item), a loop, a fallback between two reads, or a let.
export async function untraced(id: string) {
  const [first = new ThenModel({id})] = await OrderModel.query('status').eq('open').exec();
  // TODO(dynotable-orm-codemod): save(): only new M(...).save() and x.save() on a const x = new M(...) or x = await M.get(...) or await M.<method>(...) typed as M's item, of the same function, with M a const or an import, are converted: use M.create(item, {overwrite: true}), plus keepCreatedAt: true for an item that was read
  await first.save();
  for (const each of await OrderModel.scan().exec()) // TODO(dynotable-orm-codemod): save(): only new M(...).save() and x.save() on a const x = new M(...) or x = await M.get(...) or await M.<method>(...) typed as M's item, of the same function, with M a const or an import, are converted: use M.create(item, {overwrite: true}), plus keepCreatedAt: true for an item that was read
  await each.save();
  const either = (await OrderModel.get({id})) ?? (await OrderModel.get({id: `${id}-copy`}));
  // TODO(dynotable-orm-codemod): save(): only new M(...).save() and x.save() on a const x = new M(...) or x = await M.get(...) or await M.<method>(...) typed as M's item, of the same function, with M a const or an import, are converted: use M.create(item, {overwrite: true}), plus keepCreatedAt: true for an item that was read
  await either!.save();
  let later = await OrderModel.get({id});
  later = await ThenModel.get({id});
  // TODO(dynotable-orm-codemod): save(): only new M(...).save() and x.save() on a const x = new M(...) or x = await M.get(...) or await M.<method>(...) typed as M's item, of the same function, with M a const or an import, are converted: use M.create(item, {overwrite: true}), plus keepCreatedAt: true for an item that was read
  await later.save();
}

// A later methods.set replaces an earlier one, which an object literal cannot hold.
export const TwiceModel = createOrderModel();
// TODO(dynotable-orm-codemod): methods.set('label'): set more than once on TwiceModel, and the last one wins: keep one, then run again
TwiceModel.methods.set('label', () => 'first');
// TODO(dynotable-orm-codemod): methods.set('label'): set more than once on TwiceModel, and the last one wins: keep one, then run again
TwiceModel.methods.set('label', () => 'second');
// TODO(dynotable-orm-codemod): methods.set: convert to extend({...}) with the other methods of this model
TwiceModel.methods.set('other', () => 'kept');

// A plain item, not a stored one: fromStored would refuse it.
// TODO(dynotable-orm-codemod): conformToSchema: only new M(x).conformToSchema({type: 'fromDynamo'}) with the settings of a read, with M a const or an import and x typed as a record of AttributeValue, is converted, to M.fromStored(x)
export const plain = () => new OrderModel({id: 'k'}).conformToSchema({type: 'fromDynamo'});

// The chain stops at x before toJSON.
// TODO(dynotable-orm-codemod): x?.toJSON(): only a variable, a property or a literal index at the end of the chain is converted, to (x == null ? undefined : toJSON(x))
export const nested = (x: {item: Order} | undefined) => x?.item.toJSON();

const transaction = 1;
const ormTransaction = 2;
export const taken = [transaction, ormTransaction];
// TODO(dynotable-orm-codemod): transaction: this file already has its own transaction and ormTransaction: rename one, then run again
export const run = () => dynamoose.transaction([]);

interface UpdateOptions {
  local: true;
}
export const settings: Settings | UpdateOptions | undefined = undefined;
