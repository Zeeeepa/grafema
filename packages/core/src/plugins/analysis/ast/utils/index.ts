/**
 * AST utility functions
 */
export { createParameterNodes } from './createParameterNodes.js';
export {
  getNodeLocation,
  getLine,
  getColumn,
  getEndLocation,
  UNKNOWN_LOCATION,
  type NodeLocation
} from './location.js';
export { getMemberExpressionName } from './getMemberExpressionName.js';
export { getExpressionValue } from './getExpressionValue.js';
export { unwrapAwaitExpression } from './unwrapAwaitExpression.js';
export { extractCallInfo, type CallInfo } from './extractCallInfo.js';
export { memberExpressionToString } from './memberExpressionToString.js';
export { countLogicalOperators } from './countLogicalOperators.js';
export { extractDiscriminantExpression, type DiscriminantExpressionResult } from './extractDiscriminantExpression.js';
export { generateSemanticId, generateAnonymousName } from './generateSemanticId.js';
