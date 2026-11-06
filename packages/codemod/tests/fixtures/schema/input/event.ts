import dynamoose from '@acme/dynamoose';

const lowerKind = (item: Record<string, unknown>) => ({...item, kind: String(item.kind).toLowerCase()});

/** Events keep what the sender adds under `meta`. */
export const eventSchema = new dynamoose.Schema(
  {
    pk: {type: dynamoose.type.COMBINE(['kind', 'ref']), hashKey: true},
    kind: {type: String, required: true},
    ref: {type: String, required: true},
    meta: {type: Object, schema: {source: String}},
    'trace-id': String
  },
  {
    saveUnknown: ['meta.**'],
    timestamps: {createdAt: {created: Number}, updatedAt: {modified: {type: {value: Date, settings: {storage: 'iso'}}}}},
    set: lowerKind
  }
);

export const Event = dynamoose.model('Event', eventSchema);
export const ArchivedEvent = dynamoose.model('ArchivedEvent', eventSchema, {prefix: 'archive-'});

export const Note = dynamoose.model('Note', {id: String, text: String}, {suffix: '-v2'});
export const Raw = dynamoose.model('Raw', new dynamoose.Schema({id: String, at: Date}));

export const auditSchema = new dynamoose.Schema(
  {id: String, body: {type: Object, schema: {kind: String}}, note: Object},
  {saveUnknown: true, timestamps: {createdAt: 'at'}}
);
export const Audit = dynamoose.model('Audit', auditSchema);
