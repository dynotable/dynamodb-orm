import dynamoose from '@acme/dynamoose';
import {z} from 'zod';

// z is zod itself, not @acme/shared/zod: the schema must not read it, and no second z may be imported.
export const Id = z.string();
// TODO(dynotable-orm-codemod): model(): z is bound to something other than @acme/shared/zod in this file
export const Tag = dynamoose.model('Tag', new dynamoose.Schema({id: {type: String, hashKey: true}}));
