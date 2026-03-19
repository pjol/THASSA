pub mod config;
pub mod contracts;
pub mod format;
pub mod logging;
pub mod primus;
pub mod prover;
pub mod server;
pub mod shape;
pub mod submission;
pub mod types;
pub mod workflow;

pub use config::Config;
pub use workflow::{NodeRuntime, NodeRuntimeParts};

pub async fn run() -> anyhow::Result<()> {
    logging::init_logging();
    let config = Config::load()?;
    let runtime = NodeRuntime::build(config).await?;
    runtime.run().await
}
