/**
 * resolveValueTarget — follow ASSIGNED_FROM chains to resolve what a variable points to.
 *
 * Given a graph node ID (typically a VARIABLE or CONSTANT), traverses outgoing
 * ASSIGNED_FROM edges through aliases, await expressions, imports, function returns,
 * and conditionals to find the ultimate target: a CLASS (via new X()), an object
 * LITERAL, or UNKNOWN.
 *
 * Used by PropertyAssignmentResolver to resolve `obj.prop = value` patterns where
 * `obj` was previously assigned via `const obj = new X()`, `const obj = { ... }`, etc.
 *
 * Chain traversal rules:
 * 1. VARIABLE/CONSTANT → follow ASSIGNED_FROM. If none → fallback: incoming WRITES_TO → src → ASSIGNED_FROM
 * 2. CALL (isNew: true) → INSTANCE_OF → CLASS → done
 * 3. CALL (not isNew) → CALLS → FUNCTION → RETURNS (single target) → recurse
 * 4. LITERAL (valueType: object) → done
 * 5. EXPRESSION (await) → follow CONTAINS → recurse
 * 6. IMPORT → IMPORTS_FROM → EXPORT → EXPORTS → entity → recurse
 * 7. ConditionalExpression-like → follow HAS_CONSEQUENT + HAS_ALTERNATE, if same → use it, else UNKNOWN
 */

import type { BaseNodeRecord, EdgeRecord } from '@grafema/types';

export type ResolvedTarget =
  | { kind: 'class'; classNodeId: string }
  | { kind: 'literal_object'; literalNodeId: string }
  | { kind: 'unknown'; reason: string };

export interface GraphReader {
  getNode(id: string): Promise<BaseNodeRecord | null>;
  getOutgoingEdges(nodeId: string, edgeTypes?: string[] | null): Promise<EdgeRecord[]>;
  getIncomingEdges(nodeId: string, edgeTypes?: string[] | null): Promise<EdgeRecord[]>;
}

const MAX_HOPS = 50;

export async function resolveValueTarget(
  graph: GraphReader,
  nodeId: string,
): Promise<ResolvedTarget> {
  const visited = new Set<string>();
  return resolve(graph, nodeId, visited);
}

async function resolve(
  graph: GraphReader,
  nodeId: string,
  visited: Set<string>,
): Promise<ResolvedTarget> {
  if (visited.has(nodeId)) {
    return { kind: 'unknown', reason: 'cycle_detected' };
  }
  if (visited.size >= MAX_HOPS) {
    return { kind: 'unknown', reason: 'max_hops_exceeded' };
  }
  visited.add(nodeId);

  const node = await graph.getNode(nodeId);
  if (!node) {
    return { kind: 'unknown', reason: 'node_not_found' };
  }

  const nodeType = node.type;

  // CLASS — direct target
  if (nodeType === 'CLASS') {
    return { kind: 'class', classNodeId: nodeId };
  }

  // LITERAL (object) — direct target
  if (nodeType === 'LITERAL' && node.valueType === 'object') {
    return { kind: 'literal_object', literalNodeId: nodeId };
  }

  // CALL node — check if it's a `new X()` or a function call
  if (nodeType === 'CALL') {
    if (node.isNew) {
      // new X() → follow INSTANCE_OF → CLASS
      const instanceEdges = await graph.getOutgoingEdges(nodeId, ['INSTANCE_OF']);
      if (instanceEdges.length > 0) {
        return resolve(graph, instanceEdges[0].dst, visited);
      }
      return { kind: 'unknown', reason: 'new_without_instance_of' };
    }
    // Regular call → follow CALLS → FUNCTION → RETURNS
    const callsEdges = await graph.getOutgoingEdges(nodeId, ['CALLS']);
    if (callsEdges.length === 1) {
      const funcId = callsEdges[0].dst;
      const returnsEdges = await graph.getOutgoingEdges(funcId, ['RETURNS']);
      if (returnsEdges.length === 1) {
        return resolve(graph, returnsEdges[0].dst, visited);
      }
      if (returnsEdges.length > 1) {
        return { kind: 'unknown', reason: 'multiple_returns' };
      }
    }
    return { kind: 'unknown', reason: 'unresolvable_call' };
  }

  // EXPRESSION (await) → follow CONTAINS to argument
  if (nodeType === 'EXPRESSION' && node.name === 'await') {
    const containsEdges = await graph.getOutgoingEdges(nodeId, ['CONTAINS']);
    if (containsEdges.length > 0) {
      return resolve(graph, containsEdges[0].dst, visited);
    }
    return { kind: 'unknown', reason: 'await_no_argument' };
  }

  // EXPRESSION (conditional) → follow HAS_CONSEQUENT + HAS_ALTERNATE
  if (nodeType === 'EXPRESSION' && node.name === 'ternary') {
    const consequent = await graph.getOutgoingEdges(nodeId, ['HAS_CONSEQUENT']);
    const alternate = await graph.getOutgoingEdges(nodeId, ['HAS_ALTERNATE']);
    if (consequent.length === 1 && alternate.length === 1) {
      const left = await resolve(graph, consequent[0].dst, new Set(visited));
      const right = await resolve(graph, alternate[0].dst, new Set(visited));
      if (left.kind !== 'unknown' && right.kind !== 'unknown') {
        // Both resolved — check if they point to the same target
        if (left.kind === right.kind) {
          if (left.kind === 'class' && right.kind === 'class' && left.classNodeId === right.classNodeId) {
            return left;
          }
          if (left.kind === 'literal_object' && right.kind === 'literal_object' && left.literalNodeId === right.literalNodeId) {
            return left;
          }
        }
        return { kind: 'unknown', reason: 'ambiguous_conditional' };
      }
      // One side resolved, other unknown — return unknown
      return { kind: 'unknown', reason: 'ambiguous_conditional' };
    }
  }

  // IMPORT → IMPORTS_FROM → EXPORT → EXPORTS → entity
  if (nodeType === 'IMPORT') {
    const importsFrom = await graph.getOutgoingEdges(nodeId, ['IMPORTS_FROM']);
    if (importsFrom.length > 0) {
      const exportNode = importsFrom[0].dst;
      const exportsEdges = await graph.getOutgoingEdges(exportNode, ['EXPORTS']);
      if (exportsEdges.length > 0) {
        return resolve(graph, exportsEdges[0].dst, visited);
      }
    }
    return { kind: 'unknown', reason: 'import_unresolved' };
  }

  // VARIABLE / CONSTANT / PARAMETER — follow ASSIGNED_FROM chain
  if (nodeType === 'VARIABLE' || nodeType === 'CONSTANT' || nodeType === 'VARIABLE_DECLARATION'
    || nodeType === 'PARAMETER') {
    // Primary: follow outgoing ASSIGNED_FROM
    const assignedFrom = await graph.getOutgoingEdges(nodeId, ['ASSIGNED_FROM']);
    if (assignedFrom.length > 0) {
      return resolve(graph, assignedFrom[0].dst, visited);
    }

    // Fallback for deferred init: `let obj; obj = new X();`
    // Find incoming WRITES_TO → src is EXPRESSION(assign) or PROPERTY_ASSIGNMENT
    // → follow that node's ASSIGNED_FROM
    const writesTo = await graph.getIncomingEdges(nodeId, ['WRITES_TO']);
    for (const wt of writesTo) {
      const writerAssignedFrom = await graph.getOutgoingEdges(wt.src, ['ASSIGNED_FROM']);
      if (writerAssignedFrom.length > 0) {
        return resolve(graph, writerAssignedFrom[0].dst, visited);
      }
    }

    return { kind: 'unknown', reason: 'no_assignment' };
  }

  // EXPORT → follow EXPORTS
  if (nodeType === 'EXPORT') {
    const exportsEdges = await graph.getOutgoingEdges(nodeId, ['EXPORTS']);
    if (exportsEdges.length > 0) {
      return resolve(graph, exportsEdges[0].dst, visited);
    }
    return { kind: 'unknown', reason: 'export_no_entity' };
  }

  // FUNCTION — this IS the function, not a call to it
  if (nodeType === 'FUNCTION' || nodeType === 'METHOD') {
    return { kind: 'unknown', reason: 'function_value' };
  }

  return { kind: 'unknown', reason: `unhandled_node_type:${nodeType}` };
}
