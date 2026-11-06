import {createOrderModel, type Order} from '#models';

interface Methods {
  openOrders(): Promise<unknown>;
  byStatus(status: string): Promise<unknown>;
  totals(status: string, ...ids: string[]): Promise<number>;
  pick(from: {status: string}, total?: number): Promise<unknown>;
  latest(id: string): Promise<Order>;
  byTotal(total: number): Promise<unknown>;
  firstOf(ids: string[], options: {limit: number}): Promise<unknown>;
}

const describeOrders = () => 'orders';

export const ShopOrderModel = createOrderModel() as ReturnType<typeof createOrderModel> & Methods;

/** Orders still open. */
ShopOrderModel.methods.set('openOrders', async () => ShopOrderModel.query('status').eq('open').exec());

/** Orders with a total, by status. */
ShopOrderModel.methods.set('byStatus', async function (status: string) {
  const found = await ShopOrderModel.query('status').eq(status).exec();
  return found.filter((o) => o.total > 0);
});

/**
 * How many of the ids have the status.
 * @param status - the status
 */
ShopOrderModel.methods.set('totals', async function (status, ...ids) {
  const found = await ShopOrderModel.query('status').eq(status).exec();
  return found.filter((o) => ids.includes(o.id)).length;
});

/**
 * The orders of a status, with a total.
 * @returns the orders
 */
ShopOrderModel.methods.set('pick', async function ({status}, total) {
  return (await ShopOrderModel.query('status').eq(status).exec()).filter((o) => o.total === (total ?? o.total));
});

ShopOrderModel.methods.set('latest', async function (id: string) {
  return (await ShopOrderModel.get({id}))!;
});

// A `this` parameter typed with the model itself.
ShopOrderModel.methods.set('byTotal', async function (this: typeof ShopOrderModel, total: number) {
  return (await this.query('status').eq('open').exec()).filter((o) => o.total === total);
});

/**
 * The first of the ids, after the others are counted.
 * @param ids - which orders
 */
ShopOrderModel.methods.set('firstOf', async function ([first, ...others]: string[], {limit}: {limit: number}) {
  return (await ShopOrderModel.get({id: first}))?.total ?? others.length + limit;
});

ShopOrderModel.methods.set('describe', describeOrders);

ShopOrderModel.methods.set('count', countOrders);

function countOrders() {
  return 0;
}

export const openOrders = () => ShopOrderModel.openOrders();

// Typed as this model's item: save() writes it back to this model.
export async function closeLatest(id: string) {
  const order: Order = await ShopOrderModel.latest(id);
  order.status = 'closed';
  await order.save();
}
