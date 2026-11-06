import dynamoose from '@acme/dynamoose';
import type {Condition} from 'dynotable-orm';
import type {z} from 'zod';

// Both names are imported as types only: the rewritten code needs their values.
export const open = new dynamoose.Condition('status').eq('open');
export const none: Condition | undefined = undefined;
export const Event = dynamoose.model('Event', new dynamoose.Schema({id: {type: String, hashKey: true}}));
export type Id = z.ZodString;
