//! Lighthouse local API server — a wire-compatible Rust replacement for the
//! `next start` process the desktop shell runs today (Phase 2 of the native
//! rewrite; see docs/rewrite-scope.md).
//!
//! Binds to loopback ONLY, same as the Next server: exposing the local API
//! (and every file/link/open route) to the LAN is never acceptable.

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let port: u16 = std::env::var("PORT")
        .or_else(|_| std::env::var("LIGHTHOUSE_PORT"))
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3777);

    // Phase 5: event-driven freshness (index invalidation + live tree) with a
    // TTL fallback where no watcher backend exists.
    lighthouse_core::watch::start();

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    eprintln!("lighthouse-server listening on http://127.0.0.1:{port}");
    axum::serve(listener, lighthouse_server::app()).await?;
    Ok(())
}
