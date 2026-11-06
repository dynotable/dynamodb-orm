import dynamoose from '@acme/dynamoose';
import {Item} from '@acme/dynamoose/dist/Item';
import {type Order, OrderModel} from '#models';

declare const vi: {spyOn(target: object, member: string): {mockResolvedValue(value: unknown): unknown}};
declare const expect: {
  (value: unknown): {toBeInstanceOf(type: unknown): void};
  any(type: unknown): unknown;
};

export class Payment extends Item {
  id!: string;
}
export interface Refund extends Item {
  id: string;
}

export function spies() {
  const order = new OrderModel({id: '1', status: 'open', total: 1});
  vi.spyOn(order, 'save').mockResolvedValue(order);
  let later;
  later = new OrderModel({id: '2', status: 'open', total: 2});
  void later;
  vi.spyOn(later, 'save');
  vi.spyOn(OrderModel.prototype, 'save');
  vi.spyOn(OrderModel.prototype, 'withDefaults');
  vi.spyOn(dynamoose, 'transaction').mockResolvedValue({});
  expect(order).toBeInstanceOf(OrderModel);
  return expect.any(OrderModel);
}

export async function defaults(id: string) {
  let order = await OrderModel.get({id});
  order = new OrderModel({id, status: 'open', total: 0});
  return order.withDefaults();
}

export function clients() {
  const ddb = (dynamoose as unknown as {aws: {ddb: {set(client: unknown): void; revert(): void}}}).aws.ddb;
  ddb.set({});
  ddb.revert();
  dynamoose.aws.ddb.set(new dynamoose.aws.ddb.DynamoDB({region: 'eu-west-1'}));
  dynamoose.aws.ddb.revert();
}

export function removed(update: Partial<Order>) {
  update.status = dynamoose.type.UNDEFINED as never;
  return update;
}

export const tableNames = (models: (typeof OrderModel)[]) => models.map((model) => model.table().name);

const Wrapped = Object.assign(OrderModel, {
  safeGet: (key: {id: string}) => OrderModel.get(key) as Promise<Order & {note?: string}>
});

export async function items(id: string) {
  const order = await OrderModel.get({id});
  await order?.delete();
  const made = new OrderModel({id, status: 'open', total: 0});
  await made.delete();
  const wrapped = await Wrapped.safeGet({id});
  await wrapped.save();
}

export const spied = () => dynamoose.transaction;
