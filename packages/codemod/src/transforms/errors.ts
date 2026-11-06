import {type Identifier, Node, SyntaxKind, type ts} from 'ts-morph';
import {SDK_MODULE as SDK} from '../report.js';
import type {Context} from './context.js';
import {localName, refsInFile, takenMessage} from './imports.js';

const NAME = 'ConditionalCheckFailedException';
const CHECK = 'isConditionalCheckFailed';

/**
 * `e instanceof ConditionalCheckFailedException` → `isConditionalCheckFailed(e)`. `e.name === '…'` stays: it reads
 * the same SDK error under dynotable-orm, and `isConditionalCheckFailed` also needs an `Error`. `e.code === '…'` is
 * marked: the SDK sets no `code`, so the check never matched.
 */
export function transformErrors(ctx: Context): void {
  // The exception references the rewrites took out of the code.
  const rewritten = new Set<ts.Node>();
  for (const binary of ctx.file.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    const op = binary.getOperatorToken().getKind();
    const left = binary.getLeft();
    const right = binary.getRight();
    if (op === SyntaxKind.InstanceOfKeyword && Node.isIdentifier(right) && isSdkException(right)) {
      const fn = localName(ctx, CHECK, binary);
      if (fn === undefined) {
        ctx.todo(binary, takenMessage(CHECK));
        continue;
      }
      ctx.replace(binary, () => `${fn}(${ctx.text(left)})`);
      ctx.imports.add(fn === CHECK ? fn : `${CHECK} as ${fn}`);
      rewritten.add(right.compilerNode);
      continue;
    }
    const negated =
      op === SyntaxKind.ExclamationEqualsEqualsToken || op === SyntaxKind.ExclamationEqualsToken;
    if (
      !negated &&
      op !== SyntaxKind.EqualsEqualsEqualsToken &&
      op !== SyntaxKind.EqualsEqualsToken
    )
      continue;
    const [literal, access] = Node.isStringLiteral(right) ? [right, left] : [left, right];
    if (
      !Node.isStringLiteral(literal) ||
      literal.getLiteralValue() !== NAME ||
      !Node.isPropertyAccessExpression(access)
    )
      continue;
    if (access.getName() !== 'code') continue;
    ctx.todo(
      binary,
      `${access.getText()} ${negated ? '!==' : '==='} '${NAME}': the SDK error has no code, so this never matched; if a failed condition is meant, use isConditionalCheckFailed(e)`
    );
  }

  // The SDK import goes when every use was an instanceof check that was rewritten.
  for (const decl of ctx.file.getImportDeclarations()) {
    if (!SDK.test(decl.getModuleSpecifierValue())) continue;
    const spec = decl.getNamedImports().find((s) => s.getName() === NAME);
    if (!spec) continue;
    const refs = refsInFile(ctx, spec.getAliasNode() ?? spec.getNameNode());
    if (refs.length === 0 || !refs.every((r) => rewritten.has(r.compilerNode))) continue;
    ctx.dropImport(decl, spec);
  }
}

const isSdkException = (id: Identifier) =>
  !!id
    .getSymbol()
    ?.getDeclarations()
    .some(
      (d) =>
        Node.isImportSpecifier(d) &&
        d.getName() === NAME &&
        SDK.test(d.getImportDeclaration().getModuleSpecifierValue())
    );
