import {getClient, orm, setClient} from 'dynotable-orm';
import {DynamoDB} from '@aws-sdk/client-dynamodb';
import {type Order, OrderModel} from '#models';

declare const vi: {spyOn(target: object, member: string): {mockResolvedValue(value: unknown): unknown}};
declare const expect: {
  (value: unknown): {toBeInstanceOf(type: unknown): void};
  any(type: unknown): unknown;
};

export class Payment {
  id!: string;
}
export interface Refund {
  id: string;
}

export function spies() {
  const order = new OrderModel({id: '1', status: 'open', total: 1});
  vi.spyOn(OrderModel, 'create').mockResolvedValue(order);
  let later;
  later = new OrderModel({id: '2', status: 'open', total: 2});
  void later;
  vi.spyOn(OrderModel, 'create');
  vi.spyOn(OrderModel, 'create');
  vi.spyOn(OrderModel, 'withDefaults');
  vi.spyOn(orm, 'transaction').mockResolvedValue({});
  expect(order).toBeInstanceOf(Object);
  return expect.any(Object);
}

export async function defaults(id: string) {
  let order = await OrderModel.get({id});
  order = new OrderModel({id, status: 'open', total: 0});
  return OrderModel.withDefaults(order);
}

export function clients() {
  const ddb = Object.assign(() => getClient(), {set: (client: unknown) => setClient(client as never), revert: () => setClient()});
  ddb.set({});
  ddb.revert();
  setClient(new DynamoDB({region: 'eu-west-1'}));
  setClient();
}

export function removed(update: Partial<Order>) {
  update.status = undefined as never;
  return update;
}

export const tableNames = (models: (typeof OrderModel)[]) => models.map((model) => model.tableName);

const Wrapped = Object.assign(OrderModel, {
  safeGet: (key: {id: string}) => OrderModel.get(key) as Promise<Order & {note?: string}>
});

export async function items(id: string) {
  const order = await OrderModel.get({id});
  await (order == null ? undefined : OrderModel.delete(order));
  const made = new OrderModel({id, status: 'open', total: 0});
  await OrderModel.delete(made);
  const wrapped = await Wrapped.safeGet({id});
  await Wrapped.create(wrapped, {overwrite: true, keepCreatedAt: true});
}

export const spied = () => orm.transaction;
