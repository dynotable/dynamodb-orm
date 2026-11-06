import {convertToAttr, marshall, unmarshall} from '@aws-sdk/util-dynamodb';
import fc from 'fast-check';
import {expect, it} from 'vitest';
import {marshallItem, marshallValue, unmarshallItem} from '../src/marshall.js';

// The domain both sides accept: the SDK alone also takes Map, ArrayBuffer and class instances.
const safeNumber = fc.double({
  min: Number.MIN_SAFE_INTEGER,
  max: Number.MAX_SAFE_INTEGER,
  noNaN: true,
  noDefaultInfinity: true
});
const bytes = fc.uint8Array({maxLength: 4});
const key = fc.string({maxLength: 6}).filter((k) => k !== '__proto__');

const {value} = fc.letrec<{value: unknown}>((tie) => ({
  value: fc.oneof(
    {depthSize: 'small'},
    fc.string(),
    safeNumber,
    fc.bigInt(),
    fc.boolean(),
    fc.constant(null),
    bytes,
    fc.uniqueArray(fc.string(), {minLength: 1}).map((a) => new Set(a)),
    fc.uniqueArray(safeNumber, {minLength: 1, comparator: 'SameValueZero'}).map((a) => new Set(a)),
    fc.uniqueArray(fc.bigInt(), {minLength: 1}).map((a) => new Set(a)),
    fc.array(bytes, {minLength: 1}).map((a) => new Set(a)),
    fc.array(fc.option(tie('value'), {nil: undefined})),
    fc.dictionary(key, fc.option(tie('value'), {nil: undefined}), {noNullPrototype: true})
  )
}));
const item = fc.dictionary(key, value, {noNullPrototype: true});

// The SDK returns bytes as a Uint8Array; this lib returns a Buffer, as dynamoose does.
const bytesAsBuffer = (v: unknown): unknown => {
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  if (v instanceof Set) return new Set([...v].map(bytesAsBuffer));
  if (Array.isArray(v)) return v.map(bytesAsBuffer);
  if (typeof v === 'object' && v !== null)
    return Object.fromEntries(Object.entries(v).map(([k, e]) => [k, bytesAsBuffer(e)]));
  return v;
};

// dynamoose marshalls items with removeUndefinedValues.
const sdkOptions = {removeUndefinedValues: true};

it('marshallValue deep-equals convertToAttr on the shared domain', () => {
  fc.assert(
    fc.property(value, (v) => {
      expect(marshallValue(v)).toStrictEqual(convertToAttr(v, sdkOptions));
    })
  );
});

it('unmarshallItem deep-equals unmarshall on the shared domain', () => {
  fc.assert(
    fc.property(item, (i) => {
      const stored = marshall(i, sdkOptions);
      expect(marshallItem(i)).toStrictEqual(stored);
      expect(unmarshallItem(stored)).toStrictEqual(bytesAsBuffer(unmarshall(stored)));
    })
  );
});
