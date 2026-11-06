import {createOrderModel, type Order} from '#models';

const describeOrders = () => 'orders';

export const ShopOrderModel = createOrderModel().extend({
  /** Orders still open. */
  async openOrders() {
    return this.query('status').eq('open').exec();
  },
  /**
   * Orders with a total, by status.
   * @param status
   */
  async byStatus(status: string) {
    const found = await this.query('status').eq(status).exec();
    return found.filter((o) => o.total > 0);
  },
  /**
   * How many of the ids have the status.
   * @param status - the status
   * @param ids
   */
  async totals(status?: any, ...ids: any[]) {
    const found = await this.query('status').eq(status).exec();
    return found.filter((o) => ids.includes(o.id)).length;
  },
  /**
   * The orders of a status, with a total.
   * @param root0
   * @param root0.status
   * @param total
   * @returns the orders
   */
  async pick({status}: any, total?: any) {
    return (await this.query('status').eq(status).exec()).filter((o) => o.total === (total ?? o.total));
  },
  async latest(id: string) {
    return (await this.get({id}))!;
  },
  // A `this` parameter typed with the model itself.
  async byTotal(total: number) {
    return (await this.query('status').eq('open').exec()).filter((o) => o.total === total);
  },
  /**
   * The first of the ids, after the others are counted.
   * @param ids - which orders
   * @param ids.0
   * @param root1
   * @param root1.limit
   */
  async firstOf([first, ...others]: string[], {limit}: {limit: number}) {
    return (await this.get({id: first}))?.total ?? others.length + limit;
  },
  describe: describeOrders,
  count: countOrders
});

function countOrders() {
  return 0;
}

export const openOrders = () => ShopOrderModel.openOrders();

// Typed as this model's item: save() writes it back to this model.
export async function closeLatest(id: string) {
  const order: Order = await ShopOrderModel.latest(id);
  order.status = 'closed';
  await ShopOrderModel.create(order, {overwrite: true, keepCreatedAt: true});
}
