import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {ConfigError, ValidationError} from '../src/errors.js';
import type {ModelOptions} from '../src/options.js';
import {fromStoredItem, toStoredItem} from '../src/pipeline.js';
import {compilePlan, resolveMetadata} from '../src/plan.js';
import type {StandardSchema, StoredItem} from '../src/types.js';
import {storage} from '../src/zod/index.js';
import {fixtureSchema} from './fixtures/standard-schema.js';

const NOW = '2026-01-02T03:04:05.678Z';
const NOW_MS = '1767323045678';
const planOf = (schema: StandardSchema, options: ModelOptions<any>) =>
  compilePlan(resolveMetadata(schema, options));
const create = {isNew: true};

beforeEach(() => {
  vi.useFakeTimers({toFake: ['Date'], now: new Date(NOW)});
});
afterEach(() => {
  vi.useRealTimers();
});

describe('toStoredItem', () => {
  it('runs an object refinement with timestamps on', () => {
    const schema = z
      .object({
        id: z.string(),
        low: z.number(),
        high: z.number(),
        createdAt: z.date().optional(),
        updatedAt: z.date().optional()
      })
      .refine((v) => v.low < v.high, {message: 'low must be below high'});
    const plan = planOf(schema, {hashKey: 'id', timestamps: true});

    expect(() => toStoredItem(plan, {id: 'x', low: 2, high: 1}, create)).toThrow(
      expect.objectContaining({name: 'ValidationError', message: 'low must be below high'})
    );
    expect(toStoredItem(plan, {id: 'x', low: 1, high: 2}, create)).toStrictEqual({
      id: {S: 'x'},
      low: {N: '1'},
      high: {N: '2'},
      createdAt: {N: NOW_MS},
      updatedAt: {N: NOW_MS}
    });
  });

  // dynamoose stamps both from one Date: a clock that moves between two reads must not split them.
  it('stamps createdAt and updatedAt from one clock read', () => {
    const Real = Date;
    let ms = 999;
    vi.stubGlobal(
      'Date',
      class extends Real {
        constructor(...args: [number?]) {
          if (args.length > 0) super(args[0]!);
          else super(ms++);
        }
      }
    );
    try {
      const plan = planOf(z.object({id: z.string()}), {hashKey: 'id', timestamps: true});
      expect(toStoredItem(plan, {id: 'x'}, create)).toStrictEqual({
        id: {S: 'x'},
        createdAt: {N: '999'},
        updatedAt: {N: '999'}
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the input createdAt under keepCreatedAt on a strictObject that does not declare it', () => {
    const plan = planOf(z.strictObject({id: z.string()}), {hashKey: 'id', timestamps: true});
    const input = {
      id: 'x',
      createdAt: new Date('2020-01-01T00:00:00.000Z'),
      updatedAt: new Date('2020-01-01T00:00:00.000Z')
    };

    expect(toStoredItem(plan, input, {isNew: true, keepCreatedAt: true})).toStrictEqual({
      id: {S: 'x'},
      createdAt: {N: '1577836800000'},
      updatedAt: {N: NOW_MS}
    });
  });

  it("lets a strictObject reject an undeclared key under 'zod', as Zod means it", () => {
    const plan = planOf(z.object({id: z.string(), inner: z.strictObject({a: z.string()})}), {
      hashKey: 'id'
    });
    expect(() => toStoredItem(plan, {id: 'x', inner: {a: 'a', extra: 1}}, create)).toThrow(
      ValidationError
    );
  });

  it('lets a union of strictObjects reject an undeclared key, as each option does', () => {
    const inner = z.union([z.strictObject({a: z.string()}), z.strictObject({b: z.string()})]);
    const plan = planOf(z.object({id: z.string(), inner}), {hashKey: 'id'});
    expect(() => toStoredItem(plan, {id: 'x', inner: {a: 'a', extra: 1}}, create)).toThrow(
      ValidationError
    );
  });

  // The option Zod takes is known only after the parse: Zod puts in that option's defaults.
  it("gives a union's object the defaults of the option Zod takes", () => {
    const shape = z.discriminatedUnion('k', [
      z.object({k: z.literal('a'), s: z.string().default('A')}),
      z.object({k: z.literal('b'), s: z.string().default('B')})
    ]);
    const plan = planOf(z.object({id: z.string(), shape}), {hashKey: 'id'});
    expect(toStoredItem(plan, {id: 'x', shape: {k: 'b'}}, create)).toStrictEqual({
      id: {S: 'x'},
      shape: {M: {k: {S: 'b'}, s: {S: 'B'}}}
    });
  });

  it("does not put one union option's default into a value another strict option takes", () => {
    const inner = z.union([
      z.strictObject({a: z.string(), d: z.string().default('D')}),
      z.strictObject({b: z.string()})
    ]);
    const plan = planOf(z.object({id: z.string(), inner}), {hashKey: 'id'});
    expect(toStoredItem(plan, {id: 'x', inner: {b: 'v'}}, create)).toStrictEqual({
      id: {S: 'x'},
      inner: {M: {b: {S: 'v'}}}
    });
  });

  it('combines a timestamp it computes, held out of validation, in its stored form', () => {
    const schema = z.object({
      id: z.string(),
      kind: z.string(),
      k: z.string().optional(),
      updatedAt: z.date().optional()
    });
    const plan = planOf(schema, {
      hashKey: 'id',
      timestamps: {updatedAt: {storage: 'seconds'}},
      combine: {k: {sources: ['kind', 'updatedAt'], separator: '#'}}
    });

    expect(toStoredItem(plan, {id: 'x', kind: 'a'}, create)).toStrictEqual({
      id: {S: 'x'},
      kind: {S: 'a'},
      k: {S: 'a#1767323045'},
      updatedAt: {N: '1767323045'}
    });
  });

  it("hands the hook a copy, so it cannot change the caller's nested values", () => {
    const plan = planOf(z.object({id: z.string(), meta: z.any()}), {
      hashKey: 'id',
      set: (item) => {
        (item.meta as Record<string, unknown>).touched = true;
        return item;
      }
    });
    const input = {id: 'x', meta: {a: 1}};

    expect(toStoredItem(plan, input, create)).toStrictEqual({
      id: {S: 'x'},
      meta: {M: {a: {N: '1'}, touched: {BOOL: true}}}
    });
    expect(input).toStrictEqual({id: 'x', meta: {a: 1}});
  });

  it("hands the hook a copy of each Set element, so it cannot change the caller's bytes", () => {
    const plan = planOf(z.object({id: z.string(), bins: z.set(z.instanceof(Buffer))}), {
      hashKey: 'id',
      set: (item) => {
        for (const b of item.bins as Set<Buffer>) b[0] = 9;
        return item;
      }
    });
    const bin = Buffer.from([5]);

    expect(toStoredItem(plan, {id: 'x', bins: new Set([bin])}, create)).toStrictEqual({
      id: {S: 'x'},
      bins: {BS: [Buffer.from([9])]}
    });
    expect([...bin]).toStrictEqual([5]);
  });

  it('discards a timestamp from the schema output when it is not computed', () => {
    const schema = z.object({id: z.string(), createdAt: z.date().default(() => new Date(0))});
    const plan = planOf(schema, {hashKey: 'id', timestamps: {createdAt: {}}});

    expect(toStoredItem(plan, {id: 'x'}, {isNew: true, keepCreatedAt: true})).toStrictEqual({
      id: {S: 'x'}
    });
  });

  it('validates a bare z.date() field and a required combine target', () => {
    const schema = z.object({id: z.string(), at: z.date(), part: z.string(), k: z.string()});
    const plan = planOf(schema, {
      hashKey: 'id',
      dates: {at: 'milliseconds'},
      combine: {k: {sources: ['part', 'at'], separator: '#'}}
    });

    expect(toStoredItem(plan, {id: 'x', at: new Date(1000), part: 'p'}, create)).toStrictEqual({
      id: {S: 'x'},
      at: {N: '1000'},
      part: {S: 'p'},
      k: {S: 'p#1000'}
    });
  });

  it('refuses a storage setting on a number timestamp', () => {
    const schema = z.object({id: z.string(), createdAt: z.number().optional()});
    expect(() =>
      resolveMetadata(schema, {hashKey: 'id', timestamps: {createdAt: {storage: 'seconds'}}})
    ).toThrow(
      new ConfigError(
        "the timestamp field 'createdAt' is a number, always stored in milliseconds: remove its storage setting"
      )
    );
  });

  describe('never changes the caller input', () => {
    it('when keys are dropped, timestamps held aside and defaults applied', () => {
      const schema = z.object({
        id: z.string(),
        state: z.string().default('new'),
        nested: z.object({at: z.date(), kept: z.string()}),
        tags: z.set(z.string()),
        createdAt: z.date().optional()
      });
      const plan = planOf(schema, {
        hashKey: 'id',
        unknownKeys: 'dynamoose',
        timestamps: {createdAt: {}}
      });
      const input = {
        id: 'x',
        extra: 1,
        nested: {at: new Date(0), kept: 'k', extra: 2},
        tags: new Set(['a']),
        createdAt: new Date(5)
      };
      const before = structuredClone(input);

      toStoredItem(plan, input, create);
      expect(input).toStrictEqual(before);
    });

    it('when the schema returns its input', () => {
      const identity: StandardSchema = {
        '~standard': {version: 1, vendor: 'test', validate: (value) => ({value})}
      };
      const set = (item: Record<string, unknown>) => {
        item.id = String(item.id).toLowerCase();
        return item;
      };
      const input = {id: 'X', meta: {at: new Date(1500)}};
      const before = structuredClone(input);

      // The hook changes its argument.
      expect(toStoredItem(planOf(identity, {hashKey: 'id', set}), input, create)).toStrictEqual({
        id: {S: 'x'},
        meta: {M: {at: {N: '1500'}}}
      });
      // A nested Date is turned into its stored form.
      expect(
        toStoredItem(
          planOf(identity, {hashKey: 'id', dates: {'meta.at': 'seconds'}}),
          input,
          create
        )
      ).toStrictEqual({
        id: {S: 'X'},
        meta: {M: {at: {N: '2'}}}
      });
      expect(input).toStrictEqual(before);
    });
    it('when a transform changes its input or .readonly() freezes it', () => {
      const plan = planOf(
        z.object({
          id: z.string(),
          meta: z.any().transform((v) => Object.assign(v, {touched: true})),
          frozen: z.any().readonly()
        }),
        {hashKey: 'id'}
      );
      const input = {id: 'x', meta: {a: 1}, frozen: {b: 2}};

      expect(toStoredItem(plan, input, create)).toStrictEqual({
        id: {S: 'x'},
        meta: {M: {a: {N: '1'}, touched: {BOOL: true}}},
        frozen: {M: {b: {N: '2'}}}
      });
      expect(input).toStrictEqual({id: 'x', meta: {a: 1}, frozen: {b: 2}});
      expect(Object.isFrozen(input.frozen)).toBe(false);
    });
    it('when the hook changes a byte view other than a Uint8Array', () => {
      const set = (item: Record<string, any>) => {
        item.words[0] = 9;
        item.view.setUint8(0, 9);
        return item;
      };
      const plan = planOf(z.object({id: z.string(), words: z.any(), view: z.any()}), {
        hashKey: 'id',
        set
      });
      const input = {id: 'x', words: new Uint16Array([1]), view: new DataView(new ArrayBuffer(1))};

      toStoredItem(plan, input, create);
      expect(input.words[0]).toBe(1);
      expect(input.view.getUint8(0)).toBe(0);
    });
    it('when a transform changes the Map it turns into an object', () => {
      const entries = z
        .custom<Map<string, unknown>>((v) => v instanceof Map)
        .transform((m) => {
          m.set('k', 'changed');
          return Object.fromEntries(m);
        });
      const plan = planOf(z.object({id: z.string(), m: entries}), {hashKey: 'id'});
      const input = {id: 'x', m: new Map<string, unknown>([['k', 1]])};

      expect(toStoredItem(plan, input, create)).toStrictEqual({
        id: {S: 'x'},
        m: {M: {k: {S: 'changed'}}}
      });
      expect(input.m.get('k')).toBe(1);
    });
  });

  it('puts back the undeclared keys dynamoose keeps under a .readonly() object and list, which Zod freezes', () => {
    const entry = z.object({tags: z.record(z.string(), z.string())}).readonly();
    const plan = planOf(z.object({id: z.string(), meta: entry, list: z.array(entry).readonly()}), {
      hashKey: 'id',
      unknownKeys: 'dynamoose'
    });

    expect(
      toStoredItem(
        plan,
        {id: 'x', meta: {tags: {a: 'b'}, extra: 1}, list: [{tags: {}, extra: 2}]},
        create
      )
    ).toStrictEqual({
      id: {S: 'x'},
      meta: {M: {tags: {M: {a: {S: 'b'}}}, extra: {N: '1'}}},
      list: {L: [{M: {tags: {M: {}}, extra: {N: '2'}}}]}
    });
  });

  describe('with a non-Zod schema', () => {
    const plan = planOf(fixtureSchema, {hashKey: 'id', dates: {at: 'seconds'}, timestamps: true});

    it('awaits the async validation and stores Dates, Sets and undeclared keys from the values', async () => {
      const result = toStoredItem(
        plan,
        {id: 'a', at: new Date(1500), tags: new Set(['x']), extra: 1},
        create
      );

      expect(result).toBeInstanceOf(Promise);
      expect(await result).toStrictEqual({
        id: {S: 'a'},
        at: {N: '2'},
        tags: {SS: ['x']},
        extra: {N: '1'},
        createdAt: {N: NOW_MS},
        updatedAt: {N: NOW_MS}
      });
    });

    it('rejects an item the async refine refuses', async () => {
      await expect(toStoredItem(plan, {id: 'rejected'}, create)).rejects.toThrow(
        new ValidationError([{message: 'id is rejected', path: ['id']}])
      );
      await expect(toStoredItem(plan, {id: 'rejected'}, create)).rejects.toMatchObject({
        path: ['id']
      });
    });

    it('fails loudly at write when the schema requires a timestamp', () => {
      const requiresCreatedAt: StandardSchema = {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate: (value) =>
            (value as {createdAt?: unknown}).createdAt instanceof Date
              ? {value}
              : {issues: [{message: 'createdAt is required', path: [{key: 'createdAt'}]}]}
        }
      };
      const required = planOf(requiresCreatedAt, {hashKey: 'id', timestamps: true});

      expect(() => toStoredItem(required, {id: 'a', createdAt: new Date(0)}, create)).toThrow(
        'createdAt is required at createdAt'
      );
    });
  });
});

describe('fromStoredItem', () => {
  const plan = planOf(fixtureSchema, {hashKey: 'id', dates: {at: 'seconds'}, timestamps: true});
  const stored = () => ({
    id: {S: 'a'},
    at: {N: '2'},
    tags: {SS: ['x']},
    extra: {N: '1'},
    createdAt: {N: NOW_MS}
  });

  it('keeps every attribute of a non-Zod model and turns planned Dates back', () => {
    expect(fromStoredItem(plan, stored())).toStrictEqual({
      id: 'a',
      at: new Date(2000),
      tags: new Set(['x']),
      extra: 1,
      createdAt: new Date(NOW)
    });
  });

  it('keeps the keys an object transform adds, which the input shape does not declare', () => {
    const schema = z
      .object({id: z.string(), a: z.number()})
      .transform((v) => ({...v, derived: v.a * 2}));
    const transformed = planOf(schema, {hashKey: 'id'});
    const written = toStoredItem(transformed, {id: 'a', a: 2}, create);

    expect(written).toStrictEqual({id: {S: 'a'}, a: {N: '2'}, derived: {N: '4'}});
    expect(fromStoredItem(transformed, written as StoredItem)).toStrictEqual({
      id: 'a',
      a: 2,
      derived: 4
    });
  });

  it("keeps a field a piped transform renames, until the pipe's output schema judges it", () => {
    const renamed = planOf(
      z.object({
        id: z.string(),
        o: z
          .object({a: z.string()})
          .transform((v) => ({b: v.a}))
          .pipe(z.object({b: z.string()}))
      }),
      {hashKey: 'id'}
    );
    const written = toStoredItem(renamed, {id: 'a', o: {a: 'v'}}, create);

    expect(written).toStrictEqual({id: {S: 'a'}, o: {M: {b: {S: 'v'}}}});
    expect(fromStoredItem(renamed, written as StoredItem)).toStrictEqual({id: 'a', o: {b: 'v'}});
  });

  it("keeps the field an array's piped transform renames, and reads the list by the pipe's output", () => {
    const renamed = planOf(
      z.object({
        id: z.string(),
        l: z
          .array(z.object({a: z.string()}))
          .transform((rows) => rows.map((r) => ({b: r.a, at: new Date(0)})))
          .pipe(z.array(z.object({b: z.string(), at: storage(z.date(), 'seconds')})))
      }),
      {hashKey: 'id'}
    );
    const written = toStoredItem(renamed, {id: 'a', l: [{a: 'v'}]}, create);

    expect(written).toStrictEqual({id: {S: 'a'}, l: {L: [{M: {b: {S: 'v'}, at: {N: '0'}}}]}});
    expect(fromStoredItem(renamed, written as StoredItem)).toStrictEqual({
      id: 'a',
      l: [{b: 'v', at: new Date(0)}]
    });
  });

  it('stores and reads a transformed Date in a list by the storage it is marked with', () => {
    const marked = planOf(
      z.object({
        id: z.string(),
        l: z.array(
          storage(
            z.date().transform((d) => d),
            'seconds'
          )
        )
      }),
      {hashKey: 'id'}
    );
    const written = toStoredItem(marked, {id: 'a', l: [new Date(5000)]}, create);

    expect(written).toStrictEqual({id: {S: 'a'}, l: {L: [{N: '5'}]}});
    expect(fromStoredItem(marked, written as StoredItem)).toStrictEqual({
      id: 'a',
      l: [new Date(5000)]
    });
  });

  it('reads back the string a Date transform stores, not a Date', () => {
    const dated = planOf(
      z.object({id: z.string(), at: z.date().transform((d) => d.toISOString())}),
      {hashKey: 'id'}
    );
    const written = toStoredItem(dated, {id: 'a', at: new Date(0)}, create);

    expect(written).toStrictEqual({id: {S: 'a'}, at: {S: '1970-01-01T00:00:00.000Z'}});
    expect(fromStoredItem(dated, written as StoredItem)).toStrictEqual({
      id: 'a',
      at: '1970-01-01T00:00:00.000Z'
    });
  });

  it('reads an object transform by its output pipe: a Date the transform turns into a string stays a string', () => {
    const piped = planOf(
      z.object({
        id: z.string(),
        o: z
          .object({at: z.date()})
          .transform((v) => ({at: v.at.toISOString()}))
          .pipe(z.object({at: z.string()}))
      }),
      {hashKey: 'id', defaultDateStorage: 'iso'}
    );
    const written = toStoredItem(piped, {id: 'a', o: {at: new Date(0)}}, create);

    expect(written).toStrictEqual({id: {S: 'a'}, o: {M: {at: {S: '1970-01-01T00:00:00.000Z'}}}});
    expect(fromStoredItem(piped, written as StoredItem)).toStrictEqual({
      id: 'a',
      o: {at: '1970-01-01T00:00:00.000Z'}
    });
  });

  // One rule for every container a transform makes: the input side puts in nested defaults (through their checks,
  // as dynamoose's set modifier: "up"), the output side stores the Dates and reads them back.
  describe.each([
    ['an object', (e: z.ZodType) => e, (v: object) => v, (m: object) => ({M: m})],
    ['a list', (e: z.ZodType) => z.array(e), (v: object) => [v], (m: object) => ({L: [{M: m}]})],
    ['a tuple', (e: z.ZodType) => z.tuple([e]), (v: object) => [v], (m: object) => ({L: [{M: m}]})]
  ])('%s made by a transform', (_, container, value, attribute) => {
    const element = z.object({
      s: z.string().toLowerCase().default('UP'),
      at: storage(z.date(), 'seconds')
    });
    const output = z.object({s: z.string(), at: storage(z.date(), 'seconds')});
    const given = (v: unknown) => v;
    // A preprocess takes a value of any shape, so the rows put in no default of their own: Zod gives its default
    // unchecked, as it does on its own.
    it.each([
      ['without an output pipe', container(element).transform((v) => v), given, 'up'],
      [
        'with an output pipe',
        container(element)
          .transform((v) => v)
          .pipe(container(output)),
        given,
        'up'
      ],
      [
        'with a preprocess',
        z.preprocess((v: any) => v.raw, container(element)),
        (v: unknown) => ({raw: v}),
        'UP'
      ]
    ])('%s', (__, c, wrap, s) => {
      const plan = planOf(z.object({id: z.string(), c}), {hashKey: 'id'});
      const written = toStoredItem(plan, {id: 'a', c: wrap(value({at: new Date(5000)}))}, create);

      expect(written).toStrictEqual({id: {S: 'a'}, c: attribute({s: {S: s}, at: {N: '5'}})});
      expect(fromStoredItem(plan, written as StoredItem)).toStrictEqual({
        id: 'a',
        c: value({s, at: new Date(5000)})
      });
    });
  });

  it('returns the stored values when raw', () => {
    expect(fromStoredItem(plan, stored(), {raw: true})).toStrictEqual({
      id: 'a',
      at: 2,
      tags: new Set(['x']),
      extra: 1,
      createdAt: 1767323045678
    });
  });
});
