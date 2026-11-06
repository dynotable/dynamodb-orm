import {describe, expect, it} from 'vitest';
import {
  MarshallError,
  marshallItem,
  marshallValue,
  unmarshallItem,
  unmarshallValue
} from '../src/marshall.js';

const bytes = Uint8Array.of(1, 2);

describe('marshallValue', () => {
  it('converts every supported type', () => {
    expect(
      marshallItem({
        s: '',
        n: 7,
        bool: false,
        nil: null,
        list: ['a', undefined, 'b'],
        map: {kept: 1, gone: undefined},
        ss: new Set(['a', undefined, 'b']),
        ns: new Set([2, 1]),
        bs: new Set([bytes]),
        b: Buffer.from([3]),
        gone: undefined
      })
    ).toStrictEqual({
      s: {S: ''},
      n: {N: '7'},
      bool: {BOOL: false},
      nil: {NULL: true},
      list: {L: [{S: 'a'}, {S: 'b'}]},
      map: {M: {kept: {N: '1'}}},
      ss: {SS: ['a', 'b']},
      ns: {NS: ['2', '1']},
      bs: {BS: [bytes]},
      b: {B: Buffer.from([3])}
    });
  });

  it('stores a Date with the rule the caller passes', () => {
    const d = new Date(1_700_000_000_999);
    expect(marshallValue(d, 'iso')).toEqual({S: '2023-11-14T22:13:20.999Z'});
    expect(marshallValue(d, 'milliseconds')).toEqual({N: '1700000000999'});
    // A Date attribute in seconds rounds (as dynamoose's Date type); only timestamps floor.
    expect(marshallValue(d, 'seconds')).toEqual({N: '1700000001'});
    expect(marshallValue(new Date(1_700_000_000_499), 'seconds')).toEqual({N: '1700000000'});
  });

  // Literals: the PutItem request a dynamoose 4.x build sent to a stub client for {n: value} and {ns: Set}.
  it.each([
    [1e-7, '1e-7'],
    [-0, '0'],
    [0.1 + 0.2, '0.30000000000000004'],
    [Number.MAX_SAFE_INTEGER, '9007199254740991'],
    [-1.5, '-1.5']
  ])('formats %s as dynamoose does', (n, expected) => {
    expect(marshallValue(n)).toEqual({N: expected});
  });

  it('formats Set numbers as dynamoose does', () => {
    expect(marshallValue(new Set([1e-7, -0, 0.1 + 0.2]))).toEqual({
      NS: ['1e-7', '0', '0.30000000000000004']
    });
  });

  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['1e21 (dynamoose rejects it)', 1e21],
    ['an unsafe integer', 2 ** 53],
    ['a negative unsafe integer', -(2 ** 53)],
    ['an unsafe integer in a Set', new Set([1, 2 ** 53])],
    ['an empty Set', new Set()],
    ['a Set of mixed types', new Set(['a', 1])],
    ['a Set of booleans', new Set([true])],
    ['an invalid Date', new Date(NaN)],
    // @aws-sdk/util-dynamodb skips a function silently and stores a Map as M.
    ['a function', () => 1],
    ['a Map', new Map()]
  ])('rejects %s', (_, value) => {
    expect(() => marshallValue(value, 'iso')).toThrow(MarshallError);
  });

  it('rejects a Date without a storage rule', () => {
    expect(() => marshallValue(new Date(0))).toThrow('a Date needs a date storage rule');
  });

  it('rejects an own "__proto__" key instead of dropping it', () => {
    expect(() => marshallItem(JSON.parse('{"__proto__": {"x": 1}}'))).toThrow(MarshallError);
  });

  it('reports the path of a rejected value', () => {
    const error = (() => {
      try {
        marshallItem({a: {b: ['x', NaN]}});
      } catch (e) {
        return e as MarshallError;
      }
    })();
    expect(error).toBeInstanceOf(MarshallError);
    expect(error?.path).toEqual(['a', 'b', 1]);
    expect(error?.message).toBe(
      'NaN is not a finite number within the safe integer range at a.b[1]'
    );
  });

  it('does not mutate the input', () => {
    const input = {list: ['a', undefined], map: {gone: undefined}, set: new Set(['a', undefined])};
    marshallItem(input);
    expect(input).toStrictEqual({
      list: ['a', undefined],
      map: {gone: undefined},
      set: new Set(['a', undefined])
    });
  });
});

describe('unmarshallValue', () => {
  it('converts every attribute type', () => {
    expect(
      unmarshallItem({
        s: {S: 'x'},
        n: {N: '1.5'},
        bool: {BOOL: true},
        nil: {NULL: true},
        list: {L: [{N: '1'}, {S: 'a'}]},
        map: {M: {a: {N: '2'}}},
        ss: {SS: ['a', 'b']},
        ns: {NS: ['1', '2.5']},
        bs: {BS: [bytes]},
        b: {B: bytes}
      })
    ).toStrictEqual({
      s: 'x',
      n: 1.5,
      bool: true,
      nil: null,
      list: [1, 'a'],
      map: {a: 2},
      ss: new Set(['a', 'b']),
      ns: new Set([1, 2.5]),
      // A Buffer, as dynamoose returns.
      bs: new Set([Buffer.from([1, 2])]),
      b: Buffer.from([1, 2])
    });
  });

  it('reads a large stored integer as a BigInt, as dynamoose does', () => {
    expect(unmarshallValue({N: '9007199254740993'})).toBe(9007199254740993n);
    expect(unmarshallValue({NS: ['9007199254740993']})).toEqual(new Set([9007199254740993n]));
  });

  it('writes back a large integer it read', () => {
    expect(marshallValue(9007199254740993n)).toEqual({N: '9007199254740993'});
    expect(marshallValue(new Set([9007199254740993n]))).toEqual({NS: ['9007199254740993']});
  });

  it('rejects a large stored number that is not an integer', () => {
    expect(() => unmarshallValue({N: '1e21'})).toThrow(MarshallError);
  });

  it('rejects an unsupported attribute value with its path', () => {
    expect(() => unmarshallItem(JSON.parse('{"a": {"L": [{}]}}'))).toThrow(
      'unsupported attribute value with keys [] at a[0]'
    );
  });

  it('rejects a stored "__proto__" attribute instead of replacing the prototype', () => {
    const stored = JSON.parse('{"__proto__": {"M": {"x": {"N": "1"}}}}');
    expect(() => unmarshallItem(stored)).toThrow(MarshallError);
  });
});
