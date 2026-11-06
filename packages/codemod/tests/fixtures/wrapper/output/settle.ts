import {nowUnix, type Saved, transaction, type WithDelete} from '#db';
import {type Order, OrderModel} from '#models';

export async function settle(id: string) {
  await OrderModel.update({id}, {total: nowUnix()}, {condition: OrderModel.condition().where('status').eq('open')});
  return transaction([OrderModel.transaction.delete({id})]);
}

export async function drop(id: string) {
  await (OrderModel as WithDelete<typeof OrderModel>).delete({id});
}

export async function reopen(id: string) {
  const order = (await OrderModel.get({id})) as unknown as Saved<Order>;
  await OrderModel.create(order, {overwrite: true, keepCreatedAt: true});
}

export const ordersTable = () => OrderModel.tableName;
