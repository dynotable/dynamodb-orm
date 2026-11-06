import {model} from 'dynotable-orm';
import {z} from 'zod';

export class Ticket {
  id!: string;
}

export const TicketModel = model('Ticket', z.object({
  id: z.string()
}), {hashKey: 'id'});
