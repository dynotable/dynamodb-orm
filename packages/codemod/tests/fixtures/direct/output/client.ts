import {DynamoDB} from '@aws-sdk/client-dynamodb';
import {converter, getClient, isConditionalCheckFailed, type QueryResponse, setClient, setDefaults, transaction} from 'dynotable-orm';
import {type Order, OrderModel} from '#models';

setClient(new DynamoDB({region: 'eu-west-1'}));
setDefaults({prefix: 'shop-', suffix: '-dev'});

export const client = getClient();
export const stored = converter.marshall({id: '1'});

export async function pay(id: string): Promise<QueryResponse<Order> | undefined> {
  try {
    await transaction([OrderModel.transaction.update({id}, {status: 'paid'})]);
    await OrderModel.update({id}, {status: 'paid'});
  } catch (e) {
    if (isConditionalCheckFailed(e)) return undefined;
    if ((e as Error | undefined)!.name === 'ConditionalCheckFailedException') return undefined;
    if ((e as Error).name !== 'ConditionalCheckFailedException') throw e;
  }
  return OrderModel.query('status').eq('paid').exec();
}
