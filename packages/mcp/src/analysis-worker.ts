/**
 * Analysis Worker — DEPRECATED
 *
 * Analysis is now handled by the grafema-orchestrator Rust binary.
 * This file is kept as a stub to prevent import errors from any remaining references.
 *
 * Use analysis.ts ensureAnalyzed() which spawns grafema-orchestrator.
 */

throw new Error(
  'Analysis is now handled by grafema-orchestrator. ' +
    'Use analysis.ts ensureAnalyzed() instead. ' +
    'The worker pattern is no longer needed since we shell out to a native binary.'
);
