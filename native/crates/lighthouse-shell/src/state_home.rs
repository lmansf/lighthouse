//! §41: the iOS state-home migration — Documents/.rag-vault → the app's
//! Application Support container, run by the wrapper's `bootstrap_env` right
//! after it points `LIGHTHOUSE_APP_STATE_DIR` there and BEFORE any engine
//! call opens state. Tauri-free and platform-neutral by construction (plain
//! fs code), so the whole decision + copy machinery is container-testable;
//! only the wrapper's call site and the backup-exclusion mark are iOS-gated.
//!
//! The contract, in order of importance:
//!   1. NEVER a data-loss path: conflict losers are preserved, the legacy dir
//!      is removed only after a verified copy, and any failure falls back to
//!      running from the legacy location (`LIGHTHOUSE_STATE_HOME_LEGACY=1`)
//!      with one honest log line — never a refuse-to-boot.
//!   2. IDEMPOTENT: a re-run no-ops (marker, or migrated-shape detection).
//!   3. The decision logic is a pure verdict fn over observations
//!      (`state_home_verdict`) — the house pattern — so every branch is a
//!      table-driven unit test, not an fs side effect.

use std::fs;
use std::path::{Path, PathBuf};

/// One-line marker written into the new home after a verified migration —
/// both the idempotency latch and the field-diagnosable record.
pub const MIGRATED_MARKER: &str = ".migrated-from-documents";

/// Where conflict losers (and a both-populated loser) are preserved, under
/// the NEW home — never silently discarded, never left in Documents.
pub const LEGACY_BAK_DIR: &str = ".rag-vault-legacy-bak";

/// A `state.json`-family candidate observed in the legacy dir: the canonical
/// file or an iCloud conflict variant ("state 2.json", "state (conflicted
/// copy).json", …), with the §39 `writtenBy` stamp when parseable and the
/// file mtime (Unix ms) as the tiebreak.
#[derive(Debug, Clone, PartialEq)]
pub struct StateCandidate {
    pub name: String,
    pub written_by: Option<String>,
    pub mtime_ms: u64,
}

/// Everything the verdict needs to know, gathered by the executor — the
/// verdict fn itself touches no filesystem.
#[derive(Debug, Clone, Default)]
pub struct StateHomeObs {
    /// Documents/.rag-vault exists and contains at least one file.
    pub legacy_populated: bool,
    /// The new home already carries the post-migration marker.
    pub marker_present: bool,
    /// The new home has a state.json of its own (any engine state at all).
    pub new_populated: bool,
    /// The `state.json` family found in the LEGACY dir (canonical + conflict
    /// variants). Empty when the legacy dir has no state file.
    pub legacy_state_candidates: Vec<StateCandidate>,
    /// The new home's own state.json as a candidate (both-populated case).
    pub new_state: Option<StateCandidate>,
}

/// Which side's candidate wins the `state.json` slot. Both sides can carry a
/// file literally named `state.json`, so a bare filename cannot say WHICH one
/// won — the §2 fixture that clobbered the newer side with the older proved
/// it. The tag is the disambiguator.
#[derive(Debug, Clone, PartialEq)]
pub enum StateWinner {
    /// A legacy-dir candidate (by its filename there) wins the slot.
    Legacy(String),
    /// The new home's own `state.json` is newest and keeps the slot.
    NewHome,
}

/// The four ways a boot can proceed. `Migrate.winner` is the candidate whose
/// bytes become the new home's `state.json`; every OTHER candidate (losers,
/// and the displaced side of a both-populated race) is preserved in the bak
/// dir by the executor.
#[derive(Debug, Clone, PartialEq)]
pub enum StateHomeVerdict {
    /// Nothing to migrate: first boot on the new layout.
    Fresh,
    /// The marker (or migrated shape: new populated, legacy gone) says done.
    AlreadyMigrated,
    /// Copy legacy → new; `winner` says which state.json wins the slot.
    Migrate { winner: Option<StateWinner> },
    /// Something prevents a safe migration THIS boot; run from the legacy
    /// location and say why. Nothing is deleted on this path.
    RunFromLegacy { reason: String },
}

/// Order two candidates: §39 `writtenBy` version triples first (a candidate
/// stamped by a newer app wins), file mtime as the tiebreak. Unparseable or
/// absent stamps never beat a parseable one (junk never reads newer — the
/// same fail-open shape as core's state_written_by_newer).
fn newer_of<'a>(a: &'a StateCandidate, b: &'a StateCandidate) -> &'a StateCandidate {
    fn triple(v: &Option<String>) -> (u64, u64, u64) {
        let Some(v) = v else { return (0, 0, 0) };
        let mut it = v.trim().split('.').map(|p| p.parse::<u64>().unwrap_or(0));
        (
            it.next().unwrap_or(0),
            it.next().unwrap_or(0),
            it.next().unwrap_or(0),
        )
    }
    let (ta, tb) = (triple(&a.written_by), triple(&b.written_by));
    if ta != tb {
        return if ta > tb { a } else { b };
    }
    if a.mtime_ms >= b.mtime_ms {
        a
    } else {
        b
    }
}

/// The pure decision: observations in, verdict out. Exhaustively tested —
/// every fs consequence (copying, preserving, deleting, falling back) lives
/// in the executor, keyed off this verdict.
pub fn state_home_verdict(obs: &StateHomeObs) -> StateHomeVerdict {
    if obs.marker_present {
        return StateHomeVerdict::AlreadyMigrated;
    }
    if !obs.legacy_populated {
        return if obs.new_populated {
            // Migrated shape without a marker (e.g. the marker was lost to a
            // restore): the legacy dir is gone, so there is nothing to move.
            StateHomeVerdict::AlreadyMigrated
        } else {
            StateHomeVerdict::Fresh
        };
    }
    // Legacy has data. Pick the winning state.json among the legacy family
    // AND, in the both-populated race, the new home's own copy — newest wins,
    // the displaced side is preserved by the executor.
    let mut best_legacy: Option<&StateCandidate> = None;
    for c in &obs.legacy_state_candidates {
        best_legacy = Some(match best_legacy {
            None => c,
            Some(w) => newer_of(w, c),
        });
    }
    let winner = match (best_legacy, obs.new_state.as_ref()) {
        (None, _) => None,
        (Some(l), None) => Some(StateWinner::Legacy(l.name.clone())),
        (Some(l), Some(n)) => {
            if std::ptr::eq(newer_of(l, n), l) {
                Some(StateWinner::Legacy(l.name.clone()))
            } else {
                Some(StateWinner::NewHome)
            }
        }
    };
    StateHomeVerdict::Migrate { winner }
}

/// Parse the §39 `writtenBy` stamp out of a state.json candidate without
/// deserializing the whole (forward-compatible) document.
fn read_written_by(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get("writtenBy")?.as_str().map(String::from)
}

fn mtime_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The `state.json` family: the canonical name plus iCloud duplicate shapes
/// ("state 2.json", "state (conflicted copy).json", "state-conflict …").
fn is_state_family(name: &str) -> bool {
    name == "state.json" || (name.starts_with("state") && name.ends_with(".json"))
}

fn gather_obs(legacy: &Path, new_home: &Path) -> StateHomeObs {
    let mut obs = StateHomeObs {
        marker_present: new_home.join(MIGRATED_MARKER).is_file(),
        new_populated: new_home.join("state.json").is_file(),
        ..Default::default()
    };
    if let Ok(entries) = fs::read_dir(legacy) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if e.path().is_file() || e.path().is_dir() {
                obs.legacy_populated = true;
            }
            if e.path().is_file() && is_state_family(&name) {
                obs.legacy_state_candidates.push(StateCandidate {
                    written_by: read_written_by(&e.path()),
                    mtime_ms: mtime_ms(&e.path()),
                    name,
                });
            }
        }
    }
    if obs.new_populated {
        let p = new_home.join("state.json");
        obs.new_state = Some(StateCandidate {
            name: "state.json".to_string(),
            written_by: read_written_by(&p),
            mtime_ms: mtime_ms(&p),
        });
    }
    obs
}

/// Copy one file durably: bytes, then fsync, then size verify.
fn copy_file_durable(from: &Path, to: &Path) -> std::io::Result<()> {
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(from, to)?;
    let f = fs::File::open(to)?;
    f.sync_all()?;
    let (a, b) = (fs::metadata(from)?.len(), fs::metadata(to)?.len());
    if a != b {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!("size mismatch after copy: {a} vs {b}"),
        ));
    }
    Ok(())
}

/// Recursively copy `from` into `to`, EXCLUDING state-family files at the top
/// level (the winner/losers are routed explicitly). Returns files copied.
fn copy_tree(from: &Path, to: &Path, skip_top_state_family: bool) -> std::io::Result<usize> {
    let mut copied = 0;
    for e in fs::read_dir(from)?.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let src = e.path();
        if src.is_dir() {
            copied += copy_tree(&src, &to.join(&name), false)?;
        } else if src.is_file() {
            if skip_top_state_family && is_state_family(&name) {
                continue;
            }
            copy_file_durable(&src, &to.join(&name))?;
            copied += 1;
        }
    }
    Ok(copied)
}

/// Execute the verdict. Returns the one-line outcome for shell.log. On ANY
/// failure this sets `LIGHTHOUSE_STATE_HOME_LEGACY=1` so the engine's
/// state_dir() keeps resolving to the legacy dir for this launch — the
/// fail-open path deletes nothing and refuses nothing.
pub fn ensure_state_home(legacy: &Path, new_home: &Path) -> String {
    let obs = gather_obs(legacy, new_home);
    match state_home_verdict(&obs) {
        StateHomeVerdict::Fresh => "state-home: fresh install, nothing to migrate".to_string(),
        StateHomeVerdict::AlreadyMigrated => "state-home: already migrated".to_string(),
        StateHomeVerdict::RunFromLegacy { reason } => {
            std::env::set_var("LIGHTHOUSE_STATE_HOME_LEGACY", "1");
            format!("state-home: running from legacy Documents/.rag-vault — {reason}")
        }
        StateHomeVerdict::Migrate { winner } => {
            match migrate(legacy, new_home, &obs, winner.as_ref()) {
                Ok(line) => line,
                Err(e) => {
                    std::env::set_var("LIGHTHOUSE_STATE_HOME_LEGACY", "1");
                    format!(
                        "state-home: migration failed, running from legacy \
                         Documents/.rag-vault this launch — {e}"
                    )
                }
            }
        }
    }
}

fn migrate(
    legacy: &Path,
    new_home: &Path,
    obs: &StateHomeObs,
    winner: Option<&StateWinner>,
) -> std::io::Result<String> {
    fs::create_dir_all(new_home)?;
    let bak = new_home.join(LEGACY_BAK_DIR);

    // Both-populated race, legacy side newest: preserve the new home's own
    // state.json before the winner overwrites the slot.
    let mut preserved = 0;
    if matches!(winner, Some(StateWinner::Legacy(_))) && obs.new_state.is_some() {
        let displaced = new_home.join("state.json");
        if displaced.is_file() {
            fs::create_dir_all(&bak)?;
            copy_file_durable(&displaced, &bak.join("state.json.pre-migration"))?;
            preserved += 1;
        }
    }

    // Copy everything except the state family, then route the family:
    // the winning legacy candidate → state.json; every other legacy candidate
    // → the bak dir under its own name. A NewHome winner keeps the slot as-is,
    // so ALL legacy candidates are losers there.
    let mut copied = copy_tree(legacy, new_home, true)?;
    for c in &obs.legacy_state_candidates {
        let src = legacy.join(&c.name);
        if matches!(winner, Some(StateWinner::Legacy(w)) if *w == c.name) {
            copy_file_durable(&src, &new_home.join("state.json"))?;
            copied += 1;
        } else {
            fs::create_dir_all(&bak)?;
            copy_file_durable(&src, &bak.join(&c.name))?;
            preserved += 1;
        }
    }

    // Verify: every top-level legacy file is accounted for before removal.
    let marker_line = format!(
        "migrated {copied} file(s) from Documents/.rag-vault; \
         {preserved} conflict/displaced file(s) preserved in {LEGACY_BAK_DIR}/"
    );
    fs::write(new_home.join(MIGRATED_MARKER), format!("{marker_line}\n"))?;
    let f = fs::File::open(new_home.join(MIGRATED_MARKER))?;
    f.sync_all()?;

    // Only now is the legacy dir removed — the copy is verified and durable.
    fs::remove_dir_all(legacy)?;
    Ok(format!("state-home: {marker_line}"))
}

/// §41 §1 (deferred clause): mark the extraction cache under the new home as
/// excluded from device backups — it is regenerable by CACHE_VERSION design;
/// state.json and the index stay backed up. iOS-only, via the same
/// ObjC-runtime idiom as the FM bridge (class metadata cannot be
/// dead-stripped; a missing class/selector is a silent no-op, never a crash).
#[cfg(target_os = "ios")]
pub fn mark_cache_no_backup(new_home: &Path) {
    use libc::{c_char, c_void};
    extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn class_getClassMethod(cls: *mut c_void, sel: *mut c_void) -> *mut c_void;
        fn objc_msgSend();
        // Foundation's exported key constant — a plain C symbol, present in
        // every UIKit process (unlike app-target Swift symbols, which is what
        // made dlsym unreliable for the FM bridge).
        static NSURLIsExcludedFromBackupKey: *mut c_void;
    }
    let cache = new_home.join("cache");
    let _ = fs::create_dir_all(&cache);
    let Ok(cpath) = std::ffi::CString::new(cache.to_string_lossy().into_owned()) else {
        return;
    };
    unsafe {
        let nsstring = objc_getClass(b"NSString\0".as_ptr() as *const c_char);
        let nsurl = objc_getClass(b"NSURL\0".as_ptr() as *const c_char);
        let nsnumber = objc_getClass(b"NSNumber\0".as_ptr() as *const c_char);
        if nsstring.is_null() || nsurl.is_null() || nsnumber.is_null() {
            return;
        }
        let sel_str = sel_registerName(b"stringWithUTF8String:\0".as_ptr() as *const c_char);
        let sel_url = sel_registerName(b"fileURLWithPath:\0".as_ptr() as *const c_char);
        let sel_num = sel_registerName(b"numberWithBool:\0".as_ptr() as *const c_char);
        let sel_set =
            sel_registerName(b"setResourceValue:forKey:error:\0".as_ptr() as *const c_char);
        // Verify the class methods exist before messaging (never raise).
        if class_getClassMethod(nsstring, sel_str).is_null()
            || class_getClassMethod(nsurl, sel_url).is_null()
            || class_getClassMethod(nsnumber, sel_num).is_null()
        {
            return;
        }
        type Send1 = unsafe extern "C" fn(*mut c_void, *mut c_void, *const c_char) -> *mut c_void;
        type Send1P = unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> *mut c_void;
        type SendBool = unsafe extern "C" fn(*mut c_void, *mut c_void, bool) -> *mut c_void;
        type SendSet = unsafe extern "C" fn(
            *mut c_void,
            *mut c_void,
            *mut c_void,
            *mut c_void,
            *mut *mut c_void,
        ) -> bool;
        let s1: Send1 = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let s1p: Send1P = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let sb: SendBool = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let ss: SendSet = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());

        let path_ns = s1(nsstring, sel_str, cpath.as_ptr());
        if path_ns.is_null() {
            return;
        }
        let url = s1p(nsurl, sel_url, path_ns);
        if url.is_null() {
            return;
        }
        let yes = sb(nsnumber, sel_num, true);
        if yes.is_null() {
            return;
        }
        let mut err: *mut c_void = std::ptr::null_mut();
        let _ = ss(url, sel_set, yes, NSURLIsExcludedFromBackupKey, &mut err);
    }
}

#[cfg(not(target_os = "ios"))]
pub fn mark_cache_no_backup(_new_home: &Path) {}

/// The legacy state home for a given vault directory — named here so the
/// wrapper's call site and the tests agree on the shape.
pub fn legacy_state_dir(vault_dir: &Path) -> PathBuf {
    vault_dir.join(".rag-vault")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cand(name: &str, written_by: Option<&str>, mtime_ms: u64) -> StateCandidate {
        StateCandidate {
            name: name.to_string(),
            written_by: written_by.map(String::from),
            mtime_ms,
        }
    }

    // --- the pure verdict, table-driven -------------------------------------

    #[test]
    fn verdict_fresh_when_nothing_anywhere() {
        assert_eq!(
            state_home_verdict(&StateHomeObs::default()),
            StateHomeVerdict::Fresh
        );
    }

    #[test]
    fn verdict_marker_short_circuits_everything() {
        let obs = StateHomeObs {
            marker_present: true,
            legacy_populated: true,
            legacy_state_candidates: vec![cand("state.json", Some("0.14.8"), 5)],
            ..Default::default()
        };
        assert_eq!(state_home_verdict(&obs), StateHomeVerdict::AlreadyMigrated);
    }

    #[test]
    fn verdict_migrated_shape_without_marker() {
        let obs = StateHomeObs {
            new_populated: true,
            new_state: Some(cand("state.json", Some("0.14.8"), 5)),
            ..Default::default()
        };
        assert_eq!(state_home_verdict(&obs), StateHomeVerdict::AlreadyMigrated);
    }

    #[test]
    fn verdict_conflict_newest_written_by_wins_over_mtime() {
        let obs = StateHomeObs {
            legacy_populated: true,
            legacy_state_candidates: vec![
                cand("state.json", Some("0.14.2"), 999),
                cand("state 2.json", Some("0.14.5"), 1), // older mtime, newer stamp
            ],
            ..Default::default()
        };
        assert_eq!(
            state_home_verdict(&obs),
            StateHomeVerdict::Migrate {
                winner: Some(StateWinner::Legacy("state 2.json".to_string()))
            }
        );
    }

    #[test]
    fn verdict_junk_stamp_never_beats_parseable_and_mtime_breaks_ties() {
        let obs = StateHomeObs {
            legacy_populated: true,
            legacy_state_candidates: vec![
                cand("state.json", Some("garbage"), 100), // junk → (0,0,0)
                cand("state 2.json", None, 200),          // absent → (0,0,0), newer mtime
            ],
            ..Default::default()
        };
        assert_eq!(
            state_home_verdict(&obs),
            StateHomeVerdict::Migrate {
                winner: Some(StateWinner::Legacy("state 2.json".to_string()))
            }
        );
    }

    #[test]
    fn verdict_both_populated_newest_wins_even_when_it_is_the_new_home() {
        let obs = StateHomeObs {
            legacy_populated: true,
            new_populated: true,
            legacy_state_candidates: vec![cand("state.json", Some("0.14.3"), 50)],
            new_state: Some(cand("state.json", Some("0.14.8"), 10)),
            ..Default::default()
        };
        // The new home's copy is newest → it keeps the slot; migration still
        // runs to move the REST of the legacy dir (and preserve the loser).
        assert_eq!(
            state_home_verdict(&obs),
            StateHomeVerdict::Migrate {
                winner: Some(StateWinner::NewHome)
            }
        );
    }

    // --- the executor, on real temp dirs ------------------------------------

    fn seed(dir: &Path, name: &str, contents: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join(name), contents).unwrap();
    }

    fn fixture(tag: &str) -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("lh-s41-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        (root.join("Documents/.rag-vault"), root.join("appstate/.rag-vault"))
    }

    #[test]
    fn executor_clean_move() {
        let (legacy, new_home) = fixture("clean");
        seed(&legacy, "state.json", r#"{"writtenBy":"0.14.5"}"#);
        seed(&legacy.join("cache/extract"), "a.json", "{}");
        seed(&legacy, "investigations.json", "[]");

        let line = ensure_state_home(&legacy, &new_home);
        assert!(line.starts_with("state-home: migrated"), "{line}");
        assert!(new_home.join("state.json").is_file());
        assert!(new_home.join("cache/extract/a.json").is_file());
        assert!(new_home.join("investigations.json").is_file());
        assert!(new_home.join(MIGRATED_MARKER).is_file());
        assert!(!legacy.exists(), "legacy dir is removed after verified copy");
        // Idempotent: a second run no-ops.
        assert_eq!(ensure_state_home(&legacy, &new_home), "state-home: already migrated");
    }

    #[test]
    fn executor_conflicted_duplicates_newest_wins_losers_preserved() {
        let (legacy, new_home) = fixture("conflict");
        seed(&legacy, "state.json", r#"{"writtenBy":"0.14.2","k":"old"}"#);
        seed(&legacy, "state 2.json", r#"{"writtenBy":"0.14.6","k":"new"}"#);

        let line = ensure_state_home(&legacy, &new_home);
        assert!(line.starts_with("state-home: migrated"), "{line}");
        let winner = fs::read_to_string(new_home.join("state.json")).unwrap();
        assert!(winner.contains("0.14.6"), "newest stamp wins the slot");
        let bak = new_home.join(LEGACY_BAK_DIR);
        let loser = fs::read_to_string(bak.join("state.json")).unwrap();
        assert!(loser.contains("0.14.2"), "loser preserved byte-for-byte");
        assert!(!legacy.exists());
    }

    #[test]
    fn executor_partial_previous_copy_completes() {
        let (legacy, new_home) = fixture("partial");
        seed(&legacy, "state.json", r#"{"writtenBy":"0.14.5"}"#);
        seed(&legacy, "investigations.json", "[]");
        // A previous interrupted run copied one file but wrote no marker.
        seed(&new_home, "investigations.json", "[]");

        let line = ensure_state_home(&legacy, &new_home);
        assert!(line.starts_with("state-home: migrated"), "{line}");
        assert!(new_home.join("state.json").is_file());
        assert!(new_home.join(MIGRATED_MARKER).is_file());
        assert!(!legacy.exists());
    }

    #[test]
    fn executor_both_populated_newer_new_home_keeps_slot_loser_preserved() {
        let (legacy, new_home) = fixture("both");
        seed(&legacy, "state.json", r#"{"writtenBy":"0.14.3","k":"legacy"}"#);
        seed(&legacy, "notes.txt", "rest of legacy moves");
        seed(&new_home, "state.json", r#"{"writtenBy":"0.14.8","k":"new"}"#);

        let line = ensure_state_home(&legacy, &new_home);
        assert!(line.starts_with("state-home: migrated"), "{line}");
        let kept = fs::read_to_string(new_home.join("state.json")).unwrap();
        assert!(kept.contains("0.14.8"), "newer new-home state keeps the slot");
        let bak = new_home.join(LEGACY_BAK_DIR);
        let loser = fs::read_to_string(bak.join("state.json")).unwrap();
        assert!(loser.contains("0.14.3"), "legacy loser preserved");
        assert!(new_home.join("notes.txt").is_file(), "rest of legacy moved");
        assert!(!legacy.exists());
    }

    #[test]
    fn executor_failure_falls_back_to_legacy_and_deletes_nothing() {
        let (legacy, new_home) = fixture("rofail");
        seed(&legacy, "state.json", r#"{"writtenBy":"0.14.5"}"#);
        // Make the TARGET's parent read-only so create_dir_all/copy fails.
        fs::create_dir_all(new_home.parent().unwrap()).unwrap();
        let mut perms = fs::metadata(new_home.parent().unwrap()).unwrap().permissions();
        use std::os::unix::fs::PermissionsExt;
        perms.set_mode(0o555);
        fs::set_permissions(new_home.parent().unwrap(), perms.clone()).unwrap();
        // Root ignores permission bits — the fixture can't force the failure
        // there, so skip honestly rather than assert a fiction.
        if unsafe { libc::geteuid() } == 0 {
            perms.set_mode(0o755);
            let _ = fs::set_permissions(new_home.parent().unwrap(), perms);
            eprintln!("skipping read-only fixture: running as root");
            return;
        }
        std::env::remove_var("LIGHTHOUSE_STATE_HOME_LEGACY");

        let line = ensure_state_home(&legacy, &new_home);
        assert!(
            line.contains("running from legacy"),
            "honest fallback line: {line}"
        );
        assert_eq!(
            std::env::var("LIGHTHOUSE_STATE_HOME_LEGACY").as_deref(),
            Ok("1"),
            "the fail-open switch is set for this launch"
        );
        assert!(legacy.join("state.json").is_file(), "nothing deleted");
        std::env::remove_var("LIGHTHOUSE_STATE_HOME_LEGACY");
        perms.set_mode(0o755);
        let _ = fs::set_permissions(new_home.parent().unwrap(), perms);
    }
}
