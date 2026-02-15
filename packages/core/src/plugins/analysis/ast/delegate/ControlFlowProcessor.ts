/**
 * ControlFlowProcessor — handles switch/case control flow analysis.
 *
 * Mechanical extraction from JSASTAnalyzer.ts (REG-460 Phase 4).
 * Original methods: handleSwitchStatement(), extractCaseValue(),
 * caseTerminates(), blockTerminates().
 */
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { getLine } from '../utils/location.js';
import { computeSemanticId } from '../../../../core/SemanticId.js';
import { extractDiscriminantExpression } from '../utils/extractDiscriminantExpression.js';
import { memberExpressionToString } from '../utils/memberExpressionToString.js';
import type { ScopeTracker } from '../../../../core/ScopeTracker.js';
import type {
  BranchInfo,
  CaseInfo,
  CounterRef,
} from '../types.js';
import type { VisitorModule, VisitorCollections } from '../visitors/index.js';

export class ControlFlowProcessor {
  /**
   * Handles SwitchStatement nodes.
   * Creates BRANCH node for switch, CASE nodes for each case clause,
   * and EXPRESSION node for discriminant.
   *
   * @param switchPath - The NodePath for the SwitchStatement
   * @param parentScopeId - Parent scope ID
   * @param module - Module context
   * @param collections - AST collections
   * @param scopeTracker - Tracker for semantic ID generation
   */
  handleSwitchStatement(
    switchPath: NodePath<t.SwitchStatement>,
    parentScopeId: string,
    module: VisitorModule,
    collections: VisitorCollections,
    scopeTracker: ScopeTracker | undefined,
    controlFlowState?: { branchCount: number; caseCount: number }
  ): void {
    const switchNode = switchPath.node;

    // Phase 6 (REG-267): Count branch and non-default cases for cyclomatic complexity
    if (controlFlowState) {
      controlFlowState.branchCount++;  // switch itself is a branch
      // Count non-default cases
      for (const caseNode of switchNode.cases) {
        if (caseNode.test !== null) {  // Not default case
          controlFlowState.caseCount++;
        }
      }
    }

    // Initialize collections if not exist
    if (!collections.branches) {
      collections.branches = [];
    }
    if (!collections.cases) {
      collections.cases = [];
    }
    if (!collections.branchCounterRef) {
      collections.branchCounterRef = { value: 0 };
    }
    if (!collections.caseCounterRef) {
      collections.caseCounterRef = { value: 0 };
    }

    const branches = collections.branches as BranchInfo[];
    const cases = collections.cases as CaseInfo[];
    const branchCounterRef = collections.branchCounterRef as CounterRef;
    const caseCounterRef = collections.caseCounterRef as CounterRef;

    // Create BRANCH node
    const branchCounter = branchCounterRef.value++;
    const legacyBranchId = `${module.file}:BRANCH:switch:${getLine(switchNode)}:${branchCounter}`;
    const branchId = scopeTracker
      ? computeSemanticId('BRANCH', 'switch', scopeTracker.getContext(), { discriminator: branchCounter })
      : legacyBranchId;

    // Handle discriminant expression - store metadata directly (Linus improvement)
    let discriminantExpressionId: string | undefined;
    let discriminantExpressionType: string | undefined;
    let discriminantLine: number | undefined;
    let discriminantColumn: number | undefined;

    if (switchNode.discriminant) {
      const discResult = extractDiscriminantExpression(
        switchNode.discriminant,
        module
      );
      discriminantExpressionId = discResult.id;
      discriminantExpressionType = discResult.expressionType;
      discriminantLine = discResult.line;
      discriminantColumn = discResult.column;
    }

    branches.push({
      id: branchId,
      semanticId: branchId,
      type: 'BRANCH',
      branchType: 'switch',
      file: module.file,
      line: getLine(switchNode),
      parentScopeId,
      discriminantExpressionId,
      discriminantExpressionType,
      discriminantLine,
      discriminantColumn
    });

    // Process each case clause
    for (let i = 0; i < switchNode.cases.length; i++) {
      const caseNode = switchNode.cases[i];
      const isDefault = caseNode.test === null;
      const isEmpty = caseNode.consequent.length === 0;

      // Detect fall-through: no break/return/throw at end of consequent
      const fallsThrough = isEmpty || !this.caseTerminates(caseNode);

      // Extract case value
      const value = isDefault ? null : this.extractCaseValue(caseNode.test ?? null);

      const caseCounter = caseCounterRef.value++;
      const valueName = isDefault ? 'default' : String(value);
      const legacyCaseId = `${module.file}:CASE:${valueName}:${getLine(caseNode)}:${caseCounter}`;
      const caseId = scopeTracker
        ? computeSemanticId('CASE', valueName, scopeTracker.getContext(), { discriminator: caseCounter })
        : legacyCaseId;

      cases.push({
        id: caseId,
        semanticId: caseId,
        type: 'CASE',
        value,
        isDefault,
        fallsThrough,
        isEmpty,
        file: module.file,
        line: getLine(caseNode),
        parentBranchId: branchId
      });
    }
  }

  /**
   * Extract case test value as a primitive
   */
  private extractCaseValue(test: t.Expression | null): unknown {
    if (!test) return null;

    if (t.isStringLiteral(test)) {
      return test.value;
    } else if (t.isNumericLiteral(test)) {
      return test.value;
    } else if (t.isBooleanLiteral(test)) {
      return test.value;
    } else if (t.isNullLiteral(test)) {
      return null;
    } else if (t.isIdentifier(test)) {
      // Constant reference: case CONSTANTS.ADD
      return test.name;
    } else if (t.isMemberExpression(test)) {
      // Member expression: case Action.ADD
      return memberExpressionToString(test);
    }

    return '<complex>';
  }

  /**
   * Check if case clause terminates (has break, return, throw)
   */
  private caseTerminates(caseNode: t.SwitchCase): boolean {
    const statements = caseNode.consequent;
    if (statements.length === 0) return false;

    // Check last statement (or any statement for early returns)
    for (const stmt of statements) {
      if (t.isBreakStatement(stmt)) return true;
      if (t.isReturnStatement(stmt)) return true;
      if (t.isThrowStatement(stmt)) return true;
      if (t.isContinueStatement(stmt)) return true;  // In switch inside loop

      // Check for nested blocks (if last statement is block, check inside)
      if (t.isBlockStatement(stmt)) {
        const lastInBlock = stmt.body[stmt.body.length - 1];
        if (lastInBlock && (
          t.isBreakStatement(lastInBlock) ||
          t.isReturnStatement(lastInBlock) ||
          t.isThrowStatement(lastInBlock)
        )) {
          return true;
        }
      }

      // Check for if-else where both branches terminate
      if (t.isIfStatement(stmt) && stmt.alternate) {
        const ifTerminates = this.blockTerminates(stmt.consequent);
        const elseTerminates = this.blockTerminates(stmt.alternate);
        if (ifTerminates && elseTerminates) return true;
      }
    }

    return false;
  }

  /**
   * Check if a block/statement terminates
   */
  private blockTerminates(node: t.Statement): boolean {
    if (t.isBreakStatement(node)) return true;
    if (t.isReturnStatement(node)) return true;
    if (t.isThrowStatement(node)) return true;
    if (t.isBlockStatement(node)) {
      const last = node.body[node.body.length - 1];
      return last ? this.blockTerminates(last) : false;
    }
    return false;
  }
}
