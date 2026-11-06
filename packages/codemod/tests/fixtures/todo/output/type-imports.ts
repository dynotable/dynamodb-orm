import {model} from 'dynotable-orm';
// TODO(dynotable-orm-codemod): Condition: imported as a type only, but the rewritten code needs its value: drop "type", then run again
import type {Condition} from 'dynotable-orm';
// TODO(dynotable-orm-codemod): z: imported as a type only, but the converted schemas need its value: drop "type", then run again
import type {z} from 'zod';

// Both names are imported as types only: the rewritten code needs their values.
export const open = new Condition('status').eq('open');
export const none: Condition | undefined = undefined;
export const Event = model('Event', z.object({
  id: z.string()
}), {hashKey: 'id'});
export type Id = z.ZodString;
