/**
 * Overview command - Project dashboard
 */

import { Command } from 'commander';
import { resolve, join } from 'path';
import { existsSync } from 'fs';
import { RFDBServerBackend } from '@grafema/util';
import { exitWithError } from '../utils/errorFormatter.js';


export const overviewCommand = new Command('overview')
  .description('Show project overview and statistics')
  .option('-p, --project <path>', 'Project path', '.')
  .option('-j, --json', 'Output as JSON')
  .addHelpText('after', `
Examples:
  grafema overview               Show project dashboard
  grafema overview --json        Output statistics as JSON
  grafema overview -p ./app      Overview for specific project
`)
  .action(async (options: { project: string; json?: boolean }) => {
    const projectPath = resolve(options.project);
    const grafemaDir = join(projectPath, '.grafema');
    const dbPath = join(grafemaDir, 'graph.rfdb');

    if (!existsSync(dbPath)) {
      exitWithError('No graph database found', ['Run: grafema analyze']);
    }

    const backend = new RFDBServerBackend({ dbPath, clientName: 'cli' });
    await backend.connect();

    try {
      const stats = await backend.getStats();

      if (options.json) {
        console.log(JSON.stringify(stats, null, 2));
        return;
      }

      // Header
      console.log('');
      console.log('📊 Project Overview');
      console.log('');

      // Code Structure
      console.log('Code Structure:');
      const modules = stats.nodesByType['MODULE'] || 0;
      const functions = stats.nodesByType['FUNCTION'] || 0;
      const classes = stats.nodesByType['CLASS'] || 0;
      const variables = stats.nodesByType['VARIABLE'] || 0;
      const calls = stats.nodesByType['CALL'] || 0;

      console.log(`├─ Modules: ${modules}`);
      console.log(`├─ Functions: ${functions}`);
      console.log(`├─ Classes: ${classes}`);
      console.log(`├─ Variables: ${variables}`);
      console.log(`└─ Call sites: ${calls}`);
      console.log('');

      // External Interactions (namespaced types)
      console.log('External Interactions:');
      const httpRoutes = stats.nodesByType['http:route'] || 0;
      const dbQueries = stats.nodesByType['db:query'] || 0;
      const socketEvents = stats.nodesByType['socketio:event'] || 0;
      const socketEmit = stats.nodesByType['socketio:emit'] || 0;
      const socketOn = stats.nodesByType['socketio:on'] || 0;
      const events = stats.nodesByType['event:listener'] || 0;

      if (httpRoutes > 0) console.log(`├─ HTTP routes: ${httpRoutes}`);
      if (dbQueries > 0) console.log(`├─ Database queries: ${dbQueries}`);
      if (socketEvents > 0) {
        // New format showing event count prominently
        console.log(`├─ Socket.IO: ${socketEvents} events (${socketEmit} emit, ${socketOn} listeners)`);
      } else if (socketEmit + socketOn > 0) {
        // Fallback for graphs analyzed before REG-209
        console.log(`├─ Socket.IO: ${socketEmit} emit, ${socketOn} listeners`);
      }
      if (events > 0) console.log(`├─ Event listeners: ${events}`);

      // Check for external module refs
      const externalModules = stats.nodesByType['EXTERNAL_MODULE'] || 0;
      if (externalModules > 0) console.log(`└─ External modules: ${externalModules}`);

      if (httpRoutes + dbQueries + socketEvents + socketEmit + socketOn + events + externalModules === 0) {
        console.log('└─ (none detected)');
      }
      console.log('');

      // Graph Statistics
      console.log('Graph Statistics:');
      console.log(`├─ Total nodes: ${stats.nodeCount}`);
      console.log(`├─ Total edges: ${stats.edgeCount}`);

      // Show edge breakdown
      const callEdges = stats.edgesByType['CALLS'] || 0;
      const containsEdges = stats.edgesByType['CONTAINS'] || 0;
      const importsEdges = stats.edgesByType['IMPORTS'] || 0;

      console.log(`├─ Calls: ${callEdges}`);
      console.log(`├─ Contains: ${containsEdges}`);
      console.log(`└─ Imports: ${importsEdges}`);
      console.log('');

      // Find most called functions (via incoming CALLS edges)
      // This requires a query - simplified for now
      console.log('Next steps:');
      console.log('→ grafema query "function <name>"   Search for a function');
      console.log('→ grafema trace "<var> from <fn>"   Trace data flow');
      console.log('→ grafema impact "<target>"         Analyze change impact');
      console.log('→ grafema explore                   Interactive navigation');

    } finally {
      await backend.close();
    }
  });
