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
import { ExpressionEvaluator } from './ast/ExpressionEvaluator.js';
import { GraphBuilder } from './ast/GraphBuilder.js';
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
  type TrackVariableAssignmentCallback
} from './ast/visitors/index.js';
import { Task } from '../../core/Task.js';
import { PriorityQueue } from '../../core/PriorityQueue.js';
import { WorkerPool } from '../../core/WorkerPool.js';
import { ASTWorkerPool, type ModuleInfo as ASTModuleInfo, type ParseResult } from '../../core/ASTWorkerPool.js';
import { ConditionParser } from './ast/ConditionParser.js';
import { getLine, getColumn } from './ast/utils/location.js';
import { Profiler } from '../../core/Profiler.js';
import { ScopeTracker } from '../../core/ScopeTracker.js';
import { computeSemanticId } from '../../core/SemanticId.js';
import { ConstructorCallNode } from '../../core/nodes/ConstructorCallNode.js';
import { NodeFactory } from '../../core/NodeFactory.js';
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
  RejectionPatternInfo,
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

  constructor() {
    super();
    this.graphBuilder = new GraphBuilder();
    this.analyzedModules = new Set();
    this.profiler = new Profiler('JSASTAnalyzer');
    this.callExpressionProcessor = new CallExpressionProcessor(
      this.arrayMutationProcessor,
      this.objectMutationProcessor,
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
   * Анализировать один модуль
   */
  async analyzeModule(module: ModuleNode, graph: GraphBackend, projectPath: string): Promise<{ nodes: number; edges: number }> {
    let nodesCreated = 0;
    let edgesCreated = 0;

    try {
      this.profiler.start('file_read');
      const code = readFileSync(resolveNodeFile(module.file, projectPath), 'utf-8');
      this.profiler.end('file_read');

      this.profiler.start('babel_parse');
      const ast = parse(code, {
        sourceType: 'module',
        plugins: ['jsx', 'typescript', 'decorators-legacy']
      });
      this.profiler.end('babel_parse');

      // Create ScopeTracker for semantic ID generation
      // Use basename for shorter, more readable semantic IDs
      const scopeTracker = new ScopeTracker(basename(module.file));

      const functions: FunctionInfo[] = [];
      const parameters: ParameterInfo[] = [];
      const scopes: ScopeInfo[] = [];
      // Branching (switch statements)
      const branches: BranchInfo[] = [];
      const cases: CaseInfo[] = [];
      // Control flow (loops)
      const loops: LoopInfo[] = [];
      const variableDeclarations: VariableDeclarationInfo[] = [];
      const callSites: CallSiteInfo[] = [];
      const methodCalls: MethodCallInfo[] = [];
      const eventListeners: EventListenerInfo[] = [];
      const classInstantiations: ClassInstantiationInfo[] = [];
      const constructorCalls: ConstructorCallInfo[] = [];
      const classDeclarations: ClassDeclarationInfo[] = [];
      const methodCallbacks: MethodCallbackInfo[] = [];
      const callArguments: CallArgumentInfo[] = [];
      const imports: ImportInfo[] = [];
      const exports: ExportInfo[] = [];
      const httpRequests: HttpRequestInfo[] = [];
      const literals: LiteralInfo[] = [];
      const variableAssignments: VariableAssignmentInfo[] = [];
      // TypeScript-specific collections
      const interfaces: InterfaceDeclarationInfo[] = [];
      const typeAliases: TypeAliasInfo[] = [];
      const enums: EnumDeclarationInfo[] = [];
      const decorators: DecoratorInfo[] = [];
      // Type parameter tracking for generics (REG-303)
      const typeParameters: TypeParameterInfo[] = [];
      // Object/Array literal tracking for data flow
      const objectLiterals: ObjectLiteralInfo[] = [];
      const objectProperties: ObjectPropertyInfo[] = [];
      const arrayLiterals: ArrayLiteralInfo[] = [];
      const arrayElements: ArrayElementInfo[] = [];
      // Array mutation tracking for FLOWS_INTO edges
      const arrayMutations: ArrayMutationInfo[] = [];
      // Object mutation tracking for FLOWS_INTO edges
      const objectMutations: ObjectMutationInfo[] = [];
      // Variable reassignment tracking for FLOWS_INTO edges (REG-290)
      const variableReassignments: VariableReassignmentInfo[] = [];
      // Return statement tracking for RETURNS edges
      const returnStatements: ReturnStatementInfo[] = [];
      // Update expression tracking for MODIFIES edges (REG-288, REG-312)
      const updateExpressions: UpdateExpressionInfo[] = [];
      // Promise resolution tracking for RESOLVES_TO edges (REG-334)
      const promiseResolutions: PromiseResolutionInfo[] = [];
      // Promise executor contexts (REG-334) - keyed by executor function's start:end position
      const promiseExecutorContexts = new Map<string, PromiseExecutorContext>();
      // Yield expression tracking for YIELDS/DELEGATES_TO edges (REG-270)
      const yieldExpressions: YieldExpressionInfo[] = [];
      // REG-311: Async error tracking
      const rejectionPatterns: RejectionPatternInfo[] = [];
      const catchesFromInfos: CatchesFromInfo[] = [];
      // Property access tracking for PROPERTY_ACCESS nodes (REG-395)
      const propertyAccesses: PropertyAccessInfo[] = [];

      const ifScopeCounterRef: CounterRef = { value: 0 };
      const scopeCounterRef: CounterRef = { value: 0 };
      const varDeclCounterRef: CounterRef = { value: 0 };
      const callSiteCounterRef: CounterRef = { value: 0 };
      const functionCounterRef: CounterRef = { value: 0 };
      const httpRequestCounterRef: CounterRef = { value: 0 };
      const literalCounterRef: CounterRef = { value: 0 };
      const anonymousFunctionCounterRef: CounterRef = { value: 0 };
      const objectLiteralCounterRef: CounterRef = { value: 0 };
      const arrayLiteralCounterRef: CounterRef = { value: 0 };
      const branchCounterRef: CounterRef = { value: 0 };
      const caseCounterRef: CounterRef = { value: 0 };
      const propertyAccessCounterRef: CounterRef = { value: 0 };

      const processedNodes: ProcessedNodes = {
        functions: new Set(),
        classes: new Set(),
        imports: new Set(),
        exports: new Set(),
        variables: new Set(),
        callSites: new Set(),
        methodCalls: new Set(),
        varDecls: new Set(),
        eventListeners: new Set()
      };

      // Imports/Exports
      this.profiler.start('traverse_imports');
      const importExportVisitor = new ImportExportVisitor(
        module,
        { imports, exports },
        this.extractVariableNamesFromPattern.bind(this)
      );
      traverse(ast, importExportVisitor.getImportHandlers());
      traverse(ast, importExportVisitor.getExportHandlers());
      this.profiler.end('traverse_imports');

      // Variables
      this.profiler.start('traverse_variables');
      const variableVisitor = new VariableVisitor(
        module,
        { variableDeclarations, classInstantiations, literals, variableAssignments, varDeclCounterRef, literalCounterRef, scopes, scopeCounterRef, objectLiterals, objectProperties, objectLiteralCounterRef },
        this.extractVariableNamesFromPattern.bind(this),
        this.trackVariableAssignment.bind(this) as TrackVariableAssignmentCallback,
        scopeTracker  // Pass ScopeTracker for semantic ID generation
      );
      traverse(ast, variableVisitor.getHandlers());
      this.profiler.end('traverse_variables');

      const allCollections: Collections = {
        functions, parameters, scopes,
        // Branching (switch statements)
        branches, cases,
        // Control flow (loops)
        loops,
        variableDeclarations, callSites, methodCalls,
        eventListeners, methodCallbacks, callArguments, classInstantiations, constructorCalls, classDeclarations,
        httpRequests, literals, variableAssignments,
        // TypeScript-specific collections
        interfaces, typeAliases, enums, decorators,
        // Type parameter tracking for generics (REG-303)
        typeParameters,
        // Object/Array literal tracking
        objectLiterals, objectProperties, arrayLiterals, arrayElements,
        // Array mutation tracking
        arrayMutations,
        // Object mutation tracking
        objectMutations,
        // Variable reassignment tracking (REG-290)
        variableReassignments,
        // Return statement tracking
        returnStatements,
        // Update expression tracking (REG-288, REG-312)
        updateExpressions,
        // Promise resolution tracking (REG-334)
        promiseResolutions,
        promiseExecutorContexts,
        // Yield expression tracking (REG-270)
        yieldExpressions,
        // REG-311: Async error tracking
        rejectionPatterns,
        catchesFromInfos,
        // Property access tracking (REG-395)
        propertyAccesses,
        propertyAccessCounterRef,
        objectLiteralCounterRef, arrayLiteralCounterRef,
        ifScopeCounterRef, scopeCounterRef, varDeclCounterRef,
        callSiteCounterRef, functionCounterRef, httpRequestCounterRef,
        literalCounterRef, anonymousFunctionCounterRef,
        branchCounterRef, caseCounterRef,
        processedNodes,
        imports, exports, code,
        // VisitorCollections compatibility
        classes: classDeclarations,
        methods: [],
        variables: variableDeclarations,
        sideEffects: [],
        variableCounterRef: varDeclCounterRef,
        // ScopeTracker for semantic ID generation
        scopeTracker
      };

      // Functions
      this.profiler.start('traverse_functions');
      const functionVisitor = new FunctionVisitor(
        module,
        allCollections,
        this.analyzeFunctionBody.bind(this),
        scopeTracker  // Pass ScopeTracker for semantic ID generation
      );
      traverse(ast, functionVisitor.getHandlers());
      this.profiler.end('traverse_functions');

      // AssignmentExpression (module-level function assignments)
      this.profiler.start('traverse_assignments');
      traverse(ast, {
        AssignmentExpression: (assignPath: NodePath<t.AssignmentExpression>) => {
          const assignNode = assignPath.node;
          const functionParent = assignPath.getFunctionParent();
          if (functionParent) return;

          if (assignNode.right &&
              (assignNode.right.type === 'FunctionExpression' ||
               assignNode.right.type === 'ArrowFunctionExpression')) {

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
            // Use semantic ID as primary ID (matching FunctionVisitor pattern)
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
              isAssignment: true
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
              parentFunctionId: functionId
            });

            const funcPath = assignPath.get('right') as NodePath<t.FunctionExpression | t.ArrowFunctionExpression>;
            // Enter function scope for semantic ID generation and analyze
            scopeTracker.enterScope(functionName, 'function');
            this.analyzeFunctionBody(funcPath, funcBodyScopeId, module, allCollections);
            scopeTracker.exitScope();
          }

          // === VARIABLE REASSIGNMENT (REG-290) ===
          // Check if LHS is simple identifier (not obj.prop, not arr[i])
          // Must be checked at module level too
          if (assignNode.left.type === 'Identifier') {
            // Initialize collection if not exists
            if (!allCollections.variableReassignments) {
              allCollections.variableReassignments = [];
            }
            const variableReassignments = allCollections.variableReassignments as VariableReassignmentInfo[];

            this.detectVariableReassignment(assignNode, module, variableReassignments, scopeTracker);
          }
          // === END VARIABLE REASSIGNMENT ===

          // Check for indexed array assignment at module level: arr[i] = value
          this.detectIndexedArrayAssignment(assignNode, module, arrayMutations, scopeTracker, allCollections);

          // Check for object property assignment at module level: obj.prop = value
          this.detectObjectPropertyAssignment(assignNode, module, objectMutations, scopeTracker);
        }
      });
      this.profiler.end('traverse_assignments');

      // Module-level UpdateExpression (obj.count++, arr[i]++, i++) - REG-288/REG-312
      this.profiler.start('traverse_updates');
      traverse(ast, {
        UpdateExpression: (updatePath: NodePath<t.UpdateExpression>) => {
          // Skip if inside a function - analyzeFunctionBody handles those
          const functionParent = updatePath.getFunctionParent();
          if (functionParent) return;

          // Module-level update expression: no parentScopeId
          this.collectUpdateExpression(updatePath.node, module, updateExpressions, undefined, scopeTracker);
        }
      });
      this.profiler.end('traverse_updates');

      // Classes
      this.profiler.start('traverse_classes');
      const classVisitor = new ClassVisitor(
        module,
        allCollections,
        this.analyzeFunctionBody.bind(this),
        scopeTracker  // Pass ScopeTracker for semantic ID generation
      );
      traverse(ast, classVisitor.getHandlers());
      this.profiler.end('traverse_classes');

      // TypeScript-specific constructs (interfaces, type aliases, enums)
      this.profiler.start('traverse_typescript');
      const typescriptVisitor = new TypeScriptVisitor(module, allCollections, scopeTracker);
      traverse(ast, typescriptVisitor.getHandlers());
      this.profiler.end('traverse_typescript');

      // Module-level callbacks
      this.profiler.start('traverse_callbacks');
      traverse(ast, {
        FunctionExpression: (funcPath: NodePath<t.FunctionExpression>) => {
          const funcNode = funcPath.node;
          const functionParent = funcPath.getFunctionParent();
          if (functionParent) return;

          if (funcPath.parent && funcPath.parent.type === 'CallExpression') {
            const funcName = funcNode.id ? funcNode.id.name : this.generateAnonymousName(scopeTracker);
            // Use semantic ID as primary ID (matching FunctionVisitor pattern)
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
              parentScopeId: module.id
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
              parentFunctionId: functionId
            });

            // Enter callback scope for semantic ID generation and analyze
            scopeTracker.enterScope(funcName, 'callback');
            this.analyzeFunctionBody(funcPath, callbackScopeId, module, allCollections);
            scopeTracker.exitScope();
            funcPath.skip();
          }
        }
      });
      this.profiler.end('traverse_callbacks');

      // Call expressions
      this.profiler.start('traverse_calls');
      const callExpressionVisitor = new CallExpressionVisitor(module, allCollections, scopeTracker);
      traverse(ast, callExpressionVisitor.getHandlers());
      this.profiler.end('traverse_calls');

      // REG-297: Detect top-level await expressions
      this.profiler.start('traverse_top_level_await');
      let hasTopLevelAwait = false;
      traverse(ast, {
        AwaitExpression(awaitPath: NodePath<t.AwaitExpression>) {
          if (!awaitPath.getFunctionParent()) {
            hasTopLevelAwait = true;
            awaitPath.stop();
          }
        },
        // for-await-of uses ForOfStatement.await, not AwaitExpression
        ForOfStatement(forOfPath: NodePath<t.ForOfStatement>) {
          if (forOfPath.node.await && !forOfPath.getFunctionParent()) {
            hasTopLevelAwait = true;
            forOfPath.stop();
          }
        }
      });
      this.profiler.end('traverse_top_level_await');

      // Property access expressions (REG-395)
      this.profiler.start('traverse_property_access');
      const propertyAccessVisitor = new PropertyAccessVisitor(module, allCollections, scopeTracker);
      traverse(ast, propertyAccessVisitor.getHandlers());
      this.profiler.end('traverse_property_access');

      // Module-level NewExpression (constructor calls)
      // This handles top-level code like `const x = new Date()` that's not inside a function
      this.profiler.start('traverse_new');
      const processedConstructorCalls = new Set<string>();
      traverse(ast, {
        NewExpression: (newPath: NodePath<t.NewExpression>) => {
          const newNode = newPath.node;
          const nodeKey = `constructor:new:${newNode.start}:${newNode.end}`;
          if (processedConstructorCalls.has(nodeKey)) {
            return;
          }
          processedConstructorCalls.add(nodeKey);

          // Determine className from callee
          let className: string | null = null;
          if (newNode.callee.type === 'Identifier') {
            className = newNode.callee.name;
          } else if (newNode.callee.type === 'MemberExpression' && newNode.callee.property.type === 'Identifier') {
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
              column
            });

            // REG-334: If this is Promise constructor with executor callback,
            // register the context for resolve/reject detection
            if (className === 'Promise' && newNode.arguments.length > 0) {
              const executorArg = newNode.arguments[0];

              // Only handle inline function expressions (not variable references)
              if (t.isArrowFunctionExpression(executorArg) || t.isFunctionExpression(executorArg)) {
                // Extract resolve/reject parameter names
                let resolveName: string | undefined;
                let rejectName: string | undefined;

                if (executorArg.params.length > 0 && t.isIdentifier(executorArg.params[0])) {
                  resolveName = executorArg.params[0].name;
                }
                if (executorArg.params.length > 1 && t.isIdentifier(executorArg.params[1])) {
                  rejectName = executorArg.params[1].name;
                }

                if (resolveName) {
                  // Key by function node position to allow nested Promise detection
                  const funcKey = `${executorArg.start}:${executorArg.end}`;
                  promiseExecutorContexts.set(funcKey, {
                    constructorCallId,
                    resolveName,
                    rejectName,
                    file: module.file,
                    line,
                    // REG-311: Module-level Promise has no creator function
                    creatorFunctionId: undefined
                  });
                }
              }
            }
          }
        }
      });
      this.profiler.end('traverse_new');

      // Module-level IfStatements
      this.profiler.start('traverse_ifs');
      traverse(ast, {
        IfStatement: (ifPath: NodePath<t.IfStatement>) => {
          const functionParent = ifPath.getFunctionParent();
          if (functionParent) return;

          const ifNode = ifPath.node;
          const condition = code.substring(ifNode.test.start!, ifNode.test.end!) || 'condition';
          const counterId = ifScopeCounterRef.value++;
          const ifScopeId = `SCOPE#if#${module.file}#${getLine(ifNode)}:${getColumn(ifNode)}:${counterId}`;

          const constraints = ConditionParser.parse(ifNode.test);
          const ifSemanticId = this.generateSemanticId('if_statement', scopeTracker);

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
            parentScopeId: module.id
          });

          if (ifNode.alternate && ifNode.alternate.type !== 'IfStatement') {
            const elseCounterId = ifScopeCounterRef.value++;
            const elseScopeId = `SCOPE#else#${module.file}#${getLine(ifNode.alternate)}:${getColumn(ifNode.alternate)}:${elseCounterId}`;

            const negatedConstraints = constraints.length > 0 ? ConditionParser.negate(constraints) : undefined;
            const elseSemanticId = this.generateSemanticId('else_statement', scopeTracker);

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
              parentScopeId: module.id
            });
          }
        }
      });
      this.profiler.end('traverse_ifs');

      // Build graph
      this.profiler.start('graph_build');
      const result = await this.graphBuilder.build(module, graph, projectPath, {
        functions,
        scopes,
        // Branching (switch statements) - use allCollections refs as they're populated by analyzeFunctionBody
        branches: allCollections.branches || branches,
        cases: allCollections.cases || cases,
        // Control flow (loops) - use allCollections refs as they're populated by analyzeFunctionBody
        loops: allCollections.loops || loops,
        // Control flow (try/catch/finally) - Phase 4
        tryBlocks: allCollections.tryBlocks,
        catchBlocks: allCollections.catchBlocks,
        finallyBlocks: allCollections.finallyBlocks,
        variableDeclarations,
        callSites,
        methodCalls,
        eventListeners,
        classInstantiations,
        constructorCalls,
        classDeclarations,
        methodCallbacks,
        // REG-334: Use allCollections.callArguments to include function-level resolve/reject arguments
        callArguments: allCollections.callArguments || callArguments,
        imports,
        exports,
        httpRequests,
        literals,
        variableAssignments,
        parameters,
        // TypeScript-specific collections
        interfaces,
        typeAliases,
        enums,
        decorators,
        // Type parameter tracking for generics (REG-303)
        typeParameters,
        // Array mutation tracking
        arrayMutations,
        // Object mutation tracking
        objectMutations,
        // Variable reassignment tracking (REG-290)
        variableReassignments,
        // Return statement tracking
        returnStatements,
        // Yield expression tracking (REG-270)
        yieldExpressions,
        // Update expression tracking (REG-288, REG-312)
        updateExpressions,
        // Promise resolution tracking (REG-334)
        promiseResolutions: allCollections.promiseResolutions || promiseResolutions,
        // Object/Array literal tracking - use allCollections refs as visitors may have created new arrays
        objectLiterals: allCollections.objectLiterals || objectLiterals,
        objectProperties: allCollections.objectProperties || objectProperties,
        arrayLiterals: allCollections.arrayLiterals || arrayLiterals,
        // REG-311: Async error tracking
        rejectionPatterns: Array.isArray(allCollections.rejectionPatterns)
          ? allCollections.rejectionPatterns as RejectionPatternInfo[]
          : rejectionPatterns,
        catchesFromInfos: Array.isArray(allCollections.catchesFromInfos)
          ? allCollections.catchesFromInfos as CatchesFromInfo[]
          : catchesFromInfos,
        // Property access tracking (REG-395)
        propertyAccesses: allCollections.propertyAccesses || propertyAccesses,
        // REG-297: Top-level await tracking
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

  /**
   * Helper to generate semantic ID for a scope using ScopeTracker.
   * Format: "scopePath:scopeType[index]" e.g. "MyClass->myMethod:if_statement[0]"
   */
  private generateSemanticId(
    scopeType: string,
    scopeTracker: ScopeTracker | undefined
  ): string | undefined {
    if (!scopeTracker) return undefined;

    const scopePath = scopeTracker.getScopePath();
    const siblingIndex = scopeTracker.getItemCounter(`semanticId:${scopeType}`);
    return `${scopePath}:${scopeType}[${siblingIndex}]`;
  }

  /**
   * Generate a unique anonymous function name within the current scope.
   * Uses ScopeTracker.getSiblingIndex() for stable naming.
   */
  private generateAnonymousName(scopeTracker: ScopeTracker | undefined): string {
    if (!scopeTracker) return 'anonymous';
    const index = scopeTracker.getSiblingIndex('anonymous');
    return `anonymous[${index}]`;
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

  /**
   * Handles VariableDeclaration nodes within function bodies.
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
    const varNode = varPath.node;
    const isConst = varNode.kind === 'const';

    // Check if this is a loop variable (for...of or for...in)
    const parent = varPath.parent;
    const isLoopVariable = (t.isForOfStatement(parent) || t.isForInStatement(parent)) && parent.left === varNode;

    varNode.declarations.forEach(declarator => {
      const variables = this.extractVariableNamesFromPattern(declarator.id);
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
          this.trackDestructuringAssignment(
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
              this.trackVariableAssignment(
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
          this.trackDestructuringAssignment(
            declarator.id,
            declarator.init,
            variablesWithIds,
            module,
            variableAssignments
          );
        } else {
          // Simple assignment: use existing tracking
          const varInfo = variablesWithIds[0];
          this.trackVariableAssignment(
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

  /**
   * Extract return expression info from an expression node.
   * Used for both explicit return statements and implicit arrow returns.
   *
   * This method consolidates ~450 lines of duplicated expression handling code
   * from three locations:
   * 1. Top-level implicit arrow returns (arrow function expression body)
   * 2. ReturnStatement handler (explicit returns)
   * 3. Nested arrow function implicit returns
   *
   * @param expr - The expression being returned
   * @param module - Module info for file context
   * @param literals - Collection to add literal nodes to
   * @param literalCounterRef - Counter for generating unique literal IDs
   * @param baseLine - Line number for literal ID generation
   * @param baseColumn - Column number for literal ID generation
   * @param literalIdSuffix - 'return' or 'implicit_return'
   * @returns Partial ReturnStatementInfo with expression-specific fields
   */
  private extractReturnExpressionInfo(
    expr: t.Expression,
    module: { file: string },
    literals: LiteralInfo[],
    literalCounterRef: CounterRef,
    baseLine: number,
    baseColumn: number,
    literalIdSuffix: 'return' | 'implicit_return' | 'yield' = 'return'
  ): Partial<ReturnStatementInfo> {
    const exprLine = getLine(expr);
    const exprColumn = getColumn(expr);

    // Identifier (variable reference)
    if (t.isIdentifier(expr)) {
      return {
        returnValueType: 'VARIABLE',
        returnValueName: expr.name,
      };
    }

    // TemplateLiteral must come BEFORE isLiteral (TemplateLiteral extends Literal)
    if (t.isTemplateLiteral(expr)) {
      const sourceNames: string[] = [];
      for (const embedded of expr.expressions) {
        if (t.isIdentifier(embedded)) {
          sourceNames.push(embedded.name);
        }
      }
      return {
        returnValueType: 'EXPRESSION',
        expressionType: 'TemplateLiteral',
        returnValueLine: exprLine,
        returnValueColumn: exprColumn,
        returnValueId: NodeFactory.generateExpressionId(
          'TemplateLiteral', module.file, exprLine, exprColumn
        ),
        ...(sourceNames.length > 0 ? { expressionSourceNames: sourceNames } : {}),
      };
    }

    // Literal values (after TemplateLiteral check)
    if (t.isLiteral(expr)) {
      const literalId = `LITERAL#${literalIdSuffix}#${module.file}#${baseLine}:${baseColumn}:${literalCounterRef.value++}`;
      literals.push({
        id: literalId,
        type: 'LITERAL',
        value: ExpressionEvaluator.extractLiteralValue(expr),
        valueType: typeof ExpressionEvaluator.extractLiteralValue(expr),
        file: module.file,
        line: exprLine,
        column: exprColumn,
      });
      return {
        returnValueType: 'LITERAL',
        returnValueId: literalId,
      };
    }

    // Direct function call: return foo()
    if (t.isCallExpression(expr) && t.isIdentifier(expr.callee)) {
      return {
        returnValueType: 'CALL_SITE',
        returnValueLine: exprLine,
        returnValueColumn: exprColumn,
        returnValueCallName: expr.callee.name,
      };
    }

    // Method call: return obj.method()
    if (t.isCallExpression(expr) && t.isMemberExpression(expr.callee)) {
      return {
        returnValueType: 'METHOD_CALL',
        returnValueLine: exprLine,
        returnValueColumn: exprColumn,
        returnValueCallName: t.isIdentifier(expr.callee.property)
          ? expr.callee.property.name
          : undefined,
      };
    }

    // BinaryExpression: return a + b
    if (t.isBinaryExpression(expr)) {
      return {
        returnValueType: 'EXPRESSION',
        expressionType: 'BinaryExpression',
        returnValueLine: exprLine,
        returnValueColumn: exprColumn,
        operator: expr.operator,
        returnValueId: NodeFactory.generateExpressionId(
          'BinaryExpression', module.file, exprLine, exprColumn
        ),
        leftSourceName: t.isIdentifier(expr.left) ? expr.left.name : undefined,
        rightSourceName: t.isIdentifier(expr.right) ? expr.right.name : undefined,
      };
    }

    // LogicalExpression: return a && b, return a || b
    if (t.isLogicalExpression(expr)) {
      return {
        returnValueType: 'EXPRESSION',
        expressionType: 'LogicalExpression',
        returnValueLine: exprLine,
        returnValueColumn: exprColumn,
        operator: expr.operator,
        returnValueId: NodeFactory.generateExpressionId(
          'LogicalExpression', module.file, exprLine, exprColumn
        ),
        leftSourceName: t.isIdentifier(expr.left) ? expr.left.name : undefined,
        rightSourceName: t.isIdentifier(expr.right) ? expr.right.name : undefined,
      };
    }

    // ConditionalExpression: return condition ? a : b
    if (t.isConditionalExpression(expr)) {
      return {
        returnValueType: 'EXPRESSION',
        expressionType: 'ConditionalExpression',
        returnValueLine: exprLine,
        returnValueColumn: exprColumn,
        returnValueId: NodeFactory.generateExpressionId(
          'ConditionalExpression', module.file, exprLine, exprColumn
        ),
        consequentSourceName: t.isIdentifier(expr.consequent) ? expr.consequent.name : undefined,
        alternateSourceName: t.isIdentifier(expr.alternate) ? expr.alternate.name : undefined,
      };
    }

    // UnaryExpression: return !x, return -x
    if (t.isUnaryExpression(expr)) {
      return {
        returnValueType: 'EXPRESSION',
        expressionType: 'UnaryExpression',
        returnValueLine: exprLine,
        returnValueColumn: exprColumn,
        operator: expr.operator,
        returnValueId: NodeFactory.generateExpressionId(
          'UnaryExpression', module.file, exprLine, exprColumn
        ),
        unaryArgSourceName: t.isIdentifier(expr.argument) ? expr.argument.name : undefined,
      };
    }

    // MemberExpression (property access): return obj.prop
    if (t.isMemberExpression(expr)) {
      return {
        returnValueType: 'EXPRESSION',
        expressionType: 'MemberExpression',
        returnValueLine: exprLine,
        returnValueColumn: exprColumn,
        returnValueId: NodeFactory.generateExpressionId(
          'MemberExpression', module.file, exprLine, exprColumn
        ),
        object: t.isIdentifier(expr.object) ? expr.object.name : undefined,
        objectSourceName: t.isIdentifier(expr.object) ? expr.object.name : undefined,
        property: t.isIdentifier(expr.property) ? expr.property.name : undefined,
        computed: expr.computed,
      };
    }

    // NewExpression: return new Foo()
    if (t.isNewExpression(expr)) {
      return {
        returnValueType: 'EXPRESSION',
        expressionType: 'NewExpression',
        returnValueLine: exprLine,
        returnValueColumn: exprColumn,
        returnValueId: NodeFactory.generateExpressionId(
          'NewExpression', module.file, exprLine, exprColumn
        ),
      };
    }

    // Fallback for other expression types
    return {
      returnValueType: 'EXPRESSION',
      expressionType: expr.type,
      returnValueLine: exprLine,
      returnValueColumn: exprColumn,
      returnValueId: NodeFactory.generateExpressionId(
        expr.type, module.file, exprLine, exprColumn
      ),
    };
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

  /**
   * REG-311: Micro-trace - follow variable assignments within function to find error source.
   * Used to resolve reject(err) or throw err where err is a variable.
   *
   * Uses cycle detection via Set<variableName> to avoid infinite loops on circular assignments.
   *
   * @param variableName - Name of variable to trace
   * @param funcPath - NodePath of containing function for AST traversal
   * @param variableDeclarations - Variable declarations in current scope
   * @returns Error class name if traced to NewExpression, null otherwise, plus trace path
   */
  private microTraceToErrorClass(
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
  private collectCatchesFromInfo(
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
