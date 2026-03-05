# Grafema Product Gaps

Gaps discovered during dogfooding. Each gap = graph couldn't answer a question it should.

## 2026-03-04: Cross-package import resolution missing

- **Query attempted**: `get_context` on IMPORT node `packages/cli/src/plugins/builtinPlugins.ts->IMPORT->@grafema/core` with `edgeType=IMPORTS_FROM`
- **Expected**: IMPORTS_FROM edge linking CLI's import to `packages/core/src/index.ts` MODULE node
- **Actual**: No edges found. IMPORT_BINDING nodes have `source: "@grafema/core"` as metadata but no resolved edges to target module
- **Workaround**: Used `query_graph` with `attr(X, "source", "@grafema/core")` to find IMPORT_BINDING nodes, then extracted unique symbol names via jq. Works for listing imports but can't trace through to the actual definitions in core.
- **Impact**: Cannot use graph to trace cross-package dependencies (e.g., "who uses Orchestrator from core?"). Had to combine graph metadata query with manual categorization.
- **Severity**: critical — cross-package dependency analysis is essential for refactoring tasks like the JS core removal
- **Linear issue**: REG-618
