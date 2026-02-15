import * as t from '@babel/types';

/**
 * Count logical operators (&& and ||) in a condition expression.
 * Used for cyclomatic complexity calculation (Phase 6 REG-267).
 *
 * @param node - The condition expression to analyze
 * @returns Number of logical operators found
 */
export function countLogicalOperators(node: t.Expression): number {
  let count = 0;

  const walk = (expr: t.Expression | t.Node): void => {
    if (t.isLogicalExpression(expr)) {
      // Count && and || operators
      if (expr.operator === '&&' || expr.operator === '||') {
        count++;
      }
      walk(expr.left);
      walk(expr.right);
    } else if (t.isConditionalExpression(expr)) {
      // Handle ternary conditions: test ? consequent : alternate
      walk(expr.test);
      walk(expr.consequent);
      walk(expr.alternate);
    } else if (t.isUnaryExpression(expr)) {
      walk(expr.argument);
    } else if (t.isBinaryExpression(expr)) {
      walk(expr.left);
      walk(expr.right);
    } else if (t.isSequenceExpression(expr)) {
      for (const e of expr.expressions) {
        walk(e);
      }
    } else if (t.isParenthesizedExpression(expr)) {
      walk(expr.expression);
    }
  };

  walk(node);
  return count;
}
