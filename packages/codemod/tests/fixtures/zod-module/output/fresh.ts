import {model} from 'dynotable-orm';
import * as z from '@acme/shared/zod';

// The project allows Zod only through @acme/shared/zod: the converted schema must not import zod itself.
export const Note = model('Note', z.object({
  id: z.string(),
  text: z.string().optional()
}), {hashKey: 'id'});
