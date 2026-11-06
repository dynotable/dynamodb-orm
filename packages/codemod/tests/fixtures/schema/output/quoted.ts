import {model} from 'dynotable-orm';
import {z} from 'zod';

export const quotedSchema = z.object({
  "it's": z.string(),
  n: z.number().optional()
});
export const quotedOptions = {hashKey: 'it\'s'} as const;

export const Quoted = model('Quoted', quotedSchema, quotedOptions);
