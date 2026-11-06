import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {ConfigError} from '../../src/errors.js';
import {model} from '../../src/model.js';
import {resolveMetadata} from '../../src/plan.js';
import {combine, getDynamoMeta, hashKey, index, rangeKey, storage} from '../../src/zod/index.js';

describe('getDynamoMeta', () => {
  it('survives checks, metadata calls and wrappers', () => {
    const k = hashKey(z.string());
    const derived = {
      min: k.min(1),
      describe: k.describe('id'),
      meta: k.meta({title: 'id'}),
      refine: k.refine(() => true),
      optional: k.optional(),
      nullable: k.nullable(),
      default: k.default('a'),
      catch: k.catch('a'),
      readonly: k.readonly(),
      transform: k.transform((v) => v),
      pipeIn: k.pipe(z.string()),
      pipeOut: z.string().pipe(k),
      chained: k.min(1).optional().describe('id'),
      // An extension that annotates a copy with its own def, as a Zod plugin can.
      defCopy: k.clone({...k._zod.def})
    };
    for (const [name, s] of Object.entries(derived)) {
      expect(getDynamoMeta(s), name).toStrictEqual({hashKey: true});
    }
  });

  it('marks a clone and never its base', () => {
    const base = z.string();
    const key = hashKey(base);
    const indexed = index(key, {name: 'byId'});
    expect(getDynamoMeta(base)).toBeUndefined();
    expect(getDynamoMeta(key)).toStrictEqual({hashKey: true});
    expect(getDynamoMeta(indexed)).toStrictEqual({hashKey: true, index: [{name: 'byId'}]});
  });
});

describe('resolveMetadata with field metadata', () => {
  const base = z.object({
    id: hashKey(z.string()),
    sk: rangeKey(z.number()),
    at: storage(z.date(), 'seconds'),
    x: z.string()
  });

  it('walks the shape after pick, partial, extend and omit', () => {
    expect(resolveMetadata(base.pick({id: true, at: true}))).toMatchObject({
      key: {hash: 'id'},
      dates: new Map([['at', 'seconds']])
    });
    expect(resolveMetadata(base.partial()).key).toStrictEqual({hash: 'id', range: 'sk'});
    expect(resolveMetadata(base.omit({sk: true})).key).toStrictEqual({hash: 'id'});
    const extended = base.extend({
      status: index(z.string()),
      k: combine(z.string(), ['x', 'id'], '#')
    });
    expect(resolveMetadata(extended)).toMatchObject({
      indexes: [{name: 'statusGlobalIndex', type: 'global', hash: 'status', project: true}],
      combine: [{target: 'k', sources: ['x', 'id'], separator: '#', isKey: false}]
    });
  });

  it('reads Date storage on a nested field', () => {
    const schema = z.object({
      id: z.string(),
      n: z.object({at: storage(z.date(), 'milliseconds')}).optional()
    });
    expect(resolveMetadata(schema, {hashKey: 'id'}).dates).toStrictEqual(
      new Map([['n.at', 'milliseconds']])
    );
  });

  it("reads Date storage from a union's Date option", () => {
    const at = z.union([storage(z.date(), 'seconds'), z.number()]).optional();
    expect(resolveMetadata(z.object({id: z.string(), at}), {hashKey: 'id'}).dates).toStrictEqual(
      new Map([['at', 'seconds']])
    );
  });

  it('gives one hash key when a field instance is shared by two models', () => {
    const id = z.string();
    expect(resolveMetadata(z.object({pk: hashKey(id), copy: id})).key).toStrictEqual({hash: 'pk'});
  });

  it('rejects two hash keys from a field and an option', () => {
    expect(() =>
      resolveMetadata(z.object({id: hashKey(z.string()), pk: z.string()}), {hashKey: 'pk'})
    ).toThrow(new ConfigError("two hash keys: 'pk' (options.hashKey) and 'id' (field)"));
  });

  it('rejects two range keys from two fields', () => {
    const schema = z.object({id: z.string(), a: rangeKey(z.string()), b: rangeKey(z.number())});
    expect(() => resolveMetadata(schema, {hashKey: 'id'})).toThrow(
      new ConfigError("two range keys: 'a' (field) and 'b' (field)")
    );
  });

  it('rejects a field setting that conflicts with the options', () => {
    expect(() => resolveMetadata(base, {dates: {at: 'iso'}})).toThrow(
      new ConfigError(`'at' has "seconds" in its field metadata but "iso" in options.dates`)
    );
  });

  // Probe: each stored {S: '1970-01-01T00:00:01.500Z'}, the default storage, before the marks below a list, a
  // record or a union were read.
  describe('Date storage below a list, a record and a union', () => {
    const seconds = () => storage(z.date(), 'seconds');
    const stored = async (fields: z.ZodRawShape, item: Record<string, unknown>) =>
      (
        await model('T', z.object({id: z.string(), ...fields}), {hashKey: 'id'}).create(
          {id: 'a', ...item},
          {return: 'request'}
        )
      ).Item;
    const at = new Date(1500);

    it('in a list element', async () => {
      expect(
        await stored({rows: z.array(z.object({at: seconds()}))}, {rows: [{at}]})
      ).toStrictEqual({
        id: {S: 'a'},
        rows: {L: [{M: {at: {N: '2'}}}]}
      });
    });

    it('in a record value', async () => {
      expect(
        await stored({byDay: z.record(z.string(), seconds())}, {byDay: {mon: at}})
      ).toStrictEqual({
        id: {S: 'a'},
        byDay: {M: {mon: {N: '2'}}}
      });
    });

    it('in a discriminated union option', async () => {
      const event = z.discriminatedUnion('kind', [
        z.object({kind: z.literal('a'), at: seconds()}),
        z.object({kind: z.literal('b')})
      ]);
      expect(await stored({event}, {event: {kind: 'a', at}})).toStrictEqual({
        id: {S: 'a'},
        event: {M: {kind: {S: 'a'}, at: {N: '2'}}}
      });
    });
  });

  it('rejects a key, an index or a combine mark below a list', () => {
    const schema = z.object({id: z.string(), rows: z.array(z.object({pk: hashKey(z.string())}))});
    expect(() => resolveMetadata(schema, {hashKey: 'id'})).toThrow(
      new ConfigError(
        "'rows[].pk' is nested: only a top-level field can be a key, an index or a combine target"
      )
    );
  });

  it('rejects a key, index or combine field the schema does not declare, which Zod would strip', () => {
    const schema = z.object({id: z.string(), a: z.string()});
    expect(() => resolveMetadata(schema, {hashKey: 'pk'})).toThrow(
      new ConfigError("'pk' (the hash key) is not declared in the schema")
    );
    expect(() => resolveMetadata(schema, {hashKey: 'id', indexes: {a: {rangeKey: 'b'}}})).toThrow(
      new ConfigError("'b' (index aGlobalIndex) is not declared in the schema")
    );
    expect(() => resolveMetadata(schema, {hashKey: 'id', combine: {k: {sources: ['a']}}})).toThrow(
      new ConfigError("'k' (the combine of k) is not declared in the schema")
    );
  });

  it('rejects a timestamp field it cannot check synchronously', () => {
    const schema = z.object({
      id: z.string(),
      createdAt: z
        .date()
        .optional()
        .refine(async () => true)
    });
    expect(() => resolveMetadata(schema, {hashKey: 'id', timestamps: {createdAt: {}}})).toThrow(
      new ConfigError(
        "the timestamp field 'createdAt' validates asynchronously, so model() cannot check that it accepts absence: make its checks sync"
      )
    );
  });

  it('rejects a key on a nested field', () => {
    const schema = z.object({id: z.string(), n: z.object({pk: hashKey(z.string())})});
    expect(() => resolveMetadata(schema, {hashKey: 'id'})).toThrow(
      new ConfigError(
        "'n.pk' is nested: only a top-level field can be a key, an index or a combine target"
      )
    );
  });
});
