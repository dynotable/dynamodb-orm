import dynamoose from '@acme/dynamoose';

export const quotedSchema = new dynamoose.Schema({"it's": {type: String, hashKey: true}, n: Number});

export const Quoted = dynamoose.model('Quoted', quotedSchema, {create: false, waitForActive: false});
