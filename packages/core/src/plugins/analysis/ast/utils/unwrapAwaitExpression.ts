import type { Expression } from '@babel/types';

/**
 * Recursively unwrap AwaitExpression to get the underlying expression.
 * await await fetch() -> fetch()
 */
export function unwrapAwaitExpression(node: Expression): Expression {
  if (node.type === 'AwaitExpression' && node.argument) {
    return unwrapAwaitExpression(node.argument);
  }
  return node;
}
