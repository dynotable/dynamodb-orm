import {model} from 'dynotable-orm';
import {z} from 'zod';

const orderSchema = z.object({
  id: z.string(),
  status: z.string(),
  total: z.number(),
  createdAt: z.date().optional(),
  updatedAt: z.date().optional()
});
const options = {hashKey: 'id', indexes: {status: {name: 'status-index', type: 'global'}}, timestamps: true} as const;

export const OrderModel = model('Order', orderSchema, options);
export const createOrderModel = () => model('Order', orderSchema, options);

export type Order = z.output<typeof orderSchema>;
