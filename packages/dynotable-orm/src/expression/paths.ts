import {ExpressionError} from '../errors.js';
import type {PathSegment} from '../marshall.js';

/** Attribute names are strings, list indexes are numbers. */
export type Path = readonly PathSegment[];

/** `['a', 'b', 0, 'c']` as `a.b[0].c`, for messages. */
export const formatPath = (path: Path): string =>
  path.map((seg, i) => (typeof seg === 'number' ? `[${seg}]` : i === 0 ? seg : `.${seg}`)).join('');

const DOT = 46;
const OPEN = 91;
const CLOSE = 93;
const ZERO = 48;
const NINE = 57;

// These names reach object internals in the code that walks a path through an item.
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

function pushName(out: PathSegment[], path: string, name: string): void {
  if (FORBIDDEN.has(name))
    throw new ExpressionError(
      `Invalid path: ${path}. "${name}" is not allowed as an attribute name.`
    );
  out.push(name);
}

/**
 * Splits `a.b[0].c` into `['a', 'b', 0, 'c']`. A path starts with a name, and a
 * list index is followed by a dot, another index or the end. A dot before an index (`a.[0]`) is accepted.
 */
export function parsePath(path: string): PathSegment[] {
  const out: PathSegment[] = [];
  let start = 0;
  let i = 0;
  while (i < path.length) {
    const c = path.charCodeAt(i);
    if (c === DOT) {
      if (i === start) {
        // Only `a.[0]` leaves an empty name before an index.
        if (path.charCodeAt(i + 1) !== OPEN || out.length === 0) {
          throw new ExpressionError(`Invalid path: ${path}. An attribute name cannot be empty.`);
        }
      } else {
        pushName(out, path, path.slice(start, i));
      }
      start = ++i;
    } else if (c === OPEN) {
      if (i > start) pushName(out, path, path.slice(start, i));
      if (out.length === 0)
        throw new ExpressionError(
          `Invalid path: ${path}. A path must start with an attribute name.`
        );
      let index = 0;
      let j = i + 1;
      for (; j < path.length; j++) {
        const d = path.charCodeAt(j);
        if (d === CLOSE) break;
        if (d < ZERO || d > NINE)
          throw new ExpressionError(`Invalid path: ${path}. A list index must be a number.`);
        index = index * 10 + (d - ZERO);
      }
      if (j === path.length)
        throw new ExpressionError(`Invalid path: ${path}. A bracket is not closed.`);
      if (j === i + 1)
        throw new ExpressionError(`Invalid path: ${path}. A list index cannot be empty.`);
      if (!Number.isSafeInteger(index))
        throw new ExpressionError(`Invalid path: ${path}. A list index is too large.`);
      out.push(index);
      i = j + 1;
      const next = path.charCodeAt(i);
      if (i < path.length && next !== DOT && next !== OPEN) {
        throw new ExpressionError(
          `Invalid path: ${path}. A list index must be followed by a dot, another index or the end of the path.`
        );
      }
      if (next === DOT) i++;
      start = i;
    } else {
      i++;
    }
  }
  if (i > start) pushName(out, path, path.slice(start, i));
  else if (out.length === 0 || path.charCodeAt(path.length - 1) === DOT) {
    throw new ExpressionError(`Invalid path: ${path}. An attribute name cannot be empty.`);
  }
  return out;
}
