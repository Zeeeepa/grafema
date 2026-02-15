import * as t from '@babel/types';
import { getLine, getColumn } from './location.js';
import { ExpressionNode } from '../../../../core/nodes/ExpressionNode.js';

export interface DiscriminantExpressionResult {
  id: string;
  expressionType: string;
  line: number;
  column: number;
}

/**
 * Extract EXPRESSION node ID and metadata for switch discriminant
 */
export function extractDiscriminantExpression(
  discriminant: t.Expression,
  module: { file: string },
): DiscriminantExpressionResult {
  const line = getLine(discriminant);
  const column = getColumn(discriminant);

  if (t.isIdentifier(discriminant)) {
    // Simple identifier: switch(x) - create EXPRESSION node
    return {
      id: ExpressionNode.generateId('Identifier', module.file, line, column),
      expressionType: 'Identifier',
      line,
      column
    };
  } else if (t.isMemberExpression(discriminant)) {
    // Member expression: switch(action.type)
    return {
      id: ExpressionNode.generateId('MemberExpression', module.file, line, column),
      expressionType: 'MemberExpression',
      line,
      column
    };
  } else if (t.isCallExpression(discriminant)) {
    // Call expression: switch(getType())
    const callee = t.isIdentifier(discriminant.callee) ? discriminant.callee.name : '<complex>';
    // Return CALL node ID instead of EXPRESSION (reuse existing call tracking)
    return {
      id: `${module.file}:CALL:${callee}:${line}:${column}`,
      expressionType: 'CallExpression',
      line,
      column
    };
  }

  // Default: create generic EXPRESSION
  return {
    id: ExpressionNode.generateId(discriminant.type, module.file, line, column),
    expressionType: discriminant.type,
    line,
    column
  };
}
