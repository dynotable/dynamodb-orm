import dynamoose from '@acme/dynamoose';
import {ConditionalCheckFailedException} from '@aws-sdk/client-dynamodb';
import {createOrderModel, OrderModel, ReplaceableOrderModel} from '#models';
import {model} from 'dynotable-orm';
import {z} from 'zod';

// save() names the model again at the call: a let, a shadowing binding or a parameter may hold another model.
export async function reassigned(data: {id: string}) {
  let M = OrderModel;
  const item = new M(data);
  M = createOrderModel();
  // TODO(dynotable-orm-codemod): save(): only new M(...).save() and x.save() on a const x = new M(...) or x = await M.get(...) or await M.<method>(...) typed as M's item, of the same function, with M a const or an import, are converted: use M.create(item, {overwrite: true}), plus keepCreatedAt: true for an item that was read
  await item.save();
}
export async function shadowed(data: {id: string}) {
  const item = new OrderModel(data);
  {
    const OrderModel = createOrderModel();
    // TODO(dynotable-orm-codemod): save(): only new M(...).save() and x.save() on a const x = new M(...) or x = await M.get(...) or await M.<method>(...) typed as M's item, of the same function, with M a const or an import, are converted: use M.create(item, {overwrite: true}), plus keepCreatedAt: true for an item that was read
    await item.save();
    return OrderModel;
  }
}
// TODO(dynotable-orm-codemod): save(): only new M(...).save() and x.save() on a const x = new M(...) or x = await M.get(...) or await M.<method>(...) typed as M's item, of the same function, with M a const or an import, are converted: use M.create(item, {overwrite: true}), plus keepCreatedAt: true for an item that was read
export const fromParameter = (M: typeof OrderModel, data: {id: string}) => new M(data).save();

// Both generated options names are fooOptions.
const fooSchema = z.object({
  id: z.string()
});
const fooOptions = {hashKey: 'id'} as const;
// TODO(dynotable-orm-codemod): new Schema(): no free name for the options of foo
const foo = new dynamoose.Schema({id: {type: String, hashKey: true}});
export const Foo = model('Foo', fooSchema, fooOptions);
// TODO(dynotable-orm-codemod): model(): its schema does not convert
export const OtherFoo = dynamoose.model('OtherFoo', foo);

// The check keeps its import while it cannot be rewritten.
const isConditionalCheckFailed = 1;
const ormIsConditionalCheckFailed = 2;
export const taken = [isConditionalCheckFailed, ormIsConditionalCheckFailed];
// TODO(dynotable-orm-codemod): isConditionalCheckFailed: this file already has its own isConditionalCheckFailed and ormIsConditionalCheckFailed: rename one, then run again
export const failed = (e: unknown) => e instanceof ConditionalCheckFailedException;

// An imported let: its module may assign another model before save() runs.
// TODO(dynotable-orm-codemod): save(): only new M(...).save() and x.save() on a const x = new M(...) or x = await M.get(...) or await M.<method>(...) typed as M's item, of the same function, with M a const or an import, are converted: use M.create(item, {overwrite: true}), plus keepCreatedAt: true for an item that was read
export const fromLetExport = (data: {id: string}) => new ReplaceableOrderModel(data).save();
