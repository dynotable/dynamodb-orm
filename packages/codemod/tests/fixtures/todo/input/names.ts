import dynamoose from '@acme/dynamoose';
import {ConditionalCheckFailedException} from '@aws-sdk/client-dynamodb';
import {createOrderModel, OrderModel, ReplaceableOrderModel} from '#models';

// save() names the model again at the call: a let, a shadowing binding or a parameter may hold another model.
export async function reassigned(data: {id: string}) {
  let M = OrderModel;
  const item = new M(data);
  M = createOrderModel();
  await item.save();
}
export async function shadowed(data: {id: string}) {
  const item = new OrderModel(data);
  {
    const OrderModel = createOrderModel();
    await item.save();
    return OrderModel;
  }
}
export const fromParameter = (M: typeof OrderModel, data: {id: string}) => new M(data).save();

// Both generated options names are fooOptions.
const fooSchema = new dynamoose.Schema({id: {type: String, hashKey: true}});
const foo = new dynamoose.Schema({id: {type: String, hashKey: true}});
export const Foo = dynamoose.model('Foo', fooSchema);
export const OtherFoo = dynamoose.model('OtherFoo', foo);

// The check keeps its import while it cannot be rewritten.
const isConditionalCheckFailed = 1;
const ormIsConditionalCheckFailed = 2;
export const taken = [isConditionalCheckFailed, ormIsConditionalCheckFailed];
export const failed = (e: unknown) => e instanceof ConditionalCheckFailedException;

// An imported let: its module may assign another model before save() runs.
export const fromLetExport = (data: {id: string}) => new ReplaceableOrderModel(data).save();
