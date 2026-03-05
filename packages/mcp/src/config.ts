/**
 * MCP Server Configuration
 *
 * Loads grafema config via the shared loader from @grafema/util.
 * Plugin instantiation is no longer needed — grafema-orchestrator handles analysis.
 */

import { log } from './utils.js';
import { loadConfig as loadConfigFromUtil, type GrafemaConfig } from '@grafema/util';

// === MCP-SPECIFIC CONFIG ===
/**
 * MCP-specific configuration extends GrafemaConfig with additional fields.
 */
export interface MCPConfig extends GrafemaConfig {
  discovery?: {
    enabled: boolean;
    customOnly: boolean;
  };
  analysis?: {
    service?: string;
  };
  backend?: 'local' | 'rfdb';
  rfdb_socket?: string;
}

const MCP_DEFAULTS: Pick<MCPConfig, 'discovery'> = {
  discovery: {
    enabled: true,
    customOnly: false,
  },
};

// === CONFIG LOADING ===
/**
 * Load MCP configuration (extends base GrafemaConfig).
 * Uses shared loader but adds MCP-specific defaults.
 */
export function loadConfig(projectPath: string): MCPConfig {
  // Use shared loader (handles YAML/JSON, deprecation warnings)
  const baseConfig = loadConfigFromUtil(projectPath, {
    warn: (msg) => log(`[Grafema MCP] ${msg}`),
  });

  // Add MCP-specific defaults
  return {
    ...baseConfig,
    ...MCP_DEFAULTS,
  };
}
