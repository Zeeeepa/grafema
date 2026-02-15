# Auto-Review: REG-460 Refactoring Plan

**Date:** 2026-02-15
**Reviewer:** Combined Auto-Review (Sonnet)

## Verdict: REJECT

**Vision & Architecture:** CRITICAL ISSUES
**Practical Quality:** SIGNIFICANT CONCERNS
**Code Quality:** NAMING ISSUES

---

## Vision & Architecture

### CRITICAL: Phase 2 Architecture Mismatch

**Issue:** Phase 2 proposes extending `MutationDetector` (a module-level static visitor) with function-body-level mutation methods.

**Current architecture:**
- `MutationDetector` is a **static class** with methods like `detectArrayMutation()` and `detectObjectAssign()`
- These are called from **module-level traversal** (line 1572-1575 in JSASTAnalyzer)
- The methods operate on `CallExpression` nodes found during module-level AST walk

**Phase 2 proposes adding:**
- `detectVariableReassignment()` — called from **function body** via VariableHandler
- `detectIndexedArrayAssignment()` — called from **function body** AND module level
- `detectObjectPropertyAssignment()` — called from **function body** AND module level
- `collectUpdateExpression()` — called from **function body** AND module level
- `detectArrayMutationInFunction()` — helper for function-body scope
- `detectObjectAssignInFunction()` — helper for function-body scope

**The conflict:**
1. Current `MutationDetector` methods are static and called during module traversal
2. New methods are instance methods on JSASTAnalyzer (they use `this.detectX()`)
3. New methods are called from handlers via `AnalyzerDelegate` interface (function-body context)
4. Mixing module-level static detection with function-body instance detection in the same class breaks cohesion

**Root cause:** The plan conflates two different concerns:
- Module-level mutation detection (static, called during traverse)
- Function-body mutation detection (instance, called from handlers via delegate)

**Correct architecture:**
- Keep existing `MutationDetector` static methods for module-level detection
- Phase 2 methods should go to a NEW `delegate-impl/MutationHandler.ts` (not MutationDetector extension)
- Or: convert MutationDetector to instance class and inject it in both contexts

**Recommendation:** STOP. Phase 2 approach is architecturally wrong.

### Directory Naming: `delegate-impl/`

**Concern:** The name `delegate-impl/` is unusual and doesn't match existing conventions.

**Existing patterns in codebase:**
- `ast/visitors/` — visitor classes
- `ast/handlers/` — handler classes that receive delegate
- `ast/utils/` — utility functions

**Alternative naming:**
- `ast/analyzers/` — follows "VariableAnalyzer", "ControlFlowAnalyzer" pattern
- `ast/processors/` — follows "CallExpressionProcessor" pattern (already in plan)
- `ast/delegate/` — shorter, clearer

**Why it matters:**
- "impl" suffix is typically for interface implementations in Java-style codebases
- Grafema doesn't use that pattern elsewhere
- Shorter names reduce import noise

**Recommendation:** Rename to `ast/delegate/` (simple, clear) or `ast/analyzers/` (matches existing naming).

---

## Practical Quality

### Concern 1: Phase 10 Line Count Estimates

**Plan claims:** analyzeModule will shrink from ~700 lines to ~128 lines.

**Actual current size:** Let me verify the analyzeModule structure.

**From code reading (lines 1310-1399+):**
- Collection declarations: ~89 lines (lines 1330-1398 visible, likely more)
- Counter ref initialization: ~13 lines (1386-1398)
- Plus visitor instantiation, traverse, second pass, GraphBuilder call, error handling

**Phase 10 proposes:**
- Extract collections to `CollectionFactory.createAnalysisCollections()` → saves ~89 lines
- Extract counter refs to `CollectionFactory.createCounterRefs()` → saves ~13 lines
- Extract visitor composition to `VisitorComposer.composeModuleVisitors()` → saves ~100 lines
- **Total savings claimed:** ~195 lines

**Math check:**
- Current analyzeModule: ~700 lines (estimated in plan)
- Minus Phase 10 extractions: 700 - 195 = 505 lines
- Plan claims result: ~128 lines
- **Gap:** 377 lines unaccounted for

**Question:** What are those 377 lines? Are they:
- Second pass logic (collectCatchesFromInfo traversal)?
- Error handling boilerplate?
- Comments and spacing?

**Risk:** If the plan underestimates what stays in analyzeModule, the final size could be 1,100+ lines instead of 800.

**Recommendation:** Before proceeding, accurately measure:
1. Current analyzeModule actual line count (find line range)
2. What portion is collections, counters, visitor setup, orchestration
3. Update Phase 10 estimates with real data

### Concern 2: Method Line Counts in Plan vs Reality

**Plan claims (Phase 4):**
- `handleSwitchStatement()`: 110 lines

**Actual grep result (line 2144):**
```
2134-   * Handles SwitchStatement nodes.
...
2144:  private handleSwitchStatement(
```

The method starts at line 2144. Let me estimate: if it's 110 lines, it ends around line 2254.

**Without seeing the full method, cannot verify.** But this is a **red flag pattern**: the plan uses "~" estimates for critical sizing decisions.

**Recommendation:** Before implementation, verify actual method sizes using:
```bash
# Get exact line ranges for each method
grep -n "private handleSwitchStatement" JSASTAnalyzer.ts
grep -n "private handleVariableDeclaration" JSASTAnalyzer.ts
# etc.
```

Then calculate exact sizes, update plan if discrepancies > 20%.

### Concern 3: Phase 2 Adding 6 Methods to MutationDetector

**Current MutationDetector:** ~212 lines (2 static methods)

**Phase 2 adds:** 625 lines (6 methods)

**Result:** MutationDetector grows to ~837 lines.

**Problem:** This violates the refactoring goal. We're splitting a 4,042-line file by creating a new 837-line file.

**Better approach:**
- Split mutation detection by TYPE, not by combining all mutations:
  - `VariableMutationDetector.ts` (~240 lines: detectVariableReassignment, collectUpdateExpression)
  - `ArrayMutationDetector.ts` (~194 lines: detectIndexedArrayAssignment, detectArrayMutationInFunction)
  - `ObjectMutationDetector.ts` (~168 lines: detectObjectPropertyAssignment, detectObjectAssignInFunction)
  - Keep existing `MutationDetector.ts` for module-level static detection

**Recommendation:** Phase 2 should create 3 files, not extend 1 file to 837 lines.

---

## Code Quality

### Naming Consistency

**Issue:** The plan mixes naming styles:
- `VariableTracker` (noun)
- `ControlFlowHandler` (noun)
- `CallExpressionProcessor` (noun)
- `ErrorTracker` (noun)
- `ReturnExpressionParser` (noun)
- `SemanticIdGenerator` (noun)

**But also:**
- `VariableDeclarationHandler` (noun, but different suffix than ControlFlowHandler)

**Why it matters:**
- Handler/Processor/Tracker/Parser are all similar roles
- Inconsistent naming makes the architecture harder to understand
- Is there a semantic difference between Handler and Processor?

**Existing codebase pattern (from imports):**
- `ast/handlers/` — classes that handle specific AST node types via delegate
- `ast/visitors/` — classes that traverse AST
- `ast/utils/` — pure functions

**Recommendation:**
- Use **Processor** suffix for classes that process delegate calls (not Handler, to avoid confusion with ast/handlers/)
- Use **Tracker** for stateful tracking
- Use **Parser** for expression parsing
- Use **Generator** for ID generation

**Proposed naming:**
- `VariableTrackingProcessor` (not VariableTracker — "Tracking" clarifies it tracks flow)
- `ControlFlowProcessor` (not ControlFlowHandler)
- `CallExpressionProcessor` ✓ (already good)
- `ErrorTrackingProcessor` (not ErrorTracker)
- `ReturnExpressionParser` ✓ (already good)
- `SemanticIdGenerator` ✓ (already good)
- `VariableDeclarationProcessor` (not Handler)

---

## Specific Recommendations

### Before proceeding with implementation:

1. **FIX Phase 2 architecture:**
   - Do NOT extend MutationDetector with function-body methods
   - Create separate files in `ast/delegate/`:
     - `VariableMutationProcessor.ts`
     - `ArrayMutationProcessor.ts`
     - `ObjectMutationProcessor.ts`
   - Keep existing `ast/visitors/MutationDetector.ts` unchanged

2. **Rename directory:**
   - Change `delegate-impl/` to `delegate/` (simpler, clearer)

3. **Verify analyzeModule size:**
   - Find exact line range of analyzeModule method
   - Calculate what stays after Phase 10 extractions
   - Update estimates

4. **Verify method sizes:**
   - Get exact line counts for all 18 methods to be extracted
   - Update plan if actual sizes differ by >20% from estimates

5. **Apply consistent naming:**
   - Use Processor suffix for delegate implementations
   - Update all file names in plan

6. **Split Phase 2:**
   - Phase 2a: VariableMutationProcessor (~240 lines)
   - Phase 2b: ArrayMutationProcessor (~194 lines)
   - Phase 2c: ObjectMutationProcessor (~168 lines)

### After fixes, the plan can proceed. But DO NOT implement Phase 2 as currently written.

---

## Summary of Issues

| Issue | Severity | Impact |
|-------|----------|--------|
| Phase 2 architecture (mixing module/function detection) | CRITICAL | Wrong abstractions, will create confusion |
| Directory naming (`delegate-impl/`) | MEDIUM | Code navigation, consistency |
| Phase 10 line count gap (377 lines) | HIGH | Target may be unrealistic |
| Phase 2 creates 837-line file | MEDIUM | Defeats refactoring purpose |
| Inconsistent naming (Handler/Processor/Tracker) | LOW | Code clarity |

**Next steps:**
1. User confirms architectural fix for Phase 2
2. Don updates plan with corrected architecture
3. Don verifies actual line counts
4. Re-run auto-review on updated plan
