import {transaction as ormTransaction, nowUnix as transaction} from '#db';
import {OrderModel} from '#models';

// `transaction` is the wrapper's own helper here, and it stays: dynamoose's transaction takes another name.
export const stamp = () => transaction();
export const close = (id: string) => ormTransaction([OrderModel.transaction.delete({id})]);
