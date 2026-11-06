import dynamoose from '@acme/dynamoose';
import {z} from '@acme/shared/zod';

// A named z of the module is the same Zod: no namespace import beside it, which would bind z twice.
export const Code = z.string().length(3);
export const Country = dynamoose.model('Country', new dynamoose.Schema({code: {type: String, hashKey: true}}));
