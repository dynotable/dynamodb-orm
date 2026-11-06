import dynamoose from '@acme/dynamoose';
import {Item} from '@acme/dynamoose/dist/Item';

export class Ticket extends Item {
  id!: string;
}
// Only the type argument of model() uses it: it goes with the type argument.
interface Methods {
  label(): string;
}

export const TicketModel = dynamoose.model<Ticket & Methods>('Ticket', new dynamoose.Schema({id: String}));
