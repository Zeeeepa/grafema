import type { ScopeTracker } from '../../../../core/ScopeTracker.js';

/**
 * Generate a semantic ID for a scope type within the current scope path.
 * Format: "scopePath:scopeType[index]" e.g. "MyClass->myMethod:if_statement[0]"
 */
export function generateSemanticId(
  scopeType: string,
  scopeTracker: ScopeTracker | undefined
): string | undefined {
  if (!scopeTracker) return undefined;

  const scopePath = scopeTracker.getScopePath();
  const siblingIndex = scopeTracker.getItemCounter(`semanticId:${scopeType}`);
  return `${scopePath}:${scopeType}[${siblingIndex}]`;
}

/**
 * Generate a unique anonymous function name within the current scope.
 * Uses ScopeTracker.getSiblingIndex() for stable naming.
 */
export function generateAnonymousName(scopeTracker: ScopeTracker | undefined): string {
  if (!scopeTracker) return 'anonymous';
  const index = scopeTracker.getSiblingIndex('anonymous');
  return `anonymous[${index}]`;
}
