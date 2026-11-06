import type {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {Condition, ExpressionError, ifNotExists, model, ValidationError} from '../src/index.js';
import {storage} from '../src/zod/index.js';

const stub = () => {
  const send = vi.fn(async () => ({}));
  return {client: {send} as unknown as DynamoDBClient, send};
};

const schema = z.object({
  id: z.string(),
  n: z.number().optional(),
  list: z.array(z.string()).optional(),
  meta: z.object({n: z.number().optional(), at: z.date().optional()}).optional(),
  tags: z.set(z.string()).optional()
});
const Plain = model('A', schema, {hashKey: 'id'});
const Stamped = model(
  'T',
  z.object({id: z.string(), n: z.number().optional(), updatedAt: z.date().optional()}),
  {
    hashKey: 'id',
    timestamps: {updatedAt: {}}
  }
);

afterEach(() => {
  vi.useRealTimers();
});

// The literals are what a dynamoose 4.x build returns for `{return: 'request'}` on the same schema.
describe('update requests', () => {
  it("builds dynamoose's text for a simple update", async () => {
    expect(await Plain.update({id: 'a'}, {n: 1}, {return: 'request'})).toStrictEqual({
      Key: {id: {S: 'a'}},
      ReturnValues: 'ALL_NEW',
      ExpressionAttributeNames: {'#a0': 'n'},
      ExpressionAttributeValues: {':v0': {N: '1'}},
      UpdateExpression: 'SET #a0 = :v0',
      TableName: 'A'
    });
  });

  it('appends to a list with $ADD', async () => {
    expect(await Plain.update({id: 'a'}, {$ADD: {list: ['z']}}, {return: 'request'})).toStrictEqual(
      {
        Key: {id: {S: 'a'}},
        ReturnValues: 'ALL_NEW',
        ExpressionAttributeNames: {'#a0': 'list'},
        ExpressionAttributeValues: {':v0': {L: [{S: 'z'}]}},
        UpdateExpression: 'SET #a0 = list_append(#a0, :v0)',
        TableName: 'A'
      }
    );
  });

  it("writes updatedAt first, so a timestamped update and a touch keep dynamoose's text", async () => {
    vi.useFakeTimers({toFake: ['Date'], now: new Date('2026-01-02T03:04:05.999Z')});
    const updatedAt = {N: '1767323045999'};
    expect(await Stamped.update({id: 'a'}, {n: 1}, {return: 'request'})).toStrictEqual({
      Key: {id: {S: 'a'}},
      ReturnValues: 'ALL_NEW',
      ExpressionAttributeNames: {'#a0': 'updatedAt', '#a1': 'n'},
      ExpressionAttributeValues: {':v0': updatedAt, ':v1': {N: '1'}},
      UpdateExpression: 'SET #a0 = :v0, #a1 = :v1',
      TableName: 'T'
    });
    expect(await Stamped.update({id: 'a'}, {}, {return: 'request'})).toStrictEqual({
      Key: {id: {S: 'a'}},
      ReturnValues: 'ALL_NEW',
      ExpressionAttributeNames: {'#a0': 'updatedAt'},
      ExpressionAttributeValues: {':v0': updatedAt},
      UpdateExpression: 'SET #a0 = :v0',
      TableName: 'T'
    });
  });

  it("renders the condition first, with dynamoose's text", async () => {
    // dynamoose names `n` twice (#a0 and #a1), and so does this lib.
    expect(
      await Plain.update(
        {id: 'a'},
        {n: 1},
        {return: 'request', condition: new Condition('n').eq(0)}
      )
    ).toStrictEqual({
      Key: {id: {S: 'a'}},
      ReturnValues: 'ALL_NEW',
      ConditionExpression: '#a0 = :v0',
      ExpressionAttributeNames: {'#a0': 'n', '#a1': 'n'},
      ExpressionAttributeValues: {':v0': {N: '0'}, ':v1': {N: '1'}},
      UpdateExpression: 'SET #a1 = :v1',
      TableName: 'A'
    });
  });

  describe('a field with transforms and nested defaults', () => {
    const lower = z.string().toLowerCase();
    const Shaped = model(
      'A',
      z.object({
        id: z.string(),
        codes: z.array(lower).optional(),
        rows: z.array(z.object({s: lower.default('UP'), o: z.string().optional()})).optional(),
        p: z
          .object({
            s: lower.default('UP'),
            q: z.object({d: z.string().default('D')}).optional()
          })
          .optional()
      }),
      {hashKey: 'id'}
    );

    it('appends elements as given, without their transforms or defaults', async () => {
      expect(
        await Shaped.update(
          {id: 'a'},
          {$ADD: {codes: ['UP'], rows: [{o: 'X'}]}},
          {return: 'request'}
        )
      ).toStrictEqual({
        Key: {id: {S: 'a'}},
        ReturnValues: 'ALL_NEW',
        ExpressionAttributeNames: {'#a0': 'codes', '#a1': 'rows'},
        ExpressionAttributeValues: {
          ':v0': {L: [{S: 'UP'}]},
          ':v1': {L: [{M: {o: {S: 'X'}}}]}
        },
        UpdateExpression: 'SET #a0 = list_append(#a0, :v0), #a1 = list_append(#a1, :v1)',
        TableName: 'A'
      });
    });

    it('sets a parent without its nested defaults, and with its transforms', async () => {
      expect(
        await Shaped.update({id: 'a'}, {p: {q: {}}, rows: [{o: 'X', s: 'AB'}]}, {return: 'request'})
      ).toStrictEqual({
        Key: {id: {S: 'a'}},
        ReturnValues: 'ALL_NEW',
        ExpressionAttributeNames: {'#a0': 'p', '#a1': 'rows'},
        ExpressionAttributeValues: {
          ':v0': {M: {q: {M: {}}}},
          ':v1': {L: [{M: {o: {S: 'X'}, s: {S: 'ab'}}}]}
        },
        UpdateExpression: 'SET #a0 = :v0, #a1 = :v1',
        TableName: 'A'
      });
    });
  });

  // As dynamoose: a $SET or an appended element is written as given, so its input decides what is checked and stored.
  describe('a value written as given', () => {
    const seconds = storage(z.date(), 'seconds');
    const Given = model(
      'A',
      z.object({
        id: z.string(),
        p: z
          .object({
            s: z
              .string()
              .default('x')
              .refine((v) => v.length > 3)
          })
          .optional(),
        piped: z
          .object({
            s: z.string().default('x').pipe(z.string().min(5))
          })
          .optional(),
        raw: z.preprocess((v: any) => ({a: v.raw}), z.object({a: z.string()})).optional(),
        shape: z
          .discriminatedUnion('k', [
            z.object({k: z.literal('a'), s: z.string().default('A')}),
            z.object({k: z.literal('b'), s: z.string().default('B')})
          ])
          .optional(),
        events: z
          .array(
            z
              .object({at: seconds})
              .transform((e) => ({when: e.at}))
              .pipe(z.object({when: z.date()}))
          )
          .optional(),
        renamed: z
          .array(z.object({a: z.string()}))
          .transform((l) => l.map((e) => ({b: e.a})))
          .pipe(z.array(z.object({b: z.string()})))
          .optional(),
        blank: z
          .string()
          .default('')
          .refine((v) => v.length > 3)
      }),
      {hashKey: 'id'}
    );
    const values = async (changes: object) =>
      (await Given.update({id: 'a'}, changes, {return: 'request'})).ExpressionAttributeValues;

    it("does not check a nested default's own refinement on a key it leaves out", async () => {
      expect(await values({p: {}})).toStrictEqual({':v0': {M: {}}});
    });

    it('does not check a nested default through the pipe after it on a key it leaves out', async () => {
      expect(await values({piped: {}})).toStrictEqual({':v0': {M: {}}});
      await expect(values({piped: {s: 'ab'}})).rejects.toThrow(ValidationError);
    });

    it("still checks a value given against the default's own refinement", async () => {
      await expect(values({p: {s: 'ab'}})).rejects.toThrow(ValidationError);
    });

    it("sets a union's object without the defaults of the option Zod takes", async () => {
      expect(await values({shape: {k: 'b'}})).toStrictEqual({':v0': {M: {k: {S: 'b'}}}});
    });

    it('gives a preprocess the value as given', async () => {
      expect(await values({raw: {raw: 'ok'}})).toStrictEqual({':v0': {M: {a: {S: 'ok'}}}});
    });

    it("stores an appended element's Dates by its input, which its transform renames", async () => {
      expect(await values({$ADD: {events: [{at: new Date(5000)}]}})).toStrictEqual({
        ':v0': {L: [{M: {at: {N: '5'}}}]}
      });
    });

    // dynamoose stores an appended element before the list's set modifier, which never sees it.
    it("checks an element appended to a transformed list by the list's input element", async () => {
      expect(await values({$ADD: {renamed: [{a: 'x'}]}})).toStrictEqual({
        ':v0': {L: [{M: {a: {S: 'x'}}}]}
      });
    });

    // A list a transform makes resolves by its declared list: the input side, or for a preprocess, which declares no
    // input, its output. dynamoose appends one element as a list of it, stored and checked by the element's schema.
    it.each([
      [
        'into an object',
        z
          .array(seconds)
          .transform((l) => ({n: l.length}))
          .pipe(z.object({n: z.number()}))
      ],
      ['with a preprocess', z.preprocess((l) => l, z.array(seconds))]
    ])('appends to a list a transform makes %s', async (_, l) => {
      const Listed = model('A', z.object({id: z.string(), l: l.optional()}), {hashKey: 'id'});
      const add = (v: unknown) =>
        Listed.update({id: 'a'}, {$ADD: {l: v}} as never, {return: 'request'});
      for (const v of [new Date(5000), [new Date(5000)]]) {
        expect(await add(v)).toMatchObject({
          ExpressionAttributeValues: {':v0': {L: [{N: '5'}]}},
          UpdateExpression: 'SET #a0 = list_append(#a0, :v0)'
        });
      }
      await expect(add(['nope'])).rejects.toThrow(ValidationError);
    });

    // dynamoose writes only a truthy default on a remove; a falsy one is dropped, unchecked.
    it('removes a field whose falsy default fails its own refinement', async () => {
      const removed = {UpdateExpression: 'REMOVE #a0', ExpressionAttributeNames: {'#a0': 'blank'}};
      expect(
        await Given.update({id: 'a'}, {$REMOVE: ['blank']}, {return: 'request'})
      ).toMatchObject(removed);
      expect(await Given.update({id: 'a'}, {blank: undefined}, {return: 'request'})).toMatchObject(
        removed
      );
    });
  });

  it('writes ifNotExists as if_not_exists', async () => {
    expect(
      await Plain.update({id: 'a'}, {n: ifNotExists(0)}, {return: 'request', returnValues: 'NONE'})
    ).toStrictEqual({
      Key: {id: {S: 'a'}},
      ReturnValues: 'NONE',
      ExpressionAttributeNames: {'#a0': 'n'},
      ExpressionAttributeValues: {':v0': {N: '0'}},
      UpdateExpression: 'SET #a0 = if_not_exists(#a0, :v0)',
      TableName: 'A'
    });
  });
});

describe('update', () => {
  it('throws its own error on an empty update without timestamps, and sends nothing', async () => {
    const {client, send} = stub();
    await expect(Plain.update({id: 'a'}, {}, {client})).rejects.toThrow(
      new ExpressionError('the update has nothing to write')
    );
    await expect(Plain.update({id: 'a'}, {$SET: {nope: 1} as never}, {client})).rejects.toThrow(
      new ExpressionError('the update has nothing to write')
    );
    await expect(
      Plain.update({id: 'a'}, {$SET: {'meta.nope': 1} as never}, {client})
    ).rejects.toThrow(
      new ExpressionError('Nothing to update: the schema does not declare meta.nope.')
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('writes an undeclared top-level attribute only with allowUndeclared, as given', async () => {
    const lease = {
      condition: {
        ConditionExpression: 'attribute_not_exists(#lock) OR #lock < :now',
        ExpressionAttributeNames: {'#lock': 'lockedUntil'},
        ExpressionAttributeValues: {':now': {N: '5'}}
      },
      return: 'request'
    } as const;
    expect(
      await Plain.update({id: 'a'}, {lockedUntil: 60_005}, {...lease, allowUndeclared: true})
    ).toStrictEqual({
      Key: {id: {S: 'a'}},
      ReturnValues: 'ALL_NEW',
      TableName: 'A',
      ConditionExpression: 'attribute_not_exists(#lock) OR #lock < :now',
      UpdateExpression: 'SET #a0 = :v0',
      ExpressionAttributeNames: {'#lock': 'lockedUntil', '#a0': 'lockedUntil'},
      ExpressionAttributeValues: {':now': {N: '5'}, ':v0': {N: '60005'}}
    });
    await expect(
      Plain.update({id: 'a'}, {lockedUntil: 60_005} as never, {...lease, return: undefined})
    ).rejects.toThrow(new ExpressionError('the update has nothing to write'));
  });

  it('refuses a partial write under a parent with its own checks', async () => {
    const Ruled = model(
      'R',
      z.object({
        id: z.string(),
        meta: z
          .object({n: z.number().optional()})
          .refine(() => true)
          .optional()
      }),
      {
        hashKey: 'id'
      }
    );
    await expect(Ruled.update({id: 'a'}, {$SET: {'meta.n': 1}})).rejects.toThrow(
      new ExpressionError(
        'meta.n cannot be updated alone: meta has its own checks or transform, so write the whole meta.'
      )
    );
  });

  it('refuses a $DELETE operand that is not a Set or an array', async () => {
    await expect(Plain.update({id: 'a'}, {$DELETE: {tags: 'x' as never}})).rejects.toThrow(
      new ExpressionError("$DELETE on 'tags' takes a Set or an array of elements")
    );
  });

  it('ignores a caller updatedAt, as on an item read and written back: the stamp wins', async () => {
    vi.useFakeTimers({toFake: ['Date'], now: new Date(0)});
    const request = await Stamped.update(
      {id: 'a'},
      {n: 1, updatedAt: new Date(5), $REMOVE: ['updatedAt']},
      {return: 'request'}
    );
    expect(request).toMatchObject({
      UpdateExpression: 'SET #a0 = :v0, #a1 = :v1',
      ExpressionAttributeNames: {'#a0': 'updatedAt', '#a1': 'n'},
      ExpressionAttributeValues: {':v0': {N: '0'}, ':v1': {N: '1'}}
    });
  });

  it('refuses two writes of one path, which DynamoDB rejects', async () => {
    await expect(Plain.update({id: 'a'}, {meta: {n: 1}, $SET: {'meta.n': 2}})).rejects.toThrow(
      new ExpressionError(
        "the update writes 'meta' and a path that overlaps it: DynamoDB rejects that"
      )
    );
  });

  it('writes a truthy default instead of a remove, and removes for a falsy one', async () => {
    const Defaulted = model(
      'D',
      z.object({id: z.string(), state: z.string().default('new'), zero: z.number().default(0)}),
      {hashKey: 'id'}
    );
    expect(
      await Defaulted.update({id: 'a'}, {$REMOVE: ['state', 'zero']}, {return: 'request'})
    ).toMatchObject({
      ExpressionAttributeNames: {'#a0': 'state', '#a1': 'zero'},
      ExpressionAttributeValues: {':v0': {S: 'new'}},
      UpdateExpression: 'REMOVE #a1 SET #a0 = :v0'
    });
  });

  // Zod gives an absent value to a pipe's input side, so a default there is the field's default.
  it('writes a truthy default on the input side of a pipe instead of a remove', async () => {
    const Piped = model(
      'D',
      z.object({id: z.string(), s: z.string().default('abcdef').pipe(z.string().min(5))}),
      {hashKey: 'id'}
    );
    const written = {
      ExpressionAttributeNames: {'#a0': 's'},
      ExpressionAttributeValues: {':v0': {S: 'abcdef'}},
      UpdateExpression: 'SET #a0 = :v0'
    };
    expect(await Piped.update({id: 'a'}, {$REMOVE: ['s']}, {return: 'request'})).toMatchObject(
      written
    );
    expect(await Piped.update({id: 'a'}, {s: undefined}, {return: 'request'})).toMatchObject(
      written
    );
  });

  it('stores an ifNotExists Date in its storage', async () => {
    const Dated = model('D', z.object({id: z.string(), at: z.date().optional()}), {
      hashKey: 'id',
      dates: {at: 'seconds'}
    });
    expect(
      (await Dated.update({id: 'a'}, {at: ifNotExists(new Date(1500))}, {return: 'request'}))
        .ExpressionAttributeValues
    ).toStrictEqual({
      ':v0': {N: '2'}
    });
  });

  describe('combine', () => {
    it("refuses a change to a key's source", async () => {
      const Keyed = model(
        'C',
        z.object({id: z.string(), sk: z.string(), b: z.string().optional()}),
        {
          hashKey: 'id',
          rangeKey: 'sk',
          combine: {sk: {sources: ['id', 'b']}}
        }
      );
      await expect(Keyed.update({id: 'x', sk: 'x,y'}, {b: 'z'})).rejects.toThrow(
        new ExpressionError(
          'You cannot update the combine attributes of sk because it is part of the key. Remove them from the update: b.'
        )
      );
    });

    it('refuses an update of some sources only', async () => {
      const Single = model(
        'S',
        z.object({
          id: z.string(),
          a: z.string().optional(),
          b: z.string().optional(),
          k: z.string().optional()
        }),
        {
          hashKey: 'id',
          combine: {k: {sources: ['a', 'b'], separator: '#'}}
        }
      );
      await expect(Single.update({id: 'x'}, {a: 'z'})).rejects.toThrow(
        new ExpressionError(
          'You must update all or none of the combine attributes when running Model.update. Missing combine attributes: b.'
        )
      );
      // DynamoDB may keep the stored value of an ifNotExists source, so the target cannot be computed.
      await expect(Single.update({id: 'x'}, {a: ifNotExists('z'), b: 'w'})).rejects.toThrow(
        new ExpressionError(
          'k combines a, written with ifNotExists: the stored value may stay, so k cannot be computed. Write them without ifNotExists.'
        )
      );
    });
  });

  it('removes an attribute the hook drops from a $SET, as dynamoose does', async () => {
    const Dropping = model('H', z.object({id: z.string(), v: z.string().optional()}), {
      hashKey: 'id',
      set: (item: Record<string, unknown>) => (item.v === 'drop' ? {} : item)
    });
    expect(await Dropping.update({id: 'a'}, {v: 'drop'}, {return: 'request'})).toMatchObject({
      ExpressionAttributeNames: {'#a0': 'v'},
      UpdateExpression: 'REMOVE #a0'
    });
  });

  it("sets a list by the input its piped transform renames, stored as the pipe's output", async () => {
    const Renamed = model(
      'R',
      z.object({
        id: z.string(),
        l: z
          .array(z.object({a: z.string()}))
          .transform((rows) => rows.map((r) => ({b: r.a})))
          .pipe(z.array(z.object({b: z.string()})))
          .optional()
      }),
      {hashKey: 'id'}
    );
    expect(await Renamed.update({id: 'a'}, {l: [{a: 'v'}]}, {return: 'request'})).toMatchObject({
      ExpressionAttributeValues: {':v0': {L: [{M: {b: {S: 'v'}}}]}},
      UpdateExpression: 'SET #a0 = :v0'
    });
  });

  it('names the item path of a nested validation failure', async () => {
    const error = await Plain.update({id: 'a'}, {$SET: {'meta.n': 'x' as never}}).catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).path).toStrictEqual(['meta', 'n']);
  });

  it("leaves the caller's input unchanged", async () => {
    const {client} = stub();
    const M = model('A', schema, {hashKey: 'id', client});
    const at = new Date(1700000000000);
    const changes = {
      n: 1,
      $SET: {'meta.at': at},
      $ADD: {list: ['b']},
      $DELETE: {tags: new Set(['y'])}
    };
    const item = {
      id: 'a',
      list: ['a'],
      meta: {n: 2, at},
      $ADD: {tags: ['x']},
      $REMOVE: ['n' as const]
    };
    const before = structuredClone({changes, item});
    await M.update({id: 'a'}, changes);
    await M.update(item);
    expect({changes, item}).toStrictEqual(before);
  });

  it("gives the schema a copy of the caller's $SET value and appended element", async () => {
    const touch = (v: Record<string, unknown>) => {
      v.touched = true;
      return v;
    };
    const M = model(
      'A',
      z.object({
        id: z.string(),
        meta: z.any().transform(touch),
        frozen: z.any().readonly(),
        list: z.array(z.any().transform(touch))
      }),
      {hashKey: 'id', client: stub().client}
    );
    const meta = {a: 1};
    const frozen = {b: 2};
    const appended = {c: 3};
    await M.update({id: 'a'}, {$SET: {meta, frozen}, $ADD: {list: [appended]}});
    expect({meta, frozen, appended}).toStrictEqual({
      meta: {a: 1},
      frozen: {b: 2},
      appended: {c: 3}
    });
    expect(Object.isFrozen(frozen)).toBe(false);
  });
});
