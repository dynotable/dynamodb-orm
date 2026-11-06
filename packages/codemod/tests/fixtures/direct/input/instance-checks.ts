import {type Order, OrderModel} from '#models';

declare const expect: {
  (value: unknown): {toBeInstanceOf(type: unknown): void};
  any(type: unknown): unknown;
};

// The model is named only as the class of its items: its import goes with those checks.
export function isOrder(order: Order) {
  expect(order).toBeInstanceOf(OrderModel);
  return expect.any(OrderModel);
}
