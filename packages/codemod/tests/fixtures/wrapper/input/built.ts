import {dynamoose, nowIso} from '#built';
import {OrderModel} from '#models';

export async function close(id: string) {
  await OrderModel.update({id}, {status: nowIso()}, {condition: new dynamoose.Condition('status').eq('open')});
}

export const exists = () => new dynamoose.Condition().attribute('id').exists();

export async function place(id: string) {
  const put = await OrderModel.transaction.create({id, status: 'open', total: 1});
  put.Put.ReturnValuesOnConditionCheckFailure = 'ALL_OLD';
  const transaction = [put];
  await dynamoose.transaction(transaction);
}
