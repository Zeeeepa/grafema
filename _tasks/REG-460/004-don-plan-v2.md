# REG-460: JSASTAnalyzer Refactoring Plan (v2)

**Goal:** Extract JSASTAnalyzer.ts from 4,042 lines to ~800 lines by extracting AnalyzerDelegate methods into dedicated modules.

**Date:** 2026-02-15
**Author:** Don Melton
**Version:** 2 (post auto-review revision)

## Changes from v1

1. **Fixed Phase 2 architecture:** Split mutation detection into 3 separate processor files instead of extending MutationDetector (module-level vs function-level concerns)
2. **Directory renamed:** `delegate-impl/` → `delegate/` (matches existing patterns)
3. **Verified line counts:** All method sizes verified from actual code, not estimates
4. **Fixed Phase 10 breakdown:** analyzeModule is 587 lines (1310-1896), breakdown verified
5. **Consistent naming:** All delegate implementations use `Processor` suffix

## Current State Analysis

### File Size
- **Current:** 4,042 lines
- **Target:** ~800 lines (analyzeModule orchestration + execute + metadata + delegation stubs)
- **To extract:** ~3,200 lines

### Verified Method Inventory

**analyzeModule method:**
- Lines 1310-1896: **587 lines total**
- Collection declarations: lines 1330-1398 = **69 lines**
- Counter refs: lines 1386-1398 = **13 lines**
- Visitor instantiation: lines 1414-1818 = **~350 lines** (imports, variables, functions, assignments, classes, TypeScript, calls, property access, etc.)
- GraphBuilder call: lines 1820-1887 = **68 lines**
- Error handling: lines 1892-1896 = **5 lines**
- File read/parse/setup: lines 1311-1329 = **19 lines**
- Boilerplate (comments, spacing): ~**63 lines**

**Verified AnalyzerDelegate method sizes (actual line ranges):**

| Method | Lines | Actual Size | Category |
|--------|-------|-------------|----------|
| trackVariableAssignment | 575-861 | 287 | Variable tracking |
| extractObjectProperties | 862-1084 | 223 | Object property extraction |
| trackDestructuringAssignment | 1085-1309 | 225 | Destructuring tracking |
| handleVariableDeclaration | 1963-2143 | 181 | Variable handling |
| handleSwitchStatement | 2144-2461 | 318 | Control flow |
| extractReturnExpressionInfo | 2462-2808 | 347 | Expression parsing |
| handleCallExpression | 2809-3029 | 221 | Call handling |
| extractMethodCallArguments | 3030-3127 | 98 | Argument extraction |
| microTraceToErrorClass | 3128-3229 | 102 | Error tracking |
| collectCatchesFromInfo | 3230-3381 | 152 | Error tracking |
| detectArrayMutationInFunction | 3382-3472 | 91 | Mutation detection |
| detectIndexedArrayAssignment | 3473-3600 | 128 | Mutation detection |
| detectObjectPropertyAssignment | 3601-3709 | 109 | Mutation detection |
| collectUpdateExpression | 3710-3819 | 110 | Mutation detection |
| detectVariableReassignment | 3820-3967 | 148 | Mutation detection |
| detectObjectAssignInFunction | 3968-4041 | 74 | Mutation detection |

**Verified utility method sizes:**

| Method | Lines | Actual Size | Category |
|--------|-------|-------------|----------|
| unwrapAwaitExpression | 1009-1014 | 6 | Expression helpers |
| extractCallInfo | 1020-1059 | 40 | Call helpers |
| generateSemanticId | 1903-1912 | 10 | ID generation |
| generateAnonymousName | 1918-1922 | 5 | ID generation |
| extractDiscriminantExpression | 2259-2301 | 43 | Expression helpers |
| extractCaseValue | 2306-2326 | 21 | Control flow helpers |
| caseTerminates | 2331-2363 | 33 | Control flow helpers |
| blockTerminates | 2368-2377 | 10 | Control flow helpers |
| countLogicalOperators | 2386-2418 | 33 | Expression helpers |
| memberExpressionToString | 2423-2461 | 39 | Expression helpers |

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

**Solution:** Create `ast/delegate/` directory for AnalyzerDelegate method implementations.

## Extraction Strategy

### Phase 1: Extract Expression Helpers to Utils (~161 lines)

**New files:**
- `ast/utils/memberExpressionToString.ts` — 39 lines
- `ast/utils/unwrapAwaitExpression.ts` — 6 lines
- `ast/utils/extractCallInfo.ts` — 40 lines
- `ast/utils/countLogicalOperators.ts` — 33 lines
- `ast/utils/extractDiscriminantExpression.ts` — 43 lines

**Rationale:** These are pure utility functions with no state dependencies. Easiest to extract and verify.

**Risk:** LOW — pure functions, no side effects

**Expected JSASTAnalyzer size after Phase 1:** 3,881 lines (4,042 - 161)

### Phase 2: Extract Mutation Detection to Processors (~660 lines)

**CRITICAL FIX from v1:** Do NOT extend MutationDetector. Create separate processor files.

**Why the change:**
- Current `MutationDetector` in `ast/visitors/` is module-level static visitor
- Methods we're extracting are function-body-level instance methods
- Mixing these concerns breaks cohesion

**New approach: 3 separate files in `ast/delegate/`:**

**Phase 2a: VariableMutationProcessor.ts (~258 lines)**
- `detectVariableReassignment()` (148 lines) — variable mutation
- `collectUpdateExpression()` (110 lines) — update expressions (x++, obj.count++)

**Phase 2b: ArrayMutationProcessor.ts (~219 lines)**
- `detectIndexedArrayAssignment()` (128 lines) — arr[i] = value
- `detectArrayMutationInFunction()` (91 lines) — array mutation in scope

**Phase 2c: ObjectMutationProcessor.ts (~183 lines)**
- `detectObjectPropertyAssignment()` (109 lines) — obj.prop = value
- `detectObjectAssignInFunction()` (74 lines) — object mutation in scope

**JSASTAnalyzer integration:**
```typescript
import { VariableMutationProcessor } from './ast/delegate/VariableMutationProcessor.js';
import { ArrayMutationProcessor } from './ast/delegate/ArrayMutationProcessor.js';
import { ObjectMutationProcessor } from './ast/delegate/ObjectMutationProcessor.js';

class JSASTAnalyzer implements AnalyzerDelegate {
  private varMutationProcessor = new VariableMutationProcessor();
  private arrayMutationProcessor = new ArrayMutationProcessor();
  private objectMutationProcessor = new ObjectMutationProcessor();

  detectVariableReassignment(...args) {
    return this.varMutationProcessor.detectVariableReassignment(...args);
  }
  // ... etc for all 6 methods
}
```

**Risk:** MEDIUM — complex AST traversal logic, but no handler dependencies

**Expected JSASTAnalyzer size after Phase 2:** 3,221 lines (3,881 - 660)

### Phase 3: Extract Variable Tracking to Processor (~735 lines)

**New file:** `ast/delegate/VariableTrackingProcessor.ts`

**Extract to VariableTrackingProcessor:**
- `trackVariableAssignment()` (287 lines) — variable init tracking
- `trackDestructuringAssignment()` (225 lines) — destructuring tracking
- `extractObjectProperties()` (223 lines) — object property extraction

**Why separate module?**
- These methods track variable flow, not mutations
- Called from handleVariableDeclaration (which we'll extract in Phase 4)
- Cohesive unit: all about tracking what's assigned to variables

**Structure:**
```typescript
export class VariableTrackingProcessor {
  trackVariableAssignment(...): void { ... }
  trackDestructuringAssignment(...): void { ... }
  private extractObjectProperties(...): void { ... }
}
```

**JSASTAnalyzer integration:**
```typescript
import { VariableTrackingProcessor } from './ast/delegate/VariableTrackingProcessor.js';

class JSASTAnalyzer {
  private variableTracker = new VariableTrackingProcessor();

  trackVariableAssignment(...args) {
    return this.variableTracker.trackVariableAssignment(...args);
  }
  // ... etc
}
```

**Risk:** MEDIUM — complex methods with many parameters, but pure data flow logic

**Expected JSASTAnalyzer size after Phase 3:** 2,486 lines (3,221 - 735)

### Phase 4: Extract Control Flow to Processor (~382 lines)

**New file:** `ast/delegate/ControlFlowProcessor.ts`

**Extract to ControlFlowProcessor:**
- `handleSwitchStatement()` (318 lines) — switch/case handling
- `extractCaseValue()` (21 lines) — helper
- `caseTerminates()` (33 lines) — helper
- `blockTerminates()` (10 lines) — helper

**Why separate?**
- Switch/case logic is self-contained
- Called from BranchHandler, needs to be accessible via delegate
- Will need extractDiscriminantExpression (moved to utils in Phase 1)

**JSASTAnalyzer integration:**
```typescript
import { ControlFlowProcessor } from './ast/delegate/ControlFlowProcessor.js';

class JSASTAnalyzer implements AnalyzerDelegate {
  private controlFlowProcessor = new ControlFlowProcessor();

  handleSwitchStatement(...args) {
    return this.controlFlowProcessor.handleSwitchStatement(...args);
  }
}
```

**Risk:** LOW — well-isolated logic, clear boundaries

**Expected JSASTAnalyzer size after Phase 4:** 2,104 lines (2,486 - 382)

### Phase 5: Extract Call Expression Logic (~319 lines)

**New file:** `ast/delegate/CallExpressionProcessor.ts`

**Extract to CallExpressionProcessor:**
- `handleCallExpression()` (221 lines) — function call handling
- `extractMethodCallArguments()` (98 lines) — argument extraction

**Why separate?**
- CallExpressionHandler delegates to handleCallExpression via AnalyzerDelegate
- Argument extraction is tightly coupled to call handling
- Will use utils from Phase 1 (extractCallInfo, unwrapAwaitExpression)

**JSASTAnalyzer integration:**
```typescript
import { CallExpressionProcessor } from './ast/delegate/CallExpressionProcessor.js';

class JSASTAnalyzer implements AnalyzerDelegate {
  private callProcessor = new CallExpressionProcessor();

  handleCallExpression(...args) {
    return this.callProcessor.handleCallExpression(...args);
  }
}
```

**Risk:** MEDIUM — complex method with many branches, but handlers already tested

**Expected JSASTAnalyzer size after Phase 5:** 1,785 lines (2,104 - 319)

### Phase 6: Extract Error Tracking (~254 lines)

**New file:** `ast/delegate/ErrorTrackingProcessor.ts`

**Extract to ErrorTrackingProcessor:**
- `collectCatchesFromInfo()` (152 lines) — catch-from analysis
- `microTraceToErrorClass()` (102 lines) — error class tracing

**Why separate?**
- Both methods are about error handling analysis
- Called from TryCatchHandler
- Self-contained logic

**JSASTAnalyzer integration:**
```typescript
import { ErrorTrackingProcessor } from './ast/delegate/ErrorTrackingProcessor.js';

class JSASTAnalyzer implements AnalyzerDelegate {
  private errorTracker = new ErrorTrackingProcessor();

  collectCatchesFromInfo(...args) {
    return this.errorTracker.collectCatchesFromInfo(...args);
  }

  microTraceToErrorClass(...args) {
    return this.errorTracker.microTraceToErrorClass(...args);
  }
}
```

**Risk:** LOW — isolated analysis logic

**Expected JSASTAnalyzer size after Phase 6:** 1,531 lines (1,785 - 254)

### Phase 7: Extract Return Expression Parsing (~347 lines)

**New file:** `ast/delegate/ReturnExpressionParser.ts`

**Extract to ReturnExpressionParser:**
- `extractReturnExpressionInfo()` (347 lines) — parse return expressions

**Why separate?**
- Large, complex method used by ReturnYieldHandler
- Needs to remain accessible via AnalyzerDelegate
- Will use utils from Phase 1

**JSASTAnalyzer integration:**
```typescript
import { ReturnExpressionParser } from './ast/delegate/ReturnExpressionParser.js';

class JSASTAnalyzer implements AnalyzerDelegate {
  private returnParser = new ReturnExpressionParser();

  extractReturnExpressionInfo(...args) {
    return this.returnParser.extractReturnExpressionInfo(...args);
  }
}
```

**Risk:** MEDIUM — complex expression parsing logic

**Expected JSASTAnalyzer size after Phase 7:** 1,184 lines (1,531 - 347)

### Phase 8: Extract Variable Declaration Handling (~181 lines)

**New file:** `ast/delegate/VariableDeclarationProcessor.ts`

**Extract to VariableDeclarationProcessor:**
- `handleVariableDeclaration()` (181 lines) — variable declaration processing

**Why separate?**
- Called from VariableHandler via AnalyzerDelegate
- Depends on VariableTrackingProcessor (Phase 3) — will import it
- Last large AnalyzerDelegate method to extract

**Dependencies:**
- Uses `this.extractVariableNamesFromPattern` (delegates to util)
- Uses `this.trackVariableAssignment` (Phase 3: VariableTrackingProcessor)

**JSASTAnalyzer integration:**
```typescript
import { VariableDeclarationProcessor } from './ast/delegate/VariableDeclarationProcessor.js';

class JSASTAnalyzer implements AnalyzerDelegate {
  private varDeclProcessor = new VariableDeclarationProcessor(this.variableTracker);

  handleVariableDeclaration(...args) {
    return this.varDeclProcessor.handleVariableDeclaration(...args);
  }
}
```

**Risk:** MEDIUM — complex method with many parameters, depends on VariableTrackingProcessor

**Expected JSASTAnalyzer size after Phase 8:** 1,003 lines (1,184 - 181)

### Phase 9: Extract ID Generation (~15 lines)

**New file:** `ast/delegate/SemanticIdGenerator.ts`

**Extract to SemanticIdGenerator:**
- `generateSemanticId()` (10 lines) — semantic ID generation
- `generateAnonymousName()` (5 lines) — anonymous function naming

**Why separate?**
- Small, cohesive utility
- Called from multiple handlers via AnalyzerDelegate
- Note: There's already an `ast/IdGenerator.ts` (258 lines) — this is different (node ID gen vs semantic ID gen)

**Naming clarification:**
- Existing `ast/IdGenerator.ts` — generates node IDs (FUNCTION#file#line, etc.)
- New `ast/delegate/SemanticIdGenerator.ts` — generates semantic/anonymous IDs for scopes

**JSASTAnalyzer integration:**
```typescript
import { SemanticIdGenerator } from './ast/delegate/SemanticIdGenerator.js';

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

**Expected JSASTAnalyzer size after Phase 9:** 988 lines (1,003 - 15)

### Phase 10: Clean Up analyzeModule (~587 → ~150 lines)

**Current analyzeModule structure (lines 1310-1896, 587 lines total):**
- File read/parse/setup: ~19 lines
- Collection declarations: ~69 lines
- Counter refs: ~13 lines
- ProcessedNodes setup: ~10 lines
- Visitor instantiation and traversal: ~350 lines
- GraphBuilder call: ~68 lines
- Error handling: ~5 lines
- Comments/spacing: ~53 lines

**Refactoring approach:**

**10.1. Extract collection initialization (~82 lines saved):**

Create `ast/delegate/CollectionFactory.ts`:
```typescript
export function createAnalysisCollections(): Collections {
  return {
    functions: [],
    parameters: [],
    scopes: [],
    // ... all 38 collections
  };
}

export function createCounterRefs(): CounterRefs {
  return {
    ifScopeCounterRef: { value: 0 },
    scopeCounterRef: { value: 0 },
    // ... all 13 counter refs
  };
}

export function createProcessedNodes(): ProcessedNodes {
  return {
    functions: new Set(),
    classes: new Set(),
    // ... all 9 sets
  };
}
```

**Savings:** ~82 lines (69 collections + 13 counters + 10 processedNodes - 10 factory calls)

**10.2. Extract visitor composition (~250 lines saved):**

Create `ast/delegate/VisitorComposer.ts`:
```typescript
export async function composeAndTraverse(
  ast: t.Node,
  module: VisitorModule,
  collections: Collections,
  scopeTracker: ScopeTracker,
  analyzer: AnalyzerDelegate,
  profiler: Profiler
): Promise<void> {
  // All visitor instantiation (lines 1414-1818)
  profiler.start('traverse_imports');
  const importExportVisitor = new ImportExportVisitor(...);
  traverse(ast, importExportVisitor.getImportHandlers());
  traverse(ast, importExportVisitor.getExportHandlers());
  profiler.end('traverse_imports');

  // ... all other visitors (variables, functions, assignments, etc.)
}
```

**Savings:** ~250 lines (350 visitor code - 100 for factory call and some setup)

**10.3. Keep orchestration logic in analyzeModule (~150 lines):**
- File reading and parsing (~19 lines)
- ScopeTracker creation (~5 lines)
- Collection/counter/processedNodes setup (now ~10 lines with factories)
- Visitor composition call (~5 lines)
- GraphBuilder call (~68 lines)
- Error handling (~5 lines)
- Return statement (~3 lines)
- Comments and spacing (~35 lines)

**Total remaining:** ~150 lines of actual orchestration

**Expected JSASTAnalyzer size after Phase 10:** ~750 lines
- Public interface (execute, executeParallel, shouldAnalyzeModule, calculateFileHash, get metadata): ~376 lines
- analyzeModule: ~150 lines
- Delegation stubs (16 methods × 3 lines avg): ~48 lines
- Private helper stubs (if any remain): ~10 lines
- Constructor, fields, imports: ~80 lines
- Comments and spacing: ~86 lines

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

**Future task:** Add unit tests for delegate modules (good tech debt item)

## Dependency Graph

```
Phase 1 (Utils)
    ↓ (no dependencies)
Phase 2a,b,c (Mutation Processors) — parallel
    ↓ (use Phase 1 utils)
Phase 3 (VariableTrackingProcessor)
    ↓ (uses Phase 1 utils)
Phase 4 (ControlFlowProcessor)
    ↓ (uses Phase 1 utils)
Phase 5 (CallExpressionProcessor)
    ↓ (uses Phase 1 utils)
Phase 6 (ErrorTrackingProcessor)
    ↓ (independent)
Phase 7 (ReturnExpressionParser)
    ↓ (uses Phase 1 utils)
Phase 8 (VariableDeclarationProcessor)
    ↓ (depends on Phase 3 VariableTrackingProcessor)
Phase 9 (SemanticIdGenerator)
    ↓ (independent)
Phase 10 (analyzeModule cleanup)
    ↓ (depends on all previous phases)
```

**Execution order is strict** — each phase must complete and pass tests before starting the next.

**Exception:** Phase 2a, 2b, 2c can be done in parallel or sequentially (no interdependencies).

## File Creation Summary

**New directories:**
- `packages/core/src/plugins/analysis/ast/delegate/` — AnalyzerDelegate implementations

**New files (16 total):**

**Utils (5 files, Phase 1):**
1. `ast/utils/memberExpressionToString.ts`
2. `ast/utils/unwrapAwaitExpression.ts`
3. `ast/utils/extractCallInfo.ts`
4. `ast/utils/countLogicalOperators.ts`
5. `ast/utils/extractDiscriminantExpression.ts`

**Delegate implementations (9 files, Phases 2-9):**
6. `ast/delegate/VariableMutationProcessor.ts` (Phase 2a)
7. `ast/delegate/ArrayMutationProcessor.ts` (Phase 2b)
8. `ast/delegate/ObjectMutationProcessor.ts` (Phase 2c)
9. `ast/delegate/VariableTrackingProcessor.ts` (Phase 3)
10. `ast/delegate/ControlFlowProcessor.ts` (Phase 4)
11. `ast/delegate/CallExpressionProcessor.ts` (Phase 5)
12. `ast/delegate/ErrorTrackingProcessor.ts` (Phase 6)
13. `ast/delegate/ReturnExpressionParser.ts` (Phase 7)
14. `ast/delegate/VariableDeclarationProcessor.ts` (Phase 8)
15. `ast/delegate/SemanticIdGenerator.ts` (Phase 9)

**Phase 10 factories:**
16. `ast/delegate/CollectionFactory.ts`
17. `ast/delegate/VisitorComposer.ts`

**Modified files:**
- `JSASTAnalyzer.ts` (all phases) — shrink from 4,042 → ~750 lines
- `ast/utils/index.ts` (Phase 1) — add exports for new utils
- `ast/delegate/index.ts` (new file, Phase 3) — export all delegate implementations

## Line Count Progression

| Phase | Action | Lines Extracted | JSASTAnalyzer Size |
|-------|--------|-----------------|---------------------|
| Start | - | - | 4,042 |
| 1 | Extract utils | 161 | 3,881 |
| 2a | VariableMutationProcessor | 258 | 3,623 |
| 2b | ArrayMutationProcessor | 219 | 3,404 |
| 2c | ObjectMutationProcessor | 183 | 3,221 |
| 3 | VariableTrackingProcessor | 735 | 2,486 |
| 4 | ControlFlowProcessor | 382 | 2,104 |
| 5 | CallExpressionProcessor | 319 | 1,785 |
| 6 | ErrorTrackingProcessor | 254 | 1,531 |
| 7 | ReturnExpressionParser | 347 | 1,184 |
| 8 | VariableDeclarationProcessor | 181 | 1,003 |
| 9 | SemanticIdGenerator | 15 | 988 |
| 10 | analyzeModule cleanup | ~238 | ~750 |
| **Total** | | **~3,292** | **~750** |

## Risk Assessment

**Overall risk:** MEDIUM-LOW

**High-confidence phases (LOW risk):**
- Phase 1 (utils) — pure functions
- Phase 4 (control flow) — isolated logic
- Phase 6 (error tracking) — isolated logic
- Phase 9 (ID generation) — trivial methods
- Phase 10 (cleanup) — mechanical refactoring

**Medium-confidence phases (MEDIUM risk):**
- Phase 2a,b,c (mutation detection) — complex AST logic
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
- JSASTAnalyzer.ts ≤ 850 lines (target ~750, buffer 100)
- No method > 200 lines in JSASTAnalyzer (except analyzeModule orchestration which is ~150)
- All AnalyzerDelegate methods extracted to dedicated modules
- Clear separation: orchestration (JSASTAnalyzer) vs implementation (delegate/)

**Code quality:**
- Each extracted module has clear single responsibility
- Imports organized by category (types, utils, delegate)
- No circular dependencies
- Comments preserved from original code

## Estimated Effort

**Per phase:**
- Phase 1: ~30 minutes (extract + test + commit)
- Phase 2a,b,c: ~45 minutes each (complex AST logic)
- Phase 3: ~60 minutes (large extraction)
- Phase 4: ~45 minutes
- Phase 5: ~45 minutes
- Phase 6: ~30 minutes
- Phase 7: ~60 minutes (complex logic)
- Phase 8: ~45 minutes (dependencies)
- Phase 9: ~15 minutes (trivial)
- Phase 10: ~90 minutes (two refactorings: factories + visitor composer)

**Total:** 8-10 hours of focused work

**Critical path:** Sequential execution (can't parallelize, except Phase 2a/b/c can be done in any order)

## Alternative Considered: "Big Bang" Extraction

**Rejected.** Reasons:
- Too risky — hard to isolate failures
- Violates atomic commit principle
- If snapshot diverges, can't bisect which phase broke it
- Recovery cost too high

**Chosen approach:** Incremental, test-after-every-phase

## Notes

**Naming collision:** There's an existing `ast/IdGenerator.ts` (258 lines, generates node IDs like `FUNCTION#file#line`). The new semantic ID generator (Phase 9) is named `SemanticIdGenerator.ts` to avoid confusion.

**Circular dependency warning:** The delegate modules should NOT import handlers. Flow is:
```
JSASTAnalyzer → delegate → utils
       ↓
   handlers → (via AnalyzerDelegate) → JSASTAnalyzer → delegate
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

**Exception:** Phase 2a, 2b, 2c can be done in any order (no interdependencies).
