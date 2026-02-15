/**
 * CallExpressionProcessor -- handles call expression analysis inside function bodies.
 *
 * Mechanical extraction from JSASTAnalyzer.ts (REG-460 Phase 5).
 * Original methods: handleCallExpression(), extractMethodCallArguments().
 */
import * as t from '@babel/types';
import { getLine, getColumn } from '../utils/location.js';
import { computeSemanticId } from '../../../../core/SemanticId.js';
import { ExpressionEvaluator } from '../ExpressionEvaluator.js';
import { CallExpressionVisitor } from '../visitors/CallExpressionVisitor.js';
import type { ScopeTracker } from '../../../../core/ScopeTracker.js';
import type {
  CallSiteInfo,
  MethodCallInfo,
  CallArgumentInfo,
  LiteralInfo,
  ArrayMutationInfo,
  ObjectMutationInfo,
  CounterRef,
} from '../types.js';
import type { VisitorModule, VisitorCollections } from '../visitors/index.js';
import type { ArrayMutationProcessor } from './ArrayMutationProcessor.js';
import type { ObjectMutationProcessor } from './ObjectMutationProcessor.js';

export class CallExpressionProcessor {
  constructor(
    private readonly arrayMutationProcessor: ArrayMutationProcessor,
    private readonly objectMutationProcessor: ObjectMutationProcessor,
  ) {}

  /**
   * Handle CallExpression nodes: direct function calls (greet(), main())
   * and method calls (obj.method(), data.process()).
   *
   * Handles:
   * - Direct function calls (Identifier callee) -> callSites collection
   * - Method calls (MemberExpression callee) -> methodCalls collection
   * - Array mutation detection (push, unshift, splice)
   * - Object.assign() detection
   * - REG-311: isAwaited and isInsideTry metadata on CALL nodes
   *
   * @param callNode - The call expression AST node
   * @param processedCallSites - Set of already processed call site keys to avoid duplicates
   * @param processedMethodCalls - Set of already processed method call keys to avoid duplicates
   * @param callSites - Collection for direct function calls
   * @param methodCalls - Collection for method calls
   * @param module - Current module being analyzed
   * @param callSiteCounterRef - Counter for legacy ID generation
   * @param scopeTracker - Optional scope tracker for semantic ID generation
   * @param parentScopeId - ID of the parent scope containing this call
   * @param collections - Full collections object for array/object mutations
   * @param isAwaited - REG-311: true if wrapped in await expression
   * @param isInsideTry - REG-311: true if inside try block
   * @param isInsideLoop - REG-298: true if inside loop
   */
  handleCallExpression(
    callNode: t.CallExpression,
    processedCallSites: Set<string>,
    processedMethodCalls: Set<string>,
    callSites: CallSiteInfo[],
    methodCalls: MethodCallInfo[],
    module: VisitorModule,
    callSiteCounterRef: CounterRef,
    scopeTracker: ScopeTracker | undefined,
    parentScopeId: string,
    collections: VisitorCollections,
    isAwaited: boolean = false,
    isInsideTry: boolean = false,
    isInsideLoop: boolean = false
  ): void {
    // Handle direct function calls (greet(), main())
    if (callNode.callee.type === 'Identifier') {
      const nodeKey = `${callNode.start}:${callNode.end}`;
      if (processedCallSites.has(nodeKey)) {
        return;
      }
      processedCallSites.add(nodeKey);

      // Generate semantic ID (primary) or legacy ID (fallback)
      const calleeName = callNode.callee.name;
      const legacyId = `CALL#${calleeName}#${module.file}#${getLine(callNode)}:${getColumn(callNode)}:${callSiteCounterRef.value++}`;

      let callId = legacyId;
      if (scopeTracker) {
        const discriminator = scopeTracker.getItemCounter(`CALL:${calleeName}`);
        callId = computeSemanticId('CALL', calleeName, scopeTracker.getContext(), { discriminator });
      }

      callSites.push({
        id: callId,
        type: 'CALL',
        name: calleeName,
        file: module.file,
        line: getLine(callNode),
        column: getColumn(callNode),  // REG-223: Add column for coordinate-based lookup
        parentScopeId,
        targetFunctionName: calleeName,
        // REG-311: Async error tracking metadata
        isAwaited,
        isInsideTry,
        // REG-298: Await-in-loop detection
        ...(isAwaited && isInsideLoop ? { isInsideLoop } : {})
      });
    }
    // Handle method calls (obj.method(), data.process())
    else if (callNode.callee.type === 'MemberExpression') {
      const memberCallee = callNode.callee;
      const object = memberCallee.object;
      const property = memberCallee.property;
      const isComputed = memberCallee.computed;

      if ((object.type === 'Identifier' || object.type === 'ThisExpression') && property.type === 'Identifier') {
        const nodeKey = `${callNode.start}:${callNode.end}`;
        if (processedMethodCalls.has(nodeKey)) {
          return;
        }
        processedMethodCalls.add(nodeKey);

        const objectName = object.type === 'Identifier' ? object.name : 'this';
        const methodName = isComputed ? '<computed>' : property.name;
        const fullName = `${objectName}.${methodName}`;

        // Generate semantic ID (primary) or legacy ID (fallback)
        const legacyId = `CALL#${fullName}#${module.file}#${getLine(callNode)}:${getColumn(callNode)}:${callSiteCounterRef.value++}`;

        let methodCallId = legacyId;
        if (scopeTracker) {
          const discriminator = scopeTracker.getItemCounter(`CALL:${fullName}`);
          methodCallId = computeSemanticId('CALL', fullName, scopeTracker.getContext(), { discriminator });
        }

        methodCalls.push({
          id: methodCallId,
          type: 'CALL',
          name: fullName,
          object: objectName,
          method: methodName,
          computed: isComputed,
          computedPropertyVar: isComputed ? property.name : null,
          file: module.file,
          line: getLine(callNode),
          column: getColumn(callNode),
          parentScopeId,
          // REG-311: Async error tracking metadata
          isAwaited,
          isInsideTry,
          // REG-298: Await-in-loop detection
          ...(isAwaited && isInsideLoop ? { isInsideLoop } : {}),
          isMethodCall: true
        });

        // REG-400: Extract arguments for method calls (enables callback resolution)
        if (callNode.arguments.length > 0) {
          this.extractMethodCallArguments(callNode, methodCallId, module, collections);
        }

        // Check for array mutation methods (push, unshift, splice)
        const ARRAY_MUTATION_METHODS = ['push', 'unshift', 'splice'];
        if (ARRAY_MUTATION_METHODS.includes(methodName)) {
          // Initialize collection if not exists
          if (!collections.arrayMutations) {
            collections.arrayMutations = [];
          }
          const arrayMutations = collections.arrayMutations as ArrayMutationInfo[];
          this.arrayMutationProcessor.detectArrayMutationInFunction(
            callNode,
            objectName,
            methodName as 'push' | 'unshift' | 'splice',
            module,
            arrayMutations,
            scopeTracker
          );
        }

        // Check for Object.assign() calls
        if (objectName === 'Object' && methodName === 'assign') {
          // Initialize collection if not exists
          if (!collections.objectMutations) {
            collections.objectMutations = [];
          }
          const objectMutations = collections.objectMutations as ObjectMutationInfo[];
          this.objectMutationProcessor.detectObjectAssignInFunction(
            callNode,
            module,
            objectMutations,
            scopeTracker
          );
        }
      }
      // REG-117: Nested array mutations like obj.arr.push(item)
      // REG-395: General nested method calls like a.b.c() or obj.nested.method()
      // object is MemberExpression, property is the method name
      else if (object.type === 'MemberExpression' && property.type === 'Identifier') {
        const nestedMember = object;
        const methodName = property.name;
        const ARRAY_MUTATION_METHODS = ['push', 'unshift', 'splice'];

        if (ARRAY_MUTATION_METHODS.includes(methodName)) {
          // Extract base object and property from nested MemberExpression
          const base = nestedMember.object;
          const prop = nestedMember.property;

          // Only handle single-level nesting: obj.arr.push() or this.items.push()
          if ((base.type === 'Identifier' || base.type === 'ThisExpression') &&
              !nestedMember.computed &&
              prop.type === 'Identifier') {
            const baseObjectName = base.type === 'Identifier' ? base.name : 'this';
            const propertyName = prop.name;

            // Initialize collection if not exists
            if (!collections.arrayMutations) {
              collections.arrayMutations = [];
            }
            const arrayMutations = collections.arrayMutations as ArrayMutationInfo[];

            this.arrayMutationProcessor.detectArrayMutationInFunction(
              callNode,
              `${baseObjectName}.${propertyName}`,  // arrayName for ID purposes
              methodName as 'push' | 'unshift' | 'splice',
              module,
              arrayMutations,
              scopeTracker,
              true,          // isNested
              baseObjectName,
              propertyName
            );
          }
        }

        // REG-395: Create CALL node for nested method calls like a.b.c()
        const objectName = CallExpressionVisitor.extractMemberExpressionName(nestedMember as t.MemberExpression);
        if (objectName) {
          const nodeKey = `${callNode.start}:${callNode.end}`;
          if (!processedMethodCalls.has(nodeKey)) {
            processedMethodCalls.add(nodeKey);

            const fullName = `${objectName}.${methodName}`;
            const legacyId = `CALL#${fullName}#${module.file}#${getLine(callNode)}:${getColumn(callNode)}:${callSiteCounterRef.value++}`;

            let methodCallId = legacyId;
            if (scopeTracker) {
              const discriminator = scopeTracker.getItemCounter(`CALL:${fullName}`);
              methodCallId = computeSemanticId('CALL', fullName, scopeTracker.getContext(), { discriminator });
            }

            methodCalls.push({
              id: methodCallId,
              type: 'CALL',
              name: fullName,
              object: objectName,
              method: methodName,
              file: module.file,
              line: getLine(callNode),
              column: getColumn(callNode),
              parentScopeId,
              isMethodCall: true
            });

            // REG-400: Extract arguments for nested method calls (enables callback resolution)
            if (callNode.arguments.length > 0) {
              this.extractMethodCallArguments(callNode, methodCallId, module, collections);
            }
          }
        }
      }
    }
  }

  /**
   * REG-400: Extract arguments from method call nodes inside function bodies.
   * Populates callArguments collection so GraphBuilder.bufferArgumentEdges can
   * create PASSES_ARGUMENT and callback CALLS edges.
   *
   * This mirrors CallExpressionVisitor.extractArguments but is simplified --
   * handles Identifier, Literal, CallExpression, and Expression types.
   */
  extractMethodCallArguments(
    callNode: t.CallExpression,
    methodCallId: string,
    module: VisitorModule,
    collections: VisitorCollections
  ): void {
    if (!collections.callArguments) {
      collections.callArguments = [];
    }
    const callArguments = collections.callArguments as CallArgumentInfo[];
    const literals = (collections.literals ?? []) as LiteralInfo[];
    const literalCounterRef = (collections.literalCounterRef ?? { value: 0 }) as CounterRef;

    callNode.arguments.forEach((arg, argIndex) => {
      const argInfo: CallArgumentInfo = {
        callId: methodCallId,
        argIndex,
        file: module.file,
        line: getLine(arg),
        column: getColumn(arg)
      };

      if (t.isSpreadElement(arg)) {
        const spreadArg = arg.argument;
        if (t.isIdentifier(spreadArg)) {
          argInfo.targetType = 'VARIABLE';
          argInfo.targetName = spreadArg.name;
          argInfo.isSpread = true;
        }
      } else if (t.isIdentifier(arg)) {
        argInfo.targetType = 'VARIABLE';
        argInfo.targetName = arg.name;
      } else if (t.isLiteral(arg) && !t.isTemplateLiteral(arg)) {
        const literalValue = ExpressionEvaluator.extractLiteralValue(arg as t.Literal);
        if (literalValue !== null) {
          const argLine = getLine(arg);
          const argColumn = getColumn(arg);
          const literalId = `LITERAL#arg${argIndex}#${module.file}#${argLine}:${argColumn}:${literalCounterRef.value++}`;
          literals.push({
            id: literalId,
            type: 'LITERAL',
            value: literalValue,
            valueType: typeof literalValue,
            file: module.file,
            line: argLine,
            column: argColumn,
            parentCallId: methodCallId,
            argIndex
          });
          argInfo.targetType = 'LITERAL';
          argInfo.targetId = literalId;
          argInfo.literalValue = literalValue;
        }
      } else if (t.isArrowFunctionExpression(arg) || t.isFunctionExpression(arg)) {
        argInfo.targetType = 'FUNCTION';
        argInfo.functionLine = getLine(arg);
        argInfo.functionColumn = getColumn(arg);
      } else if (t.isCallExpression(arg)) {
        argInfo.targetType = 'CALL';
        argInfo.nestedCallLine = getLine(arg);
        argInfo.nestedCallColumn = getColumn(arg);
      // REG-402: MemberExpression arguments (this.handler, obj.method)
      } else if (t.isMemberExpression(arg)) {
        argInfo.targetType = 'EXPRESSION';
        argInfo.expressionType = 'MemberExpression';
        if (t.isIdentifier(arg.object)) {
          argInfo.objectName = arg.object.name;
        } else if (t.isThisExpression(arg.object)) {
          argInfo.objectName = 'this';
          // Store enclosing class name for direct lookup in GraphBuilder
          const scopeTracker = collections.scopeTracker as ScopeTracker | undefined;
          if (scopeTracker) {
            argInfo.enclosingClassName = scopeTracker.getEnclosingScope('CLASS');
          }
        }
        if (!arg.computed && t.isIdentifier(arg.property)) {
          argInfo.propertyName = arg.property.name;
        }
      } else {
        argInfo.targetType = 'EXPRESSION';
        argInfo.expressionType = arg.type;
      }

      callArguments.push(argInfo);
    });
  }
}
