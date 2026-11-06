import {
  type CallExpression,
  type Identifier,
  type ImportDeclaration,
  type ImportSpecifier,
  type NewExpression,
  Node,
  type ObjectLiteralExpression,
  SyntaxKind,
  ts
} from 'ts-morph';
import {
  type Context,
  DYNAMOOSE_DEEP_IMPORT,
  DYNAMOOSE_MODULE,
  fromDynamoose,
  isConstDeclaration,
  isModel,
  isSourceModule,
  isStableReference,
  passesCallback,
  unwrap
} from './context.js';

/** dynamoose's type modules (`dynamoose/dist/*`) → the dynotable-orm type with the same type parameters. */
const DEEP_TYPES: Record<string, string> = {
  QueryResponse: 'QueryResponse',
  ScanResponse: 'ScanResponse',
  ModelGetSettings: 'GetOptions',
  ModelUpdateSettings: 'UpdateOptions',
  ModelDeleteSettings: 'DeleteOptions',
  ModelBatchGetSettings: 'BatchGetOptions',
  ModelBatchGetItemsResponse: 'BatchGetResponse',
  ItemSaveSettings: 'CreateOptions'
};
/**
 * Names a rewrite may import from the target, which a generated declaration must not take: the option types,
 * and their `orm<Name>` aliases.
 */
export const IMPORTED_TYPES: ReadonlySet<string> = new Set(
  [...Object.values(DEEP_TYPES), 'ModelOptions'].flatMap((n) => [n, `orm${n}`])
);

/** The module the converted schemas read Zod from. */
export const zodModule = (ctx: Context): string => ctx.options.zod ?? 'zod';

/** `import * as z` or `import {z}` from the Zod module: the binding the converted schemas read Zod through. */
export const isZodNamespace = (d: Node, module: string): boolean =>
  d.getFirstAncestorByKind(SyntaxKind.ImportDeclaration)?.getModuleSpecifierValue() === module &&
  (Node.isNamespaceImport(d) || (Node.isImportSpecifier(d) && d.getName() === 'z'));

/** dynamoose members by path, longest first, with the dynotable-orm name each one becomes. */
const MEMBERS: readonly (readonly [string, string])[] = [
  ['aws.ddb.set', 'setClient'],
  ['Table.defaults.set', 'setDefaults'],
  ['aws.ddb', 'getClient'],
  ['aws.converter', 'converter'],
  ['Condition', 'Condition'],
  ['transaction', 'transaction']
];
const TABLE_SETTINGS_KEPT = new Set(['prefix', 'suffix']);
const TABLE_SETTINGS_DROPPED = new Set(['create', 'waitForActive']);

/**
 * dynamoose's table settings, in `Table.defaults.set()` and `model()`: prefix and suffix are kept, create and
 * waitForActive have no meaning here, the rest has no dynotable-orm equivalent.
 */
export function tableSettings(
  arg: ObjectLiteralExpression,
  nameOf: (p: Node) => string | undefined
): {kept: Node[]; unknown: Node[]} {
  const kept: Node[] = [];
  const unknown: Node[] = [];
  for (const p of arg.getProperties()) {
    const name = nameOf(p);
    if (name !== undefined && TABLE_SETTINGS_KEPT.has(name)) kept.push(p);
    else if (name === undefined || !TABLE_SETTINGS_DROPPED.has(name)) unknown.push(p);
  }
  return {kept, unknown};
}

/** Identifiers in the file, outside imports, that refer to the same symbol as `name`. */
export function refsInFile(ctx: Context, name: Node): Identifier[] {
  const symbol = name.getSymbol();
  const text = name.getText();
  return ctx.file
    .getDescendantsOfKind(SyntaxKind.Identifier)
    .filter(
      (id) =>
        id !== name &&
        id.getText() === text &&
        id.getSymbol() === symbol &&
        !id.getFirstAncestorByKind(SyntaxKind.ImportDeclaration)
    );
}

interface Binding {
  decl: ImportDeclaration;
  node: Node;
  /** The local name the file refers to the binding by. */
  name: Node;
  /** The dynamoose member path the binding stands for: `[]` for dynamoose itself. */
  path: string[];
}

/** The dynamoose bindings of a `--source` import whose module resolves. */
function bindingsOf(decl: ImportDeclaration): Binding[] {
  const direct = DYNAMOOSE_MODULE.test(decl.getModuleSpecifierValue());
  const bindings: Binding[] = [];
  for (const node of [decl.getDefaultImport(), decl.getNamespaceImport()]) {
    if (node && direct) bindings.push({decl, node, name: node, path: []});
  }
  for (const spec of decl.getNamedImports()) {
    const path = direct ? [spec.getName()] : wrapperPath(spec);
    if (path)
      bindings.push({decl, node: spec, name: spec.getAliasNode() ?? spec.getNameNode(), path});
  }
  return bindings;
}

/**
 * True when the imports transform owns the import binding `decl` declares: one of a dynamoose type module, of a
 * `--source` module it cannot resolve, or that stands for dynamoose or one of its members. A source module's own
 * export (a model it defines) is not one.
 */
export function isDynamooseBinding(ctx: Context, decl: Node): boolean {
  const imported = decl.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
  if (!imported) return false;
  const module = imported.getModuleSpecifierValue();
  if (DYNAMOOSE_DEEP_IMPORT.test(module)) return true;
  if (!isSourceModule(ctx, module) && !importsDynamoose(imported)) return false;
  if (!imported.getModuleSpecifierSourceFile()) return true;
  // A default or namespace import's declaration is the clause around the bound name.
  return bindingsOf(imported).some((b) => b.node === decl || b.node.getParent() === decl);
}

/** Rewrites each use of a dynamoose binding, and drops each binding whose uses were all rewritten. */
export function transformImports(ctx: Context): void {
  for (const decl of ctx.file.getImportDeclarations()) {
    const module = decl.getModuleSpecifierValue();
    if (DYNAMOOSE_DEEP_IMPORT.test(module)) {
      deepImport(ctx, decl);
      continue;
    }
    if (!isSourceModule(ctx, module) && !importsDynamoose(decl)) continue;
    // Without the module's types, models and items cannot be told apart from other values.
    if (!decl.getModuleSpecifierSourceFile()) {
      ctx.todo(
        decl,
        `cannot resolve ${module}: install it and check that the tsconfig resolves it, then run again`
      );
      continue;
    }
    for (const b of bindingsOf(decl)) {
      // Every use is visited, so each one is rewritten or marked.
      const done = refsInFile(ctx, b.name)
        .map((ref) => ctx.claimed.get(ref.compilerNode) ?? rewriteUse(ctx, ref, b.path))
        .every(Boolean);
      if (done) ctx.dropImport(decl, b.node);
    }
  }
}

export interface Member {
  /** The dynamoose member path, dot-joined: `Schema`, `type.COMBINE`. */
  path: string;
  /** The use of the import binding the member is read through. */
  root: Identifier;
}

/** Every expression of the file that reads a dynamoose member, by its compiler node. */
export function dynamooseMembers(ctx: Context): Map<ts.Node, Member> {
  const members = new Map<ts.Node, Member>();
  for (const decl of ctx.file.getImportDeclarations()) {
    if (
      !isSourceModule(ctx, decl.getModuleSpecifierValue()) ||
      !decl.getModuleSpecifierSourceFile()
    )
      continue;
    for (const b of bindingsOf(decl)) {
      for (const ref of refsInFile(ctx, b.name)) {
        const {path, at} = memberPath(ref, b.path);
        for (let k = Math.max(b.path.length, 1); k <= path.length; k++) {
          members.set(at[k].compilerNode, {path: path.slice(0, k).join('.'), root: ref});
        }
      }
    }
  }
  return members;
}

/** The member path a use reads, and `at[k]`, the node that stands for its first `k` members. */
function memberPath(ref: Identifier, base: string[]): {path: string[]; at: Node[]} {
  const path = [...base];
  const at: Node[] = [];
  at[path.length] = ref;
  let node: Node = ref;
  for (;;) {
    const parent = node.getParent();
    // A cast or parentheses around the binding hide nothing: `(dynamoose as unknown as T).aws.ddb`.
    if (path.length === base.length && isWrapper(parent) && parent.getExpression() === node) {
      node = parent;
      at[path.length] = node;
      continue;
    }
    if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === node)
      path.push(parent.getName());
    else if (Node.isQualifiedName(parent) && parent.getLeft() === node)
      path.push(parent.getRight().getText());
    else break;
    node = parent;
    at[path.length] = node;
  }
  return {path, at};
}

const isWrapper = (node: Node | undefined): node is Node & {getExpression(): Node} =>
  Node.isAsExpression(node) ||
  Node.isParenthesizedExpression(node) ||
  Node.isNonNullExpression(node) ||
  Node.isTypeAssertion(node) ||
  Node.isSatisfiesExpression(node);

/**
 * True when a module that is not a `--source` exports dynamoose under a name this import takes: a wrapper of the
 * project (`export const dynamoose = …`), imported by a relative path. Only that binding moves; the wrapper's own
 * exports stay.
 */
function importsDynamoose(decl: ImportDeclaration): boolean {
  if (!decl.getModuleSpecifierSourceFile()) return false;
  return decl.getNamedImports().some((spec) => wrapperPath(spec)?.length === 0);
}

/** The dynamoose member a wrapper's named export stands for, or `undefined` when it is the wrapper's own. */
function wrapperPath(spec: ImportSpecifier): string[] | undefined {
  let symbol = spec.getSymbol()?.getAliasedSymbol();
  // `export const db = dynamoose`: the wrapper's own name for a dynamoose binding.
  const decl = symbol?.getValueDeclaration();
  const init =
    Node.isVariableDeclaration(decl) && isConstDeclaration(decl)
      ? decl.getInitializer()
      : undefined;
  if (init && Node.isIdentifier(unwrap(init))) {
    const target = unwrap(init).getSymbol();
    symbol = target?.isAlias() ? target.getAliasedSymbol() : target;
  }
  if (!fromDynamoose(symbol)) return isDynamooseObject(decl) ? [] : undefined;
  // dynamoose's entry is `export = _default`, an object holding `model`, `Condition`, ….
  const name = symbol!.getName();
  return name === '_default' || name === 'default' || name === 'export=' ? [] : [name];
}

/**
 * A built wrapper's `.d.ts` declares `export const db = dynamoose` as `declare const db: {Condition: …}`,
 * with no initializer to follow: the object is dynamoose's when its members' types are.
 */
function isDynamooseObject(decl: Node | undefined): boolean {
  if (!Node.isVariableDeclaration(decl) || decl.getInitializer()) return false;
  const member = (name: string) =>
    decl.getType().getProperty(name)?.getTypeAtLocation(decl).getSymbol();
  return fromDynamoose(member('Condition')) && fromDynamoose(member('Schema'));
}

function deepImport(ctx: Context, decl: ImportDeclaration): void {
  const module = decl.getModuleSpecifierValue();
  // `class X extends Item` (or an interface): items are plain objects, so the base goes.
  const item = decl
    .getNamedImports()
    .find((s) => s.getName() === 'Item' && module.endsWith('/dist/Item'));
  if (item && dropItemBase(ctx, item)) ctx.dropImport(decl, item);
  const names = decl.getNamedImports().filter((s) => s !== item);
  const unknown = names
    .filter((s) => !(s.getName() in DEEP_TYPES) && s.getName() !== 'Condition')
    .map((s) => s.getName());
  if (decl.getDefaultImport() || decl.getNamespaceImport() || unknown.length > 0) {
    ctx.todo(decl, `no dynotable-orm type for ${unknown.join(', ') || 'this import'} (${module})`);
    return;
  }
  if (item && !ctx.drops.get(decl)?.has(item)) {
    ctx.todo(
      decl,
      `Item (${module}): only \`extends Item\` of a class without a constructor or of an interface is converted, by dropping the base`
    );
    return;
  }
  // A binding of this file named as a dynotable-orm type would clash with its import, or shadow it at a use.
  const clash = names
    .map((s) => DEEP_TYPES[s.getName()] ?? 'Condition')
    .filter((mapped, i) => {
      const local = names[i].getAliasNode() ?? names[i].getNameNode();
      return (
        local.getText() !== mapped &&
        [decl, ...refsInFile(ctx, local)].some((at) => localName(ctx, mapped, at) !== mapped)
      );
    });
  if (clash.length > 0) {
    ctx.todo(
      decl,
      `${clash.join(', ')}: this file already has its own ${clash.join(', ')}: rename it, then run again`
    );
    return;
  }
  for (const s of names) {
    const mapped = DEEP_TYPES[s.getName()] ?? 'Condition';
    const local = s.getAliasNode() ?? s.getNameNode();
    if (local.getText() !== mapped) for (const r of refsInFile(ctx, local)) ctx.replace(r, mapped);
    (mapped === 'Condition' && !decl.isTypeOnly() && !s.isTypeOnly()
      ? ctx.imports
      : ctx.typeImports
    ).add(mapped);
    ctx.dropImport(decl, s);
  }
}

/** Drops `extends Item` from every class and interface of the file; false when a use is anything else. */
function dropItemBase(ctx: Context, spec: ImportSpecifier): boolean {
  const refs = refsInFile(ctx, spec.getAliasNode() ?? spec.getNameNode());
  const clauses = refs.map((ref) => {
    const type = ref.getParent();
    const clause = type?.getParent();
    const owner = clause?.getParent();
    if (
      !Node.isExpressionWithTypeArguments(type) ||
      !Node.isHeritageClause(clause) ||
      clause.getToken() !== SyntaxKind.ExtendsKeyword ||
      clause.getTypeNodes().length !== 1 ||
      !(Node.isInterfaceDeclaration(owner) || Node.isClassDeclaration(owner)) ||
      // A constructor would call super(): the class needs its base.
      (Node.isClassDeclaration(owner) && owner.getConstructors().length > 0)
    )
      return undefined;
    return clause;
  });
  if (clauses.some((c) => c === undefined)) return false;
  for (const clause of clauses) ctx.replace([clause!.getPos(), clause!.getEnd()], '');
  return true;
}

/**
 * Writes every changed import line: dropped bindings go, and the names the rewrites need join an import
 * of the target module, or a new line in place of the first changed import.
 */
export function finishImports(ctx: Context): void {
  const {target} = ctx.options;
  const decls = ctx.file.getImportDeclarations();
  const lines = new Map<ImportDeclaration, Line | undefined>();
  for (const decl of decls)
    if (ctx.drops.has(decl)) lines.set(decl, lineOf(decl, ctx.drops.get(decl)!));

  const merge = decls.find((d) => {
    const line = lines.has(d) ? lines.get(d) : lineOf(d, new Set());
    return (
      d.getModuleSpecifierValue() === target &&
      !d.isTypeOnly() &&
      line !== undefined &&
      !line.namespace
    );
  });
  const mergeLine = merge && (lines.has(merge) ? lines.get(merge)! : lineOf(merge, new Set())!);
  // A binding by its exported and local names: `Condition as C` does not provide `Condition`.
  const binding = (s: string) => {
    const [name, local = name] = s.replace(/^type /, '').split(/\s+as\s+/);
    return `${name} as ${local}`;
  };
  const have = new Map(mergeLine?.named.map((s, i) => [binding(s), i]) ?? []);
  // The target's other imports: a binding there is provided already, but `import type` gives no value.
  const elsewhere = new Map<string, ImportDeclaration>();
  for (const d of decls)
    if (d !== merge && d.getModuleSpecifierValue() === target && !ctx.drops.has(d))
      for (const s of d.getNamedImports()) elsewhere.set(binding(s.getText()), d);
  let promoted = false;
  const added = [
    ...ctx.imports,
    ...[...ctx.typeImports].filter((n) => !ctx.imports.has(n)).map((n) => `type ${n}`)
  ]
    .filter((s) => {
      const other = elsewhere.get(binding(s));
      if (other) {
        const spec = other.getNamedImports().find((n) => binding(n.getText()) === binding(s))!;
        if (!s.startsWith('type ') && (other.isTypeOnly() || spec.isTypeOnly())) {
          ctx.todo(
            other,
            `${binding(s).split(' as ').pop()}: imported as a type only, but the rewritten code needs its value: drop "type", then run again`
          );
        }
        return false;
      }
      const i = have.get(binding(s));
      if (i === undefined) return true;
      // A type-only binding provides no value: `type Condition` becomes `Condition` for `new Condition(…)`.
      if (!s.startsWith('type ') && mergeLine!.named[i].startsWith('type ')) {
        mergeLine!.named[i] = mergeLine!.named[i].slice('type '.length);
        promoted = true;
      }
      return false;
    })
    .sort(byLocalName);

  const quote = decls[0]?.getModuleSpecifier().getText()[0] ?? "'";
  const extras: string[] = [];
  if ((added.length > 0 || promoted) && merge && mergeLine) {
    // Each before the first binding it sorts before: a sorted line stays sorted.
    for (const s of added) {
      const i = mergeLine.named.findIndex((n) => byLocalName(s, n) < 0);
      mergeLine.named.splice(i === -1 ? mergeLine.named.length : i, 0, s);
    }
    lines.set(merge, mergeLine);
  } else if (added.length > 0) {
    extras.push(`import {${added.join(', ')}} from ${quote}${target}${quote};`);
  }
  const zod = zodModule(ctx);
  const zods = decls.filter((d) => d.getModuleSpecifierValue() === zod);
  // By the import's shape: `import {string as z}` binds `z` to something else.
  const zOf = (d: ImportDeclaration) =>
    [d.getNamespaceImport(), ...d.getNamedImports()].find((b) =>
      Node.isImportSpecifier(b)
        ? isZodNamespace(b, zod) && (b.getAliasNode() ?? b.getNameNode()).getText() === 'z'
        : b?.getText() === 'z'
    );
  const z = zods.map((d) => [d, zOf(d)] as const).find(([, b]) => b !== undefined);
  if (ctx.zod && z && (z[0].isTypeOnly() || (Node.isImportSpecifier(z[1]) && z[1].isTypeOnly())))
    ctx.todo(
      z[0],
      'z: imported as a type only, but the converted schemas need its value: drop "type", then run again'
    );
  else if (ctx.zod && !z)
    extras.push(
      `import ${ctx.options.zod === undefined ? '{z}' : '* as z'} from ${quote}${zod}${quote};`
    );
  if (ctx.sdk.size > 0) {
    const names = [...ctx.sdk].sort().join(', ');
    extras.push(`import {${names}} from ${quote}${SDK}${quote};`);
  }
  const extra = extras.join('\n');
  const anchor = extra ? (decls.find((d) => lines.has(d)) ?? decls.at(-1)) : undefined;
  if (extra && !anchor) ctx.replace([0, 0], `${extra}\n`);

  for (const decl of decls) {
    if (!lines.has(decl) && decl !== anchor) continue;
    const own = lines.has(decl)
      ? lines.get(decl) && render(decl, lines.get(decl)!)
      : decl.getText();
    const text = [own, decl === anchor ? extra : undefined].filter(Boolean).join('\n');
    if (text) ctx.replace(decl, text);
    else ctx.remove(decl);
  }
}

/** sort-imports' member order with ignoreCase: by local name, lowercased, by code unit. */
function byLocalName(a: string, b: string): number {
  const [x, y] = [a, b].map((s) =>
    s
      .replace(/^type /, '')
      .split(/\s+as\s+/)
      .pop()!
      .toLowerCase()
  );
  return x < y ? -1 : x > y ? 1 : 0;
}

interface Line {
  head: string[];
  named: string[];
  namespace: boolean;
}

/** The import's bindings without the dropped ones, or `undefined` when none is left. */
function lineOf(decl: ImportDeclaration, dropped: ReadonlySet<Node>): Line | undefined {
  const def = decl.getDefaultImport();
  const ns = decl.getNamespaceImport();
  const head: string[] = [];
  if (def && !dropped.has(def)) head.push(def.getText());
  if (ns && !dropped.has(ns)) head.push(`* as ${ns.getText()}`);
  const named = decl
    .getNamedImports()
    .filter((s) => !dropped.has(s))
    .map((s) => s.getText());
  if (head.length === 0 && named.length === 0 && (decl.getImportClause() || dropped.size > 0))
    return undefined;
  return {head, named, namespace: !!(ns && !dropped.has(ns))};
}

function render(decl: ImportDeclaration, line: Line): string {
  const parts = [...line.head, ...(line.named.length > 0 ? [`{${line.named.join(', ')}}`] : [])];
  return `import ${decl.isTypeOnly() ? 'type ' : ''}${parts.join(', ')} from ${decl.getModuleSpecifier().getText()};`;
}

/** Rewrites one use of a dynamoose binding. Returns false when it is marked with a TODO instead. */
function rewriteUse(ctx: Context, ref: Identifier, base: string[]): boolean {
  const {path, at} = memberPath(ref, base);
  const shown = `dynamoose.${path.join('.')}`;
  const special = compatUse(ctx, path, at[path.length]);
  if (special !== undefined) return special;
  for (const [member, name] of MEMBERS) {
    const parts = member.split('.');
    if (parts.length < base.length || parts.some((p, i) => path[i] !== p)) continue;
    const target = at[parts.length];
    const parent = target.getParent();
    const call =
      Node.isCallExpression(parent) && parent.getExpression() === target ? parent : undefined;
    // dynamoose calls the callback when the transaction settles; dynotable-orm would take it as the options.
    if (member === 'transaction' && call && passesCallback(call)) {
      ctx.todo(
        call,
        'transaction(): dynotable-orm takes no callback and returns a Promise: await the call instead'
      );
      return false;
    }
    // `dynamoose.transaction` as a value (`expect(dynamoose.transaction)`, `vi.mocked(…)`): the spied one.
    if (member === 'transaction' && !call) {
      const orm = localName(ctx, 'orm', target);
      if (orm === undefined) {
        ctx.todo(ref, takenMessage('orm'));
        return false;
      }
      ctx.replace(target, `${orm}.transaction`);
      need(ctx, target, orm === 'orm' ? 'orm' : `orm as ${orm}`);
      return true;
    }
    const local = localName(ctx, name, target);
    if (local === undefined) {
      ctx.todo(ref, takenMessage(name));
      return false;
    }
    if (member === 'Condition') {
      if (
        Node.isNewExpression(parent) &&
        parent.getExpression() === target &&
        toModelCondition(ctx, parent)
      )
        return true;
      if (!instanceTypeOf(ctx, target, local)) ctx.replace(target, local);
    } else if (member === 'aws.ddb' || member === 'aws.converter') {
      if (!call || call.getArguments().length > 0) break;
      ctx.replace(call, member === 'aws.ddb' ? `${local}()` : local);
    } else if (member === 'Table.defaults.set') {
      if (!call || !tableDefaults(ctx, call, local)) {
        ctx.todo(
          ref,
          `${shown}: only prefix and suffix have an equivalent, setDefaults({prefix, suffix})`
        );
        return false;
      }
    } else {
      ctx.replace(target, local);
    }
    need(ctx, target, local === name ? name : `${name} as ${local}`);
    return true;
  }
  if (path[0] === 'type')
    ctx.todo(ref, `${shown} has no dynotable-orm equivalent: declare the field in the schema`);
  else if (path[0] === 'model' || path[0] === 'Schema')
    ctx.todo(ref, `${shown}: define the model with model(name, schema, options)`);
  else
    ctx.todo(
      ref,
      `unknown dynamoose use: ${path.length > 0 ? shown : ref.getParentOrThrow().getText()}`
    );
  return false;
}

const SDK = '@aws-sdk/client-dynamodb';

/**
 * The dynamoose shapes tests and setup code use that have a dynotable-orm counterpart under another name:
 * `spyOn(dynamoose, 'transaction')`, `aws.ddb.revert()`, `aws.ddb` as a value, `aws.ddb.DynamoDB` and
 * `type.UNDEFINED`. Returns `undefined` for any other use.
 */
function compatUse(ctx: Context, path: string[], node: Node): boolean | undefined {
  const joined = path.join('.');
  const parent = node.getParent();
  const call =
    Node.isCallExpression(parent) && parent.getExpression() === node ? parent : undefined;
  const use = (name: string): string | undefined => {
    const local = localName(ctx, name, node);
    if (local === undefined) ctx.todo(node, takenMessage(name));
    else ctx.imports.add(local === name ? name : `${name} as ${local}`);
    return local;
  };
  if (path.length === 0) {
    // `vi.spyOn(dynamoose, 'transaction')`: transaction() calls go through the `orm` object.
    const [first, second] = Node.isCallExpression(parent) ? parent.getArguments() : [];
    const callee = Node.isCallExpression(parent) ? parent.getExpression().getText() : '';
    if (
      first === node &&
      /(^|\.)spyOn$/.test(callee) &&
      Node.isStringLiteral(second) &&
      second.getLiteralValue() === 'transaction'
    ) {
      const orm = use('orm');
      if (orm === undefined) return false;
      ctx.replace(node, orm);
      return true;
    }
    return undefined;
  }
  if (joined === 'aws.ddb.revert' && call && call.getArguments().length === 0) {
    const set = use('setClient');
    if (set === undefined) return false;
    ctx.replace(call, `${set}()`);
    return true;
  }
  if (joined === 'aws.ddb' && !call && !Node.isPropertyAccessExpression(parent)) {
    // dynamoose's client accessor held as a value: a function with set and revert.
    const get = use('getClient');
    const set = use('setClient');
    if (get === undefined || set === undefined) return false;
    ctx.replace(
      node,
      `Object.assign(() => ${get}(), {set: (client: unknown) => ${set}(client as never), revert: () => ${set}()})`
    );
    return true;
  }
  if (joined === 'aws.ddb.DynamoDB') {
    const imported = ctx.file
      .getImportDeclarations()
      .some(
        (d) =>
          d.getModuleSpecifierValue() === SDK &&
          !d.isTypeOnly() &&
          d.getNamedImports().some((s) => s.getText() === 'DynamoDB')
      );
    const free = !node
      .getSymbolsInScope(ts.SymbolFlags.Value | ts.SymbolFlags.Alias)
      .some((s) => s.getName() === 'DynamoDB');
    if (!imported && !free) {
      ctx.todo(node, 'DynamoDB: this file already has its own DynamoDB: rename it, then run again');
      return false;
    }
    if (!imported) ctx.sdk.add('DynamoDB');
    ctx.replace(node, 'DynamoDB');
    return true;
  }
  if (joined === 'type.UNDEFINED') {
    // As an update value: `undefined` removes the attribute, as dynamoose's UNDEFINED does.
    ctx.replace(node, 'undefined');
    return true;
  }
  return undefined;
}

/**
 * The name a use reads the target's `name` by: `name`, or `orm<Name>` where a binding of this file holds
 * `name` in that scope (`const transaction = …` around `dynamoose.transaction(…)`). `undefined` when a binding
 * holds `orm<Name>` too.
 */
export function localName(ctx: Context, name: string, at: Node): string | undefined {
  // A binding of the target module is the one the rewrite needs only when it imports `name` itself. A dynamoose
  // binding goes with the rewrite; any other import of a source module (a wrapper's own helper) stays.
  const own = (d: Node) => {
    const module = d
      .getFirstAncestorByKind(SyntaxKind.ImportDeclaration)
      ?.getModuleSpecifierValue();
    if (d.getSourceFile() !== ctx.file) return false;
    if (module === undefined) return true;
    if (isDynamooseBinding(ctx, d)) return false;
    return module !== ctx.options.target || !(Node.isImportSpecifier(d) && d.getName() === name);
  };
  const symbols = at.getSymbolsInScope(
    ts.SymbolFlags.Value | ts.SymbolFlags.Type | ts.SymbolFlags.Alias
  );
  const taken = (n: string) =>
    symbols.some((s) => s.getName() === n && s.getDeclarations().some(own));
  if (!taken(name)) return name;
  const alias = `orm${name[0].toUpperCase()}${name.slice(1)}`;
  return taken(alias) ? undefined : alias;
}

/** Imports `spec` for a rewritten use: as a type when the use is in a type (`typeof dynamoose.Condition`). */
function need(ctx: Context, use: Node, spec: string): void {
  (use.getFirstAncestor(Node.isTypeNode) ? ctx.typeImports : ctx.imports).add(spec);
}

/** The TODO for a name `localName` cannot give. */
export const takenMessage = (name: string) =>
  `${name}: this file already has its own ${name} and orm${name[0].toUpperCase()}${name.slice(1)}: rename one, then run again`;

/** `InstanceType<typeof dynamoose.Condition>` → `Condition`. */
function instanceTypeOf(ctx: Context, node: Node, local: string): boolean {
  const query = node.getParent();
  const ref = query?.getParent();
  if (
    !Node.isTypeQuery(query) ||
    !Node.isTypeReference(ref) ||
    ref.getTypeName().getText() !== 'InstanceType'
  )
    return false;
  ctx.replace(ref, local);
  return true;
}

/** `Table.defaults.set({prefix, suffix, create, waitForActive})` → `setDefaults({prefix, suffix})`. */
function tableDefaults(ctx: Context, call: CallExpression, local: string): boolean {
  const [arg, ...rest] = call.getArguments();
  if (rest.length > 0 || !Node.isObjectLiteralExpression(arg)) return false;
  const kept = keptDefaults(arg);
  if (!kept) return false;
  ctx.replace(call, () => `${local}({${kept.map((p) => ctx.text(p)).join(', ')}})`);
  return true;
}

function keptDefaults(arg: ObjectLiteralExpression): Node[] | undefined {
  const {kept, unknown} = tableSettings(arg, (p) =>
    Node.isPropertyAssignment(p) || Node.isShorthandPropertyAssignment(p) ? p.getName() : undefined
  );
  return unknown.length === 0 ? kept : undefined;
}

/**
 * `new dynamoose.Condition('x')…` passed straight to a model method, or as its `condition` option,
 * → `M.condition().where('x')…`, typed from the model. Elsewhere, and in the raw object form, it stays.
 */
function toModelCondition(ctx: Context, created: NewExpression): boolean {
  const args = created.getArguments();
  if (args.length > 1 || (args.length === 1 && !Node.isStringLiteral(args[0]))) return false;
  let top: Node = created;
  for (let p = top.getParent(); ; p = top.getParent()) {
    if (
      (Node.isPropertyAccessExpression(p) && p.getExpression() === top) ||
      (Node.isCallExpression(p) && p.getExpression() === top) ||
      Node.isParenthesizedExpression(p)
    ) {
      top = p;
    } else break;
  }
  let arg = top;
  const holder = top.getParent();
  if (Node.isPropertyAssignment(holder) && holder.getName() === 'condition')
    arg = holder.getParentOrThrow();
  const call = arg.getParent();
  if (!Node.isCallExpression(call) || !call.getArguments().includes(arg)) return false;
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return false;
  let model = callee.getExpression();
  if (Node.isPropertyAccessExpression(model) && model.getName() === 'transaction')
    model = model.getExpression();
  if (!isModel(model) || !isStableReference(model, created)) return false;
  const where = args.length === 1 ? `.where(${args[0].getText()})` : '';
  ctx.replace(created, `${model.getText()}.condition()${where}`);
  return true;
}
