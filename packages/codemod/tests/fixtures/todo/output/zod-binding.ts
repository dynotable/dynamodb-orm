import dynamoose from '@acme/dynamoose';
import {string as z} from 'zod';

// z is zod's string(), not the zod namespace the converted schema needs.
export const name = z();
// TODO(dynotable-orm-codemod): model(): z is bound to something other than zod in this file
export const Tag = dynamoose.model('Tag', new dynamoose.Schema({id: {type: String, hashKey: true}}));
