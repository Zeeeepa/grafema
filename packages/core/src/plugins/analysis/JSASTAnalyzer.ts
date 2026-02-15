/**
 * JSASTAnalyzer - плагин для парсинга JavaScript AST
 * Создаёт ноды: FUNCTION, CLASS, METHOD и т.д.
 */

import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { basename } from 'path';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import type { NodePath, TraverseOptions, Visitor } from '@babel/traverse';
import * as t from '@babel/types';

// Type for CJS/ESM interop - @babel/traverse exports a function but @types defines it as namespace
type TraverseFn = (ast: t.Node, opts: TraverseOptions) => void;
const rawModule = traverseModule as unknown as TraverseFn | { default: TraverseFn };
const traverse: TraverseFn = typeof rawModule === 'function' ? rawModule : rawModule.default;

// Type guard for analysis result
interface AnalysisResult {
  nodes: number;
  edges: number;
}

function isAnalysisResult(value: unknown): value is AnalysisResult {
  if (typeof value !== 'object' || value === null) return false;
  if (!('nodes' in value) || !('edges' in value)) return false;
  // After 'in' checks, TS knows properties exist; widening to unknown is safe
  const { nodes, edges } = value as { nodes: unknown; edges: unknown };
  return typeof nodes === 'number' && typeof edges === 'number';
}

import { Plugin, createSuccessResult, createErrorResult } from '../Plugin.js';
import { GraphBuilder } from './ast/GraphBuilder.js';
import {
  type VisitorModule,
  type VisitorCollections,
} from './ast/visitors/index.js';
import { Task } from '../../core/Task.js';
import { PriorityQueue } from '../../core/PriorityQueue.js';
import { WorkerPool } from '../../core/WorkerPool.js';
import { ASTWorkerPool, type ModuleInfo as ASTModuleInfo, type ParseResult } from '../../core/ASTWorkerPool.js';
import { getLine, getColumn } from './ast/utils/location.js';
import { Profiler } from '../../core/Profiler.js';
import { ScopeTracker } from '../../core/ScopeTracker.js';
import { brandNodeInternal } from '../../core/brandNodeInternal.js';
import { resolveNodeFile } from '../../utils/resolveNodeFile.js';
import type { PluginContext, PluginResult, PluginMetadata, GraphBackend } from '@grafema/types';
import type {
  ModuleNode,
  FunctionInfo,
  ParameterInfo,
  ScopeInfo,
  BranchInfo,
  CaseInfo,
  LoopInfo,
  TryBlockInfo,
  CatchBlockInfo,
  FinallyBlockInfo,
  VariableDeclarationInfo,
  CallSiteInfo,
  MethodCallInfo,
  EventListenerInfo,
  ClassInstantiationInfo,
  ConstructorCallInfo,
  ClassDeclarationInfo,
  MethodCallbackInfo,
  CallArgumentInfo,
  ImportInfo,
  ExportInfo,
  HttpRequestInfo,
  LiteralInfo,
  VariableAssignmentInfo,
  InterfaceDeclarationInfo,
  TypeAliasInfo,
  EnumDeclarationInfo,
  DecoratorInfo,
  ObjectLiteralInfo,
  ObjectPropertyInfo,
  ArrayLiteralInfo,
  ArrayElementInfo,
  ArrayMutationInfo,
  ObjectMutationInfo,
  VariableReassignmentInfo,
  ReturnStatementInfo,
  YieldExpressionInfo,
  UpdateExpressionInfo,
  PromiseResolutionInfo,
  PromiseExecutorContext,
  CatchesFromInfo,
  PropertyAccessInfo,
  TypeParameterInfo,
  CounterRef,
  ProcessedNodes,
  ASTCollections,
  ExtractedVariable,
} from './ast/types.js';
import { extractNamesFromPattern } from './ast/utils/extractNamesFromPattern.js';
import { memberExpressionToString } from './ast/utils/memberExpressionToString.js';
import { countLogicalOperators } from './ast/utils/countLogicalOperators.js';
import { extractDiscriminantExpression } from './ast/utils/extractDiscriminantExpression.js';
import { generateSemanticId, generateAnonymousName } from './ast/utils/generateSemanticId.js';
import { createFunctionBodyContext } from './ast/FunctionBodyContext.js';
import type { FunctionBodyContext } from './ast/FunctionBodyContext.js';
import {
  VariableHandler,
  ReturnYieldHandler,
  ThrowHandler,
  NestedFunctionHandler,
  PropertyAccessHandler,
  NewExpressionHandler,
  CallExpressionHandler,
  LoopHandler,
  TryCatchHandler,
  BranchHandler,
} from './ast/handlers/index.js';
import type { AnalyzerDelegate } from './ast/handlers/index.js';
import type { FunctionBodyHandler } from './ast/handlers/index.js';
import {
  VariableMutationProcessor,
  ArrayMutationProcessor,
  ObjectMutationProcessor,
  VariableTrackingProcessor,
  ControlFlowProcessor,
  CallExpressionProcessor,
  ErrorTrackingProcessor,
  ReturnExpressionParser,
  VariableDeclarationProcessor,
  createAnalysisCollections,
  createCounterRefs,
  createProcessedNodes,
  assembleCollections,
  composeAndTraverse,
} from './ast/delegate/index.js';

// === LOCAL TYPES ===

// Note: Legacy ScopeContext interface removed in REG-141
// Semantic ID generation now uses ScopeTracker exclusively

// Internal Collections with required fields (ASTCollections has optional for GraphBuilder)
interface Collections {
  functions: FunctionInfo[];
  parameters: ParameterInfo[];
  scopes: ScopeInfo[];
  // Branching (switch statements)
  branches: BranchInfo[];
  cases: CaseInfo[];
  // Control flow (loops)
  loops: LoopInfo[];
  // Control flow (try/catch/finally) - Phase 4
  tryBlocks?: TryBlockInfo[];
  catchBlocks?: CatchBlockInfo[];
  finallyBlocks?: FinallyBlockInfo[];
  tryBlockCounterRef?: CounterRef;
  catchBlockCounterRef?: CounterRef;
  finallyBlockCounterRef?: CounterRef;
  variableDeclarations: VariableDeclarationInfo[];
  callSites: CallSiteInfo[];
  methodCalls: MethodCallInfo[];
  eventListeners: EventListenerInfo[];
  classInstantiations: ClassInstantiationInfo[];
  classDeclarations: ClassDeclarationInfo[];
  methodCallbacks: MethodCallbackInfo[];
  callArguments: CallArgumentInfo[];
  imports: ImportInfo[];
  exports: ExportInfo[];
  httpRequests: HttpRequestInfo[];
  literals: LiteralInfo[];
  variableAssignments: VariableAssignmentInfo[];
  // TypeScript-specific collections
  interfaces: InterfaceDeclarationInfo[];
  typeAliases: TypeAliasInfo[];
  enums: EnumDeclarationInfo[];
  decorators: DecoratorInfo[];
  // Type parameter tracking for generics (REG-303)
  typeParameters: TypeParameterInfo[];
  // Object/Array literal tracking
  objectLiterals: ObjectLiteralInfo[];
  objectProperties: ObjectPropertyInfo[];
  arrayLiterals: ArrayLiteralInfo[];
  arrayElements: ArrayElementInfo[];
  // Array mutation tracking for FLOWS_INTO edges
  arrayMutations: ArrayMutationInfo[];
  // Object mutation tracking for FLOWS_INTO edges
  objectMutations: ObjectMutationInfo[];
  // Variable reassignment tracking for FLOWS_INTO edges (REG-290)
  variableReassignments: VariableReassignmentInfo[];
  // Return statement tracking for RETURNS edges
  returnStatements: ReturnStatementInfo[];
  // Update expression tracking for MODIFIES edges (REG-288, REG-312)
  updateExpressions: UpdateExpressionInfo[];
  // Promise resolution tracking for RESOLVES_TO edges (REG-334)
  promiseResolutions: PromiseResolutionInfo[];
  // Promise executor contexts (REG-334) - keyed by executor function's start:end position
  promiseExecutorContexts: Map<string, PromiseExecutorContext>;
  // Yield expression tracking for YIELDS/DELEGATES_TO edges (REG-270)
  yieldExpressions: YieldExpressionInfo[];
  // Property access tracking for PROPERTY_ACCESS nodes (REG-395)
  propertyAccesses: PropertyAccessInfo[];
  propertyAccessCounterRef: CounterRef;
  objectLiteralCounterRef: CounterRef;
  arrayLiteralCounterRef: CounterRef;
  ifScopeCounterRef: CounterRef;
  scopeCounterRef: CounterRef;
  varDeclCounterRef: CounterRef;
  callSiteCounterRef: CounterRef;
  functionCounterRef: CounterRef;
  httpRequestCounterRef: CounterRef;
  literalCounterRef: CounterRef;
  anonymousFunctionCounterRef: CounterRef;
  branchCounterRef: CounterRef;
  caseCounterRef: CounterRef;
  processedNodes: ProcessedNodes;
  code?: string;
  // VisitorCollections compatibility
  classes: ClassDeclarationInfo[];
  methods: FunctionInfo[];
  variables: VariableDeclarationInfo[];
  sideEffects: unknown[];  // TODO: define SideEffectInfo
  variableCounterRef: CounterRef;
  // ScopeTracker for semantic ID generation
  scopeTracker?: ScopeTracker;
  [key: string]: unknown;
}

interface AnalysisManifest {
  projectPath: string;
  [key: string]: unknown;
}

interface AnalyzeContext extends PluginContext {
  manifest?: AnalysisManifest;
  forceAnalysis?: boolean;
  workerCount?: number;
  /** Enable parallel parsing using ASTWorkerPool (worker_threads) */
  parallelParsing?: boolean;
  // Use base onProgress type for compatibility
  onProgress?: (info: Record<string, unknown>) => void;
}

export class JSASTAnalyzer extends Plugin {
  private graphBuilder: GraphBuilder;
  private analyzedModules: Set<string>;
  private profiler: Profiler;
  private variableMutationProcessor = new VariableMutationProcessor();
  private arrayMutationProcessor = new ArrayMutationProcessor();
  private objectMutationProcessor = new ObjectMutationProcessor();
  private variableTrackingProcessor = new VariableTrackingProcessor();
  private controlFlowProcessor = new ControlFlowProcessor();
  private callExpressionProcessor: CallExpressionProcessor;
  private errorTrackingProcessor = new ErrorTrackingProcessor();
  private returnExpressionParser = new ReturnExpressionParser();
  private variableDeclarationProcessor: VariableDeclarationProcessor;

  constructor() {
    super();
    this.graphBuilder = new GraphBuilder();
    this.analyzedModules = new Set();
    this.profiler = new Profiler('JSASTAnalyzer');
    this.callExpressionProcessor = new CallExpressionProcessor(
      this.arrayMutationProcessor,
      this.objectMutationProcessor,
    );
    this.variableDeclarationProcessor = new VariableDeclarationProcessor(
      this.variableTrackingProcessor,
    );
  }

  get metadata(): PluginMetadata {
    return {
      name: 'JSASTAnalyzer',
      phase: 'ANALYSIS',
      creates: {
        nodes: [
          'FUNCTION', 'CLASS', 'METHOD', 'VARIABLE', 'CONSTANT', 'SCOPE',
          'CALL', 'IMPORT', 'EXPORT', 'LITERAL', 'EXTERNAL_MODULE',
          'net:stdio', 'net:request', 'event:listener', 'http:request',
          // TypeScript-specific nodes
          'INTERFACE', 'TYPE', 'ENUM', 'DECORATOR', 'TYPE_PARAMETER'
        ],
        edges: [
          'CONTAINS', 'DECLARES', 'CALLS', 'HAS_SCOPE', 'CAPTURES', 'MODIFIES',
          'WRITES_TO', 'IMPORTS', 'INSTANCE_OF', 'HANDLED_BY', 'HAS_CALLBACK',
          'PASSES_ARGUMENT', 'MAKES_REQUEST', 'IMPORTS_FROM', 'EXPORTS_TO', 'ASSIGNED_FROM',
          // TypeScript-specific edges
          'IMPLEMENTS', 'EXTENDS', 'DECORATED_BY', 'HAS_TYPE_PARAMETER',
          // Promise data flow
          'RESOLVES_TO'
        ]
      },
      dependencies: ['JSModuleIndexer'],
      fields: [
        { name: 'object', fieldType: 'string', nodeTypes: ['CALL'] },
        { name: 'method', fieldType: 'string', nodeTypes: ['CALL'] },
        { name: 'async', fieldType: 'bool', nodeTypes: ['FUNCTION', 'METHOD'] },
        { name: 'scopeType', fieldType: 'string', nodeTypes: ['SCOPE'] },
        { name: 'importType', fieldType: 'string', nodeTypes: ['IMPORT'] },
        { name: 'exportType', fieldType: 'string', nodeTypes: ['EXPORT'] },
        { name: 'parentScopeId', fieldType: 'id', nodeTypes: ['FUNCTION', 'METHOD', 'SCOPE', 'VARIABLE'] },
      ]
    };
  }

  /**
   * Вычисляет хеш содержимого файла
   */
  calculateFileHash(filePath: string, projectPath: string = ''): string | null {
    try {
      const content = readFileSync(resolveNodeFile(filePath, projectPath), 'utf-8');
      return createHash('sha256').update(content).digest('hex');
    } catch {
      return null;
    }
  }

  /**
   * Проверяет нужно ли анализировать модуль (сравнивает хеши)
   */
  async shouldAnalyzeModule(module: ModuleNode, graph: GraphBackend, forceAnalysis: boolean, projectPath: string = ""): Promise<boolean> {
    if (forceAnalysis) {
      return true;
    }

    if (!module.contentHash) {
      return true;
    }

    const currentHash = this.calculateFileHash(module.file, projectPath);
    if (!currentHash) {
      return true;
    }

    if (currentHash !== module.contentHash) {
      await graph.addNode(brandNodeInternal({
        id: module.id,
        type: 'MODULE' as const,
        name: module.name,
        file: module.file,
        contentHash: currentHash
      }));
      return true;
    }

    // Hash matches - check if module was actually analyzed (has FUNCTION nodes)
    if (graph.queryNodes) {
      for await (const _node of graph.queryNodes({ type: 'FUNCTION', file: module.file })) {
        // Found at least one function - module was analyzed, skip
        return false;
      }
    }
    // No functions found - need to analyze
    return true;
  }

  async execute(context: AnalyzeContext): Promise<PluginResult> {
    const logger = this.log(context);

    try {
      const { manifest, graph, forceAnalysis = false } = context;
      const projectPath = manifest?.projectPath ?? '';

      if (forceAnalysis) {
        this.analyzedModules.clear();
      }

      const allModules = await this.getModuleNodes(graph);

      const modulesToAnalyze: ModuleNode[] = [];
      let skippedCount = 0;

      for (const module of allModules) {
        if (this.analyzedModules.has(module.id)) {
          skippedCount++;
          continue;
        }

        if (await this.shouldAnalyzeModule(module, graph, forceAnalysis, projectPath)) {
          modulesToAnalyze.push(module);
        } else {
          skippedCount++;
        }
      }

      logger.info('Starting module analysis', { toAnalyze: modulesToAnalyze.length, cached: skippedCount });

      if (modulesToAnalyze.length === 0) {
        logger.info('All modules up-to-date, skipping analysis');
        return createSuccessResult({ nodes: 0, edges: 0 });
      }

      // Use ASTWorkerPool for true parallel parsing with worker_threads if enabled
      if (context.parallelParsing) {
        return await this.executeParallel(modulesToAnalyze, graph, projectPath, context);
      }

      const queue = new PriorityQueue();
      const pool = new WorkerPool(context.workerCount || 10);

      pool.registerHandler('ANALYZE_MODULE', async (task) => {
        return await this.analyzeModule(task.data.module, graph, projectPath);
      });

      for (const module of modulesToAnalyze) {
        this.analyzedModules.add(module.id);

        const task = new Task({
          id: `analyze:${module.id}`,
          type: 'ANALYZE_MODULE',
          priority: 80,
          data: { module }
        });
        queue.add(task);
      }

      let completed = 0;
      let currentFile = '';

      const progressInterval = setInterval(() => {
        if (context.onProgress && completed > 0) {
          context.onProgress({
            phase: 'analysis',
            currentPlugin: 'JSASTAnalyzer',
            message: `Analyzing ${currentFile} (${completed}/${modulesToAnalyze.length})`,
            totalFiles: modulesToAnalyze.length,
            processedFiles: completed
          });
        }
      }, 500);

      pool.on('worker:task:started', (task: Task) => {
        currentFile = task.data.module.file?.replace(projectPath, '') || task.data.module.id;
      });

      pool.on('worker:task:completed', () => {
        completed++;

        if (completed % 10 === 0 || completed === modulesToAnalyze.length) {
          logger.debug('Analysis progress', { completed, total: modulesToAnalyze.length });
        }
      });

      await pool.processQueue(queue);

      clearInterval(progressInterval);

      if (context.onProgress) {
        context.onProgress({
          phase: 'analysis',
          currentPlugin: 'JSASTAnalyzer',
          totalFiles: modulesToAnalyze.length,
          processedFiles: completed
        });
      }

      const stats = queue.getStats();
      let nodesCreated = 0;
      let edgesCreated = 0;

      for (const task of queue.getCompletedTasks()) {
        if (isAnalysisResult(task.result)) {
          nodesCreated += task.result.nodes;
          edgesCreated += task.result.edges;
        }
      }

      logger.info('Analysis complete', { modulesAnalyzed: modulesToAnalyze.length, nodesCreated });
      logger.debug('Worker stats', { ...stats });

      this.profiler.printSummary();

      return createSuccessResult(
        { nodes: nodesCreated, edges: edgesCreated },
        { modulesAnalyzed: modulesToAnalyze.length, workerStats: stats }
      );

    } catch (error) {
      logger.error('Analysis failed', { error: error instanceof Error ? error.message : String(error) });
      const err = error instanceof Error ? error : new Error(String(error));
      return createErrorResult(err);
    }
  }

  /**
   * Execute parallel analysis using ASTWorkerPool (worker_threads).
   *
   * This method uses actual OS threads for true parallel CPU-intensive parsing.
   * Workers generate semantic IDs using ScopeTracker, matching sequential behavior.
   *
   * @param modules - Modules to analyze
   * @param graph - Graph backend for writing results
   * @param projectPath - Project root path
   * @param context - Analysis context with options
   * @returns Plugin result with node/edge counts
   */
  private async executeParallel(
    modules: ModuleNode[],
    graph: GraphBackend,
    projectPath: string,
    context: AnalyzeContext
  ): Promise<PluginResult> {
    const logger = this.log(context);
    const workerCount = context.workerCount || 4;
    const pool = new ASTWorkerPool(workerCount);

    logger.debug('Starting parallel parsing', { workerCount });

    try {
      await pool.init();

      // Convert ModuleNode to ASTModuleInfo format
      const moduleInfos: ASTModuleInfo[] = modules.map(m => ({
        id: m.id,
        file: resolveNodeFile(m.file, projectPath),
        name: m.name
      }));

      // Parse all modules in parallel using worker threads
      const results: ParseResult[] = await pool.parseModules(moduleInfos);

      let nodesCreated = 0;
      let edgesCreated = 0;
      let errors = 0;

      // Process results - collections already have semantic IDs from workers
      for (const result of results) {
        if (result.error) {
          logger.warn('Parse error', { file: result.module.file, error: result.error.message });
          errors++;
          continue;
        }

        if (result.collections) {
          // Find original module for metadata
          const module = modules.find(m => m.id === result.module.id);
          if (!module) continue;

          // Pass collections directly to GraphBuilder - IDs already semantic
          // Cast is safe because ASTWorker.ASTCollections is structurally compatible
          // with ast/types.ASTCollections (METHOD extends FUNCTION semantically)
          const buildResult = await this.graphBuilder.build(
            module,
            graph,
            projectPath,
            result.collections as unknown as ASTCollections
          );

          if (typeof buildResult === 'object' && buildResult !== null) {
            nodesCreated += (buildResult as { nodes: number }).nodes || 0;
            edgesCreated += (buildResult as { edges: number }).edges || 0;
          }
        }

        // Report progress
        if (context.onProgress) {
          context.onProgress({
            phase: 'analysis',
            currentPlugin: 'JSASTAnalyzer',
            message: `Processed ${result.module.name}`,
            totalFiles: modules.length,
            processedFiles: results.indexOf(result) + 1
          });
        }
      }

      logger.info('Parallel parsing complete', { nodesCreated, edgesCreated, errors });

      return createSuccessResult(
        { nodes: nodesCreated, edges: edgesCreated },
        { modulesAnalyzed: modules.length - errors, parallelParsing: true }
      );
    } finally {
      await pool.terminate();
    }
  }

  /**
   * Extract variable names from destructuring patterns
   * Uses t.isX() type guards to avoid casts
   *
   * REG-399: Delegated to extractNamesFromPattern utility for code reuse with parameters.
   * This method maintains the same API for backward compatibility.
   */
  extractVariableNamesFromPattern(pattern: t.Node | null | undefined, variables: ExtractedVariable[] = [], propertyPath: string[] = []): ExtractedVariable[] {
    // Delegate to the extracted utility function
    return extractNamesFromPattern(pattern, variables, propertyPath);
  }

  /**
   * Отслеживает присваивание переменной для data flow анализа.
   * Delegates to VariableTrackingProcessor (REG-460 Phase 3).
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
    this.variableTrackingProcessor.trackVariableAssignment(initNode, variableId, variableName, module, line, literals, variableAssignments, literalCounterRef, objectLiterals, objectProperties, objectLiteralCounterRef);
  }

  /**
   * Tracks destructuring assignments for data flow analysis.
   * Delegates to VariableTrackingProcessor (REG-460 Phase 3).
   */
  private trackDestructuringAssignment(
    pattern: t.ObjectPattern | t.ArrayPattern,
    initNode: t.Expression | null | undefined,
    variables: Array<ExtractedVariable & { id: string }>,
    module: VisitorModule,
    variableAssignments: VariableAssignmentInfo[]
  ): void {
    this.variableTrackingProcessor.trackDestructuringAssignment(pattern, initNode, variables, module, variableAssignments);
  }

  /**
   * Получить все MODULE ноды из графа
   */
  private async getModuleNodes(graph: GraphBackend): Promise<ModuleNode[]> {
    const modules: ModuleNode[] = [];
    for await (const node of graph.queryNodes({ type: 'MODULE' })) {
      modules.push(node as unknown as ModuleNode);
    }
    return modules;
  }

  /**
   * Анализировать один модуль.
   *
   * REG-460 Phase 10: Collection initialization, visitor composition, and
   * traversal are delegated to CollectionFactory and VisitorComposer.
   * This method orchestrates: parse -> init -> traverse -> build graph.
   */
  async analyzeModule(module: ModuleNode, graph: GraphBackend, projectPath: string): Promise<{ nodes: number; edges: number }> {
    let nodesCreated = 0;
    let edgesCreated = 0;

    try {
      // 1. Read and parse source file
      this.profiler.start('file_read');
      const code = readFileSync(resolveNodeFile(module.file, projectPath), 'utf-8');
      this.profiler.end('file_read');

      this.profiler.start('babel_parse');
      const ast = parse(code, {
        sourceType: 'module',
        plugins: ['jsx', 'typescript', 'decorators-legacy']
      });
      this.profiler.end('babel_parse');

      // 2. Initialize collections, counters, and processedNodes via factories
      const scopeTracker = new ScopeTracker(basename(module.file));
      const arrays = createAnalysisCollections();
      const counters = createCounterRefs();
      const processedNodes = createProcessedNodes();

      // 3. Assemble the unified collections object used by all visitors
      const allCollections = assembleCollections(
        arrays, counters, processedNodes, code, module.id, scopeTracker
      ) as Collections;

      // 4. Run all visitor traversals via VisitorComposer
      const { hasTopLevelAwait } = composeAndTraverse(
        ast, traverse, module, allCollections, scopeTracker, this as unknown as Parameters<typeof composeAndTraverse>[5], this.profiler
      );

      // 5. Build graph from collected data
      this.profiler.start('graph_build');
      const result = await this.graphBuilder.build(module, graph, projectPath, {
        functions: arrays.functions,
        scopes: arrays.scopes,
        branches: arrays.branches,
        cases: arrays.cases,
        loops: arrays.loops,
        tryBlocks: allCollections.tryBlocks,
        catchBlocks: allCollections.catchBlocks,
        finallyBlocks: allCollections.finallyBlocks,
        variableDeclarations: arrays.variableDeclarations,
        callSites: arrays.callSites,
        methodCalls: arrays.methodCalls,
        eventListeners: arrays.eventListeners,
        classInstantiations: arrays.classInstantiations,
        constructorCalls: arrays.constructorCalls,
        classDeclarations: arrays.classDeclarations,
        methodCallbacks: arrays.methodCallbacks,
        callArguments: arrays.callArguments,
        imports: arrays.imports,
        exports: arrays.exports,
        httpRequests: arrays.httpRequests,
        literals: arrays.literals,
        variableAssignments: arrays.variableAssignments,
        parameters: arrays.parameters,
        interfaces: arrays.interfaces,
        typeAliases: arrays.typeAliases,
        enums: arrays.enums,
        decorators: arrays.decorators,
        typeParameters: arrays.typeParameters,
        arrayMutations: arrays.arrayMutations,
        objectMutations: arrays.objectMutations,
        variableReassignments: arrays.variableReassignments,
        returnStatements: arrays.returnStatements,
        yieldExpressions: arrays.yieldExpressions,
        updateExpressions: arrays.updateExpressions,
        promiseResolutions: arrays.promiseResolutions,
        objectLiterals: arrays.objectLiterals,
        objectProperties: arrays.objectProperties,
        arrayLiterals: arrays.arrayLiterals,
        rejectionPatterns: arrays.rejectionPatterns,
        catchesFromInfos: arrays.catchesFromInfos,
        propertyAccesses: arrays.propertyAccesses,
        hasTopLevelAwait
      });
      this.profiler.end('graph_build');

      nodesCreated = result.nodes;
      edgesCreated = result.edges;

    } catch {
      // Error analyzing module - silently skip, caller handles the result
    }

    return { nodes: nodesCreated, edges: edgesCreated };
  }

  /** Delegates to generateSemanticId util (REG-460 Phase 9) */
  private generateSemanticId(scopeType: string, scopeTracker: ScopeTracker | undefined): string | undefined {
    return generateSemanticId(scopeType, scopeTracker);
  }

  /** Delegates to generateAnonymousName util (REG-460 Phase 9) */
  private generateAnonymousName(scopeTracker: ScopeTracker | undefined): string {
    return generateAnonymousName(scopeTracker);
  }

  /**
   * Factory method to create loop scope handlers.
   * All loop statements (for, for-in, for-of, while, do-while) follow the same pattern:
   * 1. Create scope with SCOPE#<scopeType>#file#line:counter
   * 2. Generate semantic ID
   * 3. Push to scopes array
   * 4. Enter/exit scope tracker
   *
   * @param trackerScopeType - Scope type for ScopeTracker (e.g., 'for', 'for-in', 'while')
   * @param scopeType - Scope type for the graph node (e.g., 'for-loop', 'for-in-loop')
   * @param parentScopeId - Parent scope ID for the scope node
   * @param module - Module context
   * @param scopes - Collection to push scope nodes to
   * @param scopeCounterRef - Counter for unique scope IDs
   * @param scopeTracker - Tracker for semantic ID generation
   */

  /** Delegates to VariableDeclarationProcessor (REG-460 Phase 8) */
  private handleVariableDeclaration(
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
    this.variableDeclarationProcessor.handleVariableDeclaration(varPath, parentScopeId, module, variableDeclarations, classInstantiations, literals, variableAssignments, varDeclCounterRef, literalCounterRef, scopeTracker, parentScopeVariables, objectLiterals, objectProperties, objectLiteralCounterRef);
  }


  /** Delegates to ControlFlowProcessor (REG-460 Phase 4) */
  handleSwitchStatement(
    switchPath: NodePath<t.SwitchStatement>,
    parentScopeId: string,
    module: VisitorModule,
    collections: VisitorCollections,
    scopeTracker: ScopeTracker | undefined,
    controlFlowState?: { branchCount: number; caseCount: number }
  ): void {
    this.controlFlowProcessor.handleSwitchStatement(
      switchPath, parentScopeId, module, collections, scopeTracker, controlFlowState
    );
  }

  extractDiscriminantExpression(
    discriminant: t.Expression,
    module: VisitorModule
  ): { id: string; expressionType: string; line: number; column: number } {
    return extractDiscriminantExpression(discriminant, module);
  }

  countLogicalOperators(node: t.Expression): number {
    return countLogicalOperators(node);
  }

  memberExpressionToString(expr: t.MemberExpression): string {
    return memberExpressionToString(expr);
  }

  /** Delegates to ReturnExpressionParser (REG-460 Phase 7) */
  extractReturnExpressionInfo(
    expr: t.Expression,
    module: { file: string },
    literals: LiteralInfo[],
    literalCounterRef: CounterRef,
    baseLine: number,
    baseColumn: number,
    literalIdSuffix: 'return' | 'implicit_return' | 'yield' = 'return'
  ): Partial<ReturnStatementInfo> {
    return this.returnExpressionParser.extractReturnExpressionInfo(
      expr, module, literals, literalCounterRef, baseLine, baseColumn, literalIdSuffix
    );
  }


  /**
   * Анализирует тело функции и извлекает переменные, вызовы, условные блоки.
   * Uses ScopeTracker from collections for semantic ID generation.
   *
   * REG-422: Delegates traversal to extracted handler classes.
   * Local state is encapsulated in FunctionBodyContext; each handler
   * contributes a Visitor fragment that is merged into a single traversal.
   */
  analyzeFunctionBody(
    funcPath: NodePath<t.Function | t.StaticBlock>,
    parentScopeId: string,
    module: VisitorModule,
    collections: VisitorCollections
  ): void {
    // 1. Create context (replaces ~260 lines of local var declarations)
    const ctx = createFunctionBodyContext(
      funcPath, parentScopeId, module, collections,
      (collections.functions ?? []) as FunctionInfo[],
      extractNamesFromPattern
    );

    // 2. Handle implicit return for THIS arrow function if it has an expression body
    // e.g., `const double = x => x * 2;` — this needs this.extractReturnExpressionInfo,
    // so it stays here rather than in a handler.
    if (t.isArrowFunctionExpression(ctx.funcNode) && !t.isBlockStatement(ctx.funcNode.body) && ctx.currentFunctionId) {
      const bodyExpr = ctx.funcNode.body;
      const exprInfo = this.extractReturnExpressionInfo(
        bodyExpr, module, ctx.literals, ctx.literalCounterRef, ctx.funcLine, ctx.funcColumn, 'implicit_return'
      );
      ctx.returnStatements.push({
        parentFunctionId: ctx.currentFunctionId,
        file: module.file,
        line: getLine(bodyExpr),
        column: getColumn(bodyExpr),
        returnValueType: 'NONE',
        isImplicitReturn: true,
        ...exprInfo,
      });
    }

    // 3. Create handlers and merge their visitors into a single traversal
    // Cast to AnalyzerDelegate — the interface declares the same methods that exist
    // on this class as private. The cast is safe because the shape matches exactly.
    const delegate = this as unknown as AnalyzerDelegate;
    const handlers: FunctionBodyHandler[] = [
      new VariableHandler(ctx, delegate),
      new ReturnYieldHandler(ctx, delegate),
      new ThrowHandler(ctx, delegate),
      new NestedFunctionHandler(ctx, delegate),
      new PropertyAccessHandler(ctx, delegate),
      new NewExpressionHandler(ctx, delegate),
      new CallExpressionHandler(ctx, delegate),
      new LoopHandler(ctx, delegate),
      new TryCatchHandler(ctx, delegate),
      new BranchHandler(ctx, delegate),
    ];

    const mergedVisitor: Visitor = {};
    for (const handler of handlers) {
      Object.assign(mergedVisitor, handler.getHandlers());
    }

    // 4. Single traversal over the function body
    funcPath.traverse(mergedVisitor);

    // 5. Post-traverse: collect CATCHES_FROM info for try/catch blocks
    if (ctx.functionPath) {
      this.collectCatchesFromInfo(
        ctx.functionPath,
        ctx.catchBlocks,
        ctx.callSites,
        ctx.methodCalls,
        ctx.constructorCalls,
        ctx.catchesFromInfos,
        module
      );
    }

    // 6. Post-traverse: Attach control flow metadata to the function node
    this.attachControlFlowMetadata(ctx);
  }

  /**
   * Attach control flow metadata (cyclomatic complexity, error tracking, HOF bindings)
   * to the matching function node after traversal completes.
   */
  private attachControlFlowMetadata(ctx: FunctionBodyContext): void {
    if (!ctx.matchingFunction) return;

    const cyclomaticComplexity = 1 +
      ctx.controlFlowState.branchCount +
      ctx.controlFlowState.loopCount +
      ctx.controlFlowState.caseCount +
      ctx.controlFlowState.logicalOpCount;

    // REG-311: Collect rejection info for this function
    const functionRejectionPatterns = ctx.rejectionPatterns.filter(p => p.functionId === ctx.matchingFunction!.id);
    const asyncPatterns = functionRejectionPatterns.filter(p => p.isAsync);
    const syncPatterns = functionRejectionPatterns.filter(p => !p.isAsync);
    const canReject = asyncPatterns.length > 0;
    const hasAsyncThrow = asyncPatterns.some(p => p.rejectionType === 'async_throw');
    const rejectedBuiltinErrors = [...new Set(
      asyncPatterns
        .filter(p => p.errorClassName !== null)
        .map(p => p.errorClassName!)
    )];
    // REG-286: Sync throw error tracking
    const thrownBuiltinErrors = [...new Set(
      syncPatterns
        .filter(p => p.errorClassName !== null)
        .map(p => p.errorClassName!)
    )];

    ctx.matchingFunction.controlFlow = {
      hasBranches: ctx.controlFlowState.branchCount > 0,
      hasLoops: ctx.controlFlowState.loopCount > 0,
      hasTryCatch: ctx.controlFlowState.hasTryCatch,
      hasEarlyReturn: ctx.controlFlowState.hasEarlyReturn,
      hasThrow: ctx.controlFlowState.hasThrow,
      cyclomaticComplexity,
      // REG-311: Async error tracking
      canReject,
      hasAsyncThrow,
      rejectedBuiltinErrors: rejectedBuiltinErrors.length > 0 ? rejectedBuiltinErrors : undefined,
      // REG-286: Sync throw tracking
      thrownBuiltinErrors: thrownBuiltinErrors.length > 0 ? thrownBuiltinErrors : undefined
    };

    // REG-401: Store invoked parameter indexes for user-defined HOF detection
    if (ctx.invokedParamIndexes.size > 0) {
      ctx.matchingFunction.invokesParamIndexes = [...ctx.invokedParamIndexes];
    }
    // REG-417: Store property paths for destructured param bindings
    if (ctx.invokesParamBindings.length > 0) {
      ctx.matchingFunction.invokesParamBindings = ctx.invokesParamBindings;
    }
  }

  private handleCallExpression(
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
    this.callExpressionProcessor.handleCallExpression(
      callNode, processedCallSites, processedMethodCalls,
      callSites, methodCalls, module, callSiteCounterRef,
      scopeTracker, parentScopeId, collections,
      isAwaited, isInsideTry, isInsideLoop
    );
  }

  /** Delegates to ErrorTrackingProcessor (REG-460 Phase 6) */
  microTraceToErrorClass(
    variableName: string,
    funcPath: NodePath<t.Function>,
    variableDeclarations: VariableDeclarationInfo[]
  ): { errorClassName: string | null; tracePath: string[] } {
    return this.errorTrackingProcessor.microTraceToErrorClass(variableName, funcPath, variableDeclarations);
  }

  /** Delegates to ErrorTrackingProcessor (REG-460 Phase 6) */
  collectCatchesFromInfo(
    funcPath: NodePath<t.Function>,
    catchBlocks: CatchBlockInfo[],
    callSites: CallSiteInfo[],
    methodCalls: MethodCallInfo[],
    constructorCalls: ConstructorCallInfo[],
    catchesFromInfos: CatchesFromInfo[],
    module: VisitorModule
  ): void {
    this.errorTrackingProcessor.collectCatchesFromInfo(
      funcPath, catchBlocks, callSites, methodCalls, constructorCalls, catchesFromInfos, module
    );
  }

  private detectIndexedArrayAssignment(
    assignNode: t.AssignmentExpression,
    module: VisitorModule,
    arrayMutations: ArrayMutationInfo[],
    scopeTracker?: ScopeTracker,
    collections?: VisitorCollections
  ): void {
    this.arrayMutationProcessor.detectIndexedArrayAssignment(assignNode, module, arrayMutations, scopeTracker, collections);
  }

  private detectObjectPropertyAssignment(
    assignNode: t.AssignmentExpression,
    module: VisitorModule,
    objectMutations: ObjectMutationInfo[],
    scopeTracker?: ScopeTracker
  ): void {
    this.objectMutationProcessor.detectObjectPropertyAssignment(assignNode, module, objectMutations, scopeTracker);
  }

  private collectUpdateExpression(
    updateNode: t.UpdateExpression,
    module: VisitorModule,
    updateExpressions: UpdateExpressionInfo[],
    parentScopeId: string | undefined,
    scopeTracker?: ScopeTracker
  ): void {
    this.variableMutationProcessor.collectUpdateExpression(updateNode, module, updateExpressions, parentScopeId, scopeTracker);
  }

  private detectVariableReassignment(
    assignNode: t.AssignmentExpression,
    module: VisitorModule,
    variableReassignments: VariableReassignmentInfo[],
    scopeTracker?: ScopeTracker
  ): void {
    this.variableMutationProcessor.detectVariableReassignment(assignNode, module, variableReassignments, scopeTracker);
  }

}
