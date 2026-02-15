# REG-460: Refactor JSASTAnalyzer.ts (4,042 → ~800 lines)

## Goal

Reduce JSASTAnalyzer.ts from 4,042 lines to ~800 lines (orchestrator-only).

## Current State

* 4,042 lines, 8x over Uncle Bob's 500-line limit
* ~30 private methods, largest: handleCallExpression (221 lines, 13 params)
* 70 `.push()` calls, 39 manual ID constructions
* Infrastructure already exists: visitors (15), handlers (13), builders (12), IdGenerator

## Approach

Follow proven patterns from GraphBuilder (2,921→528), ReactAnalyzer (1,368→323), CallExpressionVisitor (1,363→496).

Extract to dedicated modules:

1. **ast/extractors/**: handleCallExpression, extractReturnExpressionInfo, handleVariableDeclaration (~600 lines)
2. **ast/mutation-detection/**: detectArrayMutation, detectObjectAssign, detectVariableReassignment, collectUpdateExpression (~500 lines)
3. **ast/utils/**: SwitchStatementAnalyzer, CatchesFromCollector, expression-helpers (~670 lines)
4. **ID generation**: migrate to IdGenerator (~60 lines)
5. **Builder pattern**: node builders to eliminate .push() boilerplate (~200 lines)
6. **Final polish**: inline small methods, consolidate imports (~200-400 lines)

## Risk

No direct unit tests — need snapshot tests before refactoring.

## Acceptance Criteria

* JSASTAnalyzer.ts < 1,000 lines (orchestration only)
* All existing tests pass
* Graph output identical before/after (snapshot verification)
* No new public API changes

## Source

Linear issue: https://linear.app/reginaflow/issue/REG-460/refactor-jsastanalyzerts-4042-800-lines
Priority: High
Labels: v0.2, Improvement
