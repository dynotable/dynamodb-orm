import {toJSON as Condition, type CreateOptions, Condition as ormCondition} from 'dynotable-orm';

// Two dynamoose imports go from the top of the file, and the file's own Condition is dynotable-orm's toJSON.
export const open = new ormCondition('status').eq('open');
export const settings: CreateOptions | undefined = undefined;
export const json = Condition;
