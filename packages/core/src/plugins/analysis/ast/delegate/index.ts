export { VariableMutationProcessor } from './VariableMutationProcessor.js';
export { ArrayMutationProcessor } from './ArrayMutationProcessor.js';
export { ObjectMutationProcessor } from './ObjectMutationProcessor.js';
export { VariableTrackingProcessor } from './VariableTrackingProcessor.js';
export { ControlFlowProcessor } from './ControlFlowProcessor.js';
export { CallExpressionProcessor } from './CallExpressionProcessor.js';
export { ErrorTrackingProcessor } from './ErrorTrackingProcessor.js';
export { ReturnExpressionParser } from './ReturnExpressionParser.js';
export { VariableDeclarationProcessor } from './VariableDeclarationProcessor.js';
export {
  createAnalysisCollections,
  createCounterRefs,
  createProcessedNodes,
  assembleCollections,
} from './CollectionFactory.js';
export type { AnalysisArrays, AnalysisCounterRefs } from './CollectionFactory.js';
export { composeAndTraverse } from './VisitorComposer.js';
export type { VisitorComposerDelegate, CompositionResult } from './VisitorComposer.js';
