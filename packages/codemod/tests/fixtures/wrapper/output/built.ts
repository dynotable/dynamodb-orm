import {nowIso} from '#built';
import {Condition, transaction as ormTransaction} from '#db';
import {OrderModel} from '#models';

export async function close(id: string) {
  await OrderModel.update({id}, {status: nowIso()}, {condition: OrderModel.condition().where('status').eq('open')});
}

export const exists = () => new Condition().attribute('id').exists();

export async function place(id: string) {
  const put = await OrderModel.transaction.create({id, status: 'open', total: 1});
  put.Put.ReturnValuesOnConditionCheckFailure = 'ALL_OLD';
  const transaction = [put];
  await ormTransaction(transaction);
}
