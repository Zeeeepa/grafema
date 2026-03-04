use grafema_orchestrator::{analyzer, config, discovery, gc, plugin, process_pool, rfdb};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "grafema-orchestrator", version, about = "Grafema analysis pipeline orchestrator")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Run analysis on a project
    Analyze {
        /// Path to grafema.config.yaml
        #[arg(short, long)]
        config: PathBuf,

        /// Path to RFDB unix socket
        #[arg(short, long)]
        socket: Option<PathBuf>,

        /// Number of parallel analysis jobs
        #[arg(short, long, default_value_t = num_cpus())]
        jobs: usize,

        /// Force re-analysis of all files (ignore mtime)
        #[arg(long)]
        force: bool,
    },
}

fn num_cpus() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();

    let cli = Cli::parse();

    match cli.command {
        Commands::Analyze {
            config: config_path,
            socket,
            jobs,
            force,
        } => {
            let cfg = config::load(&config_path)?;

            // Resolve RFDB socket path: CLI flag > config > default
            let socket_path = socket
                .or(cfg.rfdb_socket.clone())
                .unwrap_or_else(|| PathBuf::from("/tmp/rfdb.sock"));

            tracing::info!(
                config = %config_path.display(),
                socket = %socket_path.display(),
                jobs = jobs,
                force = force,
                "Starting analysis"
            );

            // 1. Discover files
            let files = discovery::discover(&cfg)?;
            tracing::info!(count = files.len(), "Discovered files");

            if files.is_empty() {
                tracing::warn!("No files matched include patterns");
                return Ok(());
            }

            // 2. Connect to RFDB
            let mut rfdb = rfdb::RfdbClient::connect(&socket_path)
                .await
                .with_context(|| format!("Failed to connect to RFDB at {}", socket_path.display()))?;

            let db_name = "grafema";
            rfdb.create_database(db_name, false).await?;
            rfdb.open_database(db_name, "rw").await?;
            tracing::info!(db = db_name, "Connected to RFDB");

            // 3. Set up generation tracker and filter changed files
            let mut gen_tracker = gc::GenerationTracker::new(0);
            let generation = gen_tracker.bump();
            let (changed_files, unchanged_files) =
                gc::filter_changed_files(&files, &gen_tracker, force)?;

            tracing::info!(
                changed = changed_files.len(),
                skipped = unchanged_files.len(),
                generation = generation,
                "Filtered files for analysis"
            );

            if changed_files.is_empty() {
                tracing::info!("All files up to date, nothing to analyze");
                return Ok(());
            }

            // 4. Analyze changed files in parallel (OXC parse → grafema-analyzer daemon pool)
            let results = analyzer::analyze_files_parallel_pooled(&changed_files, jobs).await;

            // 5. Ingest results into RFDB (deferred indexing for performance)
            let mut total_nodes = 0usize;
            let mut total_edges = 0usize;
            let mut total_errors = 0usize;

            for result in &results {
                if !result.errors.is_empty() {
                    total_errors += result.errors.len();
                    for err in &result.errors {
                        tracing::error!(file = %result.file.display(), "{err}");
                    }
                }

                if let Some(ref analysis) = result.analysis {
                    let mut wire_nodes = analyzer::to_wire_nodes(analysis);
                    let mut wire_edges = analyzer::to_wire_edges(analysis);

                    // Stamp generation metadata on all nodes/edges
                    for node in &mut wire_nodes {
                        gc::stamp_node_metadata(&mut node.metadata, generation, "analyzer");
                    }
                    for edge in &mut wire_edges {
                        gc::stamp_edge_metadata(&mut edge.metadata, generation, "analyzer");
                    }

                    total_nodes += wire_nodes.len();
                    total_edges += wire_edges.len();

                    let file_str = result.file.display().to_string();
                    rfdb.commit_batch(&[file_str], &wire_nodes, &wire_edges, true)
                        .await
                        .with_context(|| {
                            format!("Failed to commit batch for {}", result.file.display())
                        })?;
                }
            }

            // Rebuild indexes once after all deferred commits
            rfdb.rebuild_indexes().await.context("Failed to rebuild indexes")?;

            tracing::info!(
                nodes = total_nodes,
                edges = total_edges,
                errors = total_errors,
                "Analysis complete"
            );

            // 6. Handle deleted files
            let deleted = gc::detect_deleted_files(&gen_tracker, &files);
            if !deleted.is_empty() {
                tracing::info!(count = deleted.len(), "Cleaning up deleted files");
                for del_file in &deleted {
                    let file_str = del_file.display().to_string();
                    rfdb.commit_batch(&[file_str], &[], &[], false).await?;
                }
            }

            // 7. Update mtime tracker for next incremental run
            gc::update_mtimes(&mut gen_tracker, &changed_files)?;

            // 8. Run plugins via DAG (with resolve daemon pool)
            if !cfg.plugins.is_empty() {
                tracing::info!(count = cfg.plugins.len(), "Running plugins");

                // Create resolve pool (size=1: plugins run sequentially per DAG level)
                let resolve_pool_config = process_pool::PoolConfig {
                    command: "grafema-resolve".to_string(),
                    args: vec!["--daemon".to_string()],
                    ..process_pool::PoolConfig::default()
                };
                let resolve_pool = match process_pool::ProcessPool::new(resolve_pool_config, 1) {
                    Ok(pool) => {
                        tracing::info!("Created resolve daemon pool");
                        Some(pool)
                    }
                    Err(e) => {
                        tracing::warn!("Failed to create resolve pool, falling back to spawn-per-plugin: {e}");
                        None
                    }
                };

                let plugin_results = plugin::run_plugins_dag(
                    &cfg.plugins,
                    &mut rfdb,
                    &socket_path,
                    db_name,
                    generation,
                    resolve_pool.as_ref(),
                )
                .await?;

                // Shutdown resolve pool
                if let Some(pool) = resolve_pool {
                    pool.shutdown().await;
                }

                for pr in &plugin_results {
                    if let Some(ref err) = pr.error {
                        tracing::error!(plugin = %pr.plugin_name, "{err}");
                    }
                }

                let plugin_nodes: usize = plugin_results.iter().map(|r| r.nodes_emitted).sum();
                let plugin_edges: usize = plugin_results.iter().map(|r| r.edges_emitted).sum();
                tracing::info!(
                    plugins = plugin_results.len(),
                    nodes = plugin_nodes,
                    edges = plugin_edges,
                    "Plugins complete"
                );
            }

            // 9. Summary
            println!(
                "Analyzed {} files ({} skipped): {} nodes, {} edges, {} errors",
                changed_files.len(),
                unchanged_files.len(),
                total_nodes,
                total_edges,
                total_errors
            );

            Ok(())
        }
    }
}
