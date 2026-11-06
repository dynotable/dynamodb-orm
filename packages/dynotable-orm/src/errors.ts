import type {StandardIssue} from './types.js';

/**
 * A model definition that cannot work. Thrown by `model()`, `extend()`, `createTableInput()` and `extendZod()`, before any
 * request is sent. Also thrown by the first call that parses a key, condition or query value whose field has an async
 * check or transform: those values are parsed synchronously, and only a call shows that a check is async.
 */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** A path, an update, a condition, a key, a batch or a transaction that DynamoDB would reject. Thrown before any request is sent. */
export class ExpressionError extends Error {
  override readonly name = 'ExpressionError';
}

// The type name dynamoose's messages give a value (utils/type_name).
const typeName = (v: unknown): string =>
  v === null
    ? 'null'
    : Object.prototype.toString.call(v) === '[object Object]' &&
        (v as object).constructor !== undefined &&
        (v as object).constructor !== Object
      ? (v as object).constructor.name
      : typeof v;

/**
 * The schema rejected an item. `path` is the path of the first issue. A value outside an enum and a value of the wrong
 * type are told in dynamoose's words, which callers and tests match: `status must equal ["A","B"], but is set to C`,
 * `Expected note to be of type string, instead found type null.`. Any other issue keeps the schema's message.
 */
export class ValidationError extends Error {
  override readonly name = 'ValidationError';
  readonly issues: readonly StandardIssue[];
  readonly path: readonly PropertyKey[];

  /** `valueAt` reads the rejected value at an issue's path, for the dynamoose wording. */
  constructor(
    issues: readonly StandardIssue[],
    valueAt?: (path: readonly PropertyKey[]) => unknown
  ) {
    const path = (issues[0]?.path ?? []).map((p) => (typeof p === 'object' ? p.key : p));
    const issue = issues[0] as
      | (StandardIssue & {code?: string; values?: unknown[]; expected?: string})
      | undefined;
    const key = path.map(String).join('.');
    let message = issue?.message ?? 'the schema rejected the item';
    if (valueAt && key) {
      if (issue?.code === 'invalid_value' && Array.isArray(issue.values))
        message = `${key} must equal ${JSON.stringify(issue.values)}, but is set to ${String(valueAt(path))}`;
      else if (issue?.code === 'invalid_type' && typeof issue.expected === 'string')
        message = `Expected ${key} to be of type ${issue.expected}, instead found type ${typeName(valueAt(path))}.`;
      else message = `${message} at ${key}`;
    } else if (key) message = `${message} at ${key}`;
    super(message);
    this.issues = issues;
    this.path = path;
  }
}

/** The value at `path` below `root`. */
export const valueAt =
  (root: unknown, skip = 0) =>
  (path: readonly PropertyKey[]): unknown => {
    let v: unknown = root;
    for (const seg of path.slice(skip)) v = (v as Record<PropertyKey, unknown> | undefined)?.[seg];
    return v;
  };

/** True for the SDK error of a write whose condition failed. Matched by name, so any SDK copy's error class counts. */
export const isConditionalCheckFailed = (e: unknown): boolean =>
  e instanceof Error && e.name === 'ConditionalCheckFailedException';
