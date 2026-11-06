import type {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {ConfigError, model} from '../src/index.js';

const schema = z.object({id: z.string(), n: z.number().optional()});

describe('extend()', () => {
  it('binds `this` to the model, so a method reaches built-ins and other methods', async () => {
    const send = vi.fn(async () => ({Item: {id: {S: 'a'}, n: {N: '1'}}}));
    const M = model('Items', schema, {
      hashKey: 'id',
      client: {send} as unknown as DynamoDBClient
    }).extend({
      async safeGet(id: string) {
        const item = await this.get(id);
        if (item === undefined) throw new Error(`${this.name} ${id} not found`);
        return item;
      },
      async n(id: string) {
        return (await this.safeGet(id)).n;
      }
    });
    expect(await M.n('a')).toBe(1);
    send.mockResolvedValueOnce({} as never);
    await expect(M.n('b')).rejects.toThrow('Items b not found');
  });

  it('binds each method to the model, so a method passed as a callback keeps it', async () => {
    const M = model('Items', schema, {hashKey: 'id'}).extend({
      label(id: string) {
        return `${this.name}:${id}`;
      }
    });
    expect(['a', 'b'].map(M.label)).toEqual(['Items:a', 'Items:b']);
  });

  it('rejects a name the model already has', () => {
    const M = model('Items', schema, {hashKey: 'id'});
    expect(() => M.extend({get: () => 1} as never)).toThrow(ConfigError);
    expect(() => M.extend({get: () => 1} as never)).toThrow(
      "extend() on 'Items' would replace get"
    );
    // Function.prototype members, which every model inherits.
    expect(() => M.extend({bind: () => 1, call: () => 1} as never)).toThrow(
      "extend() on 'Items' would replace bind, call"
    );
  });

  it('replaces a method added by an earlier extend(), as dynamoose methods.set does', () => {
    const M = model('Items', schema, {hashKey: 'id'}).extend({f: () => 1, g: () => 'g'});
    const N = M.extend({f: (x: string) => x});
    expect(N.f('2')).toBe('2');
    expect(N.g()).toBe('g');
  });
});
