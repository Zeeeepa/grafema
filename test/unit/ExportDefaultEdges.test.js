/**
 * Tests for EXPORTS edges on default exports (REG-595)
 *
 * Graph invariant: For every ExportDefaultDeclaration, the EXPORT node
 * with name='default' MUST have at least one outgoing EXPORTS edge
 * to the exported value's graph node.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { walkFile, jsRegistry } from '../../packages/core-v2/dist/index.js';

/**
 * Helper: walk code, find EXPORT(default) node and its EXPORTS edge targets.
 */
async function walkAndFindDefaultExport(code, filename = 'test.js') {
  const result = await walkFile(code, filename, jsRegistry);

  const exportNode = result.nodes.find(n => n.type === 'EXPORT' && n.name === 'default');
  assert.ok(exportNode, 'EXPORT(default) node must exist');

  const exportsEdges = result.edges.filter(e => e.src === exportNode.id && e.type === 'EXPORTS');
  return { result, exportNode, exportsEdges };
}

describe('Export default EXPORTS edges (REG-595)', () => {

  // ─── Edge-map cases (declaration creates a graph node) ──────────────

  describe('Named function declaration', () => {
    it('export default function foo() {} → EXPORTS → FUNCTION', async () => {
      const { result, exportsEdges } = await walkAndFindDefaultExport(
        `export default function foo() { return 1; }`
      );
      assert.strictEqual(exportsEdges.length, 1, 'Exactly one EXPORTS edge');

      const target = result.nodes.find(n => n.id === exportsEdges[0].dst);
      assert.ok(target, 'Target node must exist');
      assert.strictEqual(target.type, 'FUNCTION');
      assert.strictEqual(target.name, 'foo');
    });
  });

  describe('Named class declaration', () => {
    it('export default class Bar {} → EXPORTS → CLASS', async () => {
      const { result, exportsEdges } = await walkAndFindDefaultExport(
        `export default class Bar { constructor() {} }`
      );
      assert.strictEqual(exportsEdges.length, 1, 'Exactly one EXPORTS edge');

      const target = result.nodes.find(n => n.id === exportsEdges[0].dst);
      assert.ok(target, 'Target node must exist');
      assert.strictEqual(target.type, 'CLASS');
      assert.strictEqual(target.name, 'Bar');
    });
  });

  describe('Identifier (variable reference)', () => {
    it('export default someVar → EXPORTS → CONSTANT', async () => {
      const { result, exportsEdges } = await walkAndFindDefaultExport(
        `const someVar = 42;\nexport default someVar;`
      );
      assert.strictEqual(exportsEdges.length, 1, 'Exactly one EXPORTS edge');

      const target = result.nodes.find(n => n.id === exportsEdges[0].dst);
      assert.ok(target, 'Target node must exist');
      assert.strictEqual(target.type, 'CONSTANT');
      assert.strictEqual(target.name, 'someVar');
    });
  });

  describe('Object literal', () => {
    it('export default { a: 1 } → EXPORTS → LITERAL', async () => {
      const { exportsEdges, result } = await walkAndFindDefaultExport(
        `export default { a: 1 };`
      );
      assert.strictEqual(exportsEdges.length, 1, 'Exactly one EXPORTS edge');

      const target = result.nodes.find(n => n.id === exportsEdges[0].dst);
      assert.ok(target, 'Target node must exist');
      assert.strictEqual(target.type, 'LITERAL');
    });
  });

  describe('Anonymous function expression', () => {
    it('export default function() {} → EXPORTS → FUNCTION', async () => {
      const { result, exportsEdges } = await walkAndFindDefaultExport(
        `export default function() { return 1; }`
      );
      assert.strictEqual(exportsEdges.length, 1, 'Exactly one EXPORTS edge');

      const target = result.nodes.find(n => n.id === exportsEdges[0].dst);
      assert.ok(target, 'Target node must exist');
      assert.strictEqual(target.type, 'FUNCTION');
    });
  });

  describe('Anonymous class expression', () => {
    it('export default class {} → EXPORTS → CLASS', async () => {
      const { result, exportsEdges } = await walkAndFindDefaultExport(
        `export default class { constructor() {} }`
      );
      assert.strictEqual(exportsEdges.length, 1, 'Exactly one EXPORTS edge');

      const target = result.nodes.find(n => n.id === exportsEdges[0].dst);
      assert.ok(target, 'Target node must exist');
      assert.strictEqual(target.type, 'CLASS');
    });
  });

  describe('Arrow function', () => {
    it('export default () => {} → EXPORTS → FUNCTION', async () => {
      const { result, exportsEdges } = await walkAndFindDefaultExport(
        `export default () => { return 1; };`
      );
      assert.strictEqual(exportsEdges.length, 1, 'Exactly one EXPORTS edge');

      const target = result.nodes.find(n => n.id === exportsEdges[0].dst);
      assert.ok(target, 'Target node must exist');
      assert.strictEqual(target.type, 'FUNCTION');
    });
  });

  describe('Numeric literal', () => {
    it('export default 42 → EXPORTS → LITERAL', async () => {
      const { exportsEdges, result } = await walkAndFindDefaultExport(
        `export default 42;`
      );
      assert.strictEqual(exportsEdges.length, 1, 'Exactly one EXPORTS edge');

      const target = result.nodes.find(n => n.id === exportsEdges[0].dst);
      assert.ok(target, 'Target node must exist');
      assert.strictEqual(target.type, 'LITERAL');
    });
  });

  describe('Call expression', () => {
    it('export default createApp() → EXPORTS → CALL', async () => {
      const { exportsEdges, result } = await walkAndFindDefaultExport(
        `function createApp() { return {}; }\nexport default createApp();`
      );
      assert.strictEqual(exportsEdges.length, 1, 'Exactly one EXPORTS edge');

      const target = result.nodes.find(n => n.id === exportsEdges[0].dst);
      assert.ok(target, 'Target node must exist');
      assert.strictEqual(target.type, 'CALL');
      assert.strictEqual(target.name, 'createApp');
    });
  });

  // ─── Regression guard ──────────────────────────────────────────────

  describe('No READS_FROM for export default identifier', () => {
    it('export default someVar should NOT create READS_FROM edge', async () => {
      const { result } = await walkAndFindDefaultExport(
        `const someVar = 42;\nexport default someVar;`
      );

      const readsFromEdges = result.edges.filter(
        e => e.type === 'READS_FROM'
      );
      // There should be no READS_FROM edges — the identifier in
      // `export default someVar` is an export reference, not a read.
      const exportNode = result.nodes.find(n => n.type === 'EXPORT' && n.name === 'default');
      const readsFromExport = readsFromEdges.filter(e => e.src === exportNode.id);
      assert.strictEqual(readsFromExport.length, 0,
        'EXPORT(default) should not have READS_FROM edges');
    });
  });
});
