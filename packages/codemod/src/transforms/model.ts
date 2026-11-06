import {
  type ArrowFunction,
  type CallExpression,
  type FunctionExpression,
  type NewExpression,
  Node,
  type PropertyAccessExpression,
  type StringLiteral,
  SyntaxKind,
  ts,
  type Type,
  type TypeNode,
  type VariableDeclaration
} from 'ts-morph';
import {
  type Context,
  fromDynamoose,
  isConstDeclaration,
  isModel,
  isPlainReference,
  isStableReference,
  passesCallback,
  unwrap
} from './context.js';
import {isDynamooseBinding, localName, refsInFile, takenMessage} from './imports.js';

/** dynamoose members that dynotable-orm keeps, on models, transactions, conditions, queries and their results. */
const KEPT = new Set([
  'name',
  'get',
  'create',
  'update',
  'delete',
  'query',
  'scan',
  'batchGet',
  'batchPut',
  'batchDelete',
  'transaction',
  'condition',
  'prototype',
  'all',
  'and',
  'attribute',
  'attributes',
  'beginsWith',
  'between',
  'consistent',
  'contains',
  'count',
  'eq',
  'exec',
  'exists',
  'filter',
  'ge',
  'group',
  'gt',
  'in',
  'le',
  'limit',
  'lt',
  'ne',
  'not',
  'or',
  'parallel',
  'parenthesis',
  'sort',
  'startAt',
  'using',
  'where',
  'lastKey',
  'queriedCount',
  'timesQueried',
  'scannedCount',
  'timesScanned',
  'unprocessedKeys',
  'unprocessedItems',
  // A transaction entry is the raw TransactWriteItem in both.
  'Put',
  'Update',
  'Delete',
  'ConditionCheck'
]);
/** Calls whose result holds items that were read, so a `save()` on them keeps `createdAt`. */
const READS = new Set(['get', 'query', 'scan', 'batchGet']);
// A model's own read helper wrapping get: `findGet`, `strictGet`.
const isRead = (name: string) => READS.has(name) || /^[a-z]\w*Get$/.test(name);
const ITEM_FILE = /[\\/]dist[\\/]Item\.d\.ts$/;

/** Rewrites dynamoose model and item members, and marks the ones without an equivalent. */
export function transformModels(ctx: Context): void {
  const handled = new Set<Node>();
  extendMethods(ctx, handled);
  testShapes(ctx, handled);
  for (const pa of ctx.file.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    const name = pa.getName();
    const receiver = pa.getExpression();
    if (handled.has(pa) || ownedElsewhere(ctx, receiver)) continue;
    const parent = pa.getParent();
    const call =
      Node.isCallExpression(parent) && parent.getExpression() === pa ? parent : undefined;
    if (name === 'table' && isModel(receiver)) table(ctx, pa, call);
    else if (name === 'methods' && isModel(receiver))
      ctx.todo(
        pa,
        'methods: only methods.set(name, fn) on a model declared in this file is converted, to extend({...})'
      );
    // A wrapper's item type can redeclare `save`; an item made or read by a model is a dynamoose item anyway.
    else if (
      name === 'save' &&
      call &&
      (fromDynamoose(pa.getNameNode().getSymbol()) || originOf(unwrap(receiver)))
    ) {
      save(ctx, pa, call, receiver);
    } else if (
      name === 'toJSON' &&
      call &&
      call.getArguments().length === 0 &&
      isCastItem(receiver)
    ) {
      // A cast can hide the item's type: `(item as {toJSON(): T}).toJSON()` → `(toJSON(item) as T)`.
      const declared = receiver.getType().getProperty('toJSON');
      const node = declared?.getDeclarations()[0];
      const returns =
        Node.isMethodSignature(node) || Node.isMethodDeclaration(node)
          ? node.getReturnTypeNode()?.getText()
          : undefined;
      toJSON(
        ctx,
        pa,
        call,
        unwrap(receiver),
        returns ??
          declared?.getTypeAtLocation(pa).getCallSignatures()[0]?.getReturnType().getText(pa)
      );
    } else if (
      name === 'toJSON' &&
      call &&
      call.getArguments().length === 0 &&
      receiver.getType().isAny()
    ) {
      // An untyped value can hold an item: dynotable-orm items keep a toJSON() at run time, so the call stays.
      continue;
    } else if (!fromDynamoose(pa.getNameNode().getSymbol()) || isIndexKey(pa)) continue;
    else if (call && passesCallback(call)) {
      ctx.todo(
        call,
        `${name}(): dynotable-orm takes no callback and returns a Promise: await the call instead`
      );
    } else if (
      /^batch(Get|Put|Delete)$/.test(name) &&
      call &&
      returnSetting(call.getArguments()[1]?.getType())
    ) {
      // dynotable-orm's batch calls have no request-only mode: a `return: 'request'` call would send the request.
      ctx.todo(
        call,
        `${name}(): dynotable-orm takes no return setting and always sends the request: drop return, or build the request by hand`
      );
    } else if (name === 'toJSON' && call && call.getArguments().length === 0)
      toJSON(ctx, pa, call, receiver);
    else if (
      name === 'delete' &&
      call &&
      call.getArguments().length === 0 &&
      isItemMember(pa) &&
      !isModel(unwrap(receiver))
    ) {
      itemDelete(ctx, pa, call, receiver);
    } else if (name === 'withDefaults' && call && call.getArguments().length === 0) {
      const model = assignedModel(receiver);
      if (model && isStableReference(model, call))
        ctx.replace(call, () => `${model.getText()}.withDefaults(${ctx.text(receiver)})`);
      else
        ctx.todo(
          call,
          'withDefaults(): only x.withDefaults() on an item every assignment of x makes or reads with one model M, a const or an import, is converted, to M.withDefaults(x)'
        );
    } else if (name === 'conformToSchema' && call) fromStored(ctx, call, receiver);
    else if (
      name === 'get' &&
      Node.isPropertyAccessExpression(receiver) &&
      receiver.getName() === 'transaction'
    ) {
      ctx.todo(pa, 'transaction get has no equivalent: read the item with get() or batchGet()');
    } else if (
      name === 'populate' ||
      name === 'serializer' ||
      name === 'serialize' ||
      name === 'serializeMany'
    ) {
      ctx.todo(pa, `${name} has no dynotable-orm equivalent`);
    } else if (!KEPT.has(name) || isItemMember(pa)) {
      ctx.todo(pa, `unknown dynamoose member: ${name}`);
    }
  }
}

/**
 * Test shapes that name a model as the class of its items: `expect.any(M)` and `toBeInstanceOf(M)` become
 * `Object` (an item is a plain object), `spyOn(item, 'save')` and `spyOn(M.prototype, 'save')` spy on
 * `M.create` (what `save()` became), `spyOn(M.prototype, 'withDefaults')` on `M.withDefaults`.
 */
function testShapes(ctx: Context, handled: Set<Node>): void {
  const checks: Node[] = [];
  for (const call of ctx.file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee) && !Node.isIdentifier(callee)) continue;
    const name = Node.isPropertyAccessExpression(callee) ? callee.getName() : callee.getText();
    const args = call.getArguments();
    if (
      ((name === 'any' &&
        Node.isPropertyAccessExpression(callee) &&
        /(^|\.)expect$/.test(callee.getExpression().getText())) ||
        name === 'toBeInstanceOf') &&
      args.length === 1 &&
      isModel(args[0]) &&
      isPlainReference(args[0])
    ) {
      ctx.replace(args[0], 'Object');
      checks.push(args[0]);
      continue;
    }
    if (name !== 'spyOn' || args.length !== 2 || !Node.isStringLiteral(args[1])) continue;
    const [target, member] = [unwrap(args[0]), args[1].getLiteralValue()];
    let model: Node | undefined;
    if (Node.isPropertyAccessExpression(target) && target.getName() === 'prototype') {
      const m = target.getExpression();
      if (isModel(m) && isPlainReference(m)) model = m;
      if (model) handled.add(target);
    } else if (member === 'save') model = assignedModel(target);
    if (!model || (member !== 'save' && member !== 'withDefaults')) continue;
    if (!isStableReference(model, call)) {
      ctx.todo(
        call,
        `spyOn(…, '${member}'): the model is not a const or an import: spy on M.${member === 'save' ? 'create' : member}`
      );
      continue;
    }
    ctx.replace(
      [args[0].getStart(), args[1].getEnd()],
      `${model.getText()}, '${member === 'save' ? 'create' : member}'`
    );
  }
  dropCheckedImports(ctx, checks);
}

/** A model import that only the rewritten `expect.any(M)` and `toBeInstanceOf(M)` used goes with them. */
function dropCheckedImports(ctx: Context, checks: Node[]): void {
  const seen = new Set<Node>();
  for (const check of checks) {
    const decl = check.getSymbol()?.getDeclarations()[0];
    if (!(Node.isImportSpecifier(decl) || Node.isImportClause(decl)) || seen.has(decl)) continue;
    seen.add(decl);
    const name = Node.isImportSpecifier(decl)
      ? (decl.getAliasNode() ?? decl.getNameNode())
      : decl.getDefaultImport();
    if (!name || !refsInFile(ctx, name).every((r) => checks.includes(r))) continue;
    ctx.dropImport(
      decl.getFirstAncestorByKindOrThrow(SyntaxKind.ImportDeclaration),
      Node.isImportSpecifier(decl) ? decl : name
    );
  }
}

/**
 * The model of an item: its origin, or for a variable, the one model every value assigned to it (its initializer
 * and each `x = …`) makes or reads.
 */
function assignedModel(node: Node): Node | undefined {
  const n = unwrap(node);
  const direct = originOf(n);
  if (direct) return direct.model;
  if (!Node.isIdentifier(n)) return undefined;
  const symbol = n.getSymbol();
  const decl = symbol?.getValueDeclaration();
  if (!Node.isVariableDeclaration(decl) || !Node.isIdentifier(decl.getNameNode())) return undefined;
  const values: Node[] = [];
  const init = decl.getInitializer();
  if (init) values.push(init);
  for (const id of n.getSourceFile().getDescendantsOfKind(SyntaxKind.Identifier)) {
    const parent = id.getParent();
    if (
      id.getSymbol() === symbol &&
      Node.isBinaryExpression(parent) &&
      parent.getLeft() === id &&
      parent.getOperatorToken().getKind() === SyntaxKind.EqualsToken
    )
      values.push(parent.getRight());
  }
  const origins = values.map((v) => {
    const u = unwrap(v);
    return Node.isNewExpression(u) ? newOrigin(u) : readOrigin(u);
  });
  const [first] = origins;
  if (!first || origins.some((o) => !o || o.model.getText() !== first.model.getText()))
    return undefined;
  return first.model;
}

/**
 * A member that only dynamoose's `Item` declares (a model's type includes its item's). A declaration outside
 * dynamoose, such as a wrapper's own model type, makes it a model member.
 */
function isItemMember(pa: PropertyAccessExpression): boolean {
  return pa
    .getNameNode()
    .getSymbol()!
    .getDeclarations()
    .every((d) => ITEM_FILE.test(d.getSourceFile().getFilePath()));
}

/** A key read through an index signature, such as `toJSON()`'s `ObjectType`: the caller's data, not a dynamoose member. */
const isIndexKey = (pa: PropertyAccessExpression): boolean =>
  pa.getNameNode().getSymbol()!.getDeclarations().every(Node.isIndexSignatureDeclaration);

/**
 * True when another rule decides on this member: uses of a dynamoose binding (the imports transform), and
 * members of `M.table()` and `M.methods`.
 */
function ownedElsewhere(ctx: Context, receiver: Node): boolean {
  if (Node.isCallExpression(receiver)) {
    const callee = receiver.getExpression();
    if (
      Node.isPropertyAccessExpression(callee) &&
      callee.getName() === 'table' &&
      isModel(callee.getExpression())
    )
      return true;
  }
  if (
    Node.isPropertyAccessExpression(receiver) &&
    receiver.getName() === 'methods' &&
    isModel(receiver.getExpression())
  )
    return true;
  let root = receiver;
  while (
    Node.isPropertyAccessExpression(root) ||
    Node.isCallExpression(root) ||
    Node.isElementAccessExpression(root)
  ) {
    root = root.getExpression();
  }
  if (!Node.isIdentifier(root)) return false;
  return !!root
    .getSymbol()
    ?.getDeclarations()
    .some((d) => isDynamooseBinding(ctx, d));
}

/** `M.table();` (a spy workaround) is removed; `.name`, `.hashKey`, `.rangeKey` and `create({return: 'request'})` move to the model. */
function table(ctx: Context, pa: PropertyAccessExpression, call: CallExpression | undefined): void {
  const model = pa.getExpression();
  const use = call?.getParent();
  // Each rewrite reads the model once, where the call read it: any plain reference does, a parameter too.
  if (
    call &&
    call.getArguments().length === 0 &&
    (isStableReference(model, call) || isPlainReference(model))
  ) {
    if (Node.isExpressionStatement(use)) return ctx.remove(use);
    if (Node.isPropertyAccessExpression(use) && use.getExpression() === call) {
      const member = use.getName();
      const next = use.getParent();
      if (member === 'name') return ctx.replace(use, `${model.getText()}.tableName`);
      if (member === 'hashKey' || member === 'rangeKey')
        return ctx.replace(use, `${model.getText()}.${member}`);
      if (
        member === 'create' &&
        Node.isCallExpression(next) &&
        isReturnRequest(next.getArguments())
      ) {
        return ctx.replace(next, `${model.getText()}.createTableInput()`);
      }
    }
  }
  ctx.todo(
    pa,
    'table(): only table().name, .hashKey, .rangeKey, create({return: "request"}) and a bare table() call, on a model named by a variable or a property, are converted'
  );
}

function isReturnRequest(args: Node[]): boolean {
  const [arg] = args;
  if (args.length !== 1 || !Node.isObjectLiteralExpression(arg)) return false;
  const props = arg.getProperties();
  if (props.length !== 1 || !Node.isPropertyAssignment(props[0])) return false;
  const value = props[0].getInitializer();
  return (
    props[0].getName().replace(/^['"]|['"]$/g, '') === 'return' &&
    Node.isStringLiteral(value) &&
    value.getLiteralValue() === 'request'
  );
}

/**
 * `x.toJSON()` → `toJSON(x)`; `x?.toJSON()` → `(x == null ? undefined : toJSON(x))`, which gives `undefined` for
 * `null` too. `toJSON` is `ormToJSON` where the file has its own `toJSON`.
 */
function toJSON(
  ctx: Context,
  pa: PropertyAccessExpression,
  call: CallExpression,
  receiver: Node,
  castTo?: string
): void {
  const fn = localName(ctx, 'toJSON', call);
  if (fn === undefined) return ctx.todo(call, takenMessage('toJSON'));
  // An optional chain before `.toJSON` (`a?.b.toJSON()`) also stops at `undefined`.
  if (!ts.isOptionalChain(pa.compilerNode)) {
    ctx.replace(call, () =>
      castTo ? `(${fn}(${ctx.text(receiver)}) as ${castTo})` : `${fn}(${ctx.text(receiver)})`
    );
  } else if (!pa.hasQuestionDotToken() || !isRepeatable(receiver) || continuesChain(call)) {
    return ctx.todo(
      call,
      'x?.toJSON(): only a variable, a property or a literal index at the end of the chain is converted, to (x == null ? undefined : toJSON(x))'
    );
  } else {
    ctx.replace(call, () => guarded(ctx.text(receiver), `${fn}(${ctx.text(receiver)})`));
  }
  ctx.imports.add(fn === 'toJSON' ? fn : `toJSON as ${fn}`);
}

/** `x?.f()` as an expression that still stops at `undefined` and `null`. */
const guarded = (x: string, call: string) => `(${x} == null ? undefined : ${call})`;

/**
 * A cast whose operand is a dynamoose item, by its type or because a model read it: its `toJSON` comes from
 * dynamoose, whatever the cast says.
 */
function isCastItem(receiver: Node): boolean {
  const inner = unwrap(receiver);
  if (inner === receiver || fromDynamoose(receiver.getType().getProperty('toJSON'))) return false;
  return fromDynamoose(inner.getType().getProperty('toJSON')) || originOf(inner) !== undefined;
}

/** An expression that reads the same value when evaluated twice: `a`, `a.b`, `a[0]`, `a['b']`. */
const isRepeatable = (node: Node): boolean =>
  isPlainReference(node) ||
  (Node.isElementAccessExpression(node) &&
    isRepeatable(node.getExpression()) &&
    (Node.isNumericLiteral(node.getArgumentExpression()) ||
      Node.isStringLiteral(node.getArgumentExpression())));

/** True when the optional chain goes on after `call`, so it would no longer stop at `undefined`. */
function continuesChain(call: CallExpression): boolean {
  const parent = call.getParent();
  return (
    (Node.isPropertyAccessExpression(parent) ||
      Node.isElementAccessExpression(parent) ||
      Node.isCallExpression(parent)) &&
    parent.getExpression() === call
  );
}

/** The settings dynamoose reads an item with; `fromStored` does the same. Each key is optional but `type`. */
const READ_SETTINGS: Record<string, string> = {
  type: "'fromDynamo'",
  customTypesDynamo: 'true',
  saveUnknown: 'true',
  mapAttributes: 'true',
  modifiers: "['get']"
};

/**
 * `new M(x).conformToSchema({type: 'fromDynamo', …})` → `M.fromStored(x)`. conformToSchema returns a
 * promise and fromStored does not, so a result that is not awaited is wrapped in `Promise.resolve`.
 */
function fromStored(ctx: Context, call: CallExpression, receiver: Node): void {
  const created = unwrap(receiver);
  const [arg, ...rest] = call.getArguments();
  const props = Node.isObjectLiteralExpression(arg) ? arg.getProperties() : [];
  const reads = props.every(
    (p) =>
      Node.isPropertyAssignment(p) &&
      READ_SETTINGS[p.getName()] === p.getInitializerOrThrow().getText().replace(/"/g, "'")
  );
  if (
    Node.isNewExpression(created) &&
    created.getArguments().length === 1 &&
    // A cast changes no value: the type under it tells a stored item from a plain one.
    isStoredItem(strip(created.getArguments()[0]!)) &&
    isModel(created.getExpression()) &&
    isStableReference(created.getExpression(), call) &&
    rest.length === 0 &&
    reads &&
    props.some((p) => Node.isPropertyAssignment(p) && p.getName() === 'type')
  ) {
    const text = () =>
      `${created.getExpression().getText()}.fromStored(${ctx.text(created.getArguments()[0])})`;
    ctx.replace(call, isAwaited(call) ? text : () => `Promise.resolve(${text()})`);
    return;
  }
  ctx.todo(
    call,
    "conformToSchema: only new M(x).conformToSchema({type: 'fromDynamo'}) with the settings of a read, with M a const or an import and x typed as a record of AttributeValue, is converted, to M.fromStored(x)"
  );
}

/**
 * `x` is typed as a stored item, a record of `AttributeValue`. dynamoose's `new M(x)` also takes a plain item,
 * which `fromStored` refuses, and the type is the only thing that tells them apart.
 */
function isStoredItem(node: Node): boolean {
  const value = node.getType().getNonNullableType().getStringIndexType();
  return (value?.getAliasSymbol() ?? value?.getSymbol())?.getName() === 'AttributeValue';
}

/** Awaited, or returned from an async function, where a value and a promise of it behave the same. */
function isAwaited(node: Node): boolean {
  let parent = node.getParentOrThrow();
  while (Node.isParenthesizedExpression(parent)) parent = parent.getParentOrThrow();
  if (Node.isAwaitExpression(parent)) return true;
  const isFunction = (n: Node) =>
    Node.isFunctionDeclaration(n) ||
    Node.isFunctionExpression(n) ||
    Node.isArrowFunction(n) ||
    Node.isMethodDeclaration(n);
  const fn = Node.isReturnStatement(parent) ? parent.getFirstAncestor(isFunction) : parent;
  return !!fn && isFunction(fn) && (fn as FunctionExpression).isAsync();
}

/**
 * `x.save()` → `M.create(x, {overwrite: true})`, plus `keepCreatedAt` when `x` was read. `x?.save()` keeps its
 * stop at `undefined` and `null`.
 */
function save(
  ctx: Context,
  pa: PropertyAccessExpression,
  call: CallExpression,
  receiver: Node
): void {
  const origin = call.getArguments().length === 0 ? saveOrigin(unwrap(receiver), call) : undefined;
  // The model is named again at the call: it must still be the model the item came from.
  if (!origin || !isStableReference(origin.model, call)) {
    ctx.todo(
      call,
      "save(): only new M(...).save() and x.save() on a const x = new M(...) or x = await M.get(...) or await M.<method>(...) typed as M's item, of the same function, with M a const or an import, are converted: use M.create(item, {overwrite: true}), plus keepCreatedAt: true for an item that was read"
    );
    return;
  }
  // An optional chain before `.save` (`a?.b.save()`) also stops at `undefined`.
  const optional = ts.isOptionalChain(pa.compilerNode);
  if (optional && (!pa.hasQuestionDotToken() || !isRepeatable(receiver) || continuesChain(call))) {
    ctx.todo(
      call,
      'x?.save(): only a variable, a property or a literal index at the end of the chain is converted, to (x == null ? undefined : M.create(x, …))'
    );
    return;
  }
  const item = unwrap(receiver);
  // The receiver as written, so a non-null assertion (`stored!.save()`) stays.
  const value = Node.isNewExpression(item) ? item.getArguments()[0] : receiver;
  const options = origin.read ? '{overwrite: true, keepCreatedAt: true}' : '{overwrite: true}';
  const create = () =>
    `${origin.model.getText()}.create(${value ? ctx.text(value) : '{}'}, ${options})`;
  ctx.replace(call, optional ? () => guarded(ctx.text(receiver), create()) : create);
}

/** `x.delete()` → `M.delete(x)`: the model reads the key fields of the item. `x?.delete()` keeps its stop. */
function itemDelete(
  ctx: Context,
  pa: PropertyAccessExpression,
  call: CallExpression,
  receiver: Node
): void {
  const model = assignedModel(receiver);
  const optional = ts.isOptionalChain(pa.compilerNode);
  if (
    !model ||
    !isStableReference(model, call) ||
    (optional && (!pa.hasQuestionDotToken() || !isRepeatable(receiver) || continuesChain(call)))
  ) {
    ctx.todo(
      call,
      'delete(): only x.delete() on an item every assignment of x makes or reads with one model M, a const or an import, is converted, to M.delete(x)'
    );
    return;
  }
  const remove = () => `${model.getText()}.delete(${ctx.text(receiver)})`;
  ctx.replace(call, optional ? () => guarded(ctx.text(receiver), remove()) : remove);
}

interface Origin {
  model: Node;
  read: boolean;
}

/**
 * The model `x.save()` writes to, only where nothing else can reach `x`: `new M(…)`, or a const of the same
 * function set to `new M(…)`, `await M.get(…)` or `await M.<method>(…)` typed as `M`'s item, without destructuring. Every other item
 * gets a TODO: tracing an item through destructuring, branches, loops and callbacks kept finding items of
 * another model, and a wrong guess writes to the wrong table.
 */
function saveOrigin(item: Node, call: Node): Origin | undefined {
  if (Node.isNewExpression(item)) return newOrigin(item);
  if (!Node.isIdentifier(item)) return undefined;
  const decl = item.getSymbol()?.getValueDeclaration();
  if (
    !Node.isVariableDeclaration(decl) ||
    !isConstDeclaration(decl) ||
    !Node.isIdentifier(decl.getNameNode()) ||
    functionOf(decl) !== functionOf(call)
  )
    return undefined;
  const init = decl.getInitializer();
  const value = init && strip(init);
  if (Node.isNewExpression(value)) return newOrigin(value);
  if (!Node.isAwaitExpression(value)) return undefined;
  const read = strip(value.getExpression());
  const callee = Node.isCallExpression(read) ? read.getExpression() : undefined;
  if (!Node.isPropertyAccessExpression(callee)) return undefined;
  const model = callee.getExpression();
  if (!isModel(model) || !isPlainReference(model)) return undefined;
  // Another member's name says nothing of the table its item comes from: only its type does. A `<x>Get`
  // helper's (`safeGet`) item may carry more fields than the model's: its type must be one of the model's items.
  const name = callee.getName();
  return name === 'get' ||
    readsItemOf(model, value) ||
    (/^[a-z]\w*Get$/.test(name) && readsItemOf(model, value, true))
    ? {model, read: true}
    : undefined;
}

/**
 * The awaited value is, but for `undefined` and `null`, the item type of `model`: the type its `get` resolves to
 * (`assignable`: a type assignable to it, an item with more fields).
 */
function readsItemOf(model: Node, value: Node, assignable = false): boolean {
  const get = model.getType().getProperty('get');
  const signature = get?.getTypeAtLocation(model).getCallSignatures()[0];
  if (!signature) return false;
  const checker = model.getProject().getTypeChecker().compilerObject;
  const awaited = checker.getAwaitedType(signature.getReturnType().compilerType);
  const item = awaited && checker.getNonNullableType(awaited);
  if (!item || item.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
  const own = value.getType().getNonNullableType().compilerType;
  if (own.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
  return own === awaited || (assignable && checker.isTypeAssignableTo(own, item));
}

function newOrigin(node: NewExpression): Origin | undefined {
  const model = node.getExpression();
  return isModel(model) && isPlainReference(model) && node.getArguments().length <= 1
    ? {model, read: false}
    : undefined;
}

/** Parentheses, casts and non-null assertions, which keep the value. */
function strip(node: Node): Node {
  while (
    Node.isParenthesizedExpression(node) ||
    Node.isNonNullExpression(node) ||
    Node.isAsExpression(node) ||
    Node.isSatisfiesExpression(node)
  )
    node = node.getExpression();
  return node;
}

/** The nearest enclosing function, arrow functions included; `undefined` at module level. */
const functionOf = (node: Node) =>
  node.getFirstAncestor(
    (a) =>
      Node.isFunctionLikeDeclaration(a) || Node.isFunctionExpression(a) || Node.isArrowFunction(a)
  );

/**
 * A best guess at the model that made or read a value, to tell that the value is a dynamoose item. It never picks
 * the table `save()` writes to: `saveOrigin` does.
 */
function originOf(node: Node): Origin | undefined {
  if (Node.isNewExpression(node)) return newOrigin(node);
  if (Node.isIdentifier(node)) {
    const decl = node.getSymbol()?.getValueDeclaration();
    const variable = Node.isBindingElement(decl)
      ? decl.getFirstAncestorByKind(SyntaxKind.VariableDeclaration)
      : decl;
    if (!Node.isVariableDeclaration(variable) || !isConstDeclaration(variable)) return undefined;
    const forOf = variable.getParent()?.getParent();
    if (Node.isForOfStatement(forOf)) return readOrigin(forOf.getExpression());
    const init = variable.getInitializer();
    if (!init) return undefined;
    return decl === variable ? originOf(unwrap(init)) : readOrigin(init);
  }
  return readOrigin(node);
}

/**
 * The model of a `get`/`query`/`scan`/`batchGet`/`<x>Get` call chain, read through dynamoose's query members
 * (`eq()`, `exec()`, `all()`…) and indexing. Any other member, such as `then()`, may return another value.
 */
function readOrigin(node: Node): Origin | undefined {
  for (let n: Node | undefined = unwrap(node); n;) {
    if (Node.isPropertyAccessExpression(n)) {
      const receiver = n.getExpression();
      if (isRead(n.getName()) && isModel(receiver))
        return isPlainReference(receiver) ? {model: receiver, read: true} : undefined;
      if (!KEPT.has(n.getName())) return undefined;
      n = unwrap(receiver);
    } else if (Node.isCallExpression(n) || Node.isElementAccessExpression(n)) {
      n = unwrap(n.getExpression());
    } else if (Node.isConditionalExpression(n)) {
      // `cond ? await M.get(k) : undefined`
      return either(n.getWhenTrue(), n.getWhenFalse());
    } else if (Node.isBinaryExpression(n) && n.getOperatorToken().getText() === '&&') {
      // `cond && (await M.get(k))`: the left side is the guard, the item comes from the right.
      return readOrigin(n.getRight());
    } else if (
      Node.isBinaryExpression(n) &&
      ['??', '||'].includes(n.getOperatorToken().getText())
    ) {
      // `(await M.get(a)) ?? (await M.get(b))`
      return either(n.getLeft(), n.getRight());
    } else return undefined;
  }
  return undefined;
}

/**
 * The origin of a value that comes from one of two expressions: both reads of the same model, or one read and
 * `undefined` or `null`. A read of another model, or any other value, has no origin: `save()` would write it to
 * the wrong table.
 */
function either(a: Node, b: Node): Origin | undefined {
  const [x, y] = [a, b].map((n) => (isNothing(unwrap(n)) ? null : readOrigin(n)));
  if (x === undefined || y === undefined) return undefined;
  if (x && y) return x.model.getText() === y.model.getText() ? x : undefined;
  return x ?? y ?? undefined;
}

const isNothing = (n: Node) =>
  n.getKind() === SyntaxKind.NullKeyword ||
  (Node.isIdentifier(n) && n.getText() === 'undefined') ||
  Node.isVoidExpression(n);

/**
 * `M.methods.set('x', fn)` → `.extend({x() {...}})` on `M`'s declaration, with `M` in the body
 * rewritten to `this`. An arrow function becomes a method, because an arrow keeps the module's `this`.
 */
function extendMethods(ctx: Context, handled: Set<Node>): void {
  const byModel = new Map<VariableDeclaration, CallExpression[]>();
  for (const call of ctx.file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const set = call.getExpression();
    if (!Node.isPropertyAccessExpression(set) || set.getName() !== 'set') continue;
    const methods = set.getExpression();
    if (!Node.isPropertyAccessExpression(methods) || methods.getName() !== 'methods') continue;
    const model = methods.getExpression();
    if (!isModel(model)) continue;
    handled.add(methods);
    const decl = Node.isIdentifier(model) ? model.getSymbol()?.getValueDeclaration() : undefined;
    const [name, fn, ...rest] = call.getArguments();
    const statement = call.getParent();
    const ok =
      Node.isVariableDeclaration(decl) &&
      decl.getSourceFile() === ctx.file &&
      isConstDeclaration(decl) &&
      decl.getInitializer() !== undefined &&
      Node.isExpressionStatement(statement) &&
      Node.isStringLiteral(name) &&
      rest.length === 0 &&
      (Node.isArrowFunction(fn) || Node.isFunctionExpression(fn) || Node.isIdentifier(fn));
    if (!ok) {
      ctx.todo(call, 'methods.set: convert to extend({...}) on the model declaration by hand');
      continue;
    }
    // A call in a block, a branch or a function may run later or not at all; the declaration always runs.
    if (!Node.isSourceFile(statement.getParent())) {
      ctx.todo(
        call,
        'methods.set: the call is not a top-level statement, so it may run later or not at all: convert to extend({...}) by hand'
      );
      continue;
    }
    if (Node.isIdentifier(fn) && !readyAt(fn, decl)) {
      ctx.todo(
        call,
        `methods.set: ${fn.getText()} is not set yet where ${decl.getName()} is declared, so it cannot move to its declaration`
      );
      continue;
    }
    byModel.set(decl, [...(byModel.get(decl) ?? []), call]);
  }

  for (const [decl, calls] of byModel) {
    if (readBefore(ctx, decl, calls)) {
      // Moving the methods onto the declaration would run them before this read, which saw the model without them.
      for (const call of calls)
        ctx.todo(
          call,
          `methods.set: ${decl.getName()} is read at module load before this call, so the methods cannot move to its declaration`
        );
      continue;
    }
    // A later methods.set replaces an earlier one; an object literal cannot hold the same key twice.
    const names = calls.map((c) => (c.getArguments()[0] as StringLiteral).getLiteralValue());
    const repeated = new Set(names.filter((n, i) => names.indexOf(n) !== i));
    if (repeated.size > 0) {
      calls.forEach((call, i) =>
        ctx.todo(
          call,
          repeated.has(names[i])
            ? `methods.set('${names[i]}'): set more than once on ${decl.getName()}, and the last one wins: keep one, then run again`
            : 'methods.set: convert to extend({...}) with the other methods of this model'
        )
      );
      continue;
    }
    const methods = calls.map((call) => method(ctx, decl, call));
    if (methods.some((m) => m === undefined)) {
      // The model's methods move to one extend() call, so none of them moves.
      calls.forEach(
        (call, i) =>
          methods[i] &&
          ctx.todo(
            call,
            'methods.set: convert to extend({...}) with the other methods of this model'
          )
      );
      continue;
    }
    for (const m of methods) for (const ref of m!.refs) ctx.replace(ref, 'this');
    const init = decl.getInitializerOrThrow();
    const cast = Node.isAsExpression(init) || Node.isSatisfiesExpression(init) ? init : undefined;
    const base = cast ? cast.getExpression() : init;
    const dropped = [decl.getTypeNode(), cast?.getTypeNode()].filter(
      (n): n is TypeNode => n !== undefined
    );
    const indent = ctx.indentAt(decl.getVariableStatementOrThrow().getStart());
    const typeNode = decl.getTypeNode();
    if (typeNode) ctx.replace([decl.getNameNode().getEnd(), typeNode.getEnd()], '');
    ctx.replace(init, () => {
      const body = methods.map((m) => indentLines(m!.render(), `${indent}  `)).join(',\n');
      return `${ctx.text(base)}.extend({\n${body}\n${indent}})`;
    });
    for (const call of calls) ctx.remove(call.getParentOrThrow());
    removeUnusedTypes(ctx, dropped, calls);
  }
}

/**
 * True when `fn` holds its value where the model is declared: an import, a function declaration (hoisted), or a
 * const declared before the model.
 */
function readyAt(fn: Node, model: VariableDeclaration): boolean {
  const decl = fn.getSymbol()?.getDeclarations()[0];
  if (Node.isImportSpecifier(decl) || Node.isImportClause(decl) || Node.isNamespaceImport(decl))
    return true;
  if (Node.isFunctionDeclaration(decl)) return true;
  return (
    Node.isVariableDeclaration(decl) &&
    isConstDeclaration(decl) &&
    decl.getEnd() <= model.getVariableStatementOrThrow().getStart()
  );
}

/** A reference to the model run at module load between its declaration and its last methods.set call. */
function readBefore(
  ctx: Context,
  decl: VariableDeclaration,
  calls: CallExpression[]
): Node | undefined {
  const end = Math.max(...calls.map((c) => c.getStart()));
  return refsInFile(ctx, decl.getNameNode()).find(
    (r) =>
      r.getStart() > decl.getEnd() &&
      r.getStart() < end &&
      !calls.some((c) => c.containsRange(r.getPos(), r.getEnd())) &&
      !r.getFirstAncestor(
        (a) =>
          Node.isFunctionLikeDeclaration(a) ||
          Node.isFunctionExpression(a) ||
          Node.isArrowFunction(a)
      )
  );
}

interface Method {
  /** References to the model inside the body, which become `this`. */
  refs: Node[];
  render: () => string;
}

function method(ctx: Context, decl: VariableDeclaration, call: CallExpression): Method | undefined {
  const [nameNode, fn] = call.getArguments();
  const name = (nameNode as StringLiteral).getLiteralValue();
  const key = /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
  const commentTexts = call
    .getParentOrThrow()
    .getLeadingCommentRanges()
    .map((r) => r.getText());
  const comments = commentTexts.map((c) => `${c}\n`).join('');
  if (takesCallback(fn)) {
    ctx.todo(
      call,
      `methods.set('${name}'): the last parameter is a callback, which dynamoose passes when the caller gives none and a dynotable-orm method never gets: return a Promise instead, then run again`
    );
    return undefined;
  }
  if (Node.isIdentifier(fn))
    return {
      refs: [],
      render: () => comments + (fn.getText() === key ? key : `${key}: ${fn.getText()}`)
    };
  const f = fn as ArrowFunction | FunctionExpression;
  if (Node.isArrowFunction(f) && hasOwnThis(f)) {
    ctx.todo(
      call,
      `methods.set('${name}'): the arrow function uses this, which changes meaning in a method`
    );
    return undefined;
  }
  const own = Node.isFunctionExpression(f) ? f.getNameNode() : undefined;
  if (own && refsInFile(ctx, own).length > 0) {
    ctx.todo(call, `methods.set('${name}'): the function refers to its own name`);
    return undefined;
  }
  // A `this` parameter goes: in the method, extend() types `this` as the model.
  const thisParam = f.getParameters().find((p) => p.getName() === 'this');
  const refs = refsInFile(ctx, decl.getNameNode()).filter(
    (r) =>
      f.containsRange(r.getPos(), r.getEnd()) &&
      !(thisParam && thisParam.containsRange(r.getPos(), r.getEnd()))
  );
  for (const ref of refs) {
    if (scopeOf(ref) !== scopeOf(f.getBody()) || ref.getFirstAncestor(Node.isTypeNode)) {
      ctx.todo(
        call,
        `methods.set('${name}'): ${decl.getName()} is used where this does not refer to the model`
      );
      return undefined;
    }
  }
  const body = f.getBody();
  const returns = f.getReturnTypeNode();
  const docs = commentTexts
    .map((c, i) => `${i === commentTexts.length - 1 ? withParamTags(c, f) : c}\n`)
    .join('');
  return {
    refs,
    render: () => {
      const types = f.getTypeParameters().map((t) => ctx.text(t));
      const params = methodParameters(ctx, f);
      const block = Node.isBlock(body) ? ctx.text(body) : `{\n  return ${ctx.text(body)};\n}`;
      return `${docs}${f.isAsync() ? 'async ' : ''}${Node.isFunctionExpression(f) && f.isGenerator() ? '*' : ''}${key}${
        types.length > 0 ? `<${types.join(', ')}>` : ''
      }(${params.join(', ')})${returns ? `: ${ctx.text(returns)}` : ''} ${block}`;
    }
  };
}

/**
 * True when the method's last parameter is a callback: typed as a function (an optional one too), or called in the
 * body. A function whose body this file cannot read (`fn` names an import of a `.d.ts`) is judged by its type only.
 */
function takesCallback(fn: Node): boolean {
  let f: Node | undefined = fn;
  if (Node.isIdentifier(fn)) {
    const symbol = fn.getSymbol();
    f = (symbol?.isAlias() ? symbol.getAliasedSymbol() : symbol)?.getValueDeclaration();
    if (Node.isVariableDeclaration(f)) {
      const init = f.getInitializer();
      f = init && unwrap(init);
    }
  }
  const isFunction = (t: Type) => t.getNonNullableType().getCallSignatures().length > 0;
  if (!Node.isFunctionDeclaration(f) && !Node.isArrowFunction(f) && !Node.isFunctionExpression(f)) {
    return fn
      .getType()
      .getCallSignatures()
      .some((s) => {
        const last = s.getParameters().at(-1);
        return last !== undefined && isFunction(last.getTypeAtLocation(fn));
      });
  }
  const last = f.getParameters().at(-1);
  if (!last || last.isRestParameter()) return false;
  if (isFunction(last.getType())) return true;
  const name = last.getNameNode();
  if (!Node.isIdentifier(name)) return false;
  const symbol = name.getSymbol();
  return f.getDescendantsOfKind(SyntaxKind.Identifier).some((id) => {
    if (id === name || id.getSymbol() !== symbol) return false;
    const parent = id.getParent();
    // `cb(…)`, `cb?.(…)`, `cb.call(…)`, `cb.apply(…)`.
    const callee =
      Node.isPropertyAccessExpression(parent) &&
      parent.getExpression() === id &&
      ['call', 'apply'].includes(parent.getName())
        ? parent
        : id;
    const call = callee.getParent();
    return Node.isCallExpression(call) && call.getExpression() === callee;
  });
}

/**
 * The function's parameters as method parameters. dynamoose's methods.set types the function as
 * `(...args: any[]) => any`, so a bare parameter was an optional `any`; a binding pattern cannot be optional.
 */
function methodParameters(ctx: Context, f: ArrowFunction | FunctionExpression): string[] {
  let requiredAfter = false;
  return f
    .getParameters()
    .filter((p) => p.getName() !== 'this')
    .reverse()
    .map((p) => {
      const text = ctx.text(p);
      if (p.getTypeNode() || p.hasInitializer() || p.hasQuestionToken()) {
        requiredAfter ||= !p.hasInitializer() && !p.hasQuestionToken() && !p.isRestParameter();
        return text;
      }
      if (p.isRestParameter()) return `${text}: any[]`;
      const optional = !requiredAfter && Node.isIdentifier(p.getNameNode());
      requiredAfter ||= !optional;
      return optional ? `${text}?: any` : `${text}: any`;
    })
    .reverse();
}

/**
 * A JSDoc block gets an `@param` tag for each parameter of `f` that it does not name. On the `methods.set(...)`
 * statement no linter reads the block as the function's documentation; on the method, jsdoc/require-param does.
 * Names follow eslint-plugin-jsdoc: a destructured parameter is `root<n>` (or the name the block gives it at its
 * position), with a tag per bound property (`root0.id`) or array element (`root0.0`).
 */
function withParamTags(comment: string, f: ArrowFunction | FunctionExpression): string {
  if (!comment.startsWith('/**')) return comment;
  const tagged = [...comment.matchAll(/@param\s+(?:\{[^}]*\}\s*)?\[?([\w$.]+)/g)].map((m) => m[1]);
  const top = tagged.filter((n) => !n.includes('.'));
  const params = f.getParameters().filter((p) => p.getName() !== 'this');
  const plain = new Set(
    params.filter((p) => Node.isIdentifier(p.getNameNode())).map((p) => p.getName())
  );
  let roots = 0;
  const required = params.flatMap((p, i) => {
    const name = p.getNameNode();
    if (Node.isIdentifier(name)) return [name.getText()];
    const root = top[i] !== undefined && !plain.has(top[i]) ? top[i] : `root${roots}`;
    roots++;
    return [root, ...boundPaths(name, root)];
  });
  const missing = required.filter((n) => !tagged.includes(n));
  if (missing.length === 0) return comment;

  const lines = comment.split('\n');
  const prefix =
    lines
      .slice(1)
      .map((l) => /^\s*\*(?!\/)/.exec(l)?.[0])
      .find((p) => p !== undefined) ?? ' *';
  // Text beside `/**` or `*/` gets a line of its own, so the tags can follow it.
  const edge = (s: string) => {
    const text = s.trim().replace(/^\*\s*/, '');
    return text ? [`${prefix} ${text}`] : [];
  };
  const body =
    lines.length === 1
      ? edge(comment.slice(3, -2))
      : [...edge(lines[0].slice(3)), ...lines.slice(1, -1), ...edge(lines.at(-1)!.slice(0, -2))];
  // After the block's last @param and before the tag that follows it (@returns, …).
  const lastParam = body.map((l) => /^\s*\*\s*@param\b/.test(l)).lastIndexOf(true);
  const next = body.findIndex((l, i) => i > lastParam && /^\s*\*\s*@/.test(l));
  body.splice(next === -1 ? body.length : next, 0, ...missing.map((n) => `${prefix} @param ${n}`));
  return ['/**', ...body, `${prefix}/`].join('\n');
}

/** The tag names of what a binding pattern binds, under `prefix`: properties by key, array elements by index. */
function boundPaths(pattern: Node, prefix: string): string[] {
  if (Node.isObjectBindingPattern(pattern))
    return pattern.getElements().flatMap((e) => {
      if (e.getDotDotDotToken()) return [];
      const property = e.getPropertyNameNode();
      const key = Node.isStringLiteral(property)
        ? property.getLiteralValue()
        : (property ?? e.getNameNode()).getText();
      const path = `${prefix}.${key}`;
      return [path, ...boundPaths(e.getNameNode(), path)];
    });
  if (Node.isArrayBindingPattern(pattern))
    return pattern.getElements().flatMap((e, i) => {
      if (!Node.isBindingElement(e) || e.getDotDotDotToken()) return [];
      const path = `${prefix}.${i}`;
      return [path, ...boundPaths(e.getNameNode(), path)];
    });
  return [];
}

/** The nearest enclosing non-arrow function or class: where `this` comes from. */
const scopeOf = (node: Node) =>
  node.getFirstAncestor(
    (a) =>
      (Node.isFunctionLikeDeclaration(a) && !Node.isArrowFunction(a)) ||
      // ts-morph's FunctionLikeDeclaration leaves out function expressions.
      Node.isFunctionExpression(a) ||
      Node.isClassDeclaration(a) ||
      Node.isClassExpression(a)
  );

/** True when the arrow function uses `this` of its enclosing scope. */
const hasOwnThis = (f: ArrowFunction) =>
  f.getDescendantsOfKind(SyntaxKind.ThisKeyword).some((t) => scopeOf(t) === scopeOf(f));

function indentLines(text: string, indent: string): string {
  return text
    .split('\n')
    .map((line, i) =>
      i === 0 || line.length === 0 ? `${i === 0 ? indent : ''}${line}` : `  ${line}`
    )
    .join('\n');
}

/** Removes an interface or type alias of this file that only the dropped type annotation used. */
export function removeUnusedTypes(ctx: Context, dropped: Node[], calls: CallExpression[]): void {
  const removed = [...dropped, ...calls];
  for (const typeNode of dropped) {
    for (const id of typeNode.getDescendantsOfKind(SyntaxKind.Identifier)) {
      const decl = id.getSymbol()?.getDeclarations()[0];
      if (
        !(Node.isInterfaceDeclaration(decl) || Node.isTypeAliasDeclaration(decl)) ||
        decl.getSourceFile() !== ctx.file
      )
        continue;
      if (decl.isExported()) continue;
      const used = refsInFile(ctx, decl.getNameNode()).some(
        (r) =>
          !removed.some((n) => n.containsRange(r.getPos(), r.getEnd())) &&
          !decl.containsRange(r.getPos(), r.getEnd())
      );
      if (!used) {
        ctx.remove(decl);
        removed.push(decl);
      }
    }
  }
}

/** A settings type that has `return` itself or in any member of its union. */
function returnSetting(type: Type | undefined): boolean {
  if (!type) return false;
  return type.isUnion()
    ? type.getUnionTypes().some((t) => !!t.getProperty('return'))
    : !!type.getProperty('return');
}
