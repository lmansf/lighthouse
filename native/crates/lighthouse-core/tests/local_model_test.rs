//! Regression test for the desktop Install crash: `start_download()` used a
//! bare `tokio::spawn`, which PANICS when no Tokio runtime is ambient. Tauri
//! runs sync commands on the main thread (no runtime context), so clicking
//! "Install" killed the whole app. The fix makes `start_download()` safe from
//! any thread — ambient runtime when present, a dedicated thread otherwise.

use std::time::{Duration, Instant};

use lighthouse_core::local_model;

/// No `#[tokio::test]` here — the point is to call from a plain thread with no
/// runtime, exactly like a Tauri sync command on the main thread.
#[test]
fn start_download_outside_a_tokio_runtime_does_not_panic() {
    let dir = tempfile::tempdir().unwrap();
    std::env::set_var("LIGHTHOUSE_MODELS_DIR", dir.path());
    // Connection-refused fast: nothing listens on port 9 (discard) locally.
    std::env::set_var("LIGHTHOUSE_LOCAL_MODEL_URL", "http://127.0.0.1:9/model.gguf");

    // The old code panicked right here ("there is no reactor running…").
    let p = local_model::start_download();
    assert_eq!(p.status, "downloading", "kickoff reports the download started");

    // The fallback thread must still drive the download to a terminal state —
    // here an error (unreachable URL) — proving the task actually ran.
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let s = local_model::model_status();
        if s.status == "error" {
            assert!(s.error.is_some(), "a failed install carries a reason");
            break;
        }
        assert_ne!(s.status, "ready", "an unreachable URL cannot yield a model");
        assert!(
            Instant::now() < deadline,
            "download never reached a terminal state (status stuck at {})",
            s.status
        );
        std::thread::sleep(Duration::from_millis(100));
    }

    // A retry after the error must also not panic and must restart cleanly.
    let retry = local_model::start_download();
    assert_eq!(retry.status, "downloading", "retry restarts after an error");
}
