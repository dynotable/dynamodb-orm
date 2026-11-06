import dynamoose from '@acme/dynamoose';
import * as z from '@acme/shared/zod';

// The file reads Zod through the module already: the converted schema uses that z, with no second import.
export const Email = z.email();
export const Contact = dynamoose.model('Contact', new dynamoose.Schema({id: {type: String, hashKey: true}}));
