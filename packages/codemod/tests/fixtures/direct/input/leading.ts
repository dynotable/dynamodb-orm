import dynamoose from '@acme/dynamoose';
import type {ItemSaveSettings} from '@acme/dynamoose/dist/Item';
import {toJSON as Condition} from 'dynotable-orm';

// Two dynamoose imports go from the top of the file, and the file's own Condition is dynotable-orm's toJSON.
export const open = new dynamoose.Condition('status').eq('open');
export const settings: ItemSaveSettings | undefined = undefined;
export const json = Condition;
