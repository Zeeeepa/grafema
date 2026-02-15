import * as t from '@babel/types';

/**
 * Convert MemberExpression to string representation
 */
export function memberExpressionToString(expr: t.MemberExpression): string {
  const parts: string[] = [];

  let current: t.Expression = expr;
  while (t.isMemberExpression(current)) {
    if (t.isIdentifier(current.property)) {
      parts.unshift(current.property.name);
    } else {
      parts.unshift('<computed>');
    }
    current = current.object;
  }

  if (t.isIdentifier(current)) {
    parts.unshift(current.name);
  }

  return parts.join('.');
}
