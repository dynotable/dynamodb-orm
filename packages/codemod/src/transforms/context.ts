import {
  type CallExpression,
  type ImportDeclaration,
  Node,
  type SourceFile,
  type Symbol as MorphSymbol,
  SyntaxKind,
  ts,
  type VariableDeclaration,
  VariableDeclarationKind,
  type VariableDeclarationList
} from 'ts-morph';

export const TODO = 'TODO(dynotable-orm-codemod): ';

export interface Options {
  /** Module specifiers whose dynamoose names move to `target`. */
  sources: readonly string[];
  target: string;
  /** The module `z` comes from, imported as a namespace; `undefined` for `import {z} from 'zod'`. */
  zod?: string;
}

export interface Todo {
  file: string;
  line: number;
  message: string;
}

interface Edit {
  start: number;
  end: number;
  text: () => string;
}

// dynamoose, or a scoped dynamoose package (`@<scope>/dynamoose`).
const DYNAMOOSE_FILE = /[\\/]node_modules[\\/](@[^\\/]+[\\/])?dynamoose[\\/]/;
/** A deep import of dynamoose types, from dynamoose or a scoped dynamoose package: `dynamoose/dist/Model`. */
export const DYNAMOOSE_DEEP_IMPORT = /^(@[^/]+\/)?dynamoose\/dist\//;
/** dynamoose itself or a scoped dynamoose package (`@<scope>/dynamoose`), as opposed to a module that re-exports it. */
export const DYNAMOOSE_MODULE = /^(@[^/]+\/)?dynamoose$/;

/**
 * The edits for one file, made against its original text, so the type checker stays valid while the
 * transforms run. Edits nest or are disjoint. An edit's text is built when the file is rendered, so it
 * can include an inner node with that node's own edits applied (`text`).
 */
export class Context {
  readonly todos: Todo[] = [];
  /** Value names the file must import from the target module. */
  readonly imports = new Set<string>();
  /** Type names the file must import from the target module. */
  readonly typeImports = new Set<string>();
  /** Value names the file must import from `@aws-sdk/client-dynamodb`. */
  readonly sdk = new Set<string>();
  /** Import bindings the rewrites left unused, by import declaration. */
  readonly drops = new Map<ImportDeclaration, Set<Node>>();
  /** Uses of a dynamoose binding another transform handled: `true` rewritten, `false` marked with a TODO. */
  readonly claimed = new Map<ts.Node, boolean>();
  /** The file must import `z` from the Zod module. */
  zod = false;
  private readonly edits: Edit[] = [];
  private readonly consumed = new Set<Edit>();
  private readonly removals = new Set<Edit>();
  private readonly marked = new Set<string>();
  private readonly full: string;

  constructor(
    readonly file: SourceFile,
    readonly options: Options
  ) {
    this.full = file.getFullText();
  }

  dropImport(decl: ImportDeclaration, binding: Node): void {
    this.drops.set(decl, (this.drops.get(decl) ?? new Set()).add(binding));
  }

  replace(at: Node | readonly [number, number], text: string | (() => string)): void {
    const [start, end] = Node.isNode(at) ? [at.getStart(), at.getEnd()] : at;
    this.edits.push({start, end, text: typeof text === 'string' ? () => text : text});
  }

  /**
   * Removes a statement with its leading comments. At the file start it also takes the line break after it,
   * which is the next statement's leading trivia: removals that overlap so become one.
   */
  remove(statement: Node): void {
    let start =
      statement.getFullStart() === 0 ? statement.getStart(true) : statement.getFullStart();
    let end = statement.getEnd();
    for (const e of this.removals) {
      if (e.start < end && start < e.end) {
        start = Math.min(start, e.start);
        end = Math.max(end, e.end);
        this.removals.delete(e);
        this.edits.splice(this.edits.indexOf(e), 1);
      }
    }
    if (start === 0 && this.full[end] === '\n') end++;
    const edit: Edit = {start, end, text: () => ''};
    this.removals.add(edit);
    this.edits.push(edit);
  }

  /** The node's text with the edits inside it applied. Each edit is rendered once. */
  text(node: Node): string {
    return this.slice(node.getStart(), node.getEnd());
  }

  private slice(start: number, end: number): string {
    // Insertions before replacements at the same position; an outer replacement before the ones it contains.
    const inner = this.edits
      .filter((e) => !this.consumed.has(e) && start <= e.start && e.end <= end)
      .sort(
        (a, b) =>
          a.start - b.start ||
          Number(b.end === b.start) - Number(a.end === a.start) ||
          b.end - a.end
      );
    let out = '';
    let pos = start;
    for (const e of inner) {
      // An edit inside a replacement that did not render it (a removed statement) is dropped with it.
      if (this.consumed.has(e) || (e.start < pos && e.end <= pos)) continue;
      if (e.start < pos)
        throw new Error(`overlapping edits in ${this.file.getFilePath()} at ${e.start}`);
      out += this.full.slice(pos, e.start);
      this.consumed.add(e);
      out += e.text();
      pos = e.end;
    }
    return out + this.full.slice(pos, end);
  }

  render(): string {
    this.consumed.clear();
    return this.slice(0, this.full.length);
  }

  /** Records a TODO and marks the enclosing statement with it once, so a second run adds nothing. */
  todo(node: Node, text: string): void {
    // A message can quote multi-line source; the line comment must stay one line.
    const message = text.replace(/\s+/g, ' ');
    const statement = Node.isStatement(node)
      ? node
      : (node.getFirstAncestor(Node.isStatement) ?? node);
    this.todos.push({file: this.file.getFilePath(), line: node.getStartLineNumber(), message});
    const comment = `// ${TODO}${message}`;
    const start = statement.getStart();
    const key = `${start}\0${comment}`;
    if (this.marked.has(key)) return;
    this.marked.add(key);
    // A marker on the line of the token before (a loop body without braces) is that token's trailing comment.
    const pos = statement.getFullStart();
    const present = [
      ...(ts.getTrailingCommentRanges(this.full, pos) ?? []),
      ...(ts.getLeadingCommentRanges(this.full, pos) ?? [])
    ].some((r) => this.full.slice(r.pos, r.end) === comment);
    if (!present) this.replace([start, start], `${comment}\n${this.indentAt(start)}`);
  }

  /** The whitespace before `pos` on its line. */
  indentAt(pos: number): string {
    return /^[ \t]*/.exec(this.full.slice(this.full.lastIndexOf('\n', pos - 1) + 1))![0];
  }
}

const isDynamooseFile = (path: string): boolean => DYNAMOOSE_FILE.test(path);

/** A module that exports dynamoose: a `--source`, `dynamoose` or a scoped dynamoose package. */
export const isSourceModule = (ctx: Context, module: string): boolean =>
  ctx.options.sources.includes(module) || DYNAMOOSE_MODULE.test(module);

/** True when the symbol is declared by a dynamoose package. */
export const fromDynamoose = (symbol: {getDeclarations(): Node[]} | undefined): boolean =>
  !!symbol &&
  symbol.getDeclarations().some((d) => isDynamooseFile(d.getSourceFile().getFilePath()));

/** True when the call reaches a dynamoose overload's `callback` parameter. */
export function passesCallback(call: CallExpression): boolean {
  const signature = call.getProject().getTypeChecker().getResolvedSignature(call);
  const at = signature?.getParameters().findIndex((p) => p.getName() === 'callback') ?? -1;
  return at >= 0 && at < call.getArguments().length;
}

/** A dynamoose or dynotable-orm model, by its type. */
export function isModel(node: Node): boolean {
  const type = node.getType();
  if (type.isAny()) return false;
  const has = (n: string) => type.getProperty(n) !== undefined;
  return has('get') && has('query') && has('scan') && (has('createTableInput') || has('table'));
}

/** A model reference that can be repeated without evaluating anything twice. */
export const isPlainReference = (node: Node): boolean =>
  Node.isIdentifier(node) ||
  (Node.isPropertyAccessExpression(node) && isPlainReference(node.getExpression()));

/**
 * A model reference whose value cannot change and that names the same binding at `at`: an identifier bound by a
 * const, or an import or a namespace import's member whose export is a const. A let, a var, a parameter, an
 * exported let or an object's property can hold another model by then.
 */
export function isStableReference(node: Node, at: Node): boolean {
  if (Node.isPropertyAccessExpression(node)) {
    const root = node.getExpression();
    const [decl, ...more] = root.getSymbol()?.getDeclarations() ?? [];
    if (!Node.isIdentifier(root) || more.length > 0 || !Node.isNamespaceImport(decl)) return false;
    return sameBindingAt(root, at) && isStableExport(node.getNameNode().getSymbol());
  }
  if (!Node.isIdentifier(node)) return false;
  const symbol = node.getSymbol();
  const decls = symbol?.getDeclarations() ?? [];
  if (decls.length === 0 || !sameBindingAt(node, at)) return false;
  if (decls.every(isConstBinding)) return true;
  const [decl, ...more] = decls;
  if (more.length > 0) return false;
  if (Node.isNamespaceImport(decl)) return true;
  return (Node.isImportSpecifier(decl) || Node.isImportClause(decl)) && isStableExport(symbol);
}

// An import names the exporting module's binding, which that module may still reassign: the export must be a const.
function isStableExport(symbol: MorphSymbol | undefined): boolean {
  const target = symbol?.isAlias() ? symbol.getAliasedSymbol() : symbol;
  const decls = target?.getDeclarations() ?? [];
  return (
    decls.length > 0 &&
    decls.every(
      (d) => isConstBinding(d) || Node.isFunctionDeclaration(d) || Node.isClassDeclaration(d)
    )
  );
}

const isConstBinding = (d: Node): boolean => {
  const variable = Node.isBindingElement(d)
    ? d.getFirstAncestorByKind(SyntaxKind.VariableDeclaration)
    : d;
  return Node.isVariableDeclaration(variable) && isConstDeclaration(variable);
};

/** The name of `id` resolves at `at` to the binding it resolves to where it is written: no other one shadows it. */
function sameBindingAt(id: Node, at: Node): boolean {
  const checker = id.getProject().getTypeChecker().compilerObject;
  const own = (s: ts.Symbol | undefined) => s && checker.getExportSymbolOfSymbol(s);
  const name = id.getText();
  const there = at
    .getSymbolsInScope(ts.SymbolFlags.Value | ts.SymbolFlags.Alias)
    .find((s) => s.getName() === name);
  return !!there && own(there.compilerSymbol) === own(id.getSymbol()?.compilerSymbol);
}

export function unwrap(node: Node): Node {
  while (
    Node.isParenthesizedExpression(node) ||
    Node.isAwaitExpression(node) ||
    Node.isNonNullExpression(node) ||
    Node.isAsExpression(node) ||
    Node.isSatisfiesExpression(node)
  ) {
    node = node.getExpression();
  }
  return node;
}

export const isConstDeclaration = (v: VariableDeclaration): boolean =>
  (v.getParentOrThrow() as VariableDeclarationList).getDeclarationKind() ===
  VariableDeclarationKind.Const;
