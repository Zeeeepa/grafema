/**
 * VariableDeclarationProcessor -- handles VariableDeclaration nodes inside function bodies.
 *
 * Mechanical extraction from JSASTAnalyzer.ts (REG-460 Phase 8).
 * Original method: handleVariableDeclaration().
 *
 * Extracts variable names from patterns (including destructuring), determines
 * if the variable should be CONSTANT or VARIABLE, generates semantic or legacy IDs,
 * and tracks class instantiations and variable assignments.
 */
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { ExpressionEvaluator } from '../ExpressionEvaluator.js';
import { computeSemanticId } from '../../../../core/SemanticId.js';
import { extractNamesFromPattern } from '../utils/extractNamesFromPattern.js';
import type { ScopeTracker } from '../../../../core/ScopeTracker.js';
import type {
  VariableDeclarationInfo,
  ClassInstantiationInfo,
  LiteralInfo,
  VariableAssignmentInfo,
  CounterRef,
  ObjectLiteralInfo,
  ObjectPropertyInfo,
  ExtractedVariable,
} from '../types.js';
import type { VisitorModule } from '../visitors/index.js';
import type { VariableTrackingProcessor } from './VariableTrackingProcessor.js';

export class VariableDeclarationProcessor {
  constructor(
    private readonly variableTrackingProcessor: VariableTrackingProcessor,
  ) {}

  /**
   * Handle VariableDeclaration nodes within function bodies.
   *
   * Extracts variable names from patterns (including destructuring), determines
   * if the variable should be CONSTANT or VARIABLE, generates semantic or legacy IDs,
   * and tracks class instantiations and variable assignments.
   *
   * @param varPath - The NodePath for the VariableDeclaration
   * @param parentScopeId - Parent scope ID for the variable
   * @param module - Module context with file info
   * @param variableDeclarations - Collection to push variable declarations to
   * @param classInstantiations - Collection to push class instantiations to
   * @param literals - Collection for literal tracking
   * @param variableAssignments - Collection for variable assignment tracking
   * @param varDeclCounterRef - Counter for unique variable declaration IDs
   * @param literalCounterRef - Counter for unique literal IDs
   * @param scopeTracker - Tracker for semantic ID generation
   * @param parentScopeVariables - Set to track variables for closure analysis
   * @param objectLiterals - Collection for object literal nodes (REG-328)
   * @param objectProperties - Collection for object property edges (REG-328)
   * @param objectLiteralCounterRef - Counter for unique object literal IDs (REG-328)
   */
  handleVariableDeclaration(
    varPath: NodePath<t.VariableDeclaration>,
    parentScopeId: string,
    module: VisitorModule,
    variableDeclarations: VariableDeclarationInfo[],
    classInstantiations: ClassInstantiationInfo[],
    literals: LiteralInfo[],
    variableAssignments: VariableAssignmentInfo[],
    varDeclCounterRef: CounterRef,
    literalCounterRef: CounterRef,
    scopeTracker: ScopeTracker | undefined,
    parentScopeVariables: Set<{ name: string; id: string; scopeId: string }>,
    objectLiterals: ObjectLiteralInfo[],
    objectProperties: ObjectPropertyInfo[],
    objectLiteralCounterRef: CounterRef
  ): void {
    const varNode = varPath.node;
    const isConst = varNode.kind === 'const';

    // Check if this is a loop variable (for...of or for...in)
    const parent = varPath.parent;
    const isLoopVariable = (t.isForOfStatement(parent) || t.isForInStatement(parent)) && parent.left === varNode;

    varNode.declarations.forEach(declarator => {
      const variables = extractNamesFromPattern(declarator.id);
      const variablesWithIds: Array<ExtractedVariable & { id: string }> = [];

      variables.forEach(varInfo => {
        const literalValue = declarator.init ? ExpressionEvaluator.extractLiteralValue(declarator.init) : null;
        const isLiteral = literalValue !== null;
        const isNewExpression = declarator.init && declarator.init.type === 'NewExpression';

        // Loop variables with const should be CONSTANT (they can't be reassigned in loop body)
        // Regular variables with const are CONSTANT only if initialized with literal or new expression
        const shouldBeConstant = isConst && (isLoopVariable || isLiteral || isNewExpression);
        const nodeType = shouldBeConstant ? 'CONSTANT' : 'VARIABLE';

        // Generate semantic ID (primary) or legacy ID (fallback)
        const legacyId = `${nodeType}#${varInfo.name}#${module.file}#${varInfo.loc.start.line}:${varInfo.loc.start.column}:${varDeclCounterRef.value++}`;

        const varId = scopeTracker
          ? computeSemanticId(nodeType, varInfo.name, scopeTracker.getContext())
          : legacyId;

        // Collect variable info with ID for destructuring tracking
        variablesWithIds.push({ ...varInfo, id: varId });

        parentScopeVariables.add({
          name: varInfo.name,
          id: varId,
          scopeId: parentScopeId
        });

        if (shouldBeConstant) {
          const constantData: VariableDeclarationInfo = {
            id: varId,
            type: 'CONSTANT',
            name: varInfo.name,
            file: module.file,
            line: varInfo.loc.start.line,
            parentScopeId
          };

          if (isLiteral) {
            constantData.value = literalValue;
          }

          variableDeclarations.push(constantData);

          const init = declarator.init;
          if (isNewExpression && t.isNewExpression(init) && t.isIdentifier(init.callee)) {
            const className = init.callee.name;
            classInstantiations.push({
              variableId: varId,
              variableName: varInfo.name,
              className: className,
              line: varInfo.loc.start.line,
              parentScopeId
            });
          }
        } else {
          variableDeclarations.push({
            id: varId,
            type: 'VARIABLE',
            name: varInfo.name,
            file: module.file,
            line: varInfo.loc.start.line,
            parentScopeId
          });
        }
      });

      // Track assignments after all variables are created
      if (isLoopVariable) {
        // For loop variables, track assignment from the source collection (right side of for...of/for...in)
        const loopParent = parent as t.ForOfStatement | t.ForInStatement;
        const sourceExpression = loopParent.right;

        if (t.isObjectPattern(declarator.id) || t.isArrayPattern(declarator.id)) {
          // Destructuring in loop: track each variable separately
          this.variableTrackingProcessor.trackDestructuringAssignment(
            declarator.id,
            sourceExpression,
            variablesWithIds,
            module,
            variableAssignments
          );
        } else {
          // Simple loop variable: create DERIVES_FROM edges (not ASSIGNED_FROM)
          // Loop variables derive their values from the collection (semantic difference)
          variablesWithIds.forEach(varInfo => {
            if (t.isIdentifier(sourceExpression)) {
              variableAssignments.push({
                variableId: varInfo.id,
                sourceType: 'DERIVES_FROM_VARIABLE',
                sourceName: sourceExpression.name,
                file: module.file,
                line: varInfo.loc.start.line
              });
            } else {
              // Fallback to regular tracking for non-identifier expressions
              this.variableTrackingProcessor.trackVariableAssignment(
                sourceExpression,
                varInfo.id,
                varInfo.name,
                module,
                varInfo.loc.start.line,
                literals,
                variableAssignments,
                literalCounterRef,
                objectLiterals,
                objectProperties,
                objectLiteralCounterRef
              );
            }
          });
        }
      } else if (declarator.init) {
        // Regular variable declaration with initializer
        if (t.isObjectPattern(declarator.id) || t.isArrayPattern(declarator.id)) {
          // Destructuring: use specialized tracking
          this.variableTrackingProcessor.trackDestructuringAssignment(
            declarator.id,
            declarator.init,
            variablesWithIds,
            module,
            variableAssignments
          );
        } else {
          // Simple assignment: use existing tracking
          const varInfo = variablesWithIds[0];
          this.variableTrackingProcessor.trackVariableAssignment(
            declarator.init,
            varInfo.id,
            varInfo.name,
            module,
            varInfo.loc.start.line,
            literals,
            variableAssignments,
            literalCounterRef,
            objectLiterals,
            objectProperties,
            objectLiteralCounterRef
          );
        }
      }
    });
  }
}
