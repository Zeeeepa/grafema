/**
 * PropertyAssignmentResolver — creates ASSIGNS_TO edges for non-this object property assignments.
 *
 * For patterns like `obj.prop = value`, resolves what `obj` points to (class, object literal)
 * and creates an ASSIGNS_TO edge from the PROPERTY_ASSIGNMENT node to the matching target
 * PROPERTY or PROPERTY_ASSIGNMENT node.
 *
 * Handles:
 * - Direct `new X()`: const obj = new X(); obj.prop = v
 * - Object literal: const obj = { x: 1 }; obj.x = 2
 * - Alias chains: const a = new X(); const b = a; b.prop = v
 * - Chained access: config.db.host = v
 * - super.prop: class C extends P { m() { super.prop = v } }
 * - Deferred init: let obj; obj = new X(); obj.prop = v
 * - Function return: const obj = getObj(); obj.prop = v
 * - Import: import { obj } from './m'; obj.prop = v
 * - Await: const obj = await f(); obj.prop = v
 * - Conditional (same target): const obj = c ? new X() : new X(); obj.prop = v
 * - Parameter (single callsite): function f(obj) { obj.x = 1 }
 * - Computed string literal: obj['prop'] = v
 *
 * Skips:
 * - objectName === 'this' (handled by walk.ts post-walk pass)
 * - objectName === '?' (unresolvable)
 * - Computed with non-literal expression
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { BaseNodeRecord } from '@grafema/types';
import { resolveValueTarget, type GraphReader, type ResolvedTarget } from './resolveValueTarget.js';

export class PropertyAssignmentResolver extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'PropertyAssignmentResolver',
      phase: 'ENRICHMENT',
      creates: {
        nodes: [],
        edges: ['ASSIGNS_TO'],
      },
      dependencies: ['CoreV2Analyzer'],
      consumes: [
        'ASSIGNED_FROM', 'WRITES_TO', 'INSTANCE_OF', 'HAS_MEMBER',
        'HAS_PROPERTY', 'IMPORTS_FROM', 'EXPORTS', 'CALLS', 'RETURNS',
        'PASSES_ARGUMENT', 'EXTENDS', 'CONTAINS', 'DESTRUCTURED_FROM',
        'RECEIVES_ARGUMENT',
      ],
      produces: ['ASSIGNS_TO'],
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph } = context;
    const factory = this.getFactory(context);
    const logger = this.log(context);

    logger.info('Starting property assignment resolution');
    const startTime = Date.now();

    // Build a graph reader adapter
    const reader: GraphReader = {
      getNode: (id) => graph.getNode(id),
      getOutgoingEdges: (nodeId, edgeTypes) => graph.getOutgoingEdges(nodeId, edgeTypes),
      getIncomingEdges: (nodeId, edgeTypes) => graph.getIncomingEdges(nodeId, edgeTypes),
    };

    // Collect all PROPERTY_ASSIGNMENT nodes
    const allPA: BaseNodeRecord[] = [];
    for await (const node of graph.queryNodes({ nodeType: 'PROPERTY_ASSIGNMENT' })) {
      allPA.push(node);
    }

    logger.debug('Found PROPERTY_ASSIGNMENT nodes', { count: allPA.length });

    let edgesCreated = 0;
    let skipped = 0;
    let unknownCount = 0;

    for (const pa of allPA) {
      const objectName = pa.objectName as string | undefined;

      // Skip this.X — handled by walk.ts post-walk pass
      if (!objectName || objectName === 'this' || objectName.startsWith('this.')) {
        skipped++;
        continue;
      }
      // Skip unresolvable
      if (objectName === '?') {
        skipped++;
        continue;
      }

      // Determine property name
      const rawProp = pa.property;
      if (rawProp == null) {
        skipped++;
        continue;
      }
      let propName = String(rawProp);

      // Handle computed property keys
      if (pa.computed) {
        // Check if it's a string literal computed key like obj['prop']
        // The property name from the walker includes brackets for computed: ['prop']
        const match = propName.match(/^\['(.+)'\]$/);
        if (match) {
          propName = match[1];
        } else {
          // Non-literal computed key (including numeric indices) — can't resolve statically
          skipped++;
          continue;
        }
      }

      // Resolve the target object
      let resolved: ResolvedTarget;

      if (objectName === 'super') {
        // super.prop → find enclosing class → EXTENDS → parent CLASS
        resolved = await resolveSuperTarget(reader, pa);
      } else if (objectName.includes('.')) {
        // Dotted path: config.db.host → resolve root, then traverse properties
        resolved = await resolveDottedTarget(reader, pa, objectName);
      } else {
        // Simple variable: obj.prop → find variable via WRITES_TO, then resolve
        resolved = await resolveSimpleTarget(reader, pa, objectName);
      }

      if (resolved.kind === 'unknown') {
        unknownCount++;
        // Mark the PA node with resolution status
        await factory.update({
          ...pa,
          metadata: {
            ...(typeof pa.metadata === 'object' && pa.metadata ? pa.metadata : {}),
            assignsToResolution: 'unknown',
            assignsToReason: resolved.reason,
          },
        });
        continue;
      }

      // Find matching property in the resolved target
      const targetPropId = await findMatchingProperty(reader, resolved, propName);
      if (targetPropId) {
        await factory.link({ type: 'ASSIGNS_TO', src: pa.id, dst: targetPropId });
        edgesCreated++;
      }
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    logger.info('Complete', {
      edgesCreated,
      skipped,
      unknownCount,
      time: `${totalTime}s`,
    });

    return createSuccessResult(
      { nodes: 0, edges: edgesCreated },
      {
        paProcessed: allPA.length,
        edgesCreated,
        skipped,
        unknownCount,
        timeMs: Date.now() - startTime,
      },
    );
  }
}

/**
 * Resolve super.prop → find parent class via EXTENDS edge.
 */
async function resolveSuperTarget(
  graph: GraphReader,
  pa: BaseNodeRecord,
): Promise<ResolvedTarget> {
  const classId = pa.classId as string | undefined;
  if (!classId) {
    return { kind: 'unknown', reason: 'super_no_class_context' };
  }

  // Find EXTENDS edge from class
  const extendsEdges = await graph.getOutgoingEdges(classId, ['EXTENDS']);
  if (extendsEdges.length === 0) {
    return { kind: 'unknown', reason: 'super_no_extends' };
  }

  return resolveValueTarget(graph, extendsEdges[0].dst);
}

/**
 * Resolve simple objectName (no dots): find variable via WRITES_TO edge,
 * then follow ASSIGNED_FROM chain.
 */
async function resolveSimpleTarget(
  graph: GraphReader,
  pa: BaseNodeRecord,
  objectName: string,
): Promise<ResolvedTarget> {
  // PROPERTY_ASSIGNMENT has WRITES_TO → variable (the root variable)
  const writesTo = await graph.getOutgoingEdges(pa.id, ['WRITES_TO']);
  for (const wt of writesTo) {
    const targetNode = await graph.getNode(wt.dst);
    if (targetNode && targetNode.name === objectName) {
      return resolveValueTarget(graph, wt.dst);
    }
  }

  return { kind: 'unknown', reason: 'variable_not_found' };
}

/**
 * Resolve dotted objectName like `config.db`:
 * Split by dots, resolve root variable, then traverse properties level by level.
 */
async function resolveDottedTarget(
  graph: GraphReader,
  pa: BaseNodeRecord,
  dottedName: string,
): Promise<ResolvedTarget> {
  const parts = dottedName.split('.');

  // Resolve root variable first
  const rootName = parts[0];

  // Find root variable via WRITES_TO
  const writesTo = await graph.getOutgoingEdges(pa.id, ['WRITES_TO']);
  let rootVarId: string | undefined;
  for (const wt of writesTo) {
    const targetNode = await graph.getNode(wt.dst);
    if (targetNode && targetNode.name === rootName) {
      rootVarId = wt.dst;
      break;
    }
  }

  if (!rootVarId) {
    return { kind: 'unknown', reason: 'root_variable_not_found' };
  }

  let resolved = await resolveValueTarget(graph, rootVarId);

  // Traverse intermediate property levels
  for (let i = 1; i < parts.length; i++) {
    const propName = parts[i];

    if (resolved.kind === 'literal_object') {
      // Find HAS_PROPERTY → PROPERTY_ASSIGNMENT with matching name
      const hasPropEdges = await graph.getOutgoingEdges(resolved.literalNodeId, ['HAS_PROPERTY']);
      let found = false;
      for (const edge of hasPropEdges) {
        const propNode = await graph.getNode(edge.dst);
        if (propNode) {
          const pName = (propNode.property ?? propNode.name) as string | undefined;
          const nameMatch = pName === propName
            || (propNode.name && propNode.name.endsWith(`.${propName}`));
          if (nameMatch) {
            // Follow this property's ASSIGNED_FROM to get its value
            const assignedFrom = await graph.getOutgoingEdges(edge.dst, ['ASSIGNED_FROM']);
            if (assignedFrom.length > 0) {
              resolved = await resolveValueTarget(graph, assignedFrom[0].dst);
              found = true;
              break;
            }
            // Property exists but has no ASSIGNED_FROM — check PROPERTY_VALUE
            const propValue = await graph.getOutgoingEdges(edge.dst, ['PROPERTY_VALUE']);
            if (propValue.length > 0) {
              resolved = await resolveValueTarget(graph, propValue[0].dst);
              found = true;
              break;
            }
          }
        }
      }
      if (!found) {
        return { kind: 'unknown', reason: `property_${propName}_not_found_in_literal` };
      }
    } else if (resolved.kind === 'class') {
      // Find HAS_MEMBER → PROPERTY with matching name
      const hasMemberEdges = await graph.getOutgoingEdges(resolved.classNodeId, ['HAS_MEMBER']);
      let found = false;
      for (const edge of hasMemberEdges) {
        const memberNode = await graph.getNode(edge.dst);
        if (memberNode && memberNode.type === 'PROPERTY' && memberNode.name === propName) {
          const assignedFrom = await graph.getOutgoingEdges(edge.dst, ['ASSIGNED_FROM']);
          if (assignedFrom.length > 0) {
            resolved = await resolveValueTarget(graph, assignedFrom[0].dst);
          } else {
            return { kind: 'unknown', reason: `class_property_${propName}_no_value` };
          }
          found = true;
          break;
        }
      }
      if (!found) {
        return { kind: 'unknown', reason: `property_${propName}_not_found_in_class` };
      }
    } else {
      return resolved;
    }
  }

  return resolved;
}

/**
 * Find a matching PROPERTY or PROPERTY_ASSIGNMENT in the resolved target.
 */
async function findMatchingProperty(
  graph: GraphReader,
  target: ResolvedTarget,
  propName: string,
): Promise<string | null> {
  if (target.kind === 'class') {
    // CLASS → HAS_MEMBER → PROPERTY with matching name
    const hasMemberEdges = await graph.getOutgoingEdges(target.classNodeId, ['HAS_MEMBER']);
    for (const edge of hasMemberEdges) {
      const memberNode = await graph.getNode(edge.dst);
      if (memberNode && memberNode.type === 'PROPERTY' && memberNode.name === propName) {
        return edge.dst;
      }
    }
  } else if (target.kind === 'literal_object') {
    // LITERAL → HAS_PROPERTY → PROPERTY_ASSIGNMENT with matching property name
    const hasPropEdges = await graph.getOutgoingEdges(target.literalNodeId, ['HAS_PROPERTY']);
    for (const edge of hasPropEdges) {
      const propNode = await graph.getNode(edge.dst);
      if (propNode) {
        const pName = (propNode.property ?? propNode.name) as string | undefined;
        if (pName === propName || (propNode.name && propNode.name.endsWith(`.${propName}`))) {
          return edge.dst;
        }
      }
    }
  }
  return null;
}
