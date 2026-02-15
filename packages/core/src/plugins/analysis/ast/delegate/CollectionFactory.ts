/**
 * CollectionFactory - Creates initialized collection arrays and counter refs
 * for analyzeModule().
 *
 * Extracted from JSASTAnalyzer.analyzeModule() (REG-460 Phase 10) to reduce
 * method length. All arrays and Maps are initialized empty; counters start at 0.
 */

import type { ScopeTracker } from '../../../../core/ScopeTracker.js';
import type {
  FunctionInfo,
  ParameterInfo,
  ScopeInfo,
  BranchInfo,
  CaseInfo,
  LoopInfo,
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
  TypeParameterInfo,
  ObjectLiteralInfo,
  ObjectPropertyInfo,
  ArrayLiteralInfo,
  ArrayElementInfo,
  ArrayMutationInfo,
  ObjectMutationInfo,
  VariableReassignmentInfo,
  ReturnStatementInfo,
  UpdateExpressionInfo,
  PromiseResolutionInfo,
  PromiseExecutorContext,
  YieldExpressionInfo,
  RejectionPatternInfo,
  CatchesFromInfo,
  PropertyAccessInfo,
  CounterRef,
  ProcessedNodes,
} from '../types.js';

// === Analysis Collections ===

/** All mutable arrays populated during AST traversal. */
export interface AnalysisArrays {
  functions: FunctionInfo[];
  parameters: ParameterInfo[];
  scopes: ScopeInfo[];
  branches: BranchInfo[];
  cases: CaseInfo[];
  loops: LoopInfo[];
  variableDeclarations: VariableDeclarationInfo[];
  callSites: CallSiteInfo[];
  methodCalls: MethodCallInfo[];
  eventListeners: EventListenerInfo[];
  classInstantiations: ClassInstantiationInfo[];
  constructorCalls: ConstructorCallInfo[];
  classDeclarations: ClassDeclarationInfo[];
  methodCallbacks: MethodCallbackInfo[];
  callArguments: CallArgumentInfo[];
  imports: ImportInfo[];
  exports: ExportInfo[];
  httpRequests: HttpRequestInfo[];
  literals: LiteralInfo[];
  variableAssignments: VariableAssignmentInfo[];
  interfaces: InterfaceDeclarationInfo[];
  typeAliases: TypeAliasInfo[];
  enums: EnumDeclarationInfo[];
  decorators: DecoratorInfo[];
  typeParameters: TypeParameterInfo[];
  objectLiterals: ObjectLiteralInfo[];
  objectProperties: ObjectPropertyInfo[];
  arrayLiterals: ArrayLiteralInfo[];
  arrayElements: ArrayElementInfo[];
  arrayMutations: ArrayMutationInfo[];
  objectMutations: ObjectMutationInfo[];
  variableReassignments: VariableReassignmentInfo[];
  returnStatements: ReturnStatementInfo[];
  updateExpressions: UpdateExpressionInfo[];
  promiseResolutions: PromiseResolutionInfo[];
  promiseExecutorContexts: Map<string, PromiseExecutorContext>;
  yieldExpressions: YieldExpressionInfo[];
  rejectionPatterns: RejectionPatternInfo[];
  catchesFromInfos: CatchesFromInfo[];
  propertyAccesses: PropertyAccessInfo[];
}

/** All counter refs used during AST traversal. */
export interface AnalysisCounterRefs {
  ifScopeCounterRef: CounterRef;
  scopeCounterRef: CounterRef;
  varDeclCounterRef: CounterRef;
  callSiteCounterRef: CounterRef;
  functionCounterRef: CounterRef;
  httpRequestCounterRef: CounterRef;
  literalCounterRef: CounterRef;
  anonymousFunctionCounterRef: CounterRef;
  objectLiteralCounterRef: CounterRef;
  arrayLiteralCounterRef: CounterRef;
  branchCounterRef: CounterRef;
  caseCounterRef: CounterRef;
  propertyAccessCounterRef: CounterRef;
}

/**
 * Create all empty collection arrays for a single module analysis.
 * Each call returns fresh arrays so parallel analyses don't share state.
 */
export function createAnalysisCollections(): AnalysisArrays {
  return {
    functions: [],
    parameters: [],
    scopes: [],
    branches: [],
    cases: [],
    loops: [],
    variableDeclarations: [],
    callSites: [],
    methodCalls: [],
    eventListeners: [],
    classInstantiations: [],
    constructorCalls: [],
    classDeclarations: [],
    methodCallbacks: [],
    callArguments: [],
    imports: [],
    exports: [],
    httpRequests: [],
    literals: [],
    variableAssignments: [],
    interfaces: [],
    typeAliases: [],
    enums: [],
    decorators: [],
    typeParameters: [],
    objectLiterals: [],
    objectProperties: [],
    arrayLiterals: [],
    arrayElements: [],
    arrayMutations: [],
    objectMutations: [],
    variableReassignments: [],
    returnStatements: [],
    updateExpressions: [],
    promiseResolutions: [],
    promiseExecutorContexts: new Map<string, PromiseExecutorContext>(),
    yieldExpressions: [],
    rejectionPatterns: [],
    catchesFromInfos: [],
    propertyAccesses: [],
  };
}

/**
 * Create all counter refs initialized to zero.
 */
export function createCounterRefs(): AnalysisCounterRefs {
  return {
    ifScopeCounterRef: { value: 0 },
    scopeCounterRef: { value: 0 },
    varDeclCounterRef: { value: 0 },
    callSiteCounterRef: { value: 0 },
    functionCounterRef: { value: 0 },
    httpRequestCounterRef: { value: 0 },
    literalCounterRef: { value: 0 },
    anonymousFunctionCounterRef: { value: 0 },
    objectLiteralCounterRef: { value: 0 },
    arrayLiteralCounterRef: { value: 0 },
    branchCounterRef: { value: 0 },
    caseCounterRef: { value: 0 },
    propertyAccessCounterRef: { value: 0 },
  };
}

/**
 * Create the ProcessedNodes set used to deduplicate traversal.
 */
export function createProcessedNodes(): ProcessedNodes {
  return {
    functions: new Set(),
    classes: new Set(),
    imports: new Set(),
    exports: new Set(),
    variables: new Set(),
    callSites: new Set(),
    methodCalls: new Set(),
    varDecls: new Set(),
    eventListeners: new Set(),
  };
}

/**
 * Assembles the unified Collections object from arrays, counters, processedNodes,
 * and module-specific context. This is the object passed to visitors and
 * analyzeFunctionBody as VisitorCollections.
 *
 * The returned object contains all fields expected by the internal `Collections`
 * interface in JSASTAnalyzer plus VisitorCollections compatibility fields.
 */
export function assembleCollections(
  arrays: AnalysisArrays,
  counters: AnalysisCounterRefs,
  processedNodes: ProcessedNodes,
  code: string,
  moduleId: string,
  scopeTracker: ScopeTracker,
): Record<string, unknown> {
  return {
    // Spread all arrays
    ...arrays,
    // Spread all counters
    ...counters,
    // ProcessedNodes
    processedNodes,
    // Code
    code,
    // VisitorCollections compatibility aliases
    classes: arrays.classDeclarations,
    methods: [] as FunctionInfo[],
    variables: arrays.variableDeclarations,
    sideEffects: [] as unknown[],
    variableCounterRef: counters.varDeclCounterRef,
    // ScopeTracker
    scopeTracker,
  };
}
