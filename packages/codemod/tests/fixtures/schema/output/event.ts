import {model, type ModelOptions} from 'dynotable-orm';
import {z} from 'zod';

const lowerKind = (item: Record<string, unknown>) => ({...item, kind: String(item.kind).toLowerCase()});

/** Events keep what the sender adds under `meta`. */
export const eventSchema = z.object({
  pk: z.string(),
  kind: z.string(),
  ref: z.string(),
  meta: z.looseObject({
    source: z.string().optional()
  }).optional(),
  'trace-id': z.string().optional(),
  created: z.number().optional(),
  modified: z.date().optional()
});
export const eventOptions = {hashKey: 'pk', combine: {pk: {sources: ['kind', 'ref']}}, timestamps: {createdAt: {name: 'created'}, updatedAt: {name: 'modified', storage: 'iso'}}, set: lowerKind} as const satisfies ModelOptions<z.output<typeof eventSchema>>;

export const Event = model('Event', eventSchema, eventOptions);
export const ArchivedEvent = model('ArchivedEvent', eventSchema, {...eventOptions, prefix: 'archive-'});

export const Note = model('Note', z.object({
  id: z.string(),
  text: z.string().optional()
}), {hashKey: 'id', suffix: '-v2'});
export const Raw = model('Raw', z.object({
  id: z.string(),
  at: z.date().optional()
}), {hashKey: 'id'});

export const auditSchema = z.looseObject({
  id: z.string(),
  body: z.looseObject({
    kind: z.string().optional()
  }).optional(),
  note: z.looseObject({}).optional(),
  at: z.date().optional()
});
export const auditOptions = {hashKey: 'id', timestamps: {createdAt: {name: 'at'}}} as const;
export const Audit = model('Audit', auditSchema, auditOptions);
