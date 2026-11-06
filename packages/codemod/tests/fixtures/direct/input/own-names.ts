import dynamoose from '@acme/dynamoose';
import {Condition as C, type Condition} from 'dynotable-orm';
import {OrderModel} from '#models';
import {ConditionalCheckFailedException} from '@aws-sdk/client-dynamodb';

const toJSON = (value: unknown) => JSON.stringify(value);

export async function dump(id: string) {
  const order = await OrderModel.get({id});
  return toJSON(order!.toJSON());
}

export const open = new C('status').eq('open');
export const paid = new dynamoose.Condition('status').eq('paid');
export const none: Condition | undefined = undefined;

const isConditionalCheckFailed = (e: unknown) => e instanceof Error;
export const failed = (e: unknown) =>
  isConditionalCheckFailed(e) && e instanceof ConditionalCheckFailedException;
