import type { FunctionBodyContext } from '../FunctionBodyContext.js';

/**
 * Attach control flow metadata (cyclomatic complexity, error tracking, HOF bindings)
 * to the matching function node after traversal completes.
 */
export function attachControlFlowMetadata(ctx: FunctionBodyContext): void {
  if (!ctx.matchingFunction) return;

  const cyclomaticComplexity = 1 +
    ctx.controlFlowState.branchCount +
    ctx.controlFlowState.loopCount +
    ctx.controlFlowState.caseCount +
    ctx.controlFlowState.logicalOpCount;

  // REG-311: Collect rejection info for this function
  const functionRejectionPatterns = ctx.rejectionPatterns.filter(p => p.functionId === ctx.matchingFunction!.id);
  const asyncPatterns = functionRejectionPatterns.filter(p => p.isAsync);
  const syncPatterns = functionRejectionPatterns.filter(p => !p.isAsync);
  const canReject = asyncPatterns.length > 0;
  const hasAsyncThrow = asyncPatterns.some(p => p.rejectionType === 'async_throw');
  const rejectedBuiltinErrors = [...new Set(
    asyncPatterns
      .filter(p => p.errorClassName !== null)
      .map(p => p.errorClassName!)
  )];
  // REG-286: Sync throw error tracking
  const thrownBuiltinErrors = [...new Set(
    syncPatterns
      .filter(p => p.errorClassName !== null)
      .map(p => p.errorClassName!)
  )];

  ctx.matchingFunction.controlFlow = {
    hasBranches: ctx.controlFlowState.branchCount > 0,
    hasLoops: ctx.controlFlowState.loopCount > 0,
    hasTryCatch: ctx.controlFlowState.hasTryCatch,
    hasEarlyReturn: ctx.controlFlowState.hasEarlyReturn,
    hasThrow: ctx.controlFlowState.hasThrow,
    cyclomaticComplexity,
    // REG-311: Async error tracking
    canReject,
    hasAsyncThrow,
    rejectedBuiltinErrors: rejectedBuiltinErrors.length > 0 ? rejectedBuiltinErrors : undefined,
    // REG-286: Sync throw tracking
    thrownBuiltinErrors: thrownBuiltinErrors.length > 0 ? thrownBuiltinErrors : undefined
  };

  // REG-401: Store invoked parameter indexes for user-defined HOF detection
  if (ctx.invokedParamIndexes.size > 0) {
    ctx.matchingFunction.invokesParamIndexes = [...ctx.invokedParamIndexes];
  }
  // REG-417: Store property paths for destructured param bindings
  if (ctx.invokesParamBindings.length > 0) {
    ctx.matchingFunction.invokesParamBindings = ctx.invokesParamBindings;
  }
}
