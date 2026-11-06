import type {AttributeValue} from '@aws-sdk/client-dynamodb';
import {type Order, OrderModel} from '#models';
import {toJSON} from 'dynotable-orm';

export async function place(id: string) {
  const order = new OrderModel({id, status: 'open', total: 10});
  await OrderModel.create(order, {overwrite: true});
  await OrderModel.create({id: `${id}-copy`, status: 'open', total: 0}, {overwrite: true});
  return toJSON(order);
}

export async function close(id: string) {
  const order = await OrderModel.get({id});
  if (!order) return;
  order.status = 'closed';
  await OrderModel.create(order, {overwrite: true, keepCreatedAt: true});
}

export async function fromStream(image: Record<string, AttributeValue>) {
  return OrderModel.fromStored(image);
}

export function fromImage(image: Record<string, AttributeValue>) {
  return Promise.resolve(OrderModel.fromStored(image as never)) as Promise<Order>;
}

export async function tableInfo() {
  return {
    name: OrderModel.tableName,
    hashKey: OrderModel.hashKey,
    input: await OrderModel.createTableInput()
  };
}

export function statusOf(order: Order) {
  return toJSON(order).status;
}

export async function find(id: string) {
  const order = await OrderModel.get({id});
  const all = await OrderModel.scan().exec();
  return [(order == null ? undefined : toJSON(order)), (all[0] == null ? undefined : toJSON(all[0]))];
}

export async function rename(id: string) {
  const stored = await OrderModel.get({id});
  stored!.status = 'renamed';
  await OrderModel.create(stored!, {overwrite: true, keepCreatedAt: true});
}

export function viaCast(order: Order) {
  return (toJSON(order) as {id: string});
}

export async function pickedId(id: string) {
  const picked = (await OrderModel.get({id})) as unknown as {id: string};
  return (toJSON(picked) as {id: string});
}

export async function maybePicked(id: string, read: boolean) {
  const picked = read ? ((await OrderModel.get({id})) as unknown as {id: string}) : undefined;
  return picked && (toJSON(picked) as {id: string});
}

export async function saveIfFound(id: string) {
  const order = await OrderModel.get({id});
  await (order == null ? undefined : OrderModel.create(order, {overwrite: true, keepCreatedAt: true}));
}
