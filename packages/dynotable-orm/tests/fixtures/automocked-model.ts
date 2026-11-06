import {z} from 'zod';
import {model} from '../../src/index.js';

/** A model module for `vi.mock` automocking. */
export const Automocked = model('Automocked', z.object({id: z.string()}), {hashKey: 'id'});
