import {describe, expectTypeOf, it} from 'vitest';
import {Condition} from '../src/index.js';

interface Item {
  id: string;
  n?: number;
  tags?: Set<string>;
  at?: Date;
  address?: {city: string};
  items?: {sku: string}[];
}

describe('Condition types', () => {
  it('takes only declared attributes, or a path below an object or list attribute', () => {
    new Condition<Item>().where('id').eq('x');
    new Condition<Item>().where('address.city').eq('x');
    new Condition<Item>().where('items[0].sku').eq('x');
    // @ts-expect-error not an attribute
    new Condition<Item>().where('nope');
    // @ts-expect-error a Set has no path below it
    new Condition<Item>().where('tags.x');
  });

  it('types the value from the attribute', () => {
    new Condition<Item>().where('n').gt(1).where('n').between(1, 2).where('n').in([1, 2]);
    // @ts-expect-error a number attribute
    new Condition<Item>().where('n').gt('1');
    // @ts-expect-error a number attribute
    new Condition<Item>().where('n').in(['1']);
    // @ts-expect-error begins_with takes a string
    new Condition<Item>().where('n').beginsWith(1);
    // @ts-expect-error a comparison needs an attribute first
    new Condition<Item>().eq('x');
  });

  it('accepts a Date or its stored form on a Date attribute', () => {
    new Condition<Item>()
      .where('at')
      .lt(new Date())
      .where('at')
      .lt('2026-01-01T00:00:00.000Z')
      .where('at')
      .lt(0);
    // @ts-expect-error not a Date or a stored form
    new Condition<Item>().where('at').lt(true);
  });

  it('takes an element in contains on a Set', () => {
    new Condition<Item>().where('tags').contains('t');
    // @ts-expect-error an element of a Set of strings
    new Condition<Item>().where('tags').contains(1);
  });

  it('types the object form', () => {
    new Condition<Item>({id: 'x', n: {gt: 1}});
    // @ts-expect-error a number attribute
    new Condition<Item>({n: 'x'});
    // @ts-expect-error not an attribute
    new Condition<Item>({nope: 1});
  });

  it('leaves a condition started from a bare key untyped, as dynamoose', () => {
    expectTypeOf(new Condition('x').eq(1)).toEqualTypeOf<Condition<any>>();
  });

  it('returns a Condition from every chain call', () => {
    expectTypeOf(
      new Condition<Item>().where('id').eq('x').or().where('n').not().exists()
    ).toEqualTypeOf<Condition<Item>>();
  });
});
