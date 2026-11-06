import {db, dynamoose, nowUnix, type Saved, type WithDelete} from '#db';
import {type Order, OrderModel} from '#models';

export async function settle(id: string) {
  await OrderModel.update({id}, {total: nowUnix()}, {condition: new dynamoose.Condition('status').eq('open')});
  return db.transaction([OrderModel.transaction.delete({id})]);
}

export async function drop(id: string) {
  await (OrderModel as WithDelete<typeof OrderModel>).delete({id});
}

export async function reopen(id: string) {
  const order = (await OrderModel.get({id})) as unknown as Saved<Order>;
  await order.save();
}

export const ordersTable = () => OrderModel.table().name;
