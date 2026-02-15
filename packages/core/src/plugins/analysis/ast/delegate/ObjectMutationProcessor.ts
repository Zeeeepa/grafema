/**
 * ObjectMutationProcessor — handles object property assignment and Object.assign() detection.
 *
 * Mechanical extraction from JSASTAnalyzer.ts (REG-460 Phase 2c).
 * Original methods: detectObjectPropertyAssignment(), detectObjectAssignInFunction(),
 *   extractMutationValue().
 */
import type * as t from '@babel/types';
import { ExpressionEvaluator } from '../ExpressionEvaluator.js';
import { computeSemanticId } from '../../../../core/SemanticId.js';
import type { ScopeTracker } from '../../../../core/ScopeTracker.js';
import type {
  ObjectMutationInfo,
  ObjectMutationValue,
} from '../types.js';
import type { VisitorModule } from '../visitors/index.js';

export class ObjectMutationProcessor {
  /**
   * Detect object property assignment: obj.prop = value, obj['prop'] = value
   * Creates ObjectMutationInfo for FLOWS_INTO edge generation in GraphBuilder
   *
   * @param assignNode - The assignment expression node
   * @param module - Current module being analyzed
   * @param objectMutations - Collection to push mutation info into
   * @param scopeTracker - Optional scope tracker for semantic IDs
   */
  detectObjectPropertyAssignment(
    assignNode: t.AssignmentExpression,
    module: VisitorModule,
    objectMutations: ObjectMutationInfo[],
    scopeTracker?: ScopeTracker
  ): void {
    // Check for property assignment: obj.prop = value or obj['prop'] = value
    if (assignNode.left.type !== 'MemberExpression') return;

    const memberExpr = assignNode.left;

    // Skip NumericLiteral indexed assignment (handled by array mutation handler)
    // Array mutation handler processes: arr[0] (numeric literal index)
    // Object mutation handler processes: obj.prop, obj['prop'], obj[key], obj[expr]
    if (memberExpr.computed && memberExpr.property.type === 'NumericLiteral') {
      return; // Let array mutation handler deal with this
    }

    // Get object name and enclosing class context for 'this'
    let objectName: string;
    let enclosingClassName: string | undefined;

    if (memberExpr.object.type === 'Identifier') {
      objectName = memberExpr.object.name;
    } else if (memberExpr.object.type === 'ThisExpression') {
      objectName = 'this';
      // REG-152: Extract enclosing class name from scope context
      if (scopeTracker) {
        enclosingClassName = scopeTracker.getEnclosingScope('CLASS');
      }
    } else {
      // Complex expressions like obj.nested.prop = value
      // For now, skip these (documented limitation)
      return;
    }

    // Get property name
    let propertyName: string;
    let mutationType: 'property' | 'computed';
    let computedPropertyVar: string | undefined;

    if (!memberExpr.computed) {
      // obj.prop
      if (memberExpr.property.type === 'Identifier') {
        propertyName = memberExpr.property.name;
        mutationType = 'property';
      } else {
        return; // Unexpected property type
      }
    } else {
      // obj['prop'] or obj[key]
      if (memberExpr.property.type === 'StringLiteral') {
        propertyName = memberExpr.property.value;
        mutationType = 'property'; // String literal is effectively a property name
      } else {
        propertyName = '<computed>';
        mutationType = 'computed';
        // Capture variable name for later resolution in enrichment phase
        if (memberExpr.property.type === 'Identifier') {
          computedPropertyVar = memberExpr.property.name;
        }
      }
    }

    // Extract value info
    const value = assignNode.right;
    const valueInfo = this.extractMutationValue(value);

    // Use defensive loc checks
    const line = assignNode.loc?.start.line ?? 0;
    const column = assignNode.loc?.start.column ?? 0;

    // Capture scope path for scope-aware lookup (REG-309)
    const scopePath = scopeTracker?.getContext().scopePath ?? [];

    // Generate semantic ID if scopeTracker available
    let mutationId: string | undefined;
    if (scopeTracker) {
      const discriminator = scopeTracker.getItemCounter(`OBJECT_MUTATION:${objectName}.${propertyName}`);
      mutationId = computeSemanticId('OBJECT_MUTATION', `${objectName}.${propertyName}`, scopeTracker.getContext(), { discriminator });
    }

    objectMutations.push({
      id: mutationId,
      objectName,
      mutationScopePath: scopePath,
      enclosingClassName,  // REG-152: Class name for 'this' mutations
      propertyName,
      mutationType,
      computedPropertyVar,
      file: module.file,
      line,
      column,
      value: valueInfo
    });
  }

  /**
   * Detect Object.assign() calls inside functions
   * Creates ObjectMutationInfo for FLOWS_INTO edge generation in GraphBuilder
   */
  detectObjectAssignInFunction(
    callNode: t.CallExpression,
    module: VisitorModule,
    objectMutations: ObjectMutationInfo[],
    scopeTracker?: ScopeTracker
  ): void {
    // Need at least 2 arguments: target and at least one source
    if (callNode.arguments.length < 2) return;

    // First argument is target
    const targetArg = callNode.arguments[0];
    let targetName: string;

    if (targetArg.type === 'Identifier') {
      targetName = targetArg.name;
    } else if (targetArg.type === 'ObjectExpression') {
      targetName = '<anonymous>';
    } else {
      return;
    }

    const line = callNode.loc?.start.line ?? 0;
    const column = callNode.loc?.start.column ?? 0;

    for (let i = 1; i < callNode.arguments.length; i++) {
      let arg = callNode.arguments[i];
      let isSpread = false;

      if (arg.type === 'SpreadElement') {
        isSpread = true;
        arg = arg.argument;
      }

      const valueInfo: ObjectMutationValue = {
        valueType: 'EXPRESSION',
        argIndex: i - 1,
        isSpread
      };

      const literalValue = ExpressionEvaluator.extractLiteralValue(arg);
      if (literalValue !== null) {
        valueInfo.valueType = 'LITERAL';
        valueInfo.literalValue = literalValue;
      } else if (arg.type === 'Identifier') {
        valueInfo.valueType = 'VARIABLE';
        valueInfo.valueName = arg.name;
      } else if (arg.type === 'ObjectExpression') {
        valueInfo.valueType = 'OBJECT_LITERAL';
      } else if (arg.type === 'ArrayExpression') {
        valueInfo.valueType = 'ARRAY_LITERAL';
      } else if (arg.type === 'CallExpression') {
        valueInfo.valueType = 'CALL';
        valueInfo.callLine = arg.loc?.start.line;
        valueInfo.callColumn = arg.loc?.start.column;
      }

      let mutationId: string | undefined;
      if (scopeTracker) {
        const discriminator = scopeTracker.getItemCounter(`OBJECT_MUTATION:Object.assign:${targetName}`);
        mutationId = computeSemanticId('OBJECT_MUTATION', `Object.assign:${targetName}`, scopeTracker.getContext(), { discriminator });
      }

      objectMutations.push({
        id: mutationId,
        objectName: targetName,
        propertyName: '<assign>',
        mutationType: 'assign',
        file: module.file,
        line,
        column,
        value: valueInfo
      });
    }
  }

  /**
   * Extract value information from an expression for mutation tracking
   */
  private extractMutationValue(value: t.Expression): ObjectMutationValue {
    const valueInfo: ObjectMutationValue = {
      valueType: 'EXPRESSION'  // Default
    };

    const literalValue = ExpressionEvaluator.extractLiteralValue(value);
    if (literalValue !== null) {
      valueInfo.valueType = 'LITERAL';
      valueInfo.literalValue = literalValue;
    } else if (value.type === 'Identifier') {
      valueInfo.valueType = 'VARIABLE';
      valueInfo.valueName = value.name;
    } else if (value.type === 'ObjectExpression') {
      valueInfo.valueType = 'OBJECT_LITERAL';
    } else if (value.type === 'ArrayExpression') {
      valueInfo.valueType = 'ARRAY_LITERAL';
    } else if (value.type === 'CallExpression') {
      valueInfo.valueType = 'CALL';
      valueInfo.callLine = value.loc?.start.line;
      valueInfo.callColumn = value.loc?.start.column;
    }

    return valueInfo;
  }
}
