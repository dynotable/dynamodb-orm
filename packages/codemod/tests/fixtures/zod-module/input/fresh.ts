import dynamoose from '@acme/dynamoose';

// The project allows Zod only through @acme/shared/zod: the converted schema must not import zod itself.
export const Note = dynamoose.model('Note', new dynamoose.Schema({id: {type: String, hashKey: true}, text: String}));
