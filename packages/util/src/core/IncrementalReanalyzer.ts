/**
 * IncrementalReanalyzer - selective re-analysis of stale modules
 *
 * Shells out to grafema-orchestrator for reanalysis.
 * The Rust orchestrator handles clearing, indexing, analysis, and enrichment.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join, delimiter, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { GraphBackend } from '@grafema/types';
import type { StaleModule } from './GraphFreshnessChecker.js';

export interface ReanalysisOptions {
  skipEnrichment?: boolean;
  onProgress?: (info: ReanalysisProgress) => void;
}

export interface ReanalysisProgress {
  phase: 'clearing' | 'indexing' | 'analysis' | 'enrichment';
  processedFiles: number;
  totalFiles: number;
  currentService?: string;
}

export interface ReanalysisResult {
  modulesReanalyzed: number;
  modulesDeleted: number;
  nodesCreated: number;
  edgesCreated: number;
  nodesCleared: number;
  durationMs: number;
}

/**
 * Find grafema-orchestrator binary.
 * Search order: monorepo build, PATH, ~/.local/bin
 */
function findOrchestratorBinary(): string | null {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);

  // Monorepo: packages/util/dist/core/ → packages/grafema-orchestrator/target/
  const monorepoRoot = dirname(dirname(dirname(__dirname)));
  const releasePath = join(monorepoRoot, 'packages', 'grafema-orchestrator', 'target', 'release', 'grafema-orchestrator');
  if (existsSync(releasePath)) return releasePath;

  const debugPath = join(monorepoRoot, 'packages', 'grafema-orchestrator', 'target', 'debug', 'grafema-orchestrator');
  if (existsSync(debugPath)) return debugPath;

  // System PATH
  const pathDirs = (process.env.PATH || '').split(delimiter);
  for (const dir of pathDirs) {
    const candidate = join(dir, 'grafema-orchestrator');
    if (existsSync(candidate)) return candidate;
  }

  // ~/.local/bin
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (home) {
    const localBin = join(home, '.local', 'bin', 'grafema-orchestrator');
    if (existsSync(localBin)) return localBin;
  }

  return null;
}

export class IncrementalReanalyzer {
  private _graph: GraphBackend;
  private projectPath: string;

  constructor(graph: GraphBackend, projectPath: string) {
    this._graph = graph;
    this.projectPath = projectPath;
  }

  async reanalyze(
    staleModules: StaleModule[],
    _options: ReanalysisOptions = {}
  ): Promise<ReanalysisResult> {
    const startTime = Date.now();

    if (staleModules.length === 0) {
      return {
        modulesReanalyzed: 0,
        modulesDeleted: 0,
        nodesCreated: 0,
        edgesCreated: 0,
        nodesCleared: 0,
        durationMs: Date.now() - startTime,
      };
    }

    const binary = findOrchestratorBinary();
    if (!binary) {
      throw new Error(
        'grafema-orchestrator binary not found. ' +
        'Build it with: cd packages/grafema-orchestrator && cargo build --release'
      );
    }

    const socketPath = join(this.projectPath, '.grafema', 'rfdb.sock');

    return new Promise<ReanalysisResult>((resolve, reject) => {
      const child = spawn(binary, [
        'analyze',
        '--project', this.projectPath,
        '--socket', socketPath,
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      child.on('error', (err) => {
        reject(new Error(`Failed to start grafema-orchestrator: ${err.message}`));
      });

      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`grafema-orchestrator exited with code ${code}: ${stderr}`));
          return;
        }

        resolve({
          modulesReanalyzed: staleModules.filter(m => m.currentHash !== null).length,
          modulesDeleted: staleModules.filter(m => m.currentHash === null).length,
          nodesCreated: 0,
          edgesCreated: 0,
          nodesCleared: 0,
          durationMs: Date.now() - startTime,
        });
      });
    });
  }
}
