import {model} from 'dynotable-orm';
import {z} from '@acme/shared/zod';

// A named z of the module is the same Zod: no namespace import beside it, which would bind z twice.
export const Code = z.string().length(3);
export const Country = model('Country', z.object({
  code: z.string()
}), {hashKey: 'code'});
