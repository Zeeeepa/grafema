/**
 * ErrorTrackingProcessor — handles error tracking analysis for try/catch blocks.
 *
 * Mechanical extraction from JSASTAnalyzer.ts (REG-460 Phase 6).
 * Original methods: microTraceToErrorClass(), collectCatchesFromInfo().
 */
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { getLine, getColumn } from '../utils/location.js';
import type {
  VariableDeclarationInfo,
  CallSiteInfo,
  MethodCallInfo,
  ConstructorCallInfo,
  CatchBlockInfo,
  CatchesFromInfo,
} from '../types.js';
import type { VisitorModule } from '../visitors/index.js';

export class ErrorTrackingProcessor {
  /**
   * REG-311: Micro-trace - follow variable assignments within function to find error source.
   * Used to resolve reject(err) or throw err where err is a variable.
   *
   * Uses cycle detection via Set<variableName> to avoid infinite loops on circular assignments.
   *
   * @param variableName - Name of variable to trace
   * @param funcPath - NodePath of containing function for AST traversal
   * @param _variableDeclarations - Variable declarations in current scope
   * @returns Error class name if traced to NewExpression, null otherwise, plus trace path
   */
  microTraceToErrorClass(
    variableName: string,
    funcPath: NodePath<t.Function>,
    _variableDeclarations: VariableDeclarationInfo[]
  ): { errorClassName: string | null; tracePath: string[] } {
    const tracePath: string[] = [variableName];
    const visited = new Set<string>(); // Cycle detection
    let currentName = variableName;

    const funcBody = funcPath.node.body;
    if (!t.isBlockStatement(funcBody)) {
      return { errorClassName: null, tracePath };
    }

    // Iterate until we find a NewExpression or can't trace further
    while (!visited.has(currentName)) {
      visited.add(currentName);
      let found = false;
      let foundNewExpression: string | null = null;
      let nextName: string | null = null;

      // Walk AST to find assignments: currentName = newValue
      funcPath.traverse({
        VariableDeclarator: (declPath: NodePath<t.VariableDeclarator>) => {
          if (found || foundNewExpression) return;
          if (t.isIdentifier(declPath.node.id) && declPath.node.id.name === currentName) {
            const init = declPath.node.init;
            if (init) {
              // Case 1: const err = new Error()
              if (t.isNewExpression(init) && t.isIdentifier(init.callee)) {
                tracePath.push(`new ${init.callee.name}()`);
                foundNewExpression = init.callee.name;
                found = true;
                return;
              }
              // Case 2: const err = otherVar (chain)
              if (t.isIdentifier(init)) {
                tracePath.push(init.name);
                nextName = init.name;
                found = true;
                return;
              }
            }
          }
        },
        AssignmentExpression: (assignPath: NodePath<t.AssignmentExpression>) => {
          if (found || foundNewExpression) return;
          const left = assignPath.node.left;
          const right = assignPath.node.right;

          if (t.isIdentifier(left) && left.name === currentName) {
            if (t.isNewExpression(right) && t.isIdentifier(right.callee)) {
              tracePath.push(`new ${right.callee.name}()`);
              foundNewExpression = right.callee.name;
              found = true;
              return;
            }
            if (t.isIdentifier(right)) {
              tracePath.push(right.name);
              nextName = right.name;
              found = true;
              return;
            }
          }
        }
      });

      // If we found a NewExpression, return the class name
      if (foundNewExpression) {
        return { errorClassName: foundNewExpression, tracePath };
      }

      // If we found another variable to follow, continue
      if (nextName) {
        currentName = nextName;
        continue;
      }

      // Couldn't trace further
      break;
    }

    return { errorClassName: null, tracePath };
  }

  /**
   * REG-311: Collect CATCHES_FROM info linking catch blocks to exception sources in try blocks.
   *
   * Sources include:
   * - Awaited calls: await foo() in try block
   * - Sync calls: foo() in try block (any call can throw)
   * - Throw statements: throw new Error() in try block
   * - Constructor calls: new SomeClass() in try block
   *
   * @param funcPath - Function path to traverse
   * @param catchBlocks - Collection of CATCH_BLOCK nodes
   * @param callSites - Collection of CALL nodes (direct function calls)
   * @param methodCalls - Collection of CALL nodes (method calls)
   * @param constructorCalls - Collection of CONSTRUCTOR_CALL nodes
   * @param catchesFromInfos - Collection to push CatchesFromInfo to
   * @param module - Module context
   */
  collectCatchesFromInfo(
    funcPath: NodePath<t.Function>,
    catchBlocks: CatchBlockInfo[],
    callSites: CallSiteInfo[],
    methodCalls: MethodCallInfo[],
    constructorCalls: ConstructorCallInfo[],
    catchesFromInfos: CatchesFromInfo[],
    module: VisitorModule
  ): void {
    // Traverse to find TryStatements and collect sources
    funcPath.traverse({
      TryStatement: (tryPath: NodePath<t.TryStatement>) => {
        const tryNode = tryPath.node;
        const handler = tryNode.handler;

        // Skip if no catch clause
        if (!handler) return;

        // Find the catch block for this try
        // Match by line number since we don't have the tryBlockId here
        const catchLine = getLine(handler);
        const catchBlock = catchBlocks.find(cb =>
          cb.file === module.file && cb.line === catchLine
        );

        if (!catchBlock || !catchBlock.parameterName) return;

        // Traverse only the try block body (not catch or finally)
        const _tryBody = tryNode.block;
        const sources: Array<{ id: string; type: CatchesFromInfo['sourceType']; line: number }> = [];

        // Collect sources from try block
        tryPath.get('block').traverse({
          // Stop at nested TryStatement - don't collect from inner try blocks
          TryStatement: (innerPath) => {
            innerPath.skip(); // Don't traverse into nested try blocks
          },

          // Stop at function boundaries - don't collect from nested functions
          Function: (innerFuncPath) => {
            innerFuncPath.skip();
          },

          CallExpression: (callPath: NodePath<t.CallExpression>) => {
            const callNode = callPath.node;
            const callLine = getLine(callNode);
            const callColumn = getColumn(callNode);

            // Check if this is an awaited call
            const parent = callPath.parentPath;
            const isAwaited = parent?.isAwaitExpression() ?? false;

            // Find the CALL node that matches this CallExpression
            let sourceId: string | null = null;
            let sourceType: CatchesFromInfo['sourceType'] = 'sync_call';

            // Check method calls first (includes Promise.reject which is a method call)
            const matchingMethodCall = methodCalls.find(mc =>
              mc.file === module.file &&
              mc.line === callLine &&
              mc.column === callColumn
            );

            if (matchingMethodCall) {
              sourceId = matchingMethodCall.id;
              sourceType = isAwaited ? 'awaited_call' : 'sync_call';
            } else {
              // Check direct function calls
              const matchingCallSite = callSites.find(cs =>
                cs.file === module.file &&
                cs.line === callLine &&
                cs.column === callColumn
              );

              if (matchingCallSite) {
                sourceId = matchingCallSite.id;
                sourceType = isAwaited ? 'awaited_call' : 'sync_call';
              }
            }

            if (sourceId) {
              sources.push({ id: sourceId, type: sourceType, line: callLine });
            }
          },

          ThrowStatement: (throwPath: NodePath<t.ThrowStatement>) => {
            const throwNode = throwPath.node;
            const throwLine = getLine(throwNode);
            const throwColumn = getColumn(throwNode);

            // Create a synthetic ID for the throw statement
            // We don't have THROW_STATEMENT nodes, so we use line/column as identifier
            const sourceId = `THROW#${module.file}#${throwLine}:${throwColumn}`;

            sources.push({ id: sourceId, type: 'throw_statement', line: throwLine });
          },

          NewExpression: (newPath: NodePath<t.NewExpression>) => {
            // Skip NewExpression that is direct argument of ThrowStatement
            // In `throw new Error()`, the throw statement is the primary source
            if (newPath.parentPath?.isThrowStatement()) {
              return;
            }

            const newNode = newPath.node;
            const newLine = getLine(newNode);
            const newColumn = getColumn(newNode);

            // Find matching constructor call
            const matchingConstructor = constructorCalls.find(cc =>
              cc.file === module.file &&
              cc.line === newLine &&
              cc.column === newColumn
            );

            if (matchingConstructor) {
              sources.push({ id: matchingConstructor.id, type: 'constructor_call', line: newLine });
            }
          }
        });

        // Create CatchesFromInfo for each source
        for (const source of sources) {
          catchesFromInfos.push({
            catchBlockId: catchBlock.id,
            parameterName: catchBlock.parameterName,
            sourceId: source.id,
            sourceType: source.type,
            file: module.file,
            sourceLine: source.line
          });
        }
      }
    });
  }
}
