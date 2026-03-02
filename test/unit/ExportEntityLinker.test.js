/**
 * ExportEntityLinker Tests
 *
 * Tests for EXPORT → entity EXPORTS edge creation (REG-569)
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { ExportEntityLinker } from '@grafema/core';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

after(cleanupAllTestDatabases);

describe('ExportEntityLinker', () => {
  async function setupBackend() {
    const db = await createTestDatabase();
    return { backend: db.backend, db };
  }

  describe('Named exports (skipped — handled by core-v2)', () => {
    it('should skip named function export (core-v2 creates EXPORTS edge)', async () => {
      const { backend } = await setupBackend();
      try {
        await backend.addNodes([
          { id: 'mod-a', type: 'MODULE', name: 'a.js', file: 'a.js', line: 1 },
          { id: 'fn-foo', type: 'FUNCTION', name: 'foo', file: 'a.js', line: 1 },
          { id: 'exp-foo', type: 'EXPORT', name: 'foo', file: 'a.js', line: 1, exportType: 'named' },
        ]);
        await backend.flush();

        const enricher = new ExportEntityLinker();
        const result = await enricher.execute({ graph: backend });

        assert.strictEqual(result.created.edges, 0);
        assert.strictEqual(result.metadata.skipped, 1);
      } finally {
        await backend.close();
      }
    });

    it('should skip named const export (core-v2 creates EXPORTS edge)', async () => {
      const { backend } = await setupBackend();
      try {
        await backend.addNodes([
          { id: 'mod-a', type: 'MODULE', name: 'a.js', file: 'a.js', line: 1 },
          { id: 'var-x', type: 'VARIABLE_DECLARATION', name: 'x', file: 'a.js', line: 1 },
          { id: 'exp-x', type: 'EXPORT', name: 'x', file: 'a.js', line: 1, exportType: 'named' },
        ]);
        await backend.flush();

        const enricher = new ExportEntityLinker();
        const result = await enricher.execute({ graph: backend });

        assert.strictEqual(result.created.edges, 0);
        assert.strictEqual(result.metadata.skipped, 1);
      } finally {
        await backend.close();
      }
    });

    it('should skip named class export (core-v2 creates EXPORTS edge)', async () => {
      const { backend } = await setupBackend();
      try {
        await backend.addNodes([
          { id: 'mod-a', type: 'MODULE', name: 'a.js', file: 'a.js', line: 1 },
          { id: 'cls-Foo', type: 'CLASS', name: 'Foo', file: 'a.js', line: 1 },
          { id: 'exp-Foo', type: 'EXPORT', name: 'Foo', file: 'a.js', line: 1, exportType: 'named' },
        ]);
        await backend.flush();

        const enricher = new ExportEntityLinker();
        const result = await enricher.execute({ graph: backend });

        assert.strictEqual(result.created.edges, 0);
        assert.strictEqual(result.metadata.skipped, 1);
      } finally {
        await backend.close();
      }
    });
  });

  describe('Export specifiers (skipped — handled by core-v2)', () => {
    it('should skip { x } specifier (core-v2 creates EXPORTS edge)', async () => {
      const { backend } = await setupBackend();
      try {
        await backend.addNodes([
          { id: 'mod-a', type: 'MODULE', name: 'a.js', file: 'a.js', line: 1 },
          { id: 'var-x', type: 'VARIABLE_DECLARATION', name: 'x', file: 'a.js', line: 1 },
          { id: 'exp-x', type: 'EXPORT', name: 'x', file: 'a.js', line: 3, exportType: 'named', local: 'x' },
        ]);
        await backend.flush();

        const enricher = new ExportEntityLinker();
        const result = await enricher.execute({ graph: backend });

        assert.strictEqual(result.created.edges, 0);
        assert.strictEqual(result.metadata.skipped, 1);
      } finally {
        await backend.close();
      }
    });

    it('should skip { x as y } specifier (core-v2 creates EXPORTS edge)', async () => {
      const { backend } = await setupBackend();
      try {
        await backend.addNodes([
          { id: 'mod-a', type: 'MODULE', name: 'a.js', file: 'a.js', line: 1 },
          { id: 'fn-x', type: 'FUNCTION', name: 'x', file: 'a.js', line: 1 },
          { id: 'exp-y', type: 'EXPORT', name: 'y', file: 'a.js', line: 3, exportType: 'named', local: 'x' },
        ]);
        await backend.flush();

        const enricher = new ExportEntityLinker();
        const result = await enricher.execute({ graph: backend });

        assert.strictEqual(result.created.edges, 0);
        assert.strictEqual(result.metadata.skipped, 1);
      } finally {
        await backend.close();
      }
    });
  });

  describe('Default exports (skipped — handled by core-v2)', () => {
    it('should skip default export with local name (core-v2 creates EXPORTS edge)', async () => {
      const { backend } = await setupBackend();
      try {
        await backend.addNodes([
          { id: 'mod-a', type: 'MODULE', name: 'a.js', file: 'a.js', line: 1 },
          { id: 'fn-foo', type: 'FUNCTION', name: 'foo', file: 'a.js', line: 1 },
          { id: 'exp-default', type: 'EXPORT', name: 'default', file: 'a.js', line: 3, exportType: 'default', local: 'foo' },
        ]);
        await backend.flush();

        const enricher = new ExportEntityLinker();
        const result = await enricher.execute({ graph: backend });

        assert.strictEqual(result.created.edges, 0);
        assert.strictEqual(result.metadata.skipped, 1);
      } finally {
        await backend.close();
      }
    });

    it('should skip anonymous default export (core-v2 creates EXPORTS edge)', async () => {
      const { backend } = await setupBackend();
      try {
        await backend.addNodes([
          { id: 'mod-a', type: 'MODULE', name: 'a.js', file: 'a.js', line: 1 },
          { id: 'fn-anon', type: 'FUNCTION', name: 'anonymous', file: 'a.js', line: 5 },
          { id: 'exp-default', type: 'EXPORT', name: 'default', file: 'a.js', line: 5, exportType: 'default', local: 'default' },
        ]);
        await backend.flush();

        const enricher = new ExportEntityLinker();
        const result = await enricher.execute({ graph: backend });

        assert.strictEqual(result.created.edges, 0);
        assert.strictEqual(result.metadata.skipped, 1);
      } finally {
        await backend.close();
      }
    });
  });

  describe('Scope correctness (skipped — handled by core-v2)', () => {
    it('should skip local export regardless of scope complexity (core-v2 handles it)', async () => {
      const { backend } = await setupBackend();
      try {
        await backend.addNodes([
          { id: 'mod-a', type: 'MODULE', name: 'a.js', file: 'a.js', line: 1 },
          { id: 'fn-x', type: 'FUNCTION', name: 'x', file: 'a.js', line: 1 },
          { id: 'var-x-inner', type: 'VARIABLE_DECLARATION', name: 'x', file: 'a.js', line: 5, parentScopeId: 'scope-outer' },
          { id: 'exp-x', type: 'EXPORT', name: 'x', file: 'a.js', line: 10, exportType: 'named' },
        ]);
        await backend.flush();

        const enricher = new ExportEntityLinker();
        const result = await enricher.execute({ graph: backend });

        assert.strictEqual(result.created.edges, 0);
        assert.strictEqual(result.metadata.skipped, 1);
      } finally {
        await backend.close();
      }
    });
  });

  describe('Re-exports', () => {
    it('should create EXPORTS edge for named re-export to EXPORT in source file', async () => {
      const { backend } = await setupBackend();
      try {
        // File b.js has: export function foo() {}
        // File a.js has: export { foo } from './b'
        await backend.addNodes([
          { id: 'mod-a', type: 'MODULE', name: 'a.js', file: '/project/a.js', line: 1 },
          { id: 'mod-b', type: 'MODULE', name: 'b.js', file: '/project/b.js', line: 1 },
          { id: 'exp-foo-b', type: 'EXPORT', name: 'foo', file: '/project/b.js', line: 1, exportType: 'named' },
          { id: 'exp-foo-a', type: 'EXPORT', name: 'foo', file: '/project/a.js', line: 1, exportType: 'named', source: './b', local: 'foo' },
        ]);
        await backend.flush();

        const enricher = new ExportEntityLinker();
        const result = await enricher.execute({ graph: backend });

        // exp-foo-a → exp-foo-b (re-export chain)
        const edges = await backend.getOutgoingEdges('exp-foo-a', ['EXPORTS']);
        assert.strictEqual(edges.length, 1);
        assert.strictEqual(edges[0].dst, 'exp-foo-b');
      } finally {
        await backend.close();
      }
    });

    it('should create EXPORTS edge for default re-export', async () => {
      const { backend } = await setupBackend();
      try {
        await backend.addNodes([
          { id: 'mod-a', type: 'MODULE', name: 'a.js', file: '/project/a.js', line: 1 },
          { id: 'mod-b', type: 'MODULE', name: 'b.js', file: '/project/b.js', line: 1 },
          { id: 'exp-default-b', type: 'EXPORT', name: 'default', file: '/project/b.js', line: 1, exportType: 'default' },
          { id: 'exp-default-a', type: 'EXPORT', name: 'default', file: '/project/a.js', line: 1, exportType: 'named', source: './b', local: 'default' },
        ]);
        await backend.flush();

        const enricher = new ExportEntityLinker();
        const result = await enricher.execute({ graph: backend });

        const edges = await backend.getOutgoingEdges('exp-default-a', ['EXPORTS']);
        assert.strictEqual(edges.length, 1);
        assert.strictEqual(edges[0].dst, 'exp-default-b');
      } finally {
        await backend.close();
      }
    });

    it('should create EXPORTS edge for export * from to MODULE', async () => {
      const { backend } = await setupBackend();
      try {
        await backend.addNodes([
          { id: 'mod-a', type: 'MODULE', name: 'a.js', file: '/project/a.js', line: 1 },
          { id: 'mod-b', type: 'MODULE', name: 'b.js', file: '/project/b.js', line: 1 },
          { id: 'exp-all-a', type: 'EXPORT', name: '*', file: '/project/a.js', line: 1, exportType: 'all', source: './b' },
        ]);
        await backend.flush();

        const enricher = new ExportEntityLinker();
        const result = await enricher.execute({ graph: backend });

        const edges = await backend.getOutgoingEdges('exp-all-a', ['EXPORTS']);
        assert.strictEqual(edges.length, 1);
        assert.strictEqual(edges[0].dst, 'mod-b');
      } finally {
        await backend.close();
      }
    });

    it('should gracefully skip external package re-exports', async () => {
      const { backend } = await setupBackend();
      try {
        await backend.addNodes([
          { id: 'mod-a', type: 'MODULE', name: 'a.js', file: '/project/a.js', line: 1 },
          // Re-export from external package (non-relative)
          { id: 'exp-ext', type: 'EXPORT', name: 'foo', file: '/project/a.js', line: 1, exportType: 'named', source: 'lodash', local: 'foo' },
        ]);
        await backend.flush();

        const enricher = new ExportEntityLinker();
        const result = await enricher.execute({ graph: backend });

        // Should skip, not crash
        assert.strictEqual(result.created.edges, 0);
        assert.strictEqual(result.metadata.skipped, 1);
      } finally {
        await backend.close();
      }
    });
  });

  describe('TypeScript exports (skipped — handled by core-v2)', () => {
    it('should skip interface export (core-v2 creates EXPORTS edge)', async () => {
      const { backend } = await setupBackend();
      try {
        await backend.addNodes([
          { id: 'mod-a', type: 'MODULE', name: 'a.ts', file: 'a.ts', line: 1 },
          { id: 'iface-Foo', type: 'INTERFACE', name: 'Foo', file: 'a.ts', line: 1 },
          { id: 'exp-Foo', type: 'EXPORT', name: 'Foo', file: 'a.ts', line: 1, exportType: 'named' },
        ]);
        await backend.flush();

        const enricher = new ExportEntityLinker();
        const result = await enricher.execute({ graph: backend });

        assert.strictEqual(result.created.edges, 0);
        assert.strictEqual(result.metadata.skipped, 1);
      } finally {
        await backend.close();
      }
    });

    it('should skip type alias export (core-v2 creates EXPORTS edge)', async () => {
      const { backend } = await setupBackend();
      try {
        await backend.addNodes([
          { id: 'mod-a', type: 'MODULE', name: 'a.ts', file: 'a.ts', line: 1 },
          { id: 'type-Bar', type: 'TYPE', name: 'Bar', file: 'a.ts', line: 1 },
          { id: 'exp-Bar', type: 'EXPORT', name: 'Bar', file: 'a.ts', line: 1, exportType: 'named' },
        ]);
        await backend.flush();

        const enricher = new ExportEntityLinker();
        const result = await enricher.execute({ graph: backend });

        assert.strictEqual(result.created.edges, 0);
        assert.strictEqual(result.metadata.skipped, 1);
      } finally {
        await backend.close();
      }
    });

    it('should skip enum export (core-v2 creates EXPORTS edge)', async () => {
      const { backend } = await setupBackend();
      try {
        await backend.addNodes([
          { id: 'mod-a', type: 'MODULE', name: 'a.ts', file: 'a.ts', line: 1 },
          { id: 'enum-Dir', type: 'ENUM', name: 'Direction', file: 'a.ts', line: 1 },
          { id: 'exp-Dir', type: 'EXPORT', name: 'Direction', file: 'a.ts', line: 1, exportType: 'named' },
        ]);
        await backend.flush();

        const enricher = new ExportEntityLinker();
        const result = await enricher.execute({ graph: backend });

        assert.strictEqual(result.created.edges, 0);
        assert.strictEqual(result.metadata.skipped, 1);
      } finally {
        await backend.close();
      }
    });
  });

  describe('Graceful handling (skipped — handled by core-v2)', () => {
    it('should skip local export even when no entity exists (core-v2 handles resolution)', async () => {
      const { backend } = await setupBackend();
      try {
        await backend.addNodes([
          { id: 'mod-a', type: 'MODULE', name: 'a.js', file: 'a.js', line: 1 },
          // Export for entity that doesn't exist in graph
          { id: 'exp-missing', type: 'EXPORT', name: 'missing', file: 'a.js', line: 1, exportType: 'named' },
        ]);
        await backend.flush();

        const enricher = new ExportEntityLinker();
        const result = await enricher.execute({ graph: backend });

        assert.strictEqual(result.created.edges, 0);
        assert.strictEqual(result.metadata.skipped, 1);
      } finally {
        await backend.close();
      }
    });
  });
});
