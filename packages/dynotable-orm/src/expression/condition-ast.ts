import type {AttributeValue} from '@aws-sdk/client-dynamodb';
import {ExpressionError} from '../errors.js';
import type {RawCondition} from '../types.js';
import type {ExpressionContext} from './compile.js';
import type {Path} from './paths.js';

export type Comparator = '=' | '<>' | '<' | '<=' | '>' | '>=';

/** A condition tree. Values are already marshalled. */
export type ConditionNode =
  | {readonly kind: 'and' | 'or'; readonly items: readonly ConditionNode[]}
  | {readonly kind: 'not'; readonly item: ConditionNode}
  /** Explicit parentheses, as dynamoose's `parenthesis()`/`group()` render them. */
  | {readonly kind: 'group'; readonly item: ConditionNode}
  | {
      readonly kind: 'compare';
      readonly op: Comparator;
      readonly path: Path;
      readonly value: AttributeValue;
    }
  | {
      readonly kind: 'between';
      readonly path: Path;
      readonly low: AttributeValue;
      readonly high: AttributeValue;
    }
  | {readonly kind: 'in'; readonly path: Path; readonly values: readonly AttributeValue[]}
  | {readonly kind: 'begins_with' | 'contains'; readonly path: Path; readonly value: AttributeValue}
  | {readonly kind: 'attribute_exists' | 'attribute_not_exists'; readonly path: Path}
  | {readonly kind: 'raw'; readonly raw: RawCondition};

// DynamoDB binds NOT before AND before OR. A child that binds looser than its parent needs parentheses.
function needsParens(child: ConditionNode, parent: 'and' | 'or' | 'not'): boolean {
  if (child.kind === 'raw') return true;
  if (child.kind === 'or') return parent !== 'or';
  if (child.kind === 'and') return parent === 'not';
  return false;
}

/** Renders `node` as an operand of `parent`, in parentheses when it binds looser. */
export function renderOperand(
  ctx: ExpressionContext,
  node: ConditionNode,
  parent: 'and' | 'or' | 'not'
): string {
  const text = renderCondition(ctx, node);
  return needsParens(node, parent) ? `(${text})` : text;
}

/** Renders one pass, registering names and values in `ctx`. Numbering and function spacing follow dynamoose's text. */
export function renderCondition(ctx: ExpressionContext, node: ConditionNode): string {
  switch (node.kind) {
    case 'and':
    case 'or': {
      if (node.items.length === 0)
        throw new ExpressionError(`an "${node.kind}" condition needs at least one item`);
      const sep = node.kind === 'and' ? ' AND ' : ' OR ';
      let out = renderOperand(ctx, node.items[0]!, node.kind);
      for (let i = 1; i < node.items.length; i++)
        out += sep + renderOperand(ctx, node.items[i]!, node.kind);
      return out;
    }
    case 'not':
      return `NOT ${renderOperand(ctx, node.item, 'not')}`;
    case 'group':
      return `(${renderCondition(ctx, node.item)})`;
    case 'compare': {
      const n = ctx.take();
      return `${ctx.conditionPath(node.path, n)} ${node.op} ${ctx.value(n, node.value)}`;
    }
    case 'between': {
      const n = ctx.take();
      const path = ctx.conditionPath(node.path, n);
      return `${path} BETWEEN ${ctx.value(n, node.low, 1)} AND ${ctx.value(n, node.high, 2)}`;
    }
    case 'in': {
      if (node.values.length === 0)
        throw new ExpressionError('an "in" condition needs at least one value');
      const n = ctx.take();
      const path = ctx.conditionPath(node.path, n);
      return `${path} IN (${node.values.map((v, i) => ctx.value(n, v, i + 1)).join(', ')})`;
    }
    case 'begins_with':
    case 'contains': {
      const n = ctx.take();
      const path = ctx.conditionPath(node.path, n);
      return `${node.kind} (${path}, ${ctx.value(n, node.value)})`;
    }
    case 'attribute_exists':
    case 'attribute_not_exists': {
      // The term takes its number, but has no value, as in dynamoose.
      const n = ctx.take();
      return `${node.kind} (${ctx.conditionPath(node.path, n)})`;
    }
    case 'raw':
      return ctx.mergeRaw(node.raw);
  }
}
