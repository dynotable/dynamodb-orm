import {Condition} from 'dynotable-orm';
import {OrderModel} from '#models';

export const openOnly = new Condition('status').eq('open');

export const rawOpen = new Condition({
  ConditionExpression: '#s = :s',
  ExpressionAttributeNames: {'#s': 'status'},
  ExpressionAttributeValues: {':s': {S: 'open'}}
});

export type AnyCondition = Condition;

export const eqDescriptor = Object.getOwnPropertyDescriptor(Condition.prototype, 'eq');

export async function cancel(id: string) {
  await OrderModel.update({id}, {status: 'cancelled'}, {condition: OrderModel.condition().where('status').eq('open')});
  await OrderModel.delete({id}, {condition: OrderModel.condition().where('total').eq(0)});
  return OrderModel.query(OrderModel.condition().where('status').eq('open')).exec();
}
