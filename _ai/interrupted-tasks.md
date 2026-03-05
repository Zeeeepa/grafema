# Interrupted Tasks

Tasks paused due to gaps or context switches. Return to these when unblocked.

## 2026-03-04: Remove dead JS core code, move query layer to @grafema/util

- **Context**: User wants to remove JS Orchestrator and dead analysis pipeline code from `@grafema/core` after Rust orchestrator replaced it. Keep query layer + config + guarantees in a slimmer `@grafema/util` package. Analysis showed ~50 dead symbols (Orchestrator, all plugins/enrichers/validators) vs ~30 live symbols (query layer, config, RFDB lifecycle, guarantees).
- **Blocked by**: Gap — cross-package import resolution missing. Needed to verify full dependency map via graph, had to use workaround (metadata query + manual categorization). Workaround was sufficient for analysis but not for automated verification.
- **Resume point**: Dependency map is complete. Next step: plan the migration (create @grafema/util, move live symbols, update CLI/MCP imports, delete dead code).
- **Status**: ready to resume (workaround was sufficient)
