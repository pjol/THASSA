use tracing_subscriber::{fmt, EnvFilter};

pub fn init_logging() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = fmt()
        .with_env_filter(filter)
        .with_target(false)
        .with_level(true)
        .with_thread_ids(true)
        .with_thread_names(true)
        .pretty()
        .try_init();
}
