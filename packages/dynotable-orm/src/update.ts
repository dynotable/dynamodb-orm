import {ExpressionError, ValidationError, valueAt} from './errors.js';
import {compileUpdate, type ExpressionInput, type UpdateAction} from './expression/compile.js';
import type {ConditionNode} from './expression/condition-ast.js';
import {formatPath, parsePath, type Path} from './expression/paths.js';
import {isPlainObject, marshallValue} from './marshall.js';
import {deepCopy, stamp} from './pipeline.js';
import {type Plan, perPlan} from './plan.js';
import type {Item, StandardIssue, StandardResult, StandardSchema} from './types.js';

/** A `$SET` value written only when the attribute is not stored yet: `SET p = if_not_exists(p, v)`. */
export class IfNotExists<V = unknown> {
  constructor(readonly value: V) {}
}
export const ifNotExists = <V>(value: V): IfNotExists<V> => new IfNotExists(value);

const OPERATIONS: Readonly<Record<string, Change['kind']>> = {
  $SET: 'set',
  $REMOVE: 'remove',
  $ADD: 'add',
  $DELETE: 'delete'
};

interface Change {
  kind: 'set' | 'remove' | 'add' | 'delete';
  key: string;
  value?: unknown;
}

// A plain field is an implicit `$SET`. `$REMOVE` is a list of keys or an object of nulls.
function changesOf(input: Item): Change[] {
  const out: Change[] = [];
  for (const key of Object.keys(input)) {
    const value = input[key];
    const kind =
      Object.hasOwn(OPERATIONS, key) && typeof value === 'object' && value !== null
        ? OPERATIONS[key]!
        : undefined;
    if (kind === undefined) out.push({kind: 'set', key, value});
    else if (kind === 'remove' && Array.isArray(value))
      for (const k of value as string[]) out.push({kind, key: k});
    else
      for (const k of Object.keys(value as Item))
        out.push({kind, key: k, value: (value as Item)[k]});
  }
  return out;
}

interface UpdateField {
  path: Path;
  /** The attribute name, when the path is one. */
  top?: string;
  /** What the item holds at the path; `undefined` when the model does not declare it. */
  at: ReturnType<Plan['at']>;
  /** The schema for a value written as given: a nested default with checks of its own skips them for a key left out. */
  given?: StandardSchema;
  /** What an appended element holds at the path, before its transforms run. */
  element?: ReturnType<Plan['at']>;
  /** The schema an appended element is checked by: the list's input element, as the element is stored before the list's transform. */
  elementGiven?: StandardSchema;
  makeDefault?: () => unknown;
  /** The nearest ancestor with its own checks or transform: a partial write under it is refused. */
  ruled?: string;
}

const updateField = perPlan((plan, key): UpdateField => {
  const path = parsePath(key);
  const {adapter} = plan;
  const field: UpdateField = {path, at: plan.at(path)};
  if (path.length === 1) field.top = path[0] as string;
  const given = adapter?.asGiven(path);
  if (given) field.given = given;
  if (typeof path.at(-1) === 'number') {
    field.element = plan.at(path, true);
    const elementGiven = adapter?.asGiven(path, true);
    if (elementGiven) field.elementGiven = elementGiven;
  }
  const makeDefault = adapter?.defaults(path);
  if (makeDefault) field.makeDefault = makeDefault;
  for (let i = path.length - 1; i > 0 && adapter; i--) {
    if (adapter.hasRule(path.slice(0, i))) {
      field.ruled = formatPath(path.slice(0, i));
      break;
    }
  }
  return field;
});

// dynamoose runs the hook on the path wrapped in objects (a list index as element 0) and reads the value back.
function hooked(set: NonNullable<Plan['set']>, path: Path, value: unknown): unknown {
  const root: Record<string, unknown> = {};
  let parent: any = root;
  path.forEach((seg, i) => {
    const key = typeof seg === 'number' ? 0 : seg;
    if (i === path.length - 1) parent[key] = value;
    else parent = parent[key] = typeof path[i + 1] === 'number' ? [] : {};
  });
  let out: any = set(root);
  for (const seg of path) out = out?.[typeof seg === 'number' ? 0 : seg];
  return out;
}

// Issue paths are relative to the field; the error names the item path.
async function check(schema: StandardSchema, value: unknown, at: Path): Promise<unknown> {
  const r = schema['~standard'].validate(value);
  const result: StandardResult<unknown> = r instanceof Promise ? await r : r;
  if (!result.issues) return result.value;
  throw new ValidationError(
    result.issues.map((i): StandardIssue => ({...i, path: [...at, ...(i.path ?? [])]})),
    valueAt(value, at.length)
  );
}

// As dynamoose's `$ADD`: an appended element is checked, then stored as given, without its transforms or defaults,
// so its Dates are stored by its input's shape.
async function element(
  plan: Plan,
  key: string,
  path: Path,
  given: unknown,
  index: number
): Promise<unknown> {
  const field = updateField(plan, `${key}[0]`);
  const at = field.element;
  const kept = at?.drop ? at.drop(given) : deepCopy(given);
  // A transform may change its input, and `.readonly()` freezes it: the check gets its own copy.
  if (field.elementGiven) await check(field.elementGiven, deepCopy(kept), [...path, index]);
  return at?.toStored ? at.toStored(kept) : kept;
}

/**
 * Builds the update expression, in dynamoose's order: normalize the shapes, apply truthy defaults on remove or
 * delete, drop undeclared paths, validate each `$SET` value and appended list element (adapter only) and
 * refuse a partial write under a parent with a rule, run the hook on each `$SET` path, set `updatedAt`, combine.
 * A change of `updatedAt` itself is ignored: the stamp wins.
 */
export async function updateExpression(
  plan: Plan,
  input: Item,
  condition?: ConditionNode,
  allowUndeclared = false
): Promise<ExpressionInput> {
  const dateStorage = plan.defaultDateStorage;
  const actions: UpdateAction[] = [];
  // Top-level writes in stored form, read by combine: a set's value, or `undefined` for a remove.
  const whole = new Map<string, unknown>();
  // Top-level sets written with ifNotExists: DynamoDB may keep the stored value, so combine cannot read them.
  const conditional = new Set<string>();
  const touched = new Set<string>();
  const skipped: string[] = [];
  let requested = 0;

  const {updatedAt} = plan.timestamps;
  // `updatedAt` comes first, as in dynamoose, so a timestamped model's simple update keeps dynamoose's text.
  if (updatedAt) {
    const value = stamp(updatedAt, new Date());
    actions.push({kind: 'set', path: [updatedAt.name], value: marshallValue(value, dateStorage)});
    whole.set(updatedAt.name, value);
    touched.add(updatedAt.name);
  }

  for (const change of changesOf(input)) {
    const field = updateField(plan, change.key);
    const {path, at, top} = field;
    // The lib sets updatedAt itself: a caller's value (an item read and written back) would write the path twice.
    if (updatedAt && path[0] === updatedAt.name) continue;
    // An undeclared path is dropped, unless the call allows an undeclared top-level attribute, written as given.
    // A remove is kept: dynamoose's `Model.update` removes an undeclared attribute.
    if (at === undefined && change.kind !== 'remove' && !(allowUndeclared && top !== undefined)) {
      if (top === undefined) skipped.push(change.key);
      continue;
    }
    let {kind, value} = change;
    if (kind === 'set' && value === undefined) kind = 'remove';
    if (field.ruled !== undefined && (kind === 'set' || kind === 'remove')) {
      throw new ExpressionError(
        `${change.key} cannot be updated alone: ${field.ruled} has its own checks or transform, so write the whole ${field.ruled}.`
      );
    }
    requested++;
    touched.add(path[0] as string);

    // Only a truthy default replaces a remove or a delete (`if (defaultValue)` in dynamoose). dynamoose converts a
    // nested one as a `$SET` of it, through the field's checks, transforms and the hook; a top-level one is written as given.
    const fallback = kind === 'remove' || kind === 'delete' ? field.makeDefault?.() : undefined;
    if (fallback && top === undefined) {
      kind = 'set';
      value = fallback;
    } else if (fallback) {
      const stored = at?.toStored ? at.toStored(fallback) : fallback;
      actions.push({kind: 'set', path, value: marshallValue(stored, dateStorage)});
      whole.set(top!, stored);
      continue;
    }

    switch (kind) {
      case 'remove':
        // Removing a list element shifts the list; it never leaves a hole a required check would see. A falsy
        // default is not written, so its checks do not run: dynamoose removes the attribute.
        if (field.given && typeof path.at(-1) !== 'number')
          await check(field.given, undefined, path);
        actions.push({kind, path});
        if (top !== undefined) whole.set(top, undefined);
        break;
      case 'set': {
        const marked = value instanceof IfNotExists;
        const raw = marked ? (value as IfNotExists).value : value;
        // As on a whole-item write: undeclared keys are dropped before the check, and the ones Zod strips that
        // dynamoose's `parent.**` keeps are put back after it. The schema and the hook get a copy of the caller's value.
        const given = at?.drop ? at.drop(raw) : deepCopy(raw);
        let v = field.given ? await check(field.given, given, path) : given;
        if (at?.restore) v = at.restore(v, given);
        // dynamoose's `$SET` writes a parent as given: the nested defaults Zod put in go.
        if (at?.undefault) v = at.undefault(v, given);
        if (at?.toStored) v = at.toStored(v);
        // The hook runs on each `$SET` path, as in dynamoose.
        if (plan.set) v = hooked(plan.set, path, v);
        // The hook dropped the value: dynamoose removes the attribute.
        if (v === undefined) {
          actions.push({kind: 'remove', path});
          if (top !== undefined) whole.set(top, undefined);
          break;
        }
        actions.push({
          kind,
          path,
          value: marshallValue(v, dateStorage),
          ...(marked && {ifNotExists: true})
        });
        if (top !== undefined) {
          whole.set(top, v);
          if (marked) conditional.add(top);
        }
        break;
      }
      case 'add':
      case 'delete': {
        // A number or Set operand is a delta, not a value, so the field schema does not judge it.
        const type = at?.type;
        if (kind === 'delete' || type === 'set' || value instanceof Set) {
          const set = Array.isArray(value) ? new Set(value) : value;
          if (!(set instanceof Set))
            throw new ExpressionError(
              `$${kind.toUpperCase()} on '${change.key}' takes a Set or an array of elements`
            );
          actions.push({kind, path, value: marshallValue(set, dateStorage)});
        } else if (Array.isArray(value) || type === 'list' || type === 'tuple') {
          let appended = Array.isArray(value) ? value : [value];
          // A tuple's walk is positional, so it cannot judge elements past its end.
          if (type === 'list')
            appended = await Promise.all(
              appended.map((e, i) => element(plan, change.key, path, e, i))
            );
          actions.push({kind: 'append', path, value: marshallValue(appended, dateStorage)});
        } else {
          actions.push({kind: 'add', path, value: marshallValue(value, dateStorage)});
        }
        break;
      }
    }
  }
  if (requested === 0 && skipped.length > 0) {
    throw new ExpressionError(
      `Nothing to update: the schema does not declare ${skipped.join(', ')}.`
    );
  }

  // Combine: a key's sources can never change; otherwise all sources or none, as whole top-level sets or removes.
  for (const {target, sources, separator, isKey} of plan.combine) {
    const updated = sources.filter((s) => touched.has(s));
    if (isKey) {
      if (updated.length > 0) {
        throw new ExpressionError(
          `You cannot update the combine attributes of ${target} because it is part of the key. Remove them from the update: ${updated.join(', ')}.`
        );
      }
      continue;
    }
    if (updated.length === 0) continue;
    const unknown = sources.filter((s) => conditional.has(s));
    if (unknown.length > 0) {
      throw new ExpressionError(
        `${target} combines ${unknown.join(', ')}, written with ifNotExists: the stored value may stay, so ${target} cannot be computed. Write them without ifNotExists.`
      );
    }
    const missing = sources.filter((s) => !whole.has(s));
    if (missing.length > 0) {
      throw new ExpressionError(
        `You must update all or none of the combine attributes when running Model.update. Missing combine attributes: ${missing.join(', ')}.`
      );
    }
    const parts = sources.map((s) => whole.get(s)).filter((v) => v !== undefined && v !== null);
    const combined = parts.join(separator);
    actions.push({kind: 'set', path: [target], value: marshallValue(combined, dateStorage)});
    // A later combine can take this one as a source.
    whole.set(target, combined);
    touched.add(target);
  }

  return compileUpdate(actions, condition);
}

/** One argument holds the key and the changes; the key fields are not written. */
export function splitKey(item: unknown, keyNames: readonly string[]): {key: Item; changes: Item} {
  if (typeof item !== 'object' || item === null || !isPlainObject(item)) {
    throw new TypeError('update(item) takes an object holding the key and the changes');
  }
  const key: Item = {};
  const changes: Item = {...item};
  for (const k of keyNames) {
    key[k] = changes[k];
    delete changes[k];
  }
  return {key, changes};
}
