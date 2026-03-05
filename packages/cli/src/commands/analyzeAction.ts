/**
 * Analyze command action — spawns grafema-orchestrator for project analysis.
 *
 * The Rust grafema-orchestrator binary handles the full analysis pipeline:
 * discovery, parsing (OXC), analysis (grafema-analyzer), resolution,
 * and RFDB ingestion. This action finds the binary, spawns it with
 * the correct args, streams output, and prints a summary.
 */

import { resolve, join, delimiter, dirname } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import {
  RFDBServerBackend,
  createLogger,
} from '@grafema/util';
import type { LogLevel } from '@grafema/util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface NodeEdgeCountBackend {
  nodeCount: () => Promise<number>;
  edgeCount: () => Promise<number>;
}

export async function fetchNodeEdgeCounts(backend: NodeEdgeCountBackend): Promise<{ nodeCount: number; edgeCount: number }> {
  const [nodeCount, edgeCount] = await Promise.all([backend.nodeCount(), backend.edgeCount()]);
  return { nodeCount, edgeCount };
}

export function exitWithCode(code: number, exitFn: (code: number) => void = process.exit): void {
  exitFn(code);
}

/**
 * Determine log level from CLI options.
 * Priority: --log-level > --quiet > --verbose > default ('silent')
 *
 * By default, logs are silent to allow clean progress UI.
 * Use --verbose to see detailed logs (disables interactive progress).
 */
function getLogLevel(options: { quiet?: boolean; verbose?: boolean; logLevel?: string }): LogLevel {
  if (options.logLevel) {
    const validLevels: LogLevel[] = ['silent', 'errors', 'warnings', 'info', 'debug'];
    if (validLevels.includes(options.logLevel as LogLevel)) {
      return options.logLevel as LogLevel;
    }
  }
  if (options.quiet) return 'silent';
  if (options.verbose) return 'info';  // --verbose shows logs instead of progress UI
  return 'silent';  // Default: silent logs, clean progress UI
}

/**
 * Find grafema-orchestrator binary.
 *
 * Search order:
 * 1. GRAFEMA_ORCHESTRATOR environment variable
 * 2. Monorepo target/release (development)
 * 3. Monorepo target/debug (development)
 * 4. System PATH lookup
 * 5. ~/.local/bin/grafema-orchestrator (user-installed)
 */
function findOrchestratorBinary(): string | null {
  const binaryName = 'grafema-orchestrator';

  // 1. Environment variable
  const envBinary = process.env.GRAFEMA_ORCHESTRATOR;
  if (envBinary && existsSync(envBinary)) {
    return envBinary;
  }

  // 2-3. Monorepo development builds
  const monorepoRoot = findMonorepoRoot();
  if (monorepoRoot) {
    const releaseBinary = join(monorepoRoot, 'packages', 'grafema-orchestrator', 'target', 'release', binaryName);
    if (existsSync(releaseBinary)) {
      return releaseBinary;
    }

    const debugBinary = join(monorepoRoot, 'packages', 'grafema-orchestrator', 'target', 'debug', binaryName);
    if (existsSync(debugBinary)) {
      return debugBinary;
    }
  }

  // 4. System PATH lookup
  const pathDirs = (process.env.PATH || '').split(delimiter);
  for (const dir of pathDirs) {
    if (!dir) continue;
    const candidate = join(dir, binaryName);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  // 5. User-installed binary in ~/.local/bin
  const homeBinary = join(process.env.HOME || '', '.local', 'bin', binaryName);
  if (existsSync(homeBinary)) {
    return homeBinary;
  }

  return null;
}

/**
 * Find monorepo root by looking for characteristic files.
 */
function findMonorepoRoot(): string | null {
  const searchPaths = [
    // From packages/cli/dist/commands -> dist -> cli -> packages -> root
    join(__dirname, '..', '..', '..', '..'),
    // Environment variable override
    process.env.GRAFEMA_ROOT,
  ].filter(Boolean) as string[];

  for (const candidate of searchPaths) {
    const hasPackagesDir = existsSync(join(candidate, 'packages', 'core'));
    const hasOrchestrator = existsSync(join(candidate, 'packages', 'grafema-orchestrator', 'Cargo.toml'));
    if (hasPackagesDir && hasOrchestrator) {
      return candidate;
    }
  }

  return null;
}

/**
 * Find the grafema.config.yaml config file for the orchestrator.
 *
 * Search order:
 * 1. <projectPath>/grafema.config.yaml
 * 2. <projectPath>/.grafema/config.yaml (legacy location)
 */
function findConfigFile(projectPath: string): string | null {
  const candidates = [
    join(projectPath, 'grafema.config.yaml'),
    join(projectPath, '.grafema', 'config.yaml'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export async function analyzeAction(path: string, options: { service?: string; entrypoint?: string; clear?: boolean; quiet?: boolean; verbose?: boolean; debug?: boolean; logLevel?: string; logFile?: string; strict?: boolean; autoStart?: boolean }): Promise<void> {
  const projectPath = resolve(path);
  const grafemaDir = join(projectPath, '.grafema');
  const dbPath = join(grafemaDir, 'graph.rfdb');

  if (!existsSync(grafemaDir)) {
    mkdirSync(grafemaDir, { recursive: true });
  }

  // Two log levels for CLI output:
  // - info: important results (shows unless --quiet)
  // - debug: verbose details (shows only with --verbose)
  const info = options.quiet ? () => {} : console.log;
  const debug = options.verbose ? console.log : () => {};

  // Create logger based on CLI flags
  const logLevel = getLogLevel(options);
  const logFile = options.logFile ? resolve(options.logFile) : undefined;
  const _logger = createLogger(logLevel, logFile ? { logFile } : undefined);

  if (logFile) {
    debug(`Log file: ${logFile}`);
  }
  debug(`Analyzing project: ${projectPath}`);

  // Find grafema-orchestrator binary
  const orchestratorBinary = findOrchestratorBinary();
  if (!orchestratorBinary) {
    console.error('');
    console.error('grafema-orchestrator binary not found.');
    console.error('');
    console.error('Options:');
    console.error('  1. Set environment variable:');
    console.error('     export GRAFEMA_ORCHESTRATOR=/path/to/grafema-orchestrator');
    console.error('');
    console.error('  2. Build from source (in monorepo):');
    console.error('     cd packages/grafema-orchestrator && cargo build --release');
    console.error('');
    console.error('  3. Install to PATH:');
    console.error('     cp target/release/grafema-orchestrator ~/.local/bin/');
    console.error('');
    process.exit(1);
  }

  debug(`Using orchestrator: ${orchestratorBinary}`);

  // Find config file for the orchestrator
  const configPath = findConfigFile(projectPath);
  if (!configPath) {
    console.error('');
    console.error('No grafema config file found.');
    console.error('');
    console.error('Expected one of:');
    console.error(`  ${join(projectPath, 'grafema.config.yaml')}`);
    console.error(`  ${join(projectPath, '.grafema', 'config.yaml')}`);
    console.error('');
    console.error('Create a config file with at least:');
    console.error('  root: "."');
    console.error('  include:');
    console.error('    - "src/**/*.js"');
    console.error('');
    process.exit(1);
  }

  debug(`Using config: ${configPath}`);

  // Connect to RFDB server for stats (after orchestrator finishes)
  // Default: require explicit `grafema server start`
  // Use --auto-start for CI or backwards compatibility
  const backend = new RFDBServerBackend({
    dbPath,
    autoStart: options.autoStart ?? false,
    silent: !options.verbose,
    clientName: 'cli'
  });

  try {
    await backend.connect();
  } catch (err) {
    if (!options.autoStart && err instanceof Error && err.message.includes('not running')) {
      console.error('');
      console.error('RFDB server is not running.');
      console.error('');
      console.error('Start the server first:');
      console.error('  grafema server start');
      console.error('');
      console.error('Or use --auto-start flag:');
      console.error('  grafema analyze --auto-start');
      console.error('');
      process.exit(1);
    }
    throw err;
  }

  if (options.clear) {
    debug('Clearing existing database...');
    await backend.clear();
  }

  const startTime = Date.now();

  // Build orchestrator args
  const args: string[] = ['analyze', '--config', configPath, '--socket', backend.socketPath];

  if (options.clear) {
    args.push('--force');
  }

  debug(`Spawning: ${orchestratorBinary} ${args.join(' ')}`);

  let exitCode = 0;

  try {
    // Spawn grafema-orchestrator
    exitCode = await new Promise<number>((resolvePromise, reject) => {
      const child = spawn(orchestratorBinary, args, {
        stdio: [
          'ignore',
          options.quiet ? 'ignore' : 'inherit',
          options.quiet ? 'ignore' : 'inherit',
        ],
        env: {
          ...process.env,
          // Pass RUST_LOG for tracing verbosity
          RUST_LOG: options.verbose ? 'info' : (options.debug ? 'debug' : 'warn'),
        },
      });

      child.on('error', (err) => {
        reject(new Error(`Failed to spawn grafema-orchestrator: ${err.message}`));
      });

      child.on('close', (code) => {
        resolvePromise(code ?? 1);
      });
    });

    if (exitCode === 0) {
      const elapsedSeconds = (Date.now() - startTime) / 1000;
      const stats = await fetchNodeEdgeCounts(backend);

      info('');
      info(`Analysis complete in ${elapsedSeconds.toFixed(2)}s`);
      info(`  Nodes: ${stats.nodeCount}`);
      info(`  Edges: ${stats.edgeCount}`);
    } else {
      console.error('');
      console.error(`Analysis failed with exit code ${exitCode}`);
    }
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    console.error('');
    console.error(`Analysis failed: ${error.message}`);
    exitCode = 1;
  } finally {
    if (backend.connected) {
      await backend.close();
    }

    // Exit with appropriate code
    exitWithCode(exitCode);
  }
}
