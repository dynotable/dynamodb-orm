import {Condition as C, Condition, isConditionalCheckFailed as ormIsConditionalCheckFailed, toJSON as ormToJSON} from 'dynotable-orm';
import {OrderModel} from '#models';

const toJSON = (value: unknown) => JSON.stringify(value);

export async function dump(id: string) {
  const order = await OrderModel.get({id});
  return toJSON(ormToJSON(order!));
}

export const open = new C('status').eq('open');
export const paid = new Condition('status').eq('paid');
export const none: Condition | undefined = undefined;

const isConditionalCheckFailed = (e: unknown) => e instanceof Error;
export const failed = (e: unknown) =>
  isConditionalCheckFailed(e) && ormIsConditionalCheckFailed(e);
