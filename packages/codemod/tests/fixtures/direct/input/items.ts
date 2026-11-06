import type {AttributeValue} from '@aws-sdk/client-dynamodb';
import {type Order, OrderModel} from '#models';

export async function place(id: string) {
  const order = new OrderModel({id, status: 'open', total: 10});
  await order.save();
  await new OrderModel({id: `${id}-copy`, status: 'open', total: 0}).save();
  return order.toJSON();
}

export async function close(id: string) {
  const order = await OrderModel.get({id});
  if (!order) return;
  order.status = 'closed';
  await order.save();
}

export async function fromStream(image: Record<string, AttributeValue>) {
  return new OrderModel(image).conformToSchema({type: 'fromDynamo'});
}

export function fromImage(image: Record<string, AttributeValue>) {
  return new OrderModel(image as never).conformToSchema({type: 'fromDynamo', customTypesDynamo: true, saveUnknown: true, modifiers: ['get']}) as Promise<Order>;
}

export async function tableInfo() {
  OrderModel.table();
  return {
    name: OrderModel.table().name,
    hashKey: OrderModel.table().hashKey,
    input: await OrderModel.table().create({return: 'request'})
  };
}

export function statusOf(order: Order) {
  return order.toJSON().status;
}

export async function find(id: string) {
  const order = await OrderModel.get({id});
  const all = await OrderModel.scan().exec();
  return [order?.toJSON(), all[0]?.toJSON()];
}

export async function rename(id: string) {
  const stored = await OrderModel.get({id});
  stored!.status = 'renamed';
  await stored!.save();
}

export function viaCast(order: Order) {
  return (order as unknown as {toJSON(): {id: string}}).toJSON();
}

export async function pickedId(id: string) {
  const picked = (await OrderModel.get({id})) as unknown as {id: string};
  return (picked as unknown as {toJSON(): {id: string}}).toJSON();
}

export async function maybePicked(id: string, read: boolean) {
  const picked = read ? ((await OrderModel.get({id})) as unknown as {id: string}) : undefined;
  return picked && (picked as unknown as {toJSON(): {id: string}}).toJSON();
}

export async function saveIfFound(id: string) {
  const order = await OrderModel.get({id});
  await order?.save();
}
