import type {AttributeValue} from '@aws-sdk/client-dynamodb';
import {formatPath} from './expression/paths.js';

export type DateStorage = 'iso' | 'milliseconds' | 'seconds';
export type PathSegment = string | number;

export class MarshallError extends Error {
  override readonly name = 'MarshallError';
  readonly reason: string;
  readonly path: PathSegment[] = [];

  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

// Errors are raised without a path; each container prepends its segment while the error unwinds,
// so the happy path never builds one.
function at(e: unknown, segment: PathSegment): unknown {
  if (e instanceof MarshallError) {
    e.path.unshift(segment);
    e.message = `${e.reason} at ${formatPath(e.path)}`;
  }
  return e;
}

export function guardKey(key: string): void {
  // An own "__proto__" key cannot be assigned to a plain object; it would replace its prototype.
  if (key === '__proto__')
    throw new MarshallError('the attribute name "__proto__" is not supported');
}

function toN(n: number): string {
  // Also false for NaN and ±Infinity. Beyond 2^53 a number has already lost precision; dynamoose
  // (through @aws-sdk/util-dynamodb) rejects it too.
  if (!(n >= Number.MIN_SAFE_INTEGER && n <= Number.MAX_SAFE_INTEGER)) {
    throw new MarshallError(`${n} is not a finite number within the safe integer range`);
  }
  return String(n);
}

// ArrayBuffer.isView, unlike instanceof Uint8Array, also accepts a Buffer from another realm (jest's vm context).
const isBytes = (v: unknown): v is Uint8Array => ArrayBuffer.isView(v);

/** The stored form of a Date attribute. Seconds round, as in dynamoose's Date type. */
export function storeDate(d: Date, storage: DateStorage): string | number {
  const ms = d.getTime();
  if (Number.isNaN(ms)) throw new MarshallError('an invalid Date cannot be stored');
  if (storage === 'iso') return d.toISOString();
  return storage === 'seconds' ? Math.round(ms / 1000) : ms;
}

function toDate(d: Date, dates: DateStorage | undefined): AttributeValue {
  if (dates === undefined) throw new MarshallError('a Date needs a date storage rule');
  const stored = storeDate(d, dates);
  return typeof stored === 'string' ? {S: stored} : {N: String(stored)};
}

function toSet(set: Set<unknown>): AttributeValue {
  let kind: 'S' | 'N' | 'B' | undefined;
  const out: unknown[] = [];
  for (const v of set) {
    // dynamoose marshalls with removeUndefinedValues, which drops undefined Set elements.
    if (v === undefined) continue;
    const k =
      typeof v === 'string'
        ? 'S'
        : typeof v === 'number' || typeof v === 'bigint'
          ? 'N'
          : isBytes(v)
            ? 'B'
            : undefined;
    if (k === undefined) throw new MarshallError('a Set can hold only strings, numbers or bytes');
    if (kind === undefined) kind = k;
    else if (k !== kind) throw new MarshallError('a Set cannot mix types');
    out.push(typeof v === 'number' ? toN(v) : typeof v === 'bigint' ? v.toString() : v);
  }
  if (kind === 'S') return {SS: out as string[]};
  if (kind === 'N') return {NS: out as string[]};
  if (kind === 'B') return {BS: out as Uint8Array[]};
  throw new MarshallError('an empty Set cannot be stored');
}

function toList(list: unknown[], dates: DateStorage | undefined): AttributeValue[] {
  const out: AttributeValue[] = [];
  let i = 0;
  try {
    for (; i < list.length; i++) {
      // dynamoose drops undefined list elements, so the indexes after one shift down.
      if (list[i] !== undefined) out.push(marshallValue(list[i], dates));
    }
  } catch (e) {
    throw at(e, i);
  }
  return out;
}

export function marshallItem(
  obj: Record<string, unknown>,
  dates?: DateStorage
): Record<string, AttributeValue> {
  const out: Record<string, AttributeValue> = {};
  let key = '';
  try {
    for (key of Object.keys(obj)) {
      guardKey(key);
      const v = obj[key];
      if (v !== undefined) out[key] = marshallValue(v, dates);
    }
  } catch (e) {
    throw at(e, key);
  }
  return out;
}

export function isPlainObject(v: object): v is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(v);
  // Matches Object.prototype of any realm, and null-prototype objects.
  return proto === null || Object.getPrototypeOf(proto) === null;
}

export function marshallValue(value: unknown, dates?: DateStorage): AttributeValue {
  switch (typeof value) {
    case 'string':
      return {S: value};
    case 'number':
      return {N: toN(value)};
    // A stored number beyond 2^53 is read back as a BigInt, so it can be written back.
    case 'bigint':
      return {N: value.toString()};
    case 'boolean':
      return {BOOL: value};
    case 'object':
      break;
    default:
      throw new MarshallError(`a value of type ${typeof value} cannot be stored`);
  }
  if (value === null) return {NULL: true};
  if (Array.isArray(value)) return {L: toList(value, dates)};
  if (isPlainObject(value)) return {M: marshallItem(value, dates)};
  if (value instanceof Set) return toSet(value);
  if (isBytes(value)) return {B: value};
  if (value instanceof Date) return toDate(value, dates);
  throw new MarshallError(`a ${value.constructor?.name ?? 'object'} instance cannot be stored`);
}

function fromN(s: string): number | bigint {
  const n = Number(s);
  if (n <= Number.MAX_SAFE_INTEGER && n >= Number.MIN_SAFE_INTEGER) return n;
  // dynamoose reads through @aws-sdk/util-dynamodb, which returns a BigInt for a large integer.
  try {
    return BigInt(s);
  } catch {
    throw new MarshallError(`the stored number ${s} cannot be read without losing precision`);
  }
}

function fromList(list: AttributeValue[]): unknown[] {
  const out: unknown[] = [];
  let i = 0;
  try {
    for (; i < list.length; i++) out.push(unmarshallValue(list[i]!));
  } catch (e) {
    throw at(e, i);
  }
  return out;
}

export function unmarshallItem(map: Record<string, AttributeValue>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let key = '';
  try {
    for (key of Object.keys(map)) {
      guardKey(key);
      out[key] = unmarshallValue(map[key]!);
    }
  } catch (e) {
    throw at(e, key);
  }
  return out;
}

// dynamoose returns bytes as a Buffer, and `buffer.toString('base64')` on a plain Uint8Array silently gives "1,2,3".
const toBuffer = (b: Uint8Array) =>
  Buffer.isBuffer(b) ? b : Buffer.from(b.buffer, b.byteOffset, b.byteLength);

export function unmarshallValue(av: AttributeValue): unknown {
  if (av.S !== undefined) return av.S;
  if (av.N !== undefined) return fromN(av.N);
  if (av.BOOL !== undefined) return av.BOOL;
  if (av.NULL !== undefined) return null;
  if (av.M !== undefined) return unmarshallItem(av.M);
  if (av.L !== undefined) return fromList(av.L);
  if (av.SS !== undefined) return new Set(av.SS);
  if (av.NS !== undefined) return new Set(av.NS.map(fromN));
  if (av.B !== undefined) return toBuffer(av.B);
  if (av.BS !== undefined) return new Set(av.BS.map(toBuffer));
  throw new MarshallError(`unsupported attribute value with keys [${Object.keys(av).join(', ')}]`);
}
