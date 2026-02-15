/**
 * VisitorComposer - Orchestrates AST visitor creation and traversal.
 *
 * Extracted from JSASTAnalyzer.analyzeModule() (REG-460 Phase 10) to reduce
 * method length. Handles the ~350-line visitor instantiation and traverse()
 * call sequence.
 *
 * All visitors are created in the same order as the original code to preserve
 * any ordering dependencies.
 */

import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';

import type { Profiler } from '../../../../core/Profiler.js';
import type { ScopeTracker } from '../../../../core/ScopeTracker.js';
import { computeSemanticId } from '../../../../core/SemanticId.js';
import { ConstructorCallNode } from '../../../../core/nodes/ConstructorCallNode.js';
import { getLine, getColumn } from '../utils/location.js';
import { ConditionParser } from '../ConditionParser.js';
import { generateSemanticId } from '../utils/generateSemanticId.js';
import {
  ImportExportVisitor,
  VariableVisitor,
  FunctionVisitor,
  ClassVisitor,
  CallExpressionVisitor,
  TypeScriptVisitor,
  PropertyAccessVisitor,
  type VisitorModule,
  type VisitorCollections,
  type TrackVariableAssignmentCallback,
  type ExtractVariableNamesCallback,
} from '../visitors/index.js';
import type {
  FunctionInfo,
  ScopeInfo,
  ConstructorCallInfo,
  PromiseExecutorContext,
  ArrayMutationInfo,
  ObjectMutationInfo,
  VariableReassignmentInfo,
  UpdateExpressionInfo,
  CounterRef,
} from '../types.js';

// Type for CJS/ESM interop — matches the one in JSASTAnalyzer
import type { TraverseOptions } from '@babel/traverse';
type TraverseFn = (ast: t.Node, opts: TraverseOptions) => void;

/**
 * Subset of JSASTAnalyzer that VisitorComposer needs for delegation.
 * Keeps VisitorComposer decoupled from the full analyzer class.
 */
export interface VisitorComposerDelegate {
  extractVariableNamesFromPattern: ExtractVariableNamesCallback;
  trackVariableAssignment: TrackVariableAssignmentCallback;
  analyzeFunctionBody: (
    funcPath: NodePath<t.Function | t.StaticBlock>,
    parentScopeId: string,
    module: VisitorModule,
    collections: VisitorCollections,
  ) => void;
  detectIndexedArrayAssignment(
    assignNode: t.AssignmentExpression,
    module: VisitorModule,
    arrayMutations: ArrayMutationInfo[],
    scopeTracker?: ScopeTracker,
    collections?: VisitorCollections,
  ): void;
  detectObjectPropertyAssignment(
    assignNode: t.AssignmentExpression,
    module: VisitorModule,
    objectMutations: ObjectMutationInfo[],
    scopeTracker?: ScopeTracker,
  ): void;
  detectVariableReassignment(
    assignNode: t.AssignmentExpression,
    module: VisitorModule,
    variableReassignments: VariableReassignmentInfo[],
    scopeTracker?: ScopeTracker,
  ): void;
  collectUpdateExpression(
    updateNode: t.UpdateExpression,
    module: VisitorModule,
    updateExpressions: UpdateExpressionInfo[],
    parentScopeId: string | undefined,
    scopeTracker?: ScopeTracker,
  ): void;
  generateAnonymousName(scopeTracker: ScopeTracker | undefined): string;
  generateSemanticId(scopeType: string, scopeTracker: ScopeTracker | undefined): string | undefined;
}

/**
 * Result of visitor composition and traversal.
 * Contains the `hasTopLevelAwait` flag detected during traversal.
 */
export interface CompositionResult {
  hasTopLevelAwait: boolean;
}

/**
 * Instantiate all visitors and run all traverse passes over the AST.
 *
 * This reproduces the exact visitor creation and traversal order from the
 * original analyzeModule() method. The ordering matters because:
 * - ImportExportVisitor must run before FunctionVisitor (imports populate first)
 * - VariableVisitor must run before FunctionVisitor (variables available for scope)
 * - FunctionVisitor populates allCollections which ClassVisitor and others read
 * - CallExpressionVisitor runs after functions/classes to see all declarations
 * - PropertyAccessVisitor runs late to see all scope information
 *
 * @param ast - Parsed Babel AST
 * @param traverse - The traverse function (CJS/ESM interop resolved)
 * @param module - MODULE node being analyzed
 * @param allCollections - The unified collections object (VisitorCollections-compatible)
 * @param scopeTracker - ScopeTracker for semantic ID generation
 * @param delegate - JSASTAnalyzer methods needed by inline visitors
 * @param profiler - Profiler for performance monitoring
 */
export function composeAndTraverse(
  ast: t.File,
  traverse: TraverseFn,
  module: VisitorModule,
  allCollections: VisitorCollections & Record<string, unknown>,
  scopeTracker: ScopeTracker,
  delegate: VisitorComposerDelegate,
  profiler: Profiler,
): CompositionResult {
  // Bind all delegate methods to preserve `this` context
  const extractVarNames = delegate.extractVariableNamesFromPattern.bind(delegate);
  const trackVarAssignment = delegate.trackVariableAssignment.bind(delegate) as TrackVariableAssignmentCallback;
  const analyzeFuncBody = delegate.analyzeFunctionBody.bind(delegate);
  const detectIdxArray = delegate.detectIndexedArrayAssignment.bind(delegate);
  const detectObjProp = delegate.detectObjectPropertyAssignment.bind(delegate);
  const detectVarReassign = delegate.detectVariableReassignment.bind(delegate);
  const collectUpdate = delegate.collectUpdateExpression.bind(delegate);
  const genAnonName = delegate.generateAnonymousName.bind(delegate);

  // Shorthand references into allCollections for inline visitors
  const functions = allCollections.functions as FunctionInfo[];
  const scopes = allCollections.scopes as ScopeInfo[];
  const constructorCalls = allCollections.constructorCalls as ConstructorCallInfo[];
  const promiseExecutorContexts = allCollections.promiseExecutorContexts as Map<string, PromiseExecutorContext>;
  const arrayMutations = allCollections.arrayMutations as ArrayMutationInfo[];
  const objectMutations = allCollections.objectMutations as ObjectMutationInfo[];
  const updateExpressions = allCollections.updateExpressions as UpdateExpressionInfo[];
  const ifScopeCounterRef = allCollections.ifScopeCounterRef as CounterRef;
  const code = allCollections.code as string;

  // === 1. Imports/Exports ===
  profiler.start('traverse_imports');
  const importExportVisitor = new ImportExportVisitor(
    module,
    { imports: allCollections.imports!, exports: allCollections.exports! },
    extractVarNames,
  );
  traverse(ast, importExportVisitor.getImportHandlers());
  traverse(ast, importExportVisitor.getExportHandlers());
  profiler.end('traverse_imports');

  // === 2. Variables ===
  profiler.start('traverse_variables');
  const variableVisitor = new VariableVisitor(
    module,
    {
      variableDeclarations: allCollections.variableDeclarations!,
      classInstantiations: allCollections.classInstantiations!,
      literals: allCollections.literals!,
      variableAssignments: allCollections.variableAssignments!,
      varDeclCounterRef: allCollections.varDeclCounterRef!,
      literalCounterRef: allCollections.literalCounterRef!,
      scopes: allCollections.scopes!,
      scopeCounterRef: allCollections.scopeCounterRef!,
      objectLiterals: allCollections.objectLiterals!,
      objectProperties: allCollections.objectProperties!,
      objectLiteralCounterRef: allCollections.objectLiteralCounterRef!,
    },
    extractVarNames,
    trackVarAssignment,
    scopeTracker,
  );
  traverse(ast, variableVisitor.getHandlers());
  profiler.end('traverse_variables');

  // === 3. Functions ===
  profiler.start('traverse_functions');
  const functionVisitor = new FunctionVisitor(
    module,
    allCollections,
    analyzeFuncBody,
    scopeTracker,
  );
  traverse(ast, functionVisitor.getHandlers());
  profiler.end('traverse_functions');

  // === 4. AssignmentExpression (module-level function assignments) ===
  profiler.start('traverse_assignments');
  traverse(ast, {
    AssignmentExpression: (assignPath: NodePath<t.AssignmentExpression>) => {
      const assignNode = assignPath.node;
      const functionParent = assignPath.getFunctionParent();
      if (functionParent) return;

      if (
        assignNode.right &&
        (assignNode.right.type === 'FunctionExpression' ||
          assignNode.right.type === 'ArrowFunctionExpression')
      ) {
        let functionName = 'anonymous';
        if (assignNode.left.type === 'MemberExpression') {
          const prop = assignNode.left.property;
          if (t.isIdentifier(prop)) {
            functionName = prop.name;
          }
        } else if (assignNode.left.type === 'Identifier') {
          functionName = assignNode.left.name;
        }

        const funcNode = assignNode.right;
        const functionId = computeSemanticId('FUNCTION', functionName, scopeTracker.getContext());

        functions.push({
          id: functionId,
          type: 'FUNCTION',
          name: functionName,
          file: module.file,
          line: getLine(assignNode),
          column: getColumn(assignNode),
          async: funcNode.async || false,
          generator: funcNode.type === 'FunctionExpression' ? funcNode.generator : false,
          isAssignment: true,
        });

        const funcBodyScopeId = `SCOPE#${functionName}:body#${module.file}#${getLine(assignNode)}`;
        scopes.push({
          id: funcBodyScopeId,
          type: 'SCOPE',
          scopeType: 'function_body',
          name: `${functionName}:body`,
          semanticId: `${functionName}:function_body[0]`,
          conditional: false,
          file: module.file,
          line: getLine(assignNode),
          parentFunctionId: functionId,
        });

        const funcPath = assignPath.get('right') as NodePath<
          t.FunctionExpression | t.ArrowFunctionExpression
        >;
        scopeTracker.enterScope(functionName, 'function');
        analyzeFuncBody(funcPath, funcBodyScopeId, module, allCollections);
        scopeTracker.exitScope();
      }

      // === VARIABLE REASSIGNMENT (REG-290) ===
      if (assignNode.left.type === 'Identifier') {
        if (!allCollections.variableReassignments) {
          allCollections.variableReassignments = [];
        }
        const variableReassignments = allCollections.variableReassignments as VariableReassignmentInfo[];
        detectVarReassign(assignNode, module, variableReassignments, scopeTracker);
      }

      // Check for indexed array assignment at module level
      detectIdxArray(assignNode, module, arrayMutations, scopeTracker, allCollections);

      // Check for object property assignment at module level
      detectObjProp(assignNode, module, objectMutations, scopeTracker);
    },
  });
  profiler.end('traverse_assignments');

  // === 5. Module-level UpdateExpression (REG-288/REG-312) ===
  profiler.start('traverse_updates');
  traverse(ast, {
    UpdateExpression: (updatePath: NodePath<t.UpdateExpression>) => {
      const functionParent = updatePath.getFunctionParent();
      if (functionParent) return;
      collectUpdate(updatePath.node, module, updateExpressions, undefined, scopeTracker);
    },
  });
  profiler.end('traverse_updates');

  // === 6. Classes ===
  profiler.start('traverse_classes');
  const classVisitor = new ClassVisitor(
    module,
    allCollections,
    analyzeFuncBody,
    scopeTracker,
  );
  traverse(ast, classVisitor.getHandlers());
  profiler.end('traverse_classes');

  // === 7. TypeScript-specific constructs ===
  profiler.start('traverse_typescript');
  const typescriptVisitor = new TypeScriptVisitor(module, allCollections, scopeTracker);
  traverse(ast, typescriptVisitor.getHandlers());
  profiler.end('traverse_typescript');

  // === 8. Module-level callbacks ===
  profiler.start('traverse_callbacks');
  traverse(ast, {
    FunctionExpression: (funcPath: NodePath<t.FunctionExpression>) => {
      const funcNode = funcPath.node;
      const functionParent = funcPath.getFunctionParent();
      if (functionParent) return;

      if (funcPath.parent && funcPath.parent.type === 'CallExpression') {
        const funcName = funcNode.id ? funcNode.id.name : genAnonName(scopeTracker);
        const functionId = computeSemanticId('FUNCTION', funcName, scopeTracker.getContext());

        functions.push({
          id: functionId,
          type: 'FUNCTION',
          name: funcName,
          file: module.file,
          line: getLine(funcNode),
          column: getColumn(funcNode),
          async: funcNode.async || false,
          generator: funcNode.generator || false,
          isCallback: true,
          parentScopeId: module.id,
        });

        const callbackScopeId = `SCOPE#${funcName}:body#${module.file}#${getLine(funcNode)}`;
        scopes.push({
          id: callbackScopeId,
          type: 'SCOPE',
          scopeType: 'callback_body',
          name: `${funcName}:body`,
          semanticId: `${funcName}:callback_body[0]`,
          conditional: false,
          file: module.file,
          line: getLine(funcNode),
          parentFunctionId: functionId,
        });

        scopeTracker.enterScope(funcName, 'callback');
        analyzeFuncBody(funcPath, callbackScopeId, module, allCollections);
        scopeTracker.exitScope();
        funcPath.skip();
      }
    },
  });
  profiler.end('traverse_callbacks');

  // === 9. Call expressions ===
  profiler.start('traverse_calls');
  const callExpressionVisitor = new CallExpressionVisitor(module, allCollections, scopeTracker);
  traverse(ast, callExpressionVisitor.getHandlers());
  profiler.end('traverse_calls');

  // === 10. Top-level await (REG-297) ===
  profiler.start('traverse_top_level_await');
  let hasTopLevelAwait = false;
  traverse(ast, {
    AwaitExpression(awaitPath: NodePath<t.AwaitExpression>) {
      if (!awaitPath.getFunctionParent()) {
        hasTopLevelAwait = true;
        awaitPath.stop();
      }
    },
    ForOfStatement(forOfPath: NodePath<t.ForOfStatement>) {
      if (forOfPath.node.await && !forOfPath.getFunctionParent()) {
        hasTopLevelAwait = true;
        forOfPath.stop();
      }
    },
  });
  profiler.end('traverse_top_level_await');

  // === 11. Property access (REG-395) ===
  profiler.start('traverse_property_access');
  const propertyAccessVisitor = new PropertyAccessVisitor(module, allCollections, scopeTracker);
  traverse(ast, propertyAccessVisitor.getHandlers());
  profiler.end('traverse_property_access');

  // === 12. Module-level NewExpression (constructor calls) ===
  profiler.start('traverse_new');
  const processedConstructorCalls = new Set<string>();
  traverse(ast, {
    NewExpression: (newPath: NodePath<t.NewExpression>) => {
      const newNode = newPath.node;
      const nodeKey = `constructor:new:${newNode.start}:${newNode.end}`;
      if (processedConstructorCalls.has(nodeKey)) {
        return;
      }
      processedConstructorCalls.add(nodeKey);

      let className: string | null = null;
      if (newNode.callee.type === 'Identifier') {
        className = newNode.callee.name;
      } else if (
        newNode.callee.type === 'MemberExpression' &&
        newNode.callee.property.type === 'Identifier'
      ) {
        className = newNode.callee.property.name;
      }

      if (className) {
        const line = getLine(newNode);
        const column = getColumn(newNode);
        const constructorCallId = ConstructorCallNode.generateId(className, module.file, line, column);
        const isBuiltin = ConstructorCallNode.isBuiltinConstructor(className);

        constructorCalls.push({
          id: constructorCallId,
          type: 'CONSTRUCTOR_CALL',
          className,
          isBuiltin,
          file: module.file,
          line,
          column,
        });

        // REG-334: Promise executor context for resolve/reject detection
        if (className === 'Promise' && newNode.arguments.length > 0) {
          const executorArg = newNode.arguments[0];

          if (t.isArrowFunctionExpression(executorArg) || t.isFunctionExpression(executorArg)) {
            let resolveName: string | undefined;
            let rejectName: string | undefined;

            if (executorArg.params.length > 0 && t.isIdentifier(executorArg.params[0])) {
              resolveName = executorArg.params[0].name;
            }
            if (executorArg.params.length > 1 && t.isIdentifier(executorArg.params[1])) {
              rejectName = executorArg.params[1].name;
            }

            if (resolveName) {
              const funcKey = `${executorArg.start}:${executorArg.end}`;
              promiseExecutorContexts.set(funcKey, {
                constructorCallId,
                resolveName,
                rejectName,
                file: module.file,
                line,
                creatorFunctionId: undefined,
              });
            }
          }
        }
      }
    },
  });
  profiler.end('traverse_new');

  // === 13. Module-level IfStatements ===
  profiler.start('traverse_ifs');
  traverse(ast, {
    IfStatement: (ifPath: NodePath<t.IfStatement>) => {
      const functionParent = ifPath.getFunctionParent();
      if (functionParent) return;

      const ifNode = ifPath.node;
      const condition = code.substring(ifNode.test.start!, ifNode.test.end!) || 'condition';
      const counterId = ifScopeCounterRef.value++;
      const ifScopeId = `SCOPE#if#${module.file}#${getLine(ifNode)}:${getColumn(ifNode)}:${counterId}`;

      const constraints = ConditionParser.parse(ifNode.test);
      const ifSemanticId = generateSemanticId('if_statement', scopeTracker);

      scopes.push({
        id: ifScopeId,
        type: 'SCOPE',
        scopeType: 'if_statement',
        name: `if:${getLine(ifNode)}:${getColumn(ifNode)}:${counterId}`,
        semanticId: ifSemanticId,
        conditional: true,
        condition,
        constraints: constraints.length > 0 ? constraints : undefined,
        file: module.file,
        line: getLine(ifNode),
        parentScopeId: module.id,
      });

      if (ifNode.alternate && ifNode.alternate.type !== 'IfStatement') {
        const elseCounterId = ifScopeCounterRef.value++;
        const elseScopeId = `SCOPE#else#${module.file}#${getLine(ifNode.alternate)}:${getColumn(ifNode.alternate)}:${elseCounterId}`;

        const negatedConstraints = constraints.length > 0 ? ConditionParser.negate(constraints) : undefined;
        const elseSemanticId = generateSemanticId('else_statement', scopeTracker);

        scopes.push({
          id: elseScopeId,
          type: 'SCOPE',
          scopeType: 'else_statement',
          name: `else:${getLine(ifNode.alternate)}:${getColumn(ifNode.alternate)}:${elseCounterId}`,
          semanticId: elseSemanticId,
          conditional: true,
          constraints: negatedConstraints,
          file: module.file,
          line: getLine(ifNode.alternate),
          parentScopeId: module.id,
        });
      }
    },
  });
  profiler.end('traverse_ifs');

  return { hasTopLevelAwait };
}
