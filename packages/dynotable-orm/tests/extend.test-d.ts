import {describe, expectTypeOf, it} from 'vitest';
import {z} from 'zod';
import {type ItemOf, type KeyInputOf, type Model, model, type QueryResponse} from '../src/index.js';

const users = z.object({id: z.string(), email: z.string(), name: z.string().optional()});
const orders = z.object({account: z.string(), at: z.number(), total: z.number()});

// A helper written once and attached to many models, as a shared model factory would.
const helpers = {
  async safeGet<M extends Model<string, any>>(this: M, key: KeyInputOf<M>): Promise<ItemOf<M>> {
    const item = await this.get(key);
    if (item === undefined) throw new Error(`${this.name} not found`);
    return item;
  },
  label<M extends Model<string, any>>(this: M): M['name'] {
    return this.name;
  }
};

const Users = model('Users', users, {
  hashKey: 'id',
  indexes: {email: {name: 'byEmail', project: false}}
}).extend(helpers);
const Orders = model('Orders', orders, {hashKey: 'account', rangeKey: 'at'}).extend(helpers);

describe('extend() types', () => {
  it('infers each model in a shared helper', async () => {
    expectTypeOf(await Users.safeGet('u1')).toEqualTypeOf<z.output<typeof users>>();
    expectTypeOf(await Orders.safeGet({account: 'a', at: 1})).toEqualTypeOf<
      z.output<typeof orders>
    >();
    expectTypeOf(Users.label()).toEqualTypeOf<'Users'>();
    // @ts-expect-error Orders has a range key
    await Orders.safeGet('a');
    // @ts-expect-error not a key of Users
    await Users.safeGet({account: 'a'});
  });

  it('types `this` as the model plus the methods', async () => {
    const M = model('Users', users, {
      hashKey: 'id',
      indexes: {email: {name: 'byEmail', project: false}}
    }).extend({
      byEmail(email: string) {
        return this.query('email').eq(email).using('byEmail').exec();
      },
      async firstByEmail(email: string): Promise<{id: string; email: string} | undefined> {
        return (await this.byEmail(email))[0];
      }
    });
    expectTypeOf(await M.byEmail('x')).toEqualTypeOf<QueryResponse<{id: string; email: string}>>();
    model('Users', users, {hashKey: 'id'}).extend({
      f() {
        // @ts-expect-error not a method of the model
        return this.nope();
      }
    });
  });

  it('keeps earlier methods across calls', () => {
    const M = Users.extend({
      tag() {
        return this.label();
      }
    });
    expectTypeOf(M.tag()).toEqualTypeOf<'Users'>();
  });

  it('rejects a built-in name', () => {
    // @ts-expect-error a built-in
    model('Users', users, {hashKey: 'id'}).extend({get: () => 1});
  });

  it('takes the new signature of a method added before, and keeps the model constructible', () => {
    const M = Users.extend({
      safeGet(id: string, tenant: string) {
        return this.get(id).then((u) => (u?.name === tenant ? u : undefined));
      }
    });
    expectTypeOf(M.safeGet('u1', 't')).toEqualTypeOf<Promise<z.output<typeof users> | undefined>>();
    expectTypeOf(new M({id: 'u1'})).toEqualTypeOf<z.output<typeof users>>();
    // @ts-expect-error neither signature takes a number
    M.safeGet(1, 't');
  });
});
