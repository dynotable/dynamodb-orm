// A project's own module that re-exports dynamoose next to its helpers.
import dynamoose from '@acme/dynamoose';
import type {Item} from '@acme/dynamoose/dist/Item';

export {dynamoose};
export const db = dynamoose;
export const nowUnix = (): number => Math.floor(Date.now() / 1000);

// A wrapper's own model type, as a shared model factory declares it: `delete` is also a member of dynamoose's Item.
export type WithDelete<M> = Omit<M, 'delete'> & Item & {delete(key: {id: string}): Promise<void>};
// A wrapper's own item type: `save` is redeclared outside dynamoose.
export type Saved<T> = Omit<T, 'save'> & {save(): Promise<Saved<T>>};
