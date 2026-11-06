import dynamoose from '@acme/dynamoose';
import * as z from 'zod';

const touch = (item: Record<string, unknown>) => ({...item, touched: true});

// The file's own ModelOptions: the generated options satisfy dynotable-orm's under another name.
type ModelOptions = {label: string};
export const labelled: ModelOptions = {label: 'note'};

export const noteSchema = new dynamoose.Schema({id: {type: String, hashKey: true}}, {set: touch});
export const Note = dynamoose.model('Note', noteSchema);

// A namespace import of zod is the z the converted schemas read.
export const id = z.string();
