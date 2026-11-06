import {model} from 'dynotable-orm';
import * as z from '@acme/shared/zod';

// The file reads Zod through the module already: the converted schema uses that z, with no second import.
export const Email = z.email();
export const Contact = model('Contact', z.object({
  id: z.string()
}), {hashKey: 'id'});
