import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {optionsFromDynamoose, pairSchema} from '../equivalence/local/bridge.js';

// What a codebase's Zod extension writes: dynamoose attribute settings on `_def.dynamoose` of the instance it is called on.
const mark = <T extends z.ZodType>(schema: T, settings: object): T => {
  (schema._zod.def as {dynamoose?: object}).dynamoose = settings;
  return schema;
};
const seconds = {type: {value: Date, settings: {storage: 'seconds'}}};

describe('optionsFromDynamoose', () => {
  const set = (item: Record<string, unknown>) => item;
  const schema = z.object({
    pk: mark(z.string(), {hashKey: true}),
    sk: mark(z.string(), {rangeKey: true}),
    byOwner: mark(z.string(), {index: true}).optional(),
    byState: mark(z.string(), {index: [{name: 'a'}, {name: 'b', rangeKey: 'sk'}]}),
    joined: mark(z.string(), {
      type: {value: 'Combine', settings: {attributes: ['pk', 'sk'], separator: '#'}}
    }),
    meta: z.object({at: mark(z.date(), seconds).optional()}).optional(),
    // The converter takes a Date union's storage from its Date option.
    expireAt: z.union([mark(z.date(), seconds), z.number()]),
    createdAt: z.number().optional(),
    updatedAt: z.date().optional()
  });

  it('reads keys, indexes, combine, nested and union Date storage, timestamps and the hook', () => {
    const options = optionsFromDynamoose(schema, {
      hashKey: 'pk',
      rangeKey: 'sk',
      timestamps: {
        createdAt: {createdAt: {type: Number}},
        updatedAt: {updatedAt: {type: {value: Date, settings: {storage: 'iso'}}}}
      },
      set
    });
    expect(options).toStrictEqual({
      unknownKeys: 'dynamoose',
      defaultDateStorage: 'iso',
      hashKey: 'pk',
      rangeKey: 'sk',
      indexes: {byOwner: [{}], byState: [{name: 'a'}, {name: 'b', rangeKey: 'sk'}]},
      combine: {joined: {sources: ['pk', 'sk'], separator: '#'}},
      dates: {'meta.at': 'seconds', expireAt: 'seconds'},
      timestamps: {createdAt: {name: 'createdAt'}, updatedAt: {name: 'updatedAt', storage: 'iso'}},
      set
    });
  });

  it('refuses marks that disagree with the dynamoose schema keys', () => {
    expect(() => optionsFromDynamoose(schema, {hashKey: 'sk', rangeKey: 'pk'})).toThrow(
      'keys differ: marks give pk/sk, the dynamoose schema sk/pk'
    );
  });

  it('refuses a Date storage mark under a list', () => {
    const listed = z.object({
      id: mark(z.string(), {hashKey: true}),
      rows: z.array(z.object({at: mark(z.date(), seconds)}))
    });
    expect(() => optionsFromDynamoose(listed, {hashKey: 'id'})).toThrow(
      'a Date storage mark under a list (rows[].at) has no model option'
    );
  });
});

describe('pairSchema', () => {
  it('takes the one exported Zod object with the dynamoose attributes, timestamps aside', () => {
    const item = z.object({id: z.string(), name: z.string(), createdAt: z.date()});
    const exports = {item, alias: item, key: item.pick({id: true}), other: z.string()};
    expect(pairSchema(exports, ['name', 'id'])).toBe(item);
    expect(() => pairSchema({...exports, copy: item.extend({})}, ['id', 'name'])).toThrow(
      "2 exported Zod objects match the dynamoose schema's attributes"
    );
    expect(() => pairSchema(exports, ['id', 'missing'])).toThrow(
      "0 exported Zod objects match the dynamoose schema's attributes"
    );
  });
});
