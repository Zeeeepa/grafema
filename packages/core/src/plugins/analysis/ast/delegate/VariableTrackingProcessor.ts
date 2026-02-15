/**
 * VariableTrackingProcessor — handles variable assignment tracking for data flow analysis.
 *
 * Mechanical extraction from JSASTAnalyzer.ts (REG-460 Phase 3).
 * Original methods: trackVariableAssignment(), trackDestructuringAssignment(),
 * extractObjectProperties(), isCallOrAwaitExpression().
 */
import * as t from '@babel/types';
import { ExpressionEvaluator } from '../ExpressionEvaluator.js';
import { ExpressionNode } from '../../../../core/nodes/ExpressionNode.js';
import { ObjectLiteralNode } from '../../../../core/nodes/ObjectLiteralNode.js';
import { getLine, getColumn } from '../utils/location.js';
import { unwrapAwaitExpression } from '../utils/unwrapAwaitExpression.js';
import { extractCallInfo } from '../utils/extractCallInfo.js';
import type {
  LiteralInfo,
  VariableAssignmentInfo,
  CounterRef,
  ObjectLiteralInfo,
  ObjectPropertyInfo,
  ExtractedVariable,
} from '../types.js';
import type { VisitorModule } from '../visitors/index.js';

export class VariableTrackingProcessor {
  /**
   * Отслеживает присваивание переменной для data flow анализа
   */
  trackVariableAssignment(
    initNode: t.Expression | null | undefined,
    variableId: string,
    variableName: string,
    module: VisitorModule,
    line: number,
    literals: LiteralInfo[],
    variableAssignments: VariableAssignmentInfo[],
    literalCounterRef: CounterRef,
    objectLiterals: ObjectLiteralInfo[],
    objectProperties: ObjectPropertyInfo[],
    objectLiteralCounterRef: CounterRef
  ): void {
    if (!initNode) return;
    // initNode is already typed as t.Expression
    const initExpression = initNode;

    // 0. AwaitExpression
    if (initExpression.type === 'AwaitExpression') {
      return this.trackVariableAssignment(initExpression.argument, variableId, variableName, module, line, literals, variableAssignments, literalCounterRef, objectLiterals, objectProperties, objectLiteralCounterRef);
    }

    // 0.5. ObjectExpression (REG-328) - must be before literal check
    if (initExpression.type === 'ObjectExpression') {
      const column = initExpression.loc?.start.column ?? 0;
      const objectNode = ObjectLiteralNode.create(
        module.file,
        line,
        column,
        { counter: objectLiteralCounterRef.value++ }
      );

      // Add to objectLiterals collection for GraphBuilder to create the node
      objectLiterals.push(objectNode as unknown as ObjectLiteralInfo);

      // Extract properties from the object literal
      this.extractObjectProperties(
        initExpression,
        objectNode.id,
        module,
        objectProperties,
        objectLiterals,
        objectLiteralCounterRef,
        literals,
        literalCounterRef
      );

      // Create ASSIGNED_FROM edge: VARIABLE -> OBJECT_LITERAL
      variableAssignments.push({
        variableId,
        sourceId: objectNode.id,
        sourceType: 'OBJECT_LITERAL'
      });
      return;
    }

    // 1. Literal
    const literalValue = ExpressionEvaluator.extractLiteralValue(initExpression);
    if (literalValue !== null) {
      const literalId = `LITERAL#${line}:${initExpression.start}#${module.file}`;
      literals.push({
        id: literalId,
        type: 'LITERAL',
        value: literalValue,
        valueType: typeof literalValue,
        file: module.file,
        line: line
      });

      variableAssignments.push({
        variableId,
        sourceId: literalId,
        sourceType: 'LITERAL'
      });
      return;
    }

    // 2. CallExpression with Identifier
    if (initExpression.type === 'CallExpression' && initExpression.callee.type === 'Identifier') {
      variableAssignments.push({
        variableId,
        sourceId: null,
        sourceType: 'CALL_SITE',
        callName: initExpression.callee.name,
        callLine: getLine(initExpression),
        callColumn: getColumn(initExpression)
      });
      return;
    }

    // 3. MemberExpression call (e.g., arr.map())
    // Uses coordinate-based lookup to reference the standard CALL node created by CallExpressionVisitor
    if (initExpression.type === 'CallExpression' && initExpression.callee.type === 'MemberExpression') {
      variableAssignments.push({
        variableId,
        sourceType: 'METHOD_CALL',
        sourceLine: getLine(initExpression),
        sourceColumn: getColumn(initExpression),
        sourceFile: module.file,
        line: line
      });
      return;
    }

    // 4. Identifier
    if (initExpression.type === 'Identifier') {
      variableAssignments.push({
        variableId,
        sourceType: 'VARIABLE',
        sourceName: initExpression.name,
        line: line
      });
      return;
    }

    // 5. NewExpression -> CONSTRUCTOR_CALL
    if (initExpression.type === 'NewExpression') {
      const callee = initExpression.callee;
      let className: string;

      if (callee.type === 'Identifier') {
        className = callee.name;
      } else if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
        // Handle: new module.ClassName()
        className = callee.property.name;
      } else {
        // Unknown callee type, skip
        return;
      }

      const callLine = initExpression.loc?.start.line ?? line;
      const callColumn = initExpression.loc?.start.column ?? 0;

      variableAssignments.push({
        variableId,
        sourceType: 'CONSTRUCTOR_CALL',
        className,
        file: module.file,
        line: callLine,
        column: callColumn
      });
      return;
    }

    // 6. ArrowFunctionExpression or FunctionExpression
    if (initExpression.type === 'ArrowFunctionExpression' || initExpression.type === 'FunctionExpression') {
      variableAssignments.push({
        variableId,
        sourceType: 'FUNCTION',
        functionName: variableName,
        line: line
      });
      return;
    }

    // 7. MemberExpression (без вызова)
    if (initExpression.type === 'MemberExpression') {
      const objectName = initExpression.object.type === 'Identifier'
        ? initExpression.object.name
        : '<complex>';
      const propertyName = initExpression.computed
        ? '<computed>'
        : (initExpression.property.type === 'Identifier' ? initExpression.property.name : '<unknown>');

      const computedPropertyVar = initExpression.computed && initExpression.property.type === 'Identifier'
        ? initExpression.property.name
        : null;

      const column = initExpression.start ?? 0;
      const expressionId = ExpressionNode.generateId('MemberExpression', module.file, line, column);

      variableAssignments.push({
        variableId,
        sourceType: 'EXPRESSION',
        sourceId: expressionId,
        expressionType: 'MemberExpression',
        object: objectName,
        property: propertyName,
        computed: initExpression.computed,
        computedPropertyVar,
        objectSourceName: initExpression.object.type === 'Identifier' ? initExpression.object.name : null,
        file: module.file,
        line: line,
        column: column
      });
      return;
    }

    // 8. BinaryExpression
    if (initExpression.type === 'BinaryExpression') {
      const column = initExpression.start ?? 0;
      const expressionId = ExpressionNode.generateId('BinaryExpression', module.file, line, column);

      variableAssignments.push({
        variableId,
        sourceType: 'EXPRESSION',
        sourceId: expressionId,
        expressionType: 'BinaryExpression',
        operator: initExpression.operator,
        leftSourceName: initExpression.left.type === 'Identifier' ? initExpression.left.name : null,
        rightSourceName: initExpression.right.type === 'Identifier' ? initExpression.right.name : null,
        file: module.file,
        line: line,
        column: column
      });
      return;
    }

    // 9. ConditionalExpression
    if (initExpression.type === 'ConditionalExpression') {
      const column = initExpression.start ?? 0;
      const expressionId = ExpressionNode.generateId('ConditionalExpression', module.file, line, column);

      variableAssignments.push({
        variableId,
        sourceType: 'EXPRESSION',
        sourceId: expressionId,
        expressionType: 'ConditionalExpression',
        consequentSourceName: initExpression.consequent.type === 'Identifier' ? initExpression.consequent.name : null,
        alternateSourceName: initExpression.alternate.type === 'Identifier' ? initExpression.alternate.name : null,
        file: module.file,
        line: line,
        column: column
      });

      this.trackVariableAssignment(initExpression.consequent, variableId, variableName, module, line, literals, variableAssignments, literalCounterRef, objectLiterals, objectProperties, objectLiteralCounterRef);
      this.trackVariableAssignment(initExpression.alternate, variableId, variableName, module, line, literals, variableAssignments, literalCounterRef, objectLiterals, objectProperties, objectLiteralCounterRef);
      return;
    }

    // 10. LogicalExpression
    if (initExpression.type === 'LogicalExpression') {
      const column = initExpression.start ?? 0;
      const expressionId = ExpressionNode.generateId('LogicalExpression', module.file, line, column);

      variableAssignments.push({
        variableId,
        sourceType: 'EXPRESSION',
        sourceId: expressionId,
        expressionType: 'LogicalExpression',
        operator: initExpression.operator,
        leftSourceName: initExpression.left.type === 'Identifier' ? initExpression.left.name : null,
        rightSourceName: initExpression.right.type === 'Identifier' ? initExpression.right.name : null,
        file: module.file,
        line: line,
        column: column
      });

      this.trackVariableAssignment(initExpression.left, variableId, variableName, module, line, literals, variableAssignments, literalCounterRef, objectLiterals, objectProperties, objectLiteralCounterRef);
      this.trackVariableAssignment(initExpression.right, variableId, variableName, module, line, literals, variableAssignments, literalCounterRef, objectLiterals, objectProperties, objectLiteralCounterRef);
      return;
    }

    // 11. TemplateLiteral
    if (initExpression.type === 'TemplateLiteral' && initExpression.expressions.length > 0) {
      const column = initExpression.start ?? 0;
      const expressionId = ExpressionNode.generateId('TemplateLiteral', module.file, line, column);

      const expressionSourceNames = initExpression.expressions
        .filter((expr): expr is t.Identifier => expr.type === 'Identifier')
        .map(expr => expr.name);

      variableAssignments.push({
        variableId,
        sourceType: 'EXPRESSION',
        sourceId: expressionId,
        expressionType: 'TemplateLiteral',
        expressionSourceNames,
        file: module.file,
        line: line,
        column: column
      });

      for (const expr of initExpression.expressions) {
        // Filter out TSType nodes (only in TypeScript code)
        if (t.isExpression(expr)) {
          this.trackVariableAssignment(expr, variableId, variableName, module, line, literals, variableAssignments, literalCounterRef, objectLiterals, objectProperties, objectLiteralCounterRef);
        }
      }
      return;
    }
  }

  /**
   * Extract object properties and create ObjectPropertyInfo records.
   * Handles nested object/array literals recursively. (REG-328)
   */
  extractObjectProperties(
    objectExpr: t.ObjectExpression,
    objectId: string,
    module: VisitorModule,
    objectProperties: ObjectPropertyInfo[],
    objectLiterals: ObjectLiteralInfo[],
    objectLiteralCounterRef: CounterRef,
    literals: LiteralInfo[],
    literalCounterRef: CounterRef
  ): void {
    for (const prop of objectExpr.properties) {
      const propLine = prop.loc?.start.line || 0;
      const propColumn = prop.loc?.start.column || 0;

      // Handle spread properties: { ...other }
      if (prop.type === 'SpreadElement') {
        const spreadArg = prop.argument;
        const propertyInfo: ObjectPropertyInfo = {
          objectId,
          propertyName: '<spread>',
          valueType: 'SPREAD',
          file: module.file,
          line: propLine,
          column: propColumn
        };

        if (spreadArg.type === 'Identifier') {
          propertyInfo.valueName = spreadArg.name;
          propertyInfo.valueType = 'VARIABLE';
        }

        objectProperties.push(propertyInfo);
        continue;
      }

      // Handle regular properties
      if (prop.type === 'ObjectProperty') {
        let propertyName: string;

        // Get property name
        if (prop.key.type === 'Identifier') {
          propertyName = prop.key.name;
        } else if (prop.key.type === 'StringLiteral') {
          propertyName = prop.key.value;
        } else if (prop.key.type === 'NumericLiteral') {
          propertyName = String(prop.key.value);
        } else {
          propertyName = '<computed>';
        }

        const propertyInfo: ObjectPropertyInfo = {
          objectId,
          propertyName,
          file: module.file,
          line: propLine,
          column: propColumn,
          valueType: 'EXPRESSION'
        };

        const value = prop.value;

        // Nested object literal - check BEFORE extractLiteralValue
        if (value.type === 'ObjectExpression') {
          const nestedObjectNode = ObjectLiteralNode.create(
            module.file,
            value.loc?.start.line || 0,
            value.loc?.start.column || 0,
            { counter: objectLiteralCounterRef.value++ }
          );
          objectLiterals.push(nestedObjectNode as unknown as ObjectLiteralInfo);
          const nestedObjectId = nestedObjectNode.id;

          // Recursively extract nested properties
          this.extractObjectProperties(
            value,
            nestedObjectId,
            module,
            objectProperties,
            objectLiterals,
            objectLiteralCounterRef,
            literals,
            literalCounterRef
          );

          propertyInfo.valueType = 'OBJECT_LITERAL';
          propertyInfo.nestedObjectId = nestedObjectId;
          propertyInfo.valueNodeId = nestedObjectId;
        }
        // Literal value (primitives only - objects/arrays handled above)
        else {
          const literalValue = ExpressionEvaluator.extractLiteralValue(value);
          // Handle both non-null literals AND explicit null literals (NullLiteral)
          if (literalValue !== null || value.type === 'NullLiteral') {
            const literalId = `LITERAL#${propertyName}#${module.file}#${propLine}:${propColumn}:${literalCounterRef.value++}`;
            literals.push({
              id: literalId,
              type: 'LITERAL',
              value: literalValue,
              valueType: typeof literalValue,
              file: module.file,
              line: propLine,
              column: propColumn,
              parentCallId: objectId,
              argIndex: 0
            });
            propertyInfo.valueType = 'LITERAL';
            propertyInfo.valueNodeId = literalId;
            propertyInfo.literalValue = literalValue;
          }
          // Variable reference
          else if (value.type === 'Identifier') {
            propertyInfo.valueType = 'VARIABLE';
            propertyInfo.valueName = value.name;
          }
          // Call expression
          else if (value.type === 'CallExpression') {
            propertyInfo.valueType = 'CALL';
            propertyInfo.callLine = value.loc?.start.line;
            propertyInfo.callColumn = value.loc?.start.column;
          }
          // Other expressions
          else {
            propertyInfo.valueType = 'EXPRESSION';
          }
        }

        objectProperties.push(propertyInfo);
      }
      // Handle object methods: { foo() {} }
      else if (prop.type === 'ObjectMethod') {
        const propertyName = prop.key.type === 'Identifier' ? prop.key.name : '<computed>';
        objectProperties.push({
          objectId,
          propertyName,
          valueType: 'EXPRESSION',
          file: module.file,
          line: propLine,
          column: propColumn
        });
      }
    }
  }

  /**
   * Check if expression is CallExpression or AwaitExpression wrapping a call.
   */
  private isCallOrAwaitExpression(node: t.Expression): boolean {
    const unwrapped = unwrapAwaitExpression(node);
    return unwrapped.type === 'CallExpression';
  }

  /**
   * Tracks destructuring assignments for data flow analysis.
   *
   * For ObjectPattern: creates EXPRESSION nodes representing source.property
   * For ArrayPattern: creates EXPRESSION nodes representing source[index]
   *
   * Supports:
   * - Phase 1 (REG-201): Identifier init expressions (const { x } = obj)
   * - Phase 2 (REG-223): CallExpression/AwaitExpression init (const { x } = getConfig())
   *
   * @param pattern - The destructuring pattern (ObjectPattern or ArrayPattern)
   * @param initNode - The init expression (right-hand side)
   * @param variables - Extracted variables with propertyPath/arrayIndex metadata and IDs
   * @param module - Module context
   * @param variableAssignments - Collection to push assignment info to
   */
  trackDestructuringAssignment(
    pattern: t.ObjectPattern | t.ArrayPattern,
    initNode: t.Expression | null | undefined,
    variables: Array<ExtractedVariable & { id: string }>,
    module: VisitorModule,
    variableAssignments: VariableAssignmentInfo[]
  ): void {
    if (!initNode) return;

    // Phase 1: Simple Identifier init expressions (REG-201)
    // Examples: const { x } = obj, const [a] = arr
    if (t.isIdentifier(initNode)) {
      const sourceBaseName = initNode.name;

      // Process each extracted variable
      for (const varInfo of variables) {
        const variableId = varInfo.id;

        // Handle rest elements specially - create edge to whole source
        if (varInfo.isRest) {
          variableAssignments.push({
            variableId,
            sourceType: 'VARIABLE',
            sourceName: sourceBaseName,
            line: varInfo.loc.start.line
          });
          continue;
        }

        // ObjectPattern: const { headers } = req → headers ASSIGNED_FROM req.headers
        if (t.isObjectPattern(pattern) && varInfo.propertyPath && varInfo.propertyPath.length > 0) {
          const propertyPath = varInfo.propertyPath;
          const expressionLine = varInfo.loc.start.line;
          const expressionColumn = varInfo.loc.start.column;

          // Build property path string (e.g., "req.headers.contentType" for nested)
          const fullPath = [sourceBaseName, ...propertyPath].join('.');

          const expressionId = ExpressionNode.generateId(
            'MemberExpression',
            module.file,
            expressionLine,
            expressionColumn
          );

          variableAssignments.push({
            variableId,
            sourceType: 'EXPRESSION',
            sourceId: expressionId,
            expressionType: 'MemberExpression',
            object: sourceBaseName,
            property: propertyPath[propertyPath.length - 1], // Last property for simple display
            computed: false,
            path: fullPath,
            objectSourceName: sourceBaseName, // Use objectSourceName for DERIVES_FROM edge creation
            propertyPath: propertyPath,
            file: module.file,
            line: expressionLine,
            column: expressionColumn
          });
        }
        // ArrayPattern: const [first, second] = arr → first ASSIGNED_FROM arr[0]
        else if (t.isArrayPattern(pattern) && varInfo.arrayIndex !== undefined) {
          const arrayIndex = varInfo.arrayIndex;
          const expressionLine = varInfo.loc.start.line;
          const expressionColumn = varInfo.loc.start.column;

          // Check if we also have propertyPath (mixed destructuring: { items: [first] } = data)
          const hasPropertyPath = varInfo.propertyPath && varInfo.propertyPath.length > 0;

          const expressionId = ExpressionNode.generateId(
            'MemberExpression',
            module.file,
            expressionLine,
            expressionColumn
          );

          variableAssignments.push({
            variableId,
            sourceType: 'EXPRESSION',
            sourceId: expressionId,
            expressionType: 'MemberExpression',
            object: sourceBaseName,
            property: String(arrayIndex),
            computed: true,
            objectSourceName: sourceBaseName, // Use objectSourceName for DERIVES_FROM edge creation
            arrayIndex: arrayIndex,
            propertyPath: hasPropertyPath ? varInfo.propertyPath : undefined,
            file: module.file,
            line: expressionLine,
            column: expressionColumn
          });
        }
      }
    }
    // Phase 2: CallExpression or AwaitExpression (REG-223)
    else if (this.isCallOrAwaitExpression(initNode)) {
      const unwrapped = unwrapAwaitExpression(initNode);
      const callInfo = extractCallInfo(unwrapped);

      if (!callInfo) {
        // Unsupported call pattern (computed callee, etc.)
        return;
      }

      const callRepresentation = `${callInfo.name}()`;

      // Process each extracted variable
      for (const varInfo of variables) {
        const variableId = varInfo.id;

        // Handle rest elements - create direct CALL_SITE assignment
        if (varInfo.isRest) {
          variableAssignments.push({
            variableId,
            sourceType: 'CALL_SITE',
            callName: callInfo.name,
            callLine: callInfo.line,
            callColumn: callInfo.column,
            callSourceLine: callInfo.line,
            callSourceColumn: callInfo.column,
            callSourceFile: module.file,
            callSourceName: callInfo.name,
            line: varInfo.loc.start.line
          });
          continue;
        }

        // ObjectPattern: const { data } = fetchUser() → data ASSIGNED_FROM fetchUser().data
        if (t.isObjectPattern(pattern) && varInfo.propertyPath && varInfo.propertyPath.length > 0) {
          const propertyPath = varInfo.propertyPath;
          const expressionLine = varInfo.loc.start.line;
          const expressionColumn = varInfo.loc.start.column;

          // Build property path string: "fetchUser().data" or "fetchUser().user.name"
          const fullPath = [callRepresentation, ...propertyPath].join('.');

          const expressionId = ExpressionNode.generateId(
            'MemberExpression',
            module.file,
            expressionLine,
            expressionColumn
          );

          variableAssignments.push({
            variableId,
            sourceType: 'EXPRESSION',
            sourceId: expressionId,
            expressionType: 'MemberExpression',
            object: callRepresentation,          // "fetchUser()" - display name
            property: propertyPath[propertyPath.length - 1],
            computed: false,
            path: fullPath,                       // "fetchUser().data"
            propertyPath: propertyPath,           // ["data"]
            // Call source for DERIVES_FROM lookup (REG-223)
            callSourceLine: callInfo.line,
            callSourceColumn: callInfo.column,
            callSourceFile: module.file,
            callSourceName: callInfo.name,
            sourceMetadata: {
              sourceType: callInfo.isMethodCall ? 'method-call' : 'call'
            },
            file: module.file,
            line: expressionLine,
            column: expressionColumn
          });
        }
        // ArrayPattern: const [first] = arr.map(fn) → first ASSIGNED_FROM arr.map(fn)[0]
        else if (t.isArrayPattern(pattern) && varInfo.arrayIndex !== undefined) {
          const arrayIndex = varInfo.arrayIndex;
          const expressionLine = varInfo.loc.start.line;
          const expressionColumn = varInfo.loc.start.column;

          const hasPropertyPath = varInfo.propertyPath && varInfo.propertyPath.length > 0;

          const expressionId = ExpressionNode.generateId(
            'MemberExpression',
            module.file,
            expressionLine,
            expressionColumn
          );

          variableAssignments.push({
            variableId,
            sourceType: 'EXPRESSION',
            sourceId: expressionId,
            expressionType: 'MemberExpression',
            object: callRepresentation,
            property: String(arrayIndex),
            computed: true,
            arrayIndex: arrayIndex,
            propertyPath: hasPropertyPath ? varInfo.propertyPath : undefined,
            // Call source for DERIVES_FROM lookup (REG-223)
            callSourceLine: callInfo.line,
            callSourceColumn: callInfo.column,
            callSourceFile: module.file,
            callSourceName: callInfo.name,
            sourceMetadata: {
              sourceType: callInfo.isMethodCall ? 'method-call' : 'call'
            },
            file: module.file,
            line: expressionLine,
            column: expressionColumn
          });
        }
      }
    }
    // Unsupported init type (MemberExpression without call, etc.)
    // else: do nothing - skip silently
  }
}
