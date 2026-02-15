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
