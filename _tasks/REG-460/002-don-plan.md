# REG-460: JSASTAnalyzer Refactoring Plan

**Goal:** Extract JSASTAnalyzer.ts from 4,042 lines to ~800 lines by extracting AnalyzerDelegate methods into dedicated modules.

**Date:** 2026-02-15
**Author:** Don Melton

## Current State Analysis

### File Size
- **Current:** 4,042 lines
- **Target:** ~800 lines (analyzeModule orchestration + execute + metadata)
- **To extract:** ~3,200 lines

### Method Inventory

**Public interface (5 methods, ~376 lines):**
- `get metadata()` (46 lines) — stays in JSASTAnalyzer
- `calculateFileHash()` (7 lines) — stays
- `shouldAnalyzeModule()` (35 lines) — stays
- `execute()` (140 lines) — stays (main plugin entry point)
- `executeParallel()` (79 lines) — stays (worker pool orchestration)

**Module-level orchestration (~700 lines):**
- `analyzeModule()` (~700 lines) — stays, but will be cleaned up after extraction

**AnalyzerDelegate methods (18 methods, ~2,227 lines):**

| Method | Lines | Category |
|--------|-------|----------|
| handleVariableDeclaration | 167 | Variable handling |
| detectVariableReassignment | 114 | Mutation detection |
| detectIndexedArrayAssignment | 117 | Mutation detection |
| detectObjectPropertyAssignment | 95 | Mutation detection |
| extractReturnExpressionInfo | 182 | Expression parsing |
| microTraceToErrorClass | 83 | Error tracking |
| handleSwitchStatement | 110 | Control flow |
| generateAnonymousName | 15 | ID generation |
| generateSemanticId | 14 | ID generation |
| analyzeFunctionBody | 72 | Delegation (already extracted) |
| collectUpdateExpression | 97 | Mutation detection |
| countLogicalOperators | 36 | Expression helpers |
| handleCallExpression | 211 | Call handling |
| collectCatchesFromInfo | 134 | Error tracking |
| memberExpressionToString | 38 | Expression helpers |
| extractDiscriminantExpression | 62 | Expression helpers |
| extractVariableNamesFromPattern | 3 | Pattern helpers (delegates to util) |
| (caseTerminates) | ~20 | Control flow helpers |
| (blockTerminates) | ~20 | Control flow helpers |
| (extractCaseValue) | ~25 | Control flow helpers |

**Private helpers (7 methods, ~739 lines):**
- trackVariableAssignment (286 lines) — Variable tracking
- extractObjectProperties (146 lines) — Object property extraction
- trackDestructuringAssignment (209 lines) — Destructuring tracking
- extractMethodCallArguments (85 lines) — Argument extraction
- unwrapAwaitExpression (5 lines) — Expression helpers
- extractCallInfo (35 lines) — Call helpers
- detectArrayMutationInFunction (77 lines) — Mutation detection
- detectObjectAssignInFunction (73 lines) — Mutation detection

### Architecture Insight: The Circular Dependency Problem

JSASTAnalyzer implements AnalyzerDelegate interface. Handlers (in ast/handlers/) receive `analyzer: AnalyzerDelegate` and call back into JSASTAnalyzer methods.

**Current flow:**
```
JSASTAnalyzer (implements AnalyzerDelegate)
    ↓ calls
analyzeFunctionBody()
    ↓ creates handlers
VariableHandler, CallExpressionHandler, etc.
    ↓ receive delegate
analyzer: AnalyzerDelegate
    ↓ call back
handleVariableDeclaration(), handleCallExpression(), etc.
```

**The problem:** If we extract `handleVariableDeclaration` to a separate module, where does it go?
- Can't go in handlers/ — handlers call these methods via delegate
- Can't stay in JSASTAnalyzer — we're trying to shrink it
- Need a new location that handlers can reference via AnalyzerDelegate

**Solution:** Create `ast/delegate-impl/` directory for AnalyzerDelegate method implementations.

## Extraction Strategy

### Phase 1: Extract Expression Helpers to Utils (~150 lines)

**New files:**
- `ast/utils/memberExpressionToString.ts` — 38 lines
- `ast/utils/unwrapAwaitExpression.ts` — 5 lines
- `ast/utils/extractCallInfo.ts` — 35 lines
- `ast/utils/countLogicalOperators.ts` — 36 lines
- `ast/utils/extractDiscriminantExpression.ts` — 62 lines

**Rationale:** These are pure utility functions with no state dependencies. Easiest to extract and verify.

**Risk:** LOW — pure functions, no side effects

**Expected JSASTAnalyzer size after Phase 1:** 3,892 lines

### Phase 2: Extract Mutation Detection to Visitors (~625 lines)

**Approach:** Extend existing `ast/visitors/MutationDetector.ts` (currently 8KB/~200 lines)

**Add to MutationDetector:**
- `detectVariableReassignment()` (114 lines) — variable mutation
- `detectIndexedArrayAssignment()` (117 lines) — array mutation
- `detectObjectPropertyAssignment()` (95 lines) — object mutation
- `collectUpdateExpression()` (97 lines) — update expressions
- `detectArrayMutationInFunction()` (77 lines) — array mutation in scope
- `detectObjectAssignInFunction()` (73 lines) — object mutation in scope

**Why MutationDetector?**
- Already exists for mutation tracking logic
- All 6 methods are conceptually similar (detect mutations, populate collections)
- No circular dependency (these methods don't call handlers)

**Update AnalyzerDelegate interface:**
```typescript
// Old: methods implemented in JSASTAnalyzer
detectVariableReassignment(...): void;

// New: delegate to MutationDetector
detectVariableReassignment(...): void; // impl: MutationDetector.detectVariableReassignment
```

**JSASTAnalyzer changes:**
```typescript
import { MutationDetector } from './ast/visitors/MutationDetector.js';

class JSASTAnalyzer implements AnalyzerDelegate {
  private mutationDetector = new MutationDetector();

  detectVariableReassignment(...args) {
    return this.mutationDetector.detectVariableReassignment(...args);
  }
  // ... repeat for other 5 methods
}
```

**Risk:** MEDIUM — methods have complex AST traversal logic, but no handler dependencies

**Expected JSASTAnalyzer size after Phase 2:** 3,267 lines (3,892 - 625)

### Phase 3: Extract Variable Tracking to New Module (~640 lines)

**New file:** `ast/delegate-impl/VariableTracker.ts`

**Extract to VariableTracker:**
- `trackVariableAssignment()` (286 lines) — variable init tracking
- `trackDestructuringAssignment()` (209 lines) — destructuring tracking
- `extractObjectProperties()` (146 lines) — object property extraction

**Why separate module?**
- These methods track variable flow, not mutations
- Called from handleVariableDeclaration (which we'll extract in Phase 4)
- Cohesive unit: all about tracking what's assigned to variables

**Structure:**
```typescript
export class VariableTracker {
  trackVariableAssignment(...): void { ... }
  trackDestructuringAssignment(...): void { ... }
  private extractObjectProperties(...): void { ... }
}
```

**JSASTAnalyzer integration:**
```typescript
import { VariableTracker } from './ast/delegate-impl/VariableTracker.js';

class JSASTAnalyzer {
  private variableTracker = new VariableTracker();

  trackVariableAssignment(...args) {
    return this.variableTracker.trackVariableAssignment(...args);
  }
}
```

**Risk:** MEDIUM — complex methods with many parameters, but pure data flow logic

**Expected JSASTAnalyzer size after Phase 3:** 2,627 lines (3,267 - 640)

### Phase 4: Extract Control Flow to Delegate Impl (~265 lines)

**New file:** `ast/delegate-impl/ControlFlowHandler.ts`

**Extract to ControlFlowHandler:**
- `handleSwitchStatement()` (110 lines) — switch/case handling
- `extractCaseValue()` (~25 lines) — helper
- `caseTerminates()` (~20 lines) — helper
- `blockTerminates()` (~20 lines) — helper

**Why separate?**
- Switch/case logic is self-contained
- Called from BranchHandler, needs to be accessible via delegate
- Will need extractDiscriminantExpression (moved to utils in Phase 1)

**JSASTAnalyzer integration:**
```typescript
import { ControlFlowHandler } from './ast/delegate-impl/ControlFlowHandler.js';

class JSASTAnalyzer implements AnalyzerDelegate {
  private controlFlowHandler = new ControlFlowHandler();

  handleSwitchStatement(...args) {
    return this.controlFlowHandler.handleSwitchStatement(...args);
  }
}
```

**Risk:** LOW — well-isolated logic, clear boundaries

**Expected JSASTAnalyzer size after Phase 4:** 2,362 lines (2,627 - 265)

### Phase 5: Extract Call Expression Logic (~296 lines)

**New file:** `ast/delegate-impl/CallExpressionProcessor.ts`

**Extract to CallExpressionProcessor:**
- `handleCallExpression()` (211 lines) — function call handling
- `extractMethodCallArguments()` (85 lines) — argument extraction

**Why separate?**
- CallExpressionHandler delegates to handleCallExpression via AnalyzerDelegate
- Argument extraction is tightly coupled to call handling
- Will use utils from Phase 1 (extractCallInfo, unwrapAwaitExpression)

**JSASTAnalyzer integration:**
```typescript
import { CallExpressionProcessor } from './ast/delegate-impl/CallExpressionProcessor.js';

class JSASTAnalyzer implements AnalyzerDelegate {
  private callProcessor = new CallExpressionProcessor();

  handleCallExpression(...args) {
    return this.callProcessor.handleCallExpression(...args);
  }
}
```

**Risk:** MEDIUM — complex method with many branches, but handlers already tested

**Expected JSASTAnalyzer size after Phase 5:** 2,066 lines (2,362 - 296)

### Phase 6: Extract Error Tracking (~217 lines)

**New file:** `ast/delegate-impl/ErrorTracker.ts`

**Extract to ErrorTracker:**
- `collectCatchesFromInfo()` (134 lines) — catch-from analysis
- `microTraceToErrorClass()` (83 lines) — error class tracing

**Why separate?**
- Both methods are about error handling analysis
- Called from TryCatchHandler
- Self-contained logic

**JSASTAnalyzer integration:**
```typescript
import { ErrorTracker } from './ast/delegate-impl/ErrorTracker.js';

class JSASTAnalyzer implements AnalyzerDelegate {
  private errorTracker = new ErrorTracker();

  collectCatchesFromInfo(...args) {
    return this.errorTracker.collectCatchesFromInfo(...args);
  }

  microTraceToErrorClass(...args) {
    return this.errorTracker.microTraceToErrorClass(...args);
  }
}
```

**Risk:** LOW — isolated analysis logic

**Expected JSASTAnalyzer size after Phase 6:** 1,849 lines (2,066 - 217)

### Phase 7: Extract Return Expression Parsing (~182 lines)

**New file:** `ast/delegate-impl/ReturnExpressionParser.ts`

**Extract to ReturnExpressionParser:**
- `extractReturnExpressionInfo()` (182 lines) — parse return expressions

**Why separate?**
- Large, complex method used by ReturnYieldHandler
- Needs to remain accessible via AnalyzerDelegate
- Will use utils from Phase 1

**JSASTAnalyzer integration:**
```typescript
import { ReturnExpressionParser } from './ast/delegate-impl/ReturnExpressionParser.js';

class JSASTAnalyzer implements AnalyzerDelegate {
  private returnParser = new ReturnExpressionParser();

  extractReturnExpressionInfo(...args) {
    return this.returnParser.extractReturnExpressionInfo(...args);
  }
}
```

**Risk:** MEDIUM — complex expression parsing logic

**Expected JSASTAnalyzer size after Phase 7:** 1,667 lines (1,849 - 182)

### Phase 8: Extract Variable Declaration Handling (~167 lines)

**New file:** `ast/delegate-impl/VariableDeclarationHandler.ts`

**Extract to VariableDeclarationHandler:**
- `handleVariableDeclaration()` (167 lines) — variable declaration processing

**Why separate?**
- Called from VariableHandler via AnalyzerDelegate
- Depends on VariableTracker (Phase 3) — will import it
- Last large AnalyzerDelegate method to extract

**Dependencies:**
- Uses `this.extractVariableNamesFromPattern` (delegates to util)
- Uses `this.trackVariableAssignment` (Phase 3: VariableTracker)

**JSASTAnalyzer integration:**
```typescript
import { VariableDeclarationHandler } from './ast/delegate-impl/VariableDeclarationHandler.js';

class JSASTAnalyzer implements AnalyzerDelegate {
  private varDeclHandler = new VariableDeclarationHandler(this.variableTracker);

  handleVariableDeclaration(...args) {
    return this.varDeclHandler.handleVariableDeclaration(...args);
  }
}
```

**Risk:** MEDIUM — complex method with many parameters, depends on VariableTracker

**Expected JSASTAnalyzer size after Phase 8:** 1,500 lines (1,667 - 167)

### Phase 9: Extract ID Generation (~29 lines)

**New file:** `ast/delegate-impl/IdGenerator.ts`

**Extract to IdGenerator:**
- `generateSemanticId()` (14 lines) — semantic ID generation
- `generateAnonymousName()` (15 lines) — anonymous function naming

**Why separate?**
- Small, cohesive utility
- Called from multiple handlers via AnalyzerDelegate
- Note: There's already an `ast/IdGenerator.ts` (258 lines) — this is different (node ID gen vs semantic ID gen)

**Naming clarification:**
- Existing `ast/IdGenerator.ts` — generates node IDs (FUNCTION#file#line, etc.)
- New `ast/delegate-impl/IdGenerator.ts` — generates semantic/anonymous IDs for scopes

**Alternative:** Could rename new file to `SemanticIdGenerator.ts` to avoid confusion

**JSASTAnalyzer integration:**
```typescript
import { SemanticIdGenerator } from './ast/delegate-impl/SemanticIdGenerator.js';

class JSASTAnalyzer implements AnalyzerDelegate {
  private semanticIdGen = new SemanticIdGenerator();

  generateSemanticId(...args) {
    return this.semanticIdGen.generateSemanticId(...args);
  }

  generateAnonymousName(...args) {
    return this.semanticIdGen.generateAnonymousName(...args);
  }
}
```

**Risk:** LOW — trivial methods

**Expected JSASTAnalyzer size after Phase 9:** 1,471 lines (1,500 - 29)

### Phase 10: Clean Up analyzeModule (~700 → ~200 lines)

After all extractions, `analyzeModule()` will still be ~700 lines, mostly:
- Collection declarations (~75 lines)
- Counter ref initialization (~20 lines)
- ProcessedNodes setup (~10 lines)
- Visitor instantiation and composition (~100 lines)
- Traverse call (~5 lines)
- Second pass logic (~50 lines)
- GraphBuilder call (~10 lines)
- Error handling (~30 lines)
- Boilerplate (~100 lines of comments/spacing)

**Refactoring approach:**

**10.1. Extract collection initialization:**

Create `ast/delegate-impl/CollectionFactory.ts`:
```typescript
export function createAnalysisCollections(): Collections {
  return {
    functions: [],
    parameters: [],
    scopes: [],
    // ... all 30+ collections
  };
}

export function createCounterRefs(): CounterRefs {
  return {
    ifScopeCounterRef: { value: 0 },
    scopeCounterRef: { value: 0 },
    // ... all 13 counter refs
  };
}
```

**Savings:** ~95 lines

**10.2. Extract visitor composition:**

Create `ast/delegate-impl/VisitorComposer.ts`:
```typescript
export function composeModuleVisitors(
  module: VisitorModule,
  collections: Collections,
  scopeTracker: ScopeTracker,
  analyzer: AnalyzerDelegate
): Visitor {
  // Instantiate all visitors
  const importExportVisitor = new ImportExportVisitor(...);
  const variableVisitor = new VariableVisitor(...);
  // ... etc

  // Merge visitor objects
  return {
    ...importExportVisitor.getHandlers(),
    ...variableVisitor.getHandlers(),
    // ... etc
  };
}
```

**Savings:** ~100 lines

**10.3. Keep orchestration logic in analyzeModule:**
- File reading and parsing (~20 lines)
- ScopeTracker creation (~5 lines)
- Collection/counter setup (now 2 lines with factory)
- Visitor composition (now 1 line)
- Traverse call (~5 lines)
- Second pass (collectCatchesFromInfo) (~50 lines)
- GraphBuilder call (~10 lines)
- Error handling (~30 lines)
- Return statement (~5 lines)

**Total remaining:** ~128 lines of actual orchestration

**Expected JSASTAnalyzer size after Phase 10:** ~800 lines
- Public interface: ~376 lines
- analyzeModule: ~128 lines
- Delegation stubs (18 methods × 3 lines avg): ~54 lines
- Private helper stubs: ~40 lines
- Constructor, fields, imports: ~60 lines
- Comments and spacing: ~142 lines

**Risk:** LOW — mechanical refactoring, no logic changes

## Testing Strategy

### Existing Test Coverage
- **GraphSnapshot.test.js** — snapshot tests of full pipeline output
- Tests run through `Orchestrator`, not JSASTAnalyzer directly
- Graph output must be byte-identical before/after refactoring

### Per-Phase Testing

**After each phase:**
1. Run `pnpm build` (tests run against dist/)
2. Run full test suite: `node --test 'test/unit/*.test.js'`
3. Verify snapshot tests pass (no graph output changes)
4. If snapshot changes detected → investigate, likely a bug
5. If tests pass → commit atomic changes

**Snapshot verification command:**
```bash
node --test test/unit/GraphSnapshot.test.js
```

**If snapshot diverges:**
- DO NOT update snapshot without investigation
- Compare old vs new output: what changed and why?
- If intentional improvement → discuss with user
- If unintentional → revert and debug

### Unit Tests for Extracted Modules

**Not required for this refactoring** because:
- We're extracting existing tested code
- Full integration tests already exist
- Adding unit tests = scope creep (different task)

**Future task:** Add unit tests for delegate-impl modules (good tech debt item)

## Dependency Graph

```
Phase 1 (Utils)
    ↓ (no dependencies)
Phase 2 (MutationDetector)
    ↓ (uses Phase 1 utils)
Phase 3 (VariableTracker)
    ↓ (uses Phase 1 utils)
Phase 4 (ControlFlowHandler)
    ↓ (uses Phase 1 utils)
Phase 5 (CallExpressionProcessor)
    ↓ (uses Phase 1 utils)
Phase 6 (ErrorTracker)
    ↓ (independent)
Phase 7 (ReturnExpressionParser)
    ↓ (uses Phase 1 utils)
Phase 8 (VariableDeclarationHandler)
    ↓ (depends on Phase 3 VariableTracker)
Phase 9 (SemanticIdGenerator)
    ↓ (independent)
Phase 10 (analyzeModule cleanup)
    ↓ (depends on all previous phases)
```

**Execution order is strict** — each phase must complete and pass tests before starting the next.

## File Creation Summary

**New directories:**
- `packages/core/src/plugins/analysis/ast/delegate-impl/` — AnalyzerDelegate implementations

**New files (11 total):**

**Utils (5 files, Phase 1):**
1. `ast/utils/memberExpressionToString.ts`
2. `ast/utils/unwrapAwaitExpression.ts`
3. `ast/utils/extractCallInfo.ts`
4. `ast/utils/countLogicalOperators.ts`
5. `ast/utils/extractDiscriminantExpression.ts`

**Delegate implementations (6 files, Phases 3-9):**
6. `ast/delegate-impl/VariableTracker.ts` (Phase 3)
7. `ast/delegate-impl/ControlFlowHandler.ts` (Phase 4)
8. `ast/delegate-impl/CallExpressionProcessor.ts` (Phase 5)
9. `ast/delegate-impl/ErrorTracker.ts` (Phase 6)
10. `ast/delegate-impl/ReturnExpressionParser.ts` (Phase 7)
11. `ast/delegate-impl/VariableDeclarationHandler.ts` (Phase 8)
12. `ast/delegate-impl/SemanticIdGenerator.ts` (Phase 9)

**Phase 10 factories:**
13. `ast/delegate-impl/CollectionFactory.ts`
14. `ast/delegate-impl/VisitorComposer.ts`

**Modified files:**
- `ast/visitors/MutationDetector.ts` (Phase 2) — add 6 methods
- `JSASTAnalyzer.ts` (all phases) — shrink from 4,042 → ~800 lines
- `ast/utils/index.ts` (Phase 1) — add exports for new utils
- `ast/delegate-impl/index.ts` (new file, Phase 3) — export all delegate implementations

## Line Count Progression

| Phase | Action | Lines Extracted | JSASTAnalyzer Size |
|-------|--------|-----------------|---------------------|
| Start | - | - | 4,042 |
| 1 | Extract utils | 150 | 3,892 |
| 2 | MutationDetector | 625 | 3,267 |
| 3 | VariableTracker | 640 | 2,627 |
| 4 | ControlFlowHandler | 265 | 2,362 |
| 5 | CallExpressionProcessor | 296 | 2,066 |
| 6 | ErrorTracker | 217 | 1,849 |
| 7 | ReturnExpressionParser | 182 | 1,667 |
| 8 | VariableDeclarationHandler | 167 | 1,500 |
| 9 | SemanticIdGenerator | 29 | 1,471 |
| 10 | analyzeModule cleanup | ~671 | ~800 |
| **Total** | | **3,242** | **~800** |

## Risk Assessment

**Overall risk:** MEDIUM-LOW

**High-confidence phases (LOW risk):**
- Phase 1 (utils) — pure functions
- Phase 4 (control flow) — isolated logic
- Phase 6 (error tracking) — isolated logic
- Phase 9 (ID generation) — trivial methods
- Phase 10 (cleanup) — mechanical refactoring

**Medium-confidence phases (MEDIUM risk):**
- Phase 2 (mutation detection) — complex AST logic
- Phase 3 (variable tracking) — many parameters
- Phase 5 (call expression) — complex branching
- Phase 7 (return parsing) — complex expression logic
- Phase 8 (variable declaration) — dependencies on Phase 3

**Mitigation:**
- Atomic commits per phase
- Snapshot tests after every phase
- Revert immediately if tests fail
- Don't batch multiple phases

## Success Criteria

**Functional:**
- All existing tests pass
- Graph output byte-identical to baseline
- No new errors or warnings

**Structural:**
- JSASTAnalyzer.ts ≤ 900 lines (target ~800, buffer 100)
- No method > 100 lines in JSASTAnalyzer (except analyzeModule orchestration)
- All AnalyzerDelegate methods extracted to dedicated modules
- Clear separation: orchestration (JSASTAnalyzer) vs implementation (delegate-impl/)

**Code quality:**
- Each extracted module has clear single responsibility
- Imports organized by category (types, utils, delegate-impl)
- No circular dependencies
- Comments preserved from original code

## Estimated Effort

**Per phase:**
- Phase 1-9: ~30-60 minutes each (extract + test + commit)
- Phase 10: ~90 minutes (multiple refactorings)

**Total:** 8-12 hours of focused work

**Critical path:** Sequential execution (can't parallelize)

## Alternative Considered: "Big Bang" Extraction

**Rejected.** Reasons:
- Too risky — hard to isolate failures
- Violates atomic commit principle
- If snapshot diverges, can't bisect which phase broke it
- Recovery cost too high

**Chosen approach:** Incremental, test-after-every-phase

## Notes

**Naming collision:** There's an existing `ast/IdGenerator.ts` (258 lines, generates node IDs like `FUNCTION#file#line`). The new semantic ID generator (Phase 9) should be named `SemanticIdGenerator.ts` to avoid confusion.

**Circular dependency warning:** The delegate-impl modules should NOT import handlers. Flow is:
```
JSASTAnalyzer → delegate-impl → utils
       ↓
   handlers → (via AnalyzerDelegate) → JSASTAnalyzer → delegate-impl
```

**No new public API:** All extracted modules are internal. AnalyzerDelegate interface remains the contract.

**Commit message format:**
```
refactor(JSASTAnalyzer): extract [module name] (Phase N, REG-460)

- Extract [method names] to [file path]
- JSASTAnalyzer: 4,042 → X lines
- Tests: ✅ All passing, snapshots unchanged
```

---

## Implementation Checklist

Each phase should follow this sequence:

1. Create new file(s)
2. Copy method(s) from JSASTAnalyzer
3. Add imports/exports
4. Update JSASTAnalyzer to delegate to new module
5. Remove old implementation from JSASTAnalyzer
6. `pnpm build`
7. Run tests
8. Verify snapshots
9. Commit with atomic message

**Phase order is strict. Do not proceed to Phase N+1 until Phase N is committed and tested.**
