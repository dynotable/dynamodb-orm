import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {z as z3} from 'zod/v3';
import {ConfigError} from '../../src/errors.js';
import {resolveMetadata} from '../../src/plan.js';
import {zodAdapter} from '../../src/zod/walk.js';
import {fixtureSchema} from '../fixtures/standard-schema.js';

const value = {type: 'value'};
const date = {type: 'date'};
const object = (fields: Record<string, unknown>, rest?: unknown) => ({
  type: 'object',
  fields: new Map(Object.entries(fields)),
  ...(rest === undefined ? {} : {rest})
});

describe('subSchema', () => {
  it('walks every container through every wrapper', () => {
    const leaf = z.string();
    const schema = z.object({
      o: z.object({a: leaf}).optional(),
      n: z.object({a: leaf}).nullable(),
      d: z.object({a: leaf}).default({a: 'x'}),
      p: z.object({a: leaf}).transform((v) => v),
      pre: z.preprocess((v) => v, z.object({a: leaf})),
      c: z.object({a: leaf}).catch({a: 'x'}),
      r: z.object({a: leaf}).readonly(),
      arr: z.array(z.object({a: leaf})),
      tup: z.tuple([z.number(), z.object({a: leaf})]),
      rec: z.record(z.string(), z.object({a: leaf})),
      u: z.union([z.number(), z.object({a: leaf})]),
      du: z.discriminatedUnion('t', [
        z.object({t: z.literal('x'), a: leaf}),
        z.object({t: z.literal('y')})
      ])
    });
    const {subSchema} = zodAdapter(schema, 'zod');
    for (const path of [
      ['o', 'a'],
      ['n', 'a'],
      ['d', 'a'],
      ['p', 'a'],
      ['pre', 'a'],
      ['c', 'a'],
      ['r', 'a'],
      ['arr', 3, 'a'],
      ['tup', 1, 'a'],
      ['rec', 'anyKey', 'a'],
      ['u', 'a'],
      ['du', 'a']
    ]) {
      expect(subSchema(path), path.join('.')).toBe(leaf);
    }
    expect(subSchema(['o'])).toBe(schema.shape.o);
  });

  it('finds nothing at an undeclared path or a segment of the wrong kind', () => {
    const {subSchema} = zodAdapter(
      z.object({a: z.object({b: z.string()}), l: z.array(z.string())}),
      'zod'
    );
    expect(subSchema(['a', 'x'])).toBeUndefined();
    expect(subSchema(['l', 'b'])).toBeUndefined();
    expect(subSchema(['a', 0])).toBeUndefined();
    expect(subSchema(['constructor'])).toBeUndefined();
  });

  it('tries each union option that declares the path, in order', () => {
    const {subSchema} = zodAdapter(
      z.discriminatedUnion('t', [z.object({t: z.literal('a')}), z.object({t: z.literal('b')})]),
      'zod'
    );
    const t = subSchema(['t'])!['~standard'];
    expect(t.validate('b')).toStrictEqual({value: 'b'});
    expect(t.validate('c')).toMatchObject({issues: [{code: 'invalid_value', values: ['a']}]});
  });

  it('follows a catchall, but not a strict object', () => {
    const rest = z.date();
    expect(zodAdapter(z.object({}).catchall(rest), 'zod').subSchema(['x'])).toBe(rest);
    expect(zodAdapter(z.strictObject({}), 'zod').subSchema(['x'])).toBeUndefined();
  });
});

describe('fieldTransform', () => {
  const {fieldTransform} = zodAdapter(
    z.object({
      email: z.string().transform((s) => s.toLowerCase()),
      at: z.date(),
      slow: z.string().refine(async () => true)
    }),
    'zod'
  );

  it('applies the field transform', () => {
    expect(fieldTransform(['email'])('A@B.COM')).toBe('a@b.com');
  });

  it('returns a value that fails the parse unchanged', () => {
    expect(fieldTransform(['at'])('2026-11-05T10:00:00.000Z')).toBe('2026-11-05T10:00:00.000Z');
  });

  it('returns a value at an undeclared path unchanged', () => {
    expect(fieldTransform(['nope'])('A')).toBe('A');
  });

  it('refuses an async field', () => {
    expect(() => fieldTransform(['slow'])('x')).toThrow(ConfigError);
  });
});

describe('defaults', () => {
  it('finds a default under other wrappers and gives a fresh value per call', () => {
    const {defaults} = zodAdapter(
      z.object({
        list: z
          .array(z.string())
          .default(() => [])
          .optional(),
        n: z.number().default(5),
        none: z.string()
      }),
      'zod'
    );
    const list = defaults(['list'])!;
    expect(list()).toStrictEqual([]);
    expect(list()).not.toBe(list());
    expect(defaults(['n'])!()).toBe(5);
    expect(defaults(['none'])).toBeUndefined();
  });
});

describe('describe', () => {
  it('marks Date and Set paths, Date unions included, at every depth', () => {
    const schema = z.object({
      at: z.date(),
      orIso: z.union([z.date(), z.iso.datetime()]).nullable(),
      orNumber: z.union([z.date(), z.number()]).optional(),
      threeTypes: z.union([z.date(), z.string(), z.number()]),
      tags: z.set(z.string()),
      list: z.array(z.object({at: z.date(), name: z.string()}))
    });
    expect(zodAdapter(schema, 'zod').describe()).toStrictEqual(
      object({
        at: date,
        orIso: date,
        orNumber: date,
        threeTypes: value,
        tags: {type: 'set'},
        list: {type: 'list', element: object({at: date, name: value})}
      })
    );
  });

  it('merges the declared keys of union options', () => {
    const schema = z.object({
      u: z.discriminatedUnion('t', [
        z.object({t: z.literal('a'), at: z.date(), info: z.object({x: z.string()})}),
        z.object({t: z.literal('b'), n: z.number(), info: z.object({on: z.date()})})
      ])
    });
    expect(zodAdapter(schema, 'zod').describe()).toStrictEqual(
      object({u: object({t: value, at: date, info: object({x: value, on: date}), n: value})})
    );
  });

  describe("under 'zod'", () => {
    it('opens a record and a looseObject, keeps the parent closed and marks a strictObject', () => {
      const schema = z.object({
        a: z.object({meta: z.record(z.string(), z.date()), b: z.string()}),
        loose: z.looseObject({x: z.string()}),
        dated: z.object({}).catchall(z.date()),
        strict: z.strictObject({x: z.string()})
      });
      expect(zodAdapter(schema, 'zod').describe()).toStrictEqual(
        object({
          a: object({meta: object({}, date), b: value}),
          loose: object({x: value}, value),
          dated: object({}, date),
          strict: {...object({x: value}), strict: true}
        })
      );
    });
  });

  describe("under 'dynamoose'", () => {
    it('opens the parent of a record at every depth, but not the item for a top-level record', () => {
      const schema = z.object({
        top: z.record(z.string(), z.string()),
        a: z.object({
          meta: z.record(z.string(), z.string()).optional(),
          b: z.object({c: z.date()}),
          l: z.array(z.object({d: z.string()}))
        }),
        closed: z.object({x: z.string()})
      });
      expect(zodAdapter(schema, 'dynamoose').describe()).toStrictEqual(
        object({
          top: value,
          a: object(
            {
              meta: value,
              b: object({c: date}, value),
              l: {type: 'list', element: object({d: value}, value)}
            },
            value
          ),
          closed: object({x: value})
        })
      );
    });

    it('closes a looseObject and a catchall', () => {
      const schema = z.object({
        loose: z.looseObject({x: z.string()}),
        dated: z.object({}).catchall(z.date())
      });
      expect(zodAdapter(schema, 'dynamoose').describe()).toStrictEqual(
        object({loose: object({x: value}), dated: object({})})
      );
    });
  });
});

describe('adapter selection in the plan layer', () => {
  it('gives a Zod 4 schema the adapter, and a Zod 3 or non-Zod schema none', () => {
    expect(resolveMetadata(z.object({id: z.string()}), {hashKey: 'id'}).adapter).toBeDefined();
    expect(resolveMetadata(z3.object({id: z3.string()}), {hashKey: 'id'})).not.toHaveProperty(
      'adapter'
    );
    expect(resolveMetadata(fixtureSchema, {hashKey: 'id'})).not.toHaveProperty('adapter');
  });

  it('passes the unknownKeys mode to the adapter', () => {
    const schema = z.object({id: z.string(), loose: z.looseObject({})});
    const meta = resolveMetadata(schema, {hashKey: 'id', unknownKeys: 'dynamoose'});
    expect(meta.adapter!.describe()).toStrictEqual(object({id: value, loose: object({})}));
  });

  it('accepts a required timestamp field, and refuses one that takes neither absence nor the stamp', () => {
    const schema = (createdAt: z.ZodType) =>
      z.object({id: z.string(), createdAt, updatedAt: z.date().optional()});
    expect(
      resolveMetadata(schema(z.date()), {hashKey: 'id', timestamps: true}).timestamps.createdAt
    ).toStrictEqual({name: 'createdAt', kind: 'date', storage: 'milliseconds', required: true});
    expect(() => resolveMetadata(schema(z.string()), {hashKey: 'id', timestamps: true})).toThrow(
      new ConfigError(
        "the timestamp field 'createdAt' must accept absence or a Date: the lib sets its value"
      )
    );
    expect(() =>
      resolveMetadata(schema(z.date().optional()), {hashKey: 'id', timestamps: true})
    ).not.toThrow();
    expect(() =>
      resolveMetadata(schema(z.date().default(() => new Date())), {hashKey: 'id', timestamps: true})
    ).not.toThrow();
    expect(() => resolveMetadata(schema(z.date()), {hashKey: 'id'})).not.toThrow();
  });
});
