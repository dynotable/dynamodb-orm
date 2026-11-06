/**
 * What a value is, which says where a Set can be: `plain` values hold JS `Set`s only; `stored` is an array of raw
 * items, each a `map` of attribute names to AttributeValue `node`s, where an `SS`/`NS`/`BS` node is a Set and an
 * `M` node holds a `map`, an `L` node a `list` of nodes. An attribute named `SS` is not a Set.
 */
type Kind = 'plain' | 'stored' | 'map' | 'node' | 'list';

/**
 * Compares two values: read results (`plain`) or the raw items of two tables (`stored`). Sets are compared without
 * order. Nothing else is normalized: numbers are compared as stored text, a missing attribute is not `NULL`,
 * prototypes must match, and an own `__proto__` key is compared like any other. Map keys are compared as a set,
 * because DynamoDB does not keep attribute order.
 * Returns the path of the first difference, or `undefined` when the values are equal.
 */
export function difference(
  a: unknown,
  b: unknown,
  path = '$',
  kind: Kind = 'plain'
): string | undefined {
  if (Object.is(a, b)) return undefined;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null)
    return `${path}: ${show(a)} vs ${show(b)}`;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b))
    return `${path}: ${className(a)} vs ${className(b)}`;
  if (a instanceof Date)
    return Object.is(a.getTime(), (b as Date).getTime())
      ? undefined
      : `${path}: ${show(a)} vs ${show(b)}`;
  if (ArrayBuffer.isView(a)) {
    const x = Buffer.from(a.buffer, a.byteOffset, a.byteLength);
    const view = b as ArrayBufferView;
    return x.equals(Buffer.from(view.buffer, view.byteOffset, view.byteLength))
      ? undefined
      : `${path}: bytes differ`;
  }
  if (a instanceof Set) return unordered([...a], [...(b as Set<unknown>)], path);
  if (Array.isArray(a)) {
    const other = b as unknown[];
    if (a.length !== other.length) return `${path}: length ${a.length} vs ${other.length}`;
    const element = kind === 'stored' ? 'map' : kind === 'list' ? 'node' : 'plain';
    for (let i = 0; i < a.length; i++) {
      const d = difference(a[i], other[i], `${path}[${i}]`, element);
      if (d) return d;
    }
    return undefined;
  }
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = Object.keys(x);
  const missing =
    keys.find((k) => !Object.hasOwn(y, k)) ?? Object.keys(y).find((k) => !Object.hasOwn(x, k));
  if (missing !== undefined) return `${path}.${missing}: present on one side only`;
  for (const k of keys) {
    const at = `${path}.${k}`;
    const isSet =
      kind === 'node' &&
      (k === 'SS' || k === 'NS' || k === 'BS') &&
      Array.isArray(x[k]) &&
      Array.isArray(y[k]);
    const d = isSet
      ? unordered(x[k] as unknown[], y[k] as unknown[], at)
      : difference(x[k], y[k], at, childKind(kind, k));
    if (d) return d;
  }
  return undefined;
}

function childKind(kind: Kind, key: string): Kind {
  if (kind === 'map') return 'node';
  if (kind === 'node') return key === 'M' ? 'map' : key === 'L' ? 'list' : 'plain';
  return 'plain';
}

// Each element of `a` is matched to one equal element of `b`.
function unordered(a: unknown[], b: unknown[], path: string): string | undefined {
  if (a.length !== b.length) return `${path}: size ${a.length} vs ${b.length}`;
  const rest = [...b];
  for (const e of a) {
    const i = rest.findIndex((r) => difference(e, r) === undefined);
    if (i === -1) return `${path}: ${show(e)} has no match`;
    rest.splice(i, 1);
  }
  return undefined;
}

const className = (v: object) => Object.getPrototypeOf(v)?.constructor?.name ?? 'null-prototype';
function show(v: unknown): string {
  if (v instanceof Date) return `Date(${Number.isNaN(v.getTime()) ? 'invalid' : v.toISOString()})`;
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'object' && v !== null) return className(v);
  return Object.is(v, -0) ? '-0' : String(v);
}
