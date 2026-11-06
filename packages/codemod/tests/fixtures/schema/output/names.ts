import {model, type ModelOptions as ormModelOptions} from 'dynotable-orm';
import * as z from 'zod';

const touch = (item: Record<string, unknown>) => ({...item, touched: true});

// The file's own ModelOptions: the generated options satisfy dynotable-orm's under another name.
type ModelOptions = {label: string};
export const labelled: ModelOptions = {label: 'note'};

export const noteSchema = z.object({
  id: z.string()
});
export const noteOptions = {hashKey: 'id', set: touch} as const satisfies ormModelOptions<z.output<typeof noteSchema>>;
export const Note = model('Note', noteSchema, noteOptions);

// A namespace import of zod is the z the converted schemas read.
export const id = z.string();
