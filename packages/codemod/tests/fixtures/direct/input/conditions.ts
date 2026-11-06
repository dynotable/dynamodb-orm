import dynamoose from '@acme/dynamoose';
import {OrderModel} from '#models';

export const openOnly = new dynamoose.Condition('status').eq('open');

export const rawOpen = new dynamoose.Condition({
  ConditionExpression: '#s = :s',
  ExpressionAttributeNames: {'#s': 'status'},
  ExpressionAttributeValues: {':s': {S: 'open'}}
});

export type AnyCondition = InstanceType<typeof dynamoose.Condition>;

export const eqDescriptor = Object.getOwnPropertyDescriptor(dynamoose.Condition.prototype, 'eq');

export async function cancel(id: string) {
  await OrderModel.update({id}, {status: 'cancelled'}, {condition: new dynamoose.Condition('status').eq('open')});
  await OrderModel.delete({id}, {condition: new dynamoose.Condition().where('total').eq(0)});
  return OrderModel.query(new dynamoose.Condition('status').eq('open')).exec();
}
