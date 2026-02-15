import * as t from '@babel/types';

export interface CallInfo {
  line: number;
  column: number;
  name: string;
  isMethodCall: boolean;
}

/**
 * Extract call site information from CallExpression.
 * Returns null if not a valid CallExpression.
 */
export function extractCallInfo(node: t.Expression): CallInfo | null {
  if (node.type !== 'CallExpression') {
    return null;
  }

  const callee = node.callee;
  let name: string;
  let isMethodCall = false;

  // Direct call: fetchUser()
  if (t.isIdentifier(callee)) {
    name = callee.name;
  }
  // Method call: obj.fetchUser() or arr.map()
  else if (t.isMemberExpression(callee)) {
    isMethodCall = true;
    const objectName = t.isIdentifier(callee.object)
      ? callee.object.name
      : (t.isThisExpression(callee.object) ? 'this' : 'unknown');
    const methodName = t.isIdentifier(callee.property)
      ? callee.property.name
      : 'unknown';
    name = `${objectName}.${methodName}`;
  }
  else {
    return null;
  }

  return {
    line: node.loc?.start.line ?? 0,
    column: node.loc?.start.column ?? 0,
    name,
    isMethodCall
  };
}
