import type {AttributeValue} from '@aws-sdk/client-dynamodb';
import {ExpressionError} from '../errors.js';
import type {RawCondition} from '../types.js';
import {type ConditionNode, renderCondition} from './condition-ast.js';
import {formatPath, type Path} from './paths.js';

/** One update action. Values are already marshalled. */
export type UpdateAction =
  | {
      readonly kind: 'set';
      readonly path: Path;
      readonly value: AttributeValue;
      readonly ifNotExists?: boolean;
    }
  /** `$ADD` on a list: `SET p = list_append(p, v)`. */
  | {readonly kind: 'append'; readonly path: Path; readonly value: AttributeValue}
  | {readonly kind: 'remove'; readonly path: Path}
  | {readonly kind: 'add' | 'delete'; readonly path: Path; readonly value: AttributeValue};

export interface ExpressionInput {
  UpdateExpression?: string;
  ConditionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, AttributeValue>;
}

// Placeholders as DynamoDB defines them. Used only to rename a raw condition's colliding placeholders.
const PLACEHOLDER = /[#:][A-Za-z0-9_]+/g;
const NAME = /^#[A-Za-z0-9_]+$/;
const VALUE = /^:[A-Za-z0-9_]+$/;
// The number in a placeholder the counter hands out: `#a3`, `#a3_1`, `:v3`, `:v3_2`.
const NUMBERED = /^(?:#a|:v)(\d+)(?:_\d+)?$/;

/**
 * Hands out placeholders as dynamoose numbers them, from one counter: each condition term and each update action
 * takes the next number N, and its names and values are `#aN`/`:vN` (a condition's nested path `#aN_0.#aN_1`, its
 * `in`/`between` values `:vN_1`, `:vN_2`…; an update path one number per name, its value the first one's). Names
 * are never shared between terms, as in dynamoose. A number a raw condition already holds is skipped.
 */
export class ExpressionContext {
  readonly names: Record<string, string> = {};
  readonly values: Record<string, AttributeValue> = {};
  private next = 0;
  private blocked: Set<number> | undefined;

  /** The first of `count` free numbers, and moves the counter past them. */
  take(count = 1): number {
    let n = this.next;
    if (this.blocked)
      for (let i = 0; i < count; i++) {
        if (this.blocked.has(n + i)) {
          n += i + 1;
          i = -1;
        }
      }
    this.next = n + count;
    return n;
  }

  /** Skips one number, as dynamoose does for a condition it moves into a key condition. */
  reserve(): void {
    this.take();
  }

  /** A condition term's path: `#aN`, or `#aN_0.#aN_1` below an object. A list index stays literal. */
  conditionPath(path: Path, n: number): string {
    let named = 0;
    for (const segment of path) if (typeof segment === 'string') named++;
    let out = '';
    let j = 0;
    for (const segment of path) {
      if (typeof segment === 'number') {
        out += `[${segment}]`;
        continue;
      }
      const key = named === 1 ? `#a${n}` : `#a${n}_${j++}`;
      this.names[key] = segment;
      out += out === '' ? key : `.${key}`;
    }
    return out;
  }

  /** An update path: one number per name (`#aN.#aN+1`), taken here. Returns the path text and its value number. */
  updatePath(path: Path): {text: string; n: number} {
    let named = 0;
    for (const segment of path) if (typeof segment === 'string') named++;
    const n = this.take(Math.max(named, 1));
    let out = '';
    let k = n;
    for (const segment of path) {
      if (typeof segment === 'number') {
        out += `[${segment}]`;
        continue;
      }
      const key = `#a${k++}`;
      this.names[key] = segment;
      out += out === '' ? key : `.${key}`;
    }
    return {text: out, n};
  }

  value(n: number, value: AttributeValue, part?: number): string {
    const key = part === undefined ? `:v${n}` : `:v${n}_${part}`;
    this.values[key] = value;
    return key;
  }

  /** Adds a raw condition and returns its expression, with the placeholders that collide renamed. */
  mergeRaw(raw: RawCondition): string {
    const names = Object.entries(raw.ExpressionAttributeNames ?? {});
    const values = Object.entries(raw.ExpressionAttributeValues ?? {});
    // Also keeps an own `__proto__` key (JSON.parse) from replacing a map's prototype.
    for (const [key] of names)
      if (!NAME.test(key))
        throw new ExpressionError(
          `'${key}' is not a name placeholder: it starts with # and holds A-Z, a-z, 0-9 or _`
        );
    for (const [key] of values)
      if (!VALUE.test(key))
        throw new ExpressionError(
          `'${key}' is not a value placeholder: it starts with : and holds A-Z, a-z, 0-9 or _`
        );
    const nameCollides = ([key, attribute]: [string, string]) =>
      this.names[key] !== undefined && this.names[key] !== attribute;
    const valueCollides = ([key]: [string, AttributeValue]) => this.values[key] !== undefined;
    const block = (key: string) => {
      const m = NUMBERED.exec(key);
      if (m) (this.blocked ??= new Set()).add(Number(m[1]));
    };
    // Every number the raw condition holds is blocked first, so a fresh placeholder cannot take one of them.
    for (const [key] of [...names, ...values]) block(key);
    for (const entry of names) if (!nameCollides(entry)) this.names[entry[0]] = entry[1];
    // A colliding `#aN`/`:vN` pair moves to one fresh number, so the name and its value still share it.
    const moved = new Map<string, number>();
    const fresh = (key: string, prefix: string) => {
      const m = NUMBERED.exec(key);
      if (!m) return `${prefix}${this.take()}`;
      let n = moved.get(m[1]!);
      if (n === undefined) moved.set(m[1]!, (n = this.take()));
      return key.replace(/\d+/, String(n));
    };
    const renamed = new Map<string, string>();
    for (const entry of values) {
      if (!valueCollides(entry)) this.values[entry[0]] = entry[1];
      else {
        const key = fresh(entry[0], ':v');
        this.values[key] = entry[1];
        renamed.set(entry[0], key);
      }
    }
    for (const entry of names) {
      if (nameCollides(entry)) {
        const key = fresh(entry[0], '#a');
        this.names[key] = entry[1];
        renamed.set(entry[0], key);
      }
    }
    if (renamed.size === 0) return raw.ConditionExpression;
    return raw.ConditionExpression.replace(PLACEHOLDER, (token) => renamed.get(token) ?? token);
  }
}

function attributes(ctx: ExpressionContext, out: ExpressionInput): ExpressionInput {
  // DynamoDB rejects an empty ExpressionAttributeValues map, as for a REMOVE-only update.
  if (Object.keys(ctx.names).length > 0) out.ExpressionAttributeNames = ctx.names;
  if (Object.keys(ctx.values).length > 0) out.ExpressionAttributeValues = ctx.values;
  return out;
}

export function compileCondition(condition: ConditionNode): ExpressionInput {
  const ctx = new ExpressionContext();
  return attributes(ctx, {ConditionExpression: renderCondition(ctx, condition)});
}

// Clause order follows dynamoose's text: DELETE, REMOVE, ADD, SET.
const CLAUSES = ['DELETE', 'REMOVE', 'ADD', 'SET'] as const;
const CLAUSE_OF = {set: 3, append: 3, remove: 1, add: 2, delete: 0} as const;

// DynamoDB rejects an update that writes one path twice, or a path and another inside it.
function refuseOverlap(actions: readonly UpdateAction[]): void {
  const written = new Set<string>();
  const ancestors = new Set<string>();
  for (const {path} of actions) {
    let key = '';
    for (let i = 0; i < path.length; i++) {
      const seg = path[i]!;
      key += typeof seg === 'number' ? `\u0000${seg}` : `\u0001${seg}`;
      const last = i === path.length - 1;
      if ((last && (written.has(key) || ancestors.has(key))) || (!last && written.has(key))) {
        throw new ExpressionError(
          `the update writes '${formatPath(path.slice(0, i + 1))}' and a path that overlaps it: DynamoDB rejects that`
        );
      }
      if (!last) ancestors.add(key);
    }
    written.add(key);
  }
}

/**
 * Placeholders are numbered in action order, then the actions are grouped by clause. The condition,
 * when given, is rendered first and the actions take the numbers after it, as in dynamoose.
 */
export function compileUpdate(
  actions: readonly UpdateAction[],
  condition?: ConditionNode
): ExpressionInput {
  if (actions.length === 0) throw new ExpressionError('the update has nothing to write');
  refuseOverlap(actions);
  const ctx = new ExpressionContext();
  const out: ExpressionInput = {};
  if (condition !== undefined) out.ConditionExpression = renderCondition(ctx, condition);
  const clauses: string[][] = [[], [], [], []];
  for (const action of actions) {
    const {text: path, n} = ctx.updatePath(action.path);
    let term: string;
    switch (action.kind) {
      case 'set':
        term = action.ifNotExists
          ? `${path} = if_not_exists(${path}, ${ctx.value(n, action.value)})`
          : `${path} = ${ctx.value(n, action.value)}`;
        break;
      case 'append':
        term = `${path} = list_append(${path}, ${ctx.value(n, action.value)})`;
        break;
      case 'remove':
        term = path;
        break;
      case 'add':
      case 'delete':
        term = `${path} ${ctx.value(n, action.value)}`;
        break;
    }
    clauses[CLAUSE_OF[action.kind]]!.push(term);
  }
  let text = '';
  for (let i = 0; i < CLAUSES.length; i++) {
    if (clauses[i]!.length === 0) continue;
    text += `${text === '' ? '' : ' '}${CLAUSES[i]} ${clauses[i]!.join(', ')}`;
  }
  out.UpdateExpression = text;
  return attributes(ctx, out);
}
