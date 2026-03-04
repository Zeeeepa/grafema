//! Configuration parsing for grafema.config.yaml

use anyhow::{Context, Result};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Top-level analyzer configuration.
#[derive(Debug, Deserialize)]
pub struct AnalyzerConfig {
    /// Project root directory (resolved relative to config file)
    #[serde(default = "default_root")]
    pub root: PathBuf,

    /// Glob patterns for files to include
    pub include: Vec<String>,

    /// Glob patterns for files to exclude
    #[serde(default)]
    pub exclude: Vec<String>,

    /// Plugin configurations
    #[serde(default)]
    pub plugins: Vec<PluginConfig>,

    /// Path to RFDB unix socket (overridable via CLI)
    #[serde(default = "default_rfdb_socket")]
    pub rfdb_socket: Option<PathBuf>,
}

/// Plugin configuration.
#[derive(Debug, Deserialize)]
pub struct PluginConfig {
    /// Plugin name (unique identifier)
    pub name: String,

    /// Command to execute
    pub command: String,

    /// Datalog query for streaming mode input
    pub query: Option<String>,

    /// Plugin names this depends on
    #[serde(default)]
    pub depends_on: Vec<String>,

    /// Execution mode
    #[serde(default)]
    pub mode: PluginMode,

    /// Execution timeout in seconds (e.g., 60 for one minute)
    #[serde(default)]
    pub timeout_secs: Option<u64>,
}

impl PluginConfig {
    /// Returns the timeout as a `Duration`, if configured.
    pub fn timeout(&self) -> Option<Duration> {
        self.timeout_secs.map(Duration::from_secs)
    }
}

/// Plugin execution mode.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginMode {
    /// Orchestrator queries RFDB, pipes nodes to plugin stdin
    #[default]
    Streaming,
    /// Plugin gets RFDB_SOCKET env var, queries directly
    Batch,
}

fn default_root() -> PathBuf {
    PathBuf::from(".")
}

fn default_rfdb_socket() -> Option<PathBuf> {
    Some(PathBuf::from("/tmp/rfdb.sock"))
}

/// Load and validate configuration from a YAML file.
pub fn load(path: &Path) -> Result<AnalyzerConfig> {
    let content = std::fs::read_to_string(path)
        .with_context(|| format!("Failed to read config: {}", path.display()))?;

    let mut config: AnalyzerConfig = serde_yaml::from_str(&content)
        .with_context(|| format!("Failed to parse config: {}", path.display()))?;

    // Resolve root relative to config file location
    if config.root.is_relative() {
        if let Some(parent) = path.parent() {
            config.root = parent.join(&config.root);
        }
    }

    // Canonicalize so downstream code gets a clean absolute path
    config.root = config.root.canonicalize().with_context(|| {
        format!(
            "Config 'root' directory does not exist or is not accessible: {}",
            config.root.display()
        )
    })?;

    if !config.root.is_dir() {
        anyhow::bail!(
            "Config 'root' must be a directory, got: {}",
            config.root.display()
        );
    }

    if config.include.is_empty() {
        anyhow::bail!("Config must have at least one 'include' pattern");
    }

    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TEST_COUNTER: AtomicUsize = AtomicUsize::new(0);

    /// Create a unique temp directory for each test.
    fn test_dir() -> PathBuf {
        let id = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir()
            .join("grafema-config-tests")
            .join(format!("{}_{}", std::process::id(), id));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Helper: write a temporary config file and return its path.
    fn write_config(dir: &Path, yaml: &str) -> PathBuf {
        let path = dir.join("grafema.config.yaml");
        fs::write(&path, yaml).unwrap();
        path
    }

    /// Cleanup helper (best-effort).
    fn cleanup(dir: &Path) {
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn load_minimal_config() {
        let dir = test_dir();
        let config_path = write_config(
            &dir,
            &format!(
                "root: \"{}\"\ninclude:\n  - \"**/*.js\"\n",
                dir.display()
            ),
        );

        let cfg = load(&config_path).unwrap();
        assert_eq!(cfg.include, vec!["**/*.js"]);
        assert!(cfg.exclude.is_empty());
        assert!(cfg.plugins.is_empty());
        // Default rfdb_socket
        assert_eq!(cfg.rfdb_socket, Some(PathBuf::from("/tmp/rfdb.sock")));
        cleanup(&dir);
    }

    #[test]
    fn load_empty_include_fails() {
        let dir = test_dir();
        let config_path = write_config(
            &dir,
            &format!("root: \"{}\"\ninclude: []\n", dir.display()),
        );

        let err = load(&config_path).unwrap_err();
        assert!(
            err.to_string().contains("at least one 'include' pattern"),
            "unexpected error: {err}"
        );
        cleanup(&dir);
    }

    #[test]
    fn load_nonexistent_root_fails() {
        let dir = test_dir();
        let config_path = write_config(
            &dir,
            "root: \"/nonexistent/path/that/does/not/exist\"\ninclude:\n  - \"**/*.js\"\n",
        );

        let err = load(&config_path).unwrap_err();
        assert!(
            err.to_string().contains("does not exist"),
            "unexpected error: {err}"
        );
        cleanup(&dir);
    }

    #[test]
    fn root_resolved_relative_to_config_dir() {
        let dir = test_dir();
        let sub = dir.join("project");
        fs::create_dir_all(&sub).unwrap();

        let config_path = write_config(
            &dir,
            "root: \"project\"\ninclude:\n  - \"**/*.js\"\n",
        );

        let cfg = load(&config_path).unwrap();
        // After canonicalize, should point to the sub directory
        assert_eq!(cfg.root, sub.canonicalize().unwrap());
        cleanup(&dir);
    }

    #[test]
    fn rfdb_socket_override() {
        let dir = test_dir();
        let config_path = write_config(
            &dir,
            &format!(
                "root: \"{}\"\ninclude:\n  - \"**/*.js\"\nrfdb_socket: /custom/rfdb.sock\n",
                dir.display()
            ),
        );

        let cfg = load(&config_path).unwrap();
        assert_eq!(cfg.rfdb_socket, Some(PathBuf::from("/custom/rfdb.sock")));
        cleanup(&dir);
    }

    #[test]
    fn plugin_timeout_as_seconds() {
        let dir = test_dir();
        let yaml = format!(
            r#"
root: "{}"
include:
  - "**/*.js"
plugins:
  - name: resolver
    command: "grafema-resolve imports"
    timeout_secs: 120
"#,
            dir.display()
        );
        let config_path = write_config(&dir, &yaml);
        let cfg = load(&config_path).unwrap();

        assert_eq!(cfg.plugins.len(), 1);
        assert_eq!(cfg.plugins[0].timeout(), Some(Duration::from_secs(120)));
        cleanup(&dir);
    }

    #[test]
    fn plugin_timeout_absent() {
        let dir = test_dir();
        let yaml = format!(
            r#"
root: "{}"
include:
  - "**/*.js"
plugins:
  - name: resolver
    command: "grafema-resolve imports"
"#,
            dir.display()
        );
        let config_path = write_config(&dir, &yaml);
        let cfg = load(&config_path).unwrap();

        assert_eq!(cfg.plugins[0].timeout(), None);
        cleanup(&dir);
    }

    #[test]
    fn plugin_mode_defaults_to_streaming() {
        let dir = test_dir();
        let yaml = format!(
            r#"
root: "{}"
include:
  - "**/*.js"
plugins:
  - name: resolver
    command: "grafema-resolve"
"#,
            dir.display()
        );
        let config_path = write_config(&dir, &yaml);
        let cfg = load(&config_path).unwrap();
        assert!(matches!(cfg.plugins[0].mode, PluginMode::Streaming));
        cleanup(&dir);
    }

    #[test]
    fn plugin_mode_batch() {
        let dir = test_dir();
        let yaml = format!(
            r#"
root: "{}"
include:
  - "**/*.js"
plugins:
  - name: resolver
    command: "grafema-resolve"
    mode: batch
"#,
            dir.display()
        );
        let config_path = write_config(&dir, &yaml);
        let cfg = load(&config_path).unwrap();
        assert!(matches!(cfg.plugins[0].mode, PluginMode::Batch));
        cleanup(&dir);
    }

    #[test]
    fn missing_config_file_fails() {
        let err = load(Path::new("/nonexistent/grafema.config.yaml")).unwrap_err();
        assert!(
            err.to_string().contains("Failed to read config"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn malformed_yaml_fails() {
        let dir = test_dir();
        let config_path = write_config(&dir, "not: [valid: yaml: {{");

        let err = load(&config_path).unwrap_err();
        assert!(
            err.to_string().contains("Failed to parse config"),
            "unexpected error: {err}"
        );
        cleanup(&dir);
    }
}
