//! E2E test for RESUMABLE private-model downloads (`src/local_model.rs`) — the
//! HTTP-Range machinery behind "start it during onboarding, pause it from the
//! AI-models dialog, pick it back up later without re-fetching gigabytes".
//! Mirrors `test/localModel.resume.test.mjs` on the TS twin.
//!
//! Drives the real module against a local plain-HTTP server standing in for
//! Hugging Face, covering: interrupt keeps the `.part` (error + partialBytes);
//! resume sends `Range: bytes=<size>-` and appends the 206 body (progress
//! never dips below the resumed offset, only the missing tail travels);
//! `request_uninstall()` during a download = pause (`.part` survives — also a
//! rapid second call — no `.uninstall` marker, settles at "absent"); a server
//! that ignores Range (200) triggers a clean truncate-restart; a junk `.part`
//! is discarded before any Range is sent; a completed non-GGUF payload is
//! deleted and errors (a corrupt part must never become a ready model); and an
//! oversized `.part` gets 416 → discard → fresh restart.
//!
//! One `#[test]` with sequential phases: the module tracks one download in
//! process-global state, so phases must not run in parallel threads.

use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use lighthouse_core::local_model;

const MB: u64 = 1024 * 1024;
/// Just over the module's 100 MB "real model" guard.
const SIZE: u64 = 100 * MB + MB;
const INTERRUPT_AT: u64 = 8 * MB;
const FILE: &str = "test-model-Q4_K_M.gguf";

/// Server behaviour, switched per phase.
#[derive(Clone, Copy, PartialEq, Default)]
enum Kind {
    /// Honors `Range` with 206 (or 416 past the end).
    #[default]
    Range,
    /// 200, then drops the connection mid-stream.
    Interrupt,
    /// Always 200 with the full body, even when a Range was asked.
    IgnoreRange,
    /// 200 full body that does NOT start with the GGUF magic.
    NoMagic,
}

#[derive(Clone, Copy, Default)]
struct Mode {
    kind: Kind,
    /// Stretch the stream so mid-flight states are observable to a poller.
    slow: bool,
}

/// One hit on the payload endpoint.
#[derive(Clone, Default)]
struct Req {
    range: Option<String>,
    status: u16,
    sent: u64,
}

#[derive(Default)]
struct ServerState {
    mode: Mutex<Mode>,
    requests: Mutex<Vec<Req>>,
}

fn set_mode(state: &ServerState, kind: Kind, slow: bool) {
    *state.mode.lock().unwrap() = Mode { kind, slow };
}

fn req(state: &ServerState, i: usize) -> Req {
    state.requests.lock().unwrap()[i].clone()
}

fn req_count(state: &ServerState) -> usize {
    state.requests.lock().unwrap().len()
}

/// Serve one request on `stream` per the current mode, then close.
fn handle(mut stream: TcpStream, state: &ServerState) {
    // Read the request head (we never need a body).
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        match stream.read(&mut byte) {
            Ok(1) => head.push(byte[0]),
            _ => return,
        }
        if head.len() > 65_536 {
            return;
        }
    }
    let head = String::from_utf8_lossy(&head).to_string();
    let range = head.lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.trim().eq_ignore_ascii_case("range").then(|| v.trim().to_string())
    });
    let mode = *state.mode.lock().unwrap();
    let idx = {
        let mut reqs = state.requests.lock().unwrap();
        reqs.push(Req { range: range.clone(), status: 0, sent: 0 });
        reqs.len() - 1
    };

    let start: u64 = match (&range, mode.kind == Kind::Range) {
        (Some(r), true) => r
            .strip_prefix("bytes=")
            .and_then(|s| s.strip_suffix('-'))
            .and_then(|s| s.parse().ok())
            .unwrap_or(0),
        _ => 0,
    };
    if mode.kind == Kind::Range && range.is_some() && start >= SIZE {
        state.requests.lock().unwrap()[idx].status = 416;
        let _ = write!(
            stream,
            "HTTP/1.1 416 Range Not Satisfiable\r\ncontent-range: bytes */{SIZE}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
        );
        return;
    }
    let head_out = if start > 0 {
        state.requests.lock().unwrap()[idx].status = 206;
        format!(
            "HTTP/1.1 206 Partial Content\r\ncontent-length: {}\r\ncontent-range: bytes {}-{}/{}\r\ncontent-type: application/octet-stream\r\nconnection: close\r\n\r\n",
            SIZE - start,
            start,
            SIZE - 1,
            SIZE
        )
    } else {
        state.requests.lock().unwrap()[idx].status = 200;
        format!(
            "HTTP/1.1 200 OK\r\ncontent-length: {SIZE}\r\ncontent-type: application/octet-stream\r\nconnection: close\r\n\r\n"
        )
    };
    if stream.write_all(head_out.as_bytes()).is_err() {
        return;
    }
    let mut pos = start;
    let mut sent = 0u64;
    while pos < SIZE {
        if mode.kind == Kind::Interrupt && sent >= INTERRUPT_AT {
            let _ = stream.shutdown(Shutdown::Both); // drop the connection mid-stream
            return;
        }
        let len = MB.min(SIZE - pos) as usize;
        let mut chunk = vec![0u8; len];
        if pos == 0 && mode.kind != Kind::NoMagic {
            chunk[..4].copy_from_slice(b"GGUF"); // the file's first bytes carry the magic
        }
        if stream.write_all(&chunk).is_err() {
            return; // client went away (pause) — fine
        }
        pos += len as u64;
        sent += len as u64;
        state.requests.lock().unwrap()[idx].sent = sent;
        // Throttle so in-flight states are observable to a poller.
        std::thread::sleep(Duration::from_millis(if mode.slow { 12 } else { 1 }));
    }
}

/// Poll until the download reaches a terminal state, collecting samples.
fn settle() -> (local_model::Progress, Vec<local_model::Progress>) {
    let deadline = Instant::now() + Duration::from_secs(120);
    let mut samples = Vec::new();
    loop {
        let s = local_model::model_status();
        if s.status != "downloading" {
            return (s, samples);
        }
        samples.push(s);
        assert!(
            Instant::now() < deadline,
            "download never reached a terminal state"
        );
        std::thread::sleep(Duration::from_millis(15));
    }
}

#[test]
fn resumable_download_pause_and_integrity_lifecycle() {
    // --- mock model host --------------------------------------------------
    let state = Arc::new(ServerState::default());
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    {
        let state = state.clone();
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(stream) = conn else { continue };
                let state = state.clone();
                std::thread::spawn(move || handle(stream, &state));
            }
        });
    }

    // Hermetic env: an empty resources dir (so a dev machine's fetched model
    // can't leak into the "installed" checks), the model file name, and the
    // mock host URL. LIGHTHOUSE_MODELS_DIR is re-pointed per phase — the
    // module reads it on every call.
    let res_dir = tempfile::tempdir().unwrap();
    std::env::set_var("LIGHTHOUSE_RESOURCES_PATH", res_dir.path());
    std::env::set_var("LIGHTHOUSE_LOCAL_MODEL_FILE", FILE);
    std::env::set_var(
        "LIGHTHOUSE_LOCAL_MODEL_URL",
        format!("http://127.0.0.1:{port}/cdn/model.gguf"),
    );

    // --- A. Interrupt: the partial is KEPT (that's the whole feature) ------
    let dir_a = tempfile::tempdir().unwrap();
    std::env::set_var("LIGHTHOUSE_MODELS_DIR", dir_a.path());
    set_mode(&state, Kind::Interrupt, false);
    let kicked = local_model::start_download();
    assert_eq!(kicked.status, "downloading", "kickoff returns immediately (fire-and-forget)");
    let (fin_a, _) = settle();
    assert_eq!(fin_a.status, "error", "an interrupted download surfaces as error");
    let part_a = dir_a.path().join(format!("{FILE}.part"));
    assert!(part_a.exists(), "the .part is KEPT after an interruption (resumable)");
    let part_a_size = std::fs::metadata(&part_a).unwrap().len();
    assert!(part_a_size > 4 && part_a_size < SIZE, ".part holds a real prefix");
    assert_eq!(fin_a.partial_bytes, Some(part_a_size), "status reports the resumable bytes");
    assert!(!dir_a.path().join(FILE).exists(), "no installed model after an interruption");
    assert_eq!(req(&state, 0).range, None, "a fresh download sends no Range header");

    // --- B. Resume: Range → 206 appended → ready, all in the background ----
    set_mode(&state, Kind::Range, true);
    let before_b = req_count(&state);
    let kicked = local_model::start_download();
    assert_eq!(kicked.status, "downloading", "resume kickoff also returns immediately");
    let (fin_b, samples) = settle();
    assert_eq!(fin_b.status, "ready", "resumed download completes to ready: {:?}", fin_b.error);
    let r = req(&state, before_b);
    assert_eq!(
        r.range.as_deref(),
        Some(format!("bytes={part_a_size}-").as_str()),
        "resume sends Range from the kept .part size"
    );
    assert_eq!(r.status, 206, "the server honored the Range (206)");
    assert_eq!(r.sent, SIZE - part_a_size, "only the missing tail traveled (206 APPEND, not a refetch)");
    let observed: Vec<_> = samples.iter().filter(|s| s.total > 0).collect();
    assert!(!observed.is_empty(), "mid-flight progress is observable");
    for s in &observed {
        assert!(
            s.received >= part_a_size,
            "resumed progress never dips below the offset ({} < {part_a_size})",
            s.received
        );
    }
    let dest_a = dir_a.path().join(FILE);
    assert_eq!(std::fs::metadata(&dest_a).unwrap().len(), SIZE, "installed file is the complete payload");
    let mut magic = [0u8; 4];
    std::fs::File::open(&dest_a).unwrap().read_exact(&mut magic).unwrap();
    assert_eq!(&magic, b"GGUF", "the resumed file begins with the GGUF magic");
    assert!(!part_a.exists(), "no .part remains after a successful resume");
    assert_eq!(local_model::model_status().partial_bytes, None, "ready status carries no partialBytes");

    // --- C. Pause = uninstall while downloading: .part survives, no marker --
    let dir_c = tempfile::tempdir().unwrap();
    std::env::set_var("LIGHTHOUSE_MODELS_DIR", dir_c.path());
    set_mode(&state, Kind::Range, true);
    local_model::start_download();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let s = local_model::model_status();
        assert_ne!(s.status, "error", "pause-phase download must not error before the pause");
        if s.status == "downloading" && s.received > 3 * MB {
            break;
        }
        assert!(Instant::now() < deadline, "download never got going for the pause phase");
        std::thread::sleep(Duration::from_millis(10));
    }
    let paused = local_model::request_uninstall();
    assert_eq!(paused.status, "absent", "DELETE during a download pauses (absent, not uninstalling)");
    std::thread::sleep(Duration::from_millis(500)); // let the torn-down task settle
    let after = local_model::model_status();
    assert_eq!(after.status, "absent", "a paused download settles at absent, never error");
    let part_c = dir_c.path().join(format!("{FILE}.part"));
    assert!(part_c.exists(), "pause KEEPS the .part");
    assert!(after.partial_bytes.unwrap_or(0) > 0, "paused status reports the resumable bytes");
    assert!(
        !dir_c.path().join(".uninstall").exists(),
        "pause drops NO uninstall marker (nothing installed to remove)"
    );
    let again = local_model::request_uninstall();
    assert_eq!(again.status, "absent", "a second DELETE is a safe no-op");
    assert!(part_c.exists(), "a rapid second DELETE does not discard the resumable .part");
    let part_c_size = std::fs::metadata(&part_c).unwrap().len();
    set_mode(&state, Kind::Range, false);
    let before_c = req_count(&state);
    local_model::start_download();
    let (fin_c, _) = settle();
    assert_eq!(fin_c.status, "ready", "a paused download resumes to ready: {:?}", fin_c.error);
    assert_eq!(
        req(&state, before_c).range.as_deref(),
        Some(format!("bytes={part_c_size}-").as_str()),
        "the resume after pause sends Range"
    );
    assert_eq!(
        std::fs::metadata(dir_c.path().join(FILE)).unwrap().len(),
        SIZE,
        "paused+resumed file is byte-exact"
    );

    // --- D. Server ignores Range: 200 → truncate + clean full restart ------
    let dir_d = tempfile::tempdir().unwrap();
    std::env::set_var("LIGHTHOUSE_MODELS_DIR", dir_d.path());
    set_mode(&state, Kind::Interrupt, false);
    local_model::start_download();
    let (fin_d1, _) = settle();
    assert_eq!(fin_d1.status, "error");
    let part_d = dir_d.path().join(format!("{FILE}.part"));
    let part_d_size = std::fs::metadata(&part_d).unwrap().len();
    assert!(part_d_size > 0, "interrupted again: .part kept for the fallback phase");
    set_mode(&state, Kind::IgnoreRange, false);
    let before_d = req_count(&state);
    local_model::start_download();
    let (fin_d2, _) = settle();
    assert_eq!(fin_d2.status, "ready", "the 200 fallback still completes: {:?}", fin_d2.error);
    let r = req(&state, before_d);
    assert_eq!(
        r.range.as_deref(),
        Some(format!("bytes={part_d_size}-").as_str()),
        "the module DID ask to resume"
    );
    assert_eq!(r.status, 200, "…but the server ignored the Range (200)");
    assert_eq!(r.sent, SIZE, "the server sent the full body");
    assert_eq!(
        std::fs::metadata(dir_d.path().join(FILE)).unwrap().len(),
        SIZE,
        "truncate-restart yields the exact size (no double-append)"
    );

    // --- E. Junk .part (no GGUF magic) is discarded before any Range -------
    let dir_e = tempfile::tempdir().unwrap();
    std::env::set_var("LIGHTHOUSE_MODELS_DIR", dir_e.path());
    let mut junk = b"JUNK".to_vec();
    junk.extend(std::iter::repeat(7u8).take((2 * MB) as usize));
    std::fs::write(dir_e.path().join(format!("{FILE}.part")), junk).unwrap();
    set_mode(&state, Kind::Range, false);
    let before_e = req_count(&state);
    local_model::start_download();
    let (fin_e, _) = settle();
    assert_eq!(fin_e.status, "ready", "a junk partial never blocks a clean install: {:?}", fin_e.error);
    assert_eq!(
        req(&state, before_e).range,
        None,
        "a junk .part is discarded — no Range sent (integrity gate)"
    );
    assert_eq!(std::fs::metadata(dir_e.path().join(FILE)).unwrap().len(), SIZE);

    // --- F. Completed-but-corrupt payload: DELETED + error (strict) --------
    let dir_f = tempfile::tempdir().unwrap();
    std::env::set_var("LIGHTHOUSE_MODELS_DIR", dir_f.path());
    set_mode(&state, Kind::NoMagic, false);
    local_model::start_download();
    let (fin_f, _) = settle();
    assert_eq!(fin_f.status, "error", "a corrupt completed download surfaces as error");
    assert!(
        fin_f.error.as_deref().unwrap_or("").contains("not a valid GGUF model"),
        "the error names the integrity failure: {:?}",
        fin_f.error
    );
    assert!(
        !dir_f.path().join(format!("{FILE}.part")).exists(),
        "the corrupt .part is DELETED, never kept"
    );
    assert!(
        !dir_f.path().join(FILE).exists(),
        "a corrupt part never becomes a ready model"
    );
    assert_eq!(fin_f.partial_bytes, None, "no resumable bytes advertised after an integrity failure");

    // --- G. Oversized .part → 416 → discard → fresh restart ----------------
    let dir_g = tempfile::tempdir().unwrap();
    std::env::set_var("LIGHTHOUSE_MODELS_DIR", dir_g.path());
    let part_g = dir_g.path().join(format!("{FILE}.part"));
    {
        // Sparse GGUF-prefixed .part LARGER than the asset (e.g. the URL now
        // serves a smaller file than an old attempt did).
        let mut f = std::fs::File::create(&part_g).unwrap();
        f.write_all(b"GGUF").unwrap();
        f.set_len(SIZE + MB).unwrap();
    }
    set_mode(&state, Kind::Range, false);
    let before_g = req_count(&state);
    local_model::start_download();
    let (fin_g, _) = settle();
    assert_eq!(fin_g.status, "ready", "the 416 path recovers to a clean install: {:?}", fin_g.error);
    assert_eq!(req(&state, before_g).status, 416, "the oversized resume got 416");
    assert_eq!(
        req(&state, before_g + 1).range,
        None,
        "after 416 the .part is discarded and the refetch is rangeless"
    );
    assert_eq!(std::fs::metadata(dir_g.path().join(FILE)).unwrap().len(), SIZE);
}
