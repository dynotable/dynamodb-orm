import {ConditionalCheckFailedException, DynamoDB} from '@aws-sdk/client-dynamodb';
import dynamoose from '@acme/dynamoose';
import type {QueryResponse} from '@acme/dynamoose/dist/ItemRetriever';
import {type Order, OrderModel} from '#models';

dynamoose.aws.ddb.set(new DynamoDB({region: 'eu-west-1'}));
dynamoose.Table.defaults.set({prefix: 'shop-', suffix: '-dev', create: false, waitForActive: false});

export const client = dynamoose.aws.ddb();
export const stored = dynamoose.aws.converter().marshall({id: '1'});

export async function pay(id: string): Promise<QueryResponse<Order> | undefined> {
  try {
    await dynamoose.transaction([OrderModel.transaction.update({id}, {status: 'paid'})]);
    await OrderModel.update({id}, {status: 'paid'});
  } catch (e) {
    if (e instanceof ConditionalCheckFailedException) return undefined;
    if ((e as Error | undefined)!.name === 'ConditionalCheckFailedException') return undefined;
    if ((e as Error).name !== 'ConditionalCheckFailedException') throw e;
  }
  return OrderModel.query('status').eq('paid').exec();
}
