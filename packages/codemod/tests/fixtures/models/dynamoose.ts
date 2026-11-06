import dynamoose from '@acme/dynamoose';
import {Item} from '@acme/dynamoose/dist/Item';

export class Order extends Item {
  id!: string;
  status!: string;
  total!: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export class Customer extends Item {
  id!: string;
  name!: string;
}

const orderSchema = new dynamoose.Schema(
  {
    id: {type: String, hashKey: true},
    status: {type: String, index: {name: 'status-index', type: 'global'}},
    total: Number
  },
  {timestamps: true}
);

export const OrderModel = dynamoose.model<Order>('Order', orderSchema);
export const createOrderModel = () => dynamoose.model<Order>('Order', orderSchema);
// The module may assign another model to it.
export let ReplaceableOrderModel = dynamoose.model<Order>('Order', orderSchema);
export const replaceOrderModel = () => {
  ReplaceableOrderModel = createOrderModel();
};
