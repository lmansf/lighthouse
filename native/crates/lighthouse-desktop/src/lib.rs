//! Lighthouse shell library (Tauri 2) — Phase 3 of docs/rewrite-scope.md,
//! restructured for add-mobile-apps §2.
//!
//! This file is the PORTABLE spine: the engine bootstrap (`bootstrap_env`),
//! the settings file, the IPC command registration, the pins/briefings
//! scheduler, the watcher + index warm-up, the smoke/diag drivers, and the
//! UI transport (bundled-asset IPC or the embedded loopback server). The
//! desktop bin (`main.rs`) and the mobile targets (`#[tauri::mobile_entry_point]`)
//! share exactly this one `run()` code path.
//!
//! Everything desktop-only — window + tray (close hides, quit from tray),
//! native Add/Link/Choose-vault dialogs, launch-at-login, single instance,
//! the floating widget + summon hotkeys + whisper mode, safe-mode boot
//! guard, llama-server supervision with the uninstall marker handshake, and
//! the notify-only update check — lives in `src/desktop/` behind
//! `cfg(desktop)` and is compiled out entirely on iOS/Android.

mod commands;
#[cfg(desktop)]
mod desktop;

// Compat re-exports: the pre-split shell was one flat module, and the moved
// code (commands.rs, supervise.rs, whisper.rs) addresses its siblings by
// absolute `crate::` paths. Re-exporting the desktop modules/items at the
// crate root keeps every one of those paths valid — the split moves code,
// not call sites.
#[cfg(desktop)]
pub(crate) use desktop::{boot_guard, supervise, whisper};
#[cfg(desktop)]
pub use desktop::widget::*;
#[cfg(desktop)]
pub(crate) use desktop::tray::*;

use std::fs;
use std::path::PathBuf;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

/// Port of the embedded loopback server, when one is running (no bundled UI
/// or LIGHTHOUSE_SERVE=1). Lazily-created windows need it to build their URL;
/// 0 = no server, use the bundled-asset route.
#[derive(Default)]
pub struct ServerPort(pub(crate) std::sync::atomic::AtomicU16);

/// Whether the desktop boot guard put this launch in safe mode. Mobile has no
/// boot guard (the OS supervises app lifecycle), so a mobile launch is never
/// in safe mode.
fn safe_mode() -> bool {
    #[cfg(desktop)]
    {
        boot_guard::safe_mode()
    }
    #[cfg(not(desktop))]
    {
        false
    }
}

/// Whether background-conserve currently has the local model servers
/// suspended. Mobile has no llama supervision (no local 3B/7B servers), so
/// nothing is ever suspended there.
fn servers_suspended(app: &AppHandle) -> bool {
    #[cfg(desktop)]
    {
        app.try_state::<supervise::Supervisor>()
            .map(|s| s.is_suspended())
            .unwrap_or(false)
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        false
    }
}

/// The install-global app-data base, PINNED to the historical
/// `com.lighthouse.app` directory.
///
/// 0.12.8 renamed the Tauri bundle identifier `com.lighthouse.app` →
/// `app.lhvault` (to match the App Store identity / owned domain lhvault.app).
/// Tauri derives `app_data_dir()` as `<base>/<identifier>`, so *following* the
/// rename would silently relocate — and orphan — every existing user's
/// settings, sealed API keys, and downloaded models. The identifier is the
/// app's OS / store / updater identity; the on-disk data path is deliberately
/// decoupled from it so the rename carries ZERO data-migration risk.
/// `boot_guard.rs::state_dir` pins the same literal, and `secrets.rs`'s
/// `KEYCHAIN_SERVICE` is likewise left unchanged. DO NOT "unify" this to
/// `app_data_dir()` without first shipping a first-launch data migration —
/// `tests/identity_pin.rs` guards against exactly that. Every app-data reader/
/// writer in the crate (settings, secrets env, logs, updater staging) resolves
/// through here so nothing splits across the old and new identifier dirs.
pub(crate) fn app_data_base(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    // Desktop only: `<base>/app.lhvault` → `<base>/com.lighthouse.app`, so the
    // rename moves no existing data (if there's somehow no parent, keep the
    // derived dir rather than lose the base). Mobile ships later and is
    // greenfield — it uses its natural `app.lhvault` path, nothing to preserve.
    #[cfg(desktop)]
    let base = dir
        .parent()
        .map(|b| b.join("com.lighthouse.app"))
        .unwrap_or(dir);
    #[cfg(not(desktop))]
    let base = dir;
    Some(base)
}

/// The ONE platform signal (iOS field patch 1 §1): the shell's form factor,
/// carried on every capability surface (settings_get / rag_list) so the UI
/// branches on a single engine-reported value — no UA sniffing, no
/// window-size proxies. Deliberately distinct from the existing
/// `desktop: true` compat flag and from LIGHTHOUSE_DESKTOP=1, which both mean
/// "embedded shell" (the engine relies on that on iOS too) — this field is
/// WHICH shell. Delegates to the core (§3): the same value drives the
/// engine's own platform verdicts (local-model support, profile defaults),
/// so shell and engine can never disagree about what they're running on.
pub(crate) fn platform_kind() -> &'static str {
    lighthouse_core::config::platform_kind()
}

/// Append a timestamped line to app-data/shell.log — the debugging lifeline
/// for GUI builds, where stderr goes nowhere (0.6.3 field report: widget mode
/// silently absent on one Windows machine, zero clues). Rotates once past
/// ~256 KB (shell.log → shell.log.1) so it can run forever. Best-effort.
pub fn shell_log(app: &AppHandle, msg: &str) {
    let Some(dir) = app_data_base(app) else { return };
    let _ = fs::create_dir_all(&dir);
    let path = dir.join("shell.log");
    if fs::metadata(&path).map(|m| m.len() > 256 * 1024).unwrap_or(false) {
        let _ = fs::rename(&path, dir.join("shell.log.1"));
    }
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        use std::io::Write as _;
        let _ = writeln!(f, "[{}] {}", lighthouse_core::config::now_ms(), msg);
    }
}

/// The in-webview end-to-end probe for LIGHTHOUSE_SMOKE=1 (see the driver in
/// setup): list the vault, include the harness-seeded fixture, ask one
/// question through the intercepted window.fetch (the exact path a user's ask
/// takes in IPC mode), and assert the NDJSON stream ends in a done chunk that
/// cites the fixture and quotes its content. Retries the first fetch while
/// the transport is still installing. Verdict goes to the `smoke_report`
/// command, which turns it into the process exit code.
const SMOKE_DRIVER_JS: &str = r#"
(function () {
  var inv = function (p) { window.__TAURI_INTERNALS__.invoke('smoke_report', { payload: p }); };
  var tries = 0;
  var step = 'list';
  function start() {
    step = 'list';
    fetch('/api/rag').then(function (r) { return r.json(); }).then(function (j) {
      var nodes = j.nodes || [];
      var f = null;
      for (var i = 0; i < nodes.length; i++) {
        if (String(nodes[i].id).indexOf('smoke-fixture') >= 0) { f = nodes[i]; break; }
      }
      if (!f) { throw new Error('fixture not in vault list (nodes=' + nodes.length + ')'); }
      step = 'include';
      return fetch('/api/rag', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'include', nodeId: f.id, included: true })
      }).then(function () { return f; });
    }).then(function (f) {
      step = 'ask';
      return fetch('/api/chat', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'What is the Q3 revenue target?', includedFileIds: [f.id], history: [] })
      }).then(function (r) { return r.text(); });
    }).then(function (t) {
      step = 'assert';
      var lines = t.trim().split('\n');
      var last = JSON.parse(lines[lines.length - 1]);
      var answer = '';
      for (var i = 0; i < lines.length - 1; i++) {
        try { answer += (JSON.parse(lines[i]).delta || ''); } catch (e) {}
      }
      if (!last.done) { throw new Error('final chunk not done'); }
      var refs = last.references || [];
      if (!refs.length) { throw new Error('no references on final chunk'); }
      var cited = false;
      for (var i = 0; i < refs.length; i++) {
        if (String(refs[i].fileId).indexOf('smoke-fixture') >= 0) { cited = true; break; }
      }
      if (!cited) { throw new Error('references do not cite the fixture: ' + JSON.stringify(refs).slice(0, 200)); }
      if (answer.indexOf('42 million') < 0) { throw new Error('answer does not quote fixture content: ' + answer.slice(0, 160)); }
      inv('OK grounded answer: ' + refs.length + ' reference(s), ' + lines.length + ' stream lines');
    }).catch(function (e) {
      if (step === 'list' && ++tries < 30) { setTimeout(start, 1000); return; }
      inv('FAIL at ' + step + ': ' + String((e && e.message) || e));
    });
  }
  start();
})();
"#;

/// CI boot-smoke isolation (release-smoke.yml): when set, all install-scope
/// state (settings, models, connectors, profile, app state) lives under this
/// directory instead of the OS app-data dir, so a smoke run can never touch —
/// or be influenced by — a real install on the same machine.
fn smoke_state_dir() -> Option<PathBuf> {
    std::env::var("LIGHTHOUSE_SMOKE_STATE")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

fn settings_file(app: &AppHandle) -> PathBuf {
    // Pinned base (see `app_data_base`) so the 0.12.8 identifier rename does not
    // move `lighthouse-settings.json` — and the vaultDir pointer inside it —
    // out from under existing installs. Smoke isolation still wins.
    smoke_state_dir()
        .or_else(|| app_data_base(app))
        .unwrap_or_else(std::env::temp_dir)
        .join("lighthouse-settings.json")
}

pub(crate) fn read_settings(app: &AppHandle) -> Value {
    fs::read_to_string(settings_file(app))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

/// G5: fire the briefing-note OS notification, gated. Off when `briefingNotify`
/// is false (the note is still written), and — the "never wake from hidden"
/// rule — suppressed while the app is suspended (hidden to tray or idle-
/// suspended under background-conserve). The note write itself is unaffected.
fn maybe_notify(app: &AppHandle, n: usize) {
    use tauri_plugin_notification::NotificationExt;
    if read_settings(app)["briefingNotify"].as_bool() == Some(false) {
        return;
    }
    if servers_suspended(app) {
        return;
    }
    let body = format!("{n} pinned question{} changed.", if n == 1 { "" } else { "s" });
    let _ = app
        .notification()
        .builder()
        .title("Lighthouse Briefing updated")
        .body(body)
        .show();
}

pub(crate) fn write_settings(app: &AppHandle, patch: Value) {
    let mut s = read_settings(app);
    if let (Some(obj), Some(p)) = (s.as_object_mut(), patch.as_object()) {
        for (k, v) in p {
            obj.insert(k.clone(), v.clone());
        }
    }
    let f = settings_file(app);
    if let Some(dir) = f.parent() {
        let _ = fs::create_dir_all(dir);
    }
    // Same atomic temp+rename writer the core uses — this file has TWO
    // writers (core's settings_set and this raw merge), and a plain
    // fs::write could tear or interleave with the other side's rename.
    lighthouse_core::config::write_json(&f, &s);
}

/// The local vault directory (persisted; defaults under the user's Documents).
/// Managed policy: a stored vaultDir that violates `vaultRoots` (a policy
/// that arrived AFTER the vault was chosen) is not applied — the app falls
/// back to an allowed location instead of silently indexing a forbidden
/// path at boot. Non-destructive: the old folder's files are untouched.
pub fn vault_dir_setting(app: &AppHandle) -> PathBuf {
    let from_settings = read_settings(app)["vaultDir"]
        .as_str()
        .map(PathBuf::from)
        .filter(|d| lighthouse_core::policy::vault_path_allowed(d));
    let dir = from_settings.unwrap_or_else(|| {
        let default = app
            .path()
            .document_dir()
            // Pinned base (see `app_data_base`) so a no-Documents fallback lands
            // at the same default across the 0.12.8 identifier rename.
            .unwrap_or_else(|_| app_data_base(app).unwrap_or_else(std::env::temp_dir))
            .join("Lighthouse Vault");
        if lighthouse_core::policy::vault_path_allowed(&default) {
            default
        } else {
            // Even the OS default is outside the allowlist: root the vault
            // under the first allowed prefix.
            lighthouse_core::policy::first_vault_root()
                .map(|r| r.join("Lighthouse Vault"))
                .unwrap_or(default)
        }
    });
    let _ = fs::create_dir_all(&dir);
    dir
}

/// Wire the engine's environment before any core call (the core reads env per
/// call, so a later "Choose vault folder…" can re-point VAULT_DIR live).
fn bootstrap_env(app: &AppHandle) {
    std::env::set_var("LIGHTHOUSE_DESKTOP", "1");
    std::env::set_var("VAULT_DIR", vault_dir_setting(app));
    std::env::set_var("LIGHTHOUSE_SETTINGS_FILE", settings_file(app));
    // Pinned base (see `app_data_base`): models, connectors, profile, and the
    // whole LIGHTHOUSE_APP_STATE_DIR (secrets, sealed keys) stay at the historical
    // path across the 0.12.8 identifier rename. Smoke isolation still wins.
    if let Some(data) = smoke_state_dir().or_else(|| app_data_base(app)) {
        let models = data.join("models");
        let connectors = data.join("connectors");
        let _ = fs::create_dir_all(&models);
        let _ = fs::create_dir_all(&connectors);
        std::env::set_var("LIGHTHOUSE_MODELS_DIR", &models);
        std::env::set_var("LIGHTHOUSE_CONNECTORS_DIR", &connectors);

        // The signed-in profile lives in this private data dir so it survives
        // vault moves / re-points (which otherwise stranded it and forced a
        // sign-in on every launch). One-time migration: if there's no profile
        // here yet but an earlier build left one inside the vault, carry it
        // over so returning users stay signed in.
        let _ = fs::create_dir_all(&data);
        let profile = data.join("profile.json");
        if !profile.exists() {
            let legacy = vault_dir_setting(app)
                .join(".rag-vault")
                .join("profile.json");
            if legacy.exists() {
                let _ = fs::copy(&legacy, &profile);
            }
        }
        std::env::set_var("LIGHTHOUSE_PROFILE_FILE", &profile);

        // Always-unlocked build: the licensing / accounts / registration system
        // is gone. Earlier builds migrated license, identity, and contact state
        // INTO this app-state dir (and kept trial/usage bookkeeping here); flip
        // that migrate-in to a best-effort CLEAN-UP so a machine upgrading to
        // this build doesn't leave stale unlock/telemetry files behind. Errors
        // are ignored (a missing file is the normal case). profile.json and
        // secrets.json are deliberately NOT removed — they hold the signed-in
        // profile and the sealed API keys the app still needs.
        for name in [
            "license.json",
            "identity.json",
            "contact.json",
            "launch.json",
            "usage.json",
            "usage-snapshot.json",
            "experiments.json",
            "activation.json",
        ] {
            let _ = fs::remove_file(data.join(name));
        }
        std::env::set_var("LIGHTHOUSE_APP_STATE_DIR", &data);

        // §41 (iOS only): move the engine state home out of the user-visible
        // Documents vault into this Application Support container — BEFORE
        // any engine call opens state. The migration is lossless and
        // idempotent; on ANY failure it flips LIGHTHOUSE_STATE_HOME_LEGACY=1
        // so this launch runs from the legacy dir (never a refuse-to-boot).
        // The one-line outcome goes to shell.log for field diagnosability,
        // and the regenerable extraction cache under the new home is marked
        // do-not-back-up (state.json and the index stay backed up).
        #[cfg(all(not(desktop), target_os = "ios"))]
        {
            let legacy = lighthouse_shell::state_home::legacy_state_dir(&vault_dir_setting(app));
            let new_home = data.join(".rag-vault");
            let outcome = lighthouse_shell::state_home::ensure_state_home(&legacy, &new_home);
            shell_log(app, &outcome);
            lighthouse_shell::state_home::mark_cache_no_backup(&new_home);
        }
    }
    // Bundled offline assets (llama-server, embed + OCR models). Packaged
    // builds have them under the resource dir; dev runs fall back to the
    // repo's resources/. §1 (iOS field patch 2): accept the dir when ANY of
    // the three asset folders exists — the mobile bundle carries only `ocr`
    // (llama-server and the embed GGUF it serves are desktop-only), and the
    // old llm-only gate would have rejected a bundle without it, leaving
    // LIGHTHOUSE_RESOURCES_PATH unset and OCR unreachable on device.
    let resource_root = app
        .path()
        .resource_dir()
        .ok()
        .filter(|d| d.join("llm").exists() || d.join("ocr").exists() || d.join("embed").exists());
    let dev_root = std::env::current_dir()
        .ok()
        .map(|d| d.join("../../../resources"))
        .filter(|d| d.exists());
    if let Some(root) = resource_root.or(dev_root) {
        std::env::set_var("LIGHTHOUSE_RESOURCES_PATH", root);
    }
}

/// Whether a real UI bundle is compiled in (Phase 4 IPC mode) — the static
/// build drops a `lighthouse-ui.json` marker beside its assets.
pub(crate) fn has_bundled_ui(app: &AppHandle) -> bool {
    app.asset_resolver()
        .get("/lighthouse-ui.json".into())
        .is_some()
        || app
            .asset_resolver()
            .get("lighthouse-ui.json".into())
            .is_some()
}

/// Embedded loopback API server (server-UI mode and web parity). Returns the
/// bound port once the server is accepting.
async fn start_embedded_server() -> anyhow::Result<u16> {
    let token = hex::encode(rand::random::<[u8; 32]>());
    std::env::set_var("LIGHTHOUSE_API_TOKEN", &token);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = axum::serve(listener, lighthouse_server::app()).await {
            eprintln!("embedded server exited: {e}");
        }
    });
    Ok(port)
}

pub(crate) fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

/// Shared shell entry point (add-mobile-apps §2). The desktop bin (`main.rs`)
/// calls this directly; on the mobile targets Tauri's generated native entry
/// point invokes it through `#[tauri::mobile_entry_point]`. All shell logic
/// lives here so desktop and mobile share exactly one code path.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Must run before the builder: safe mode's webview flags only count if
    // they're in the environment before any webview process is spawned.
    // (Desktop-only: mobile has no boot guard — the OS supervises launches.)
    #[cfg(desktop)]
    let _safe = desktop::boot_guard::begin(env!("CARGO_PKG_VERSION"));

    let builder = tauri::Builder::default();
    // Desktop plugins (single-instance, autostart, window-state,
    // global-shortcut), widget/supervision state, and menu/window handlers.
    #[cfg(desktop)]
    let builder = desktop::configure(builder);
    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init()); // G5 briefing-note alerts
    // §31 touch feel: haptics exist only where there's a taptic engine — the
    // plugin (and its capability, capabilities/mobile.json) is mobile-only.
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_haptics::init());
    builder
        .manage(ServerPort::default())
        .invoke_handler(tauri::generate_handler![
            commands::rag_list,
            commands::rag_op,
            commands::chat_ask,
            commands::profile_get,
            commands::profile_op,
            commands::connect_op,
            commands::model_status,
            commands::model_download,
            commands::model_uninstall,
            commands::private_model_availability,
            commands::open_node,
            commands::reveal_node,
            commands::settings_get,
            commands::settings_set,
            commands::diagnostics,
            commands::add_paths,
            commands::pick_link_paths,
            commands::upload_file,
            commands::update_state,
            commands::update_now,
            commands::watch_generation,
            commands::diag_report,
            commands::smoke_report,
            commands::widget_hide,
            commands::widget_show,
            commands::widget_set_pin,
            commands::widget_hold,
            commands::widget_resize,
            commands::show_main,
            commands::open_vault_dir,
            commands::open_explorer,
            commands::reduce_transparency,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            bootstrap_env(&handle);

            // CI boot smoke (LIGHTHOUSE_SMOKE=1, release-smoke.yml): prove the
            // shipped binary boots and answers one grounded ask with ZERO
            // network — so the model supervisor and the update check (the two
            // legitimate background egress/spawn sources) stay off for the
            // run, and the verdict is the process exit code.
            let smoke = std::env::var("LIGHTHOUSE_SMOKE")
                .map(|v| v == "1")
                .unwrap_or(false);

            // Everything desktop-only: autostart consent, menu + tray, the
            // widget boot surface + launch presentation, safe-mode dialog,
            // boot-guard ready timer, summon hotkey + whisper, and the
            // supervision + update loops.
            #[cfg(desktop)]
            desktop::setup(app, smoke)?;
            #[cfg(not(desktop))]
            let _ = smoke;

            // Mobile: probe the on-device private-model backend once at boot so
            // the availability verdict + LIGHTHOUSE_LOCAL_LLM_URL are set before
            // the first ask (on iOS this also stands up the in-process Foundation
            // Models loopback responder). Runs inline — binding a resident
            // Tier-1 model's loopback socket is instant, and the first ask must
            // never race the probe. Desktop owns llama-server and never needs it.
            // The verdict goes to shell.log (iOS field report: private model
            // absent with zero clues) — the opt-in bug report attaches that
            // log, so the FM result behind any "unavailable" is diagnosable.
            #[cfg(not(desktop))]
            {
                let verdict = commands::private_model_availability_impl();
                shell_log(app.handle(), &format!("private-model probe: {verdict}"));
                // §35 §1: Dynamic Type changes re-resolve without an app kill.
                commands::start_content_size_observer();
            }

            // --- Pinned-question rechecks (openspec: add-pinned-questions):
            // sample the watcher generation every 30 s; when it advanced,
            // wait for a full 60 s window with no further changes (bulk file
            // operations collapse into one pass), then re-run every pin's
            // stored SQL — deterministic, guarded, no model — and emit ONE
            // `pins-changed` event with the changed set. Emission failures
            // go to shell.log and the next generation change retries.
            {
                let handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    let mut last_seen = lighthouse_core::watch::generation();
                    // Alerts that couldn't be delivered yet (emit failure) —
                    // carried into the next pass so they're never lost: the
                    // digests persist BEFORE the emit, so without this buffer
                    // a failed emit would silently swallow the change.
                    let mut pending: Vec<lighthouse_core::pins::ChangedPin> = Vec::new();
                    // G5 briefing note: pins changed since the LAST note, keyed by
                    // id so a pin that changes twice before a note reads
                    // before=oldest, now=newest. Independent of `pending` (which
                    // clears on each emit); this clears only when a note is written.
                    let mut note_changes: std::collections::HashMap<
                        String,
                        lighthouse_core::pins::ChangedPin,
                    > = std::collections::HashMap::new();
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                        let g = lighthouse_core::watch::generation();
                        if g == last_seen {
                            continue;
                        }
                        // Quiet debounce: keep waiting while changes keep landing.
                        let mut quiet = g;
                        loop {
                            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                            let now = lighthouse_core::watch::generation();
                            if now == quiet {
                                break;
                            }
                            quiet = now;
                        }
                        last_seen = quiet;
                        if pending.is_empty() && lighthouse_core::pins::list().is_empty() {
                            continue;
                        }
                        let changed = lighthouse_core::pins::recheck_all().await;
                        // Accumulate for the briefing note (keep earliest `before`,
                        // update `after`) BEFORE `changed` is moved into `pending`.
                        for c in &changed {
                            note_changes
                                .entry(c.id.clone())
                                .and_modify(|e| e.after = c.after.clone())
                                .or_insert_with(|| c.clone());
                        }
                        // Newest state wins per pin id; undelivered older
                        // alerts for other pins ride along.
                        let fresh: std::collections::HashSet<String> =
                            changed.iter().map(|c| c.id.clone()).collect();
                        pending.retain(|p| !fresh.contains(&p.id));
                        pending.extend(changed);
                        // Fire the change toast when there's something fresh — but
                        // do NOT early-continue on an empty `pending`, or a note
                        // that has come due this pass (from changes accumulated on
                        // an EARLIER pass) would be skipped whenever the current
                        // pass produced no fresh pin change — e.g. the watcher
                        // generation bumped on an unrelated vault edit.
                        if !pending.is_empty() {
                            match handle
                                .emit("pins-changed", serde_json::json!({ "changed": pending }))
                            {
                                Ok(()) => pending.clear(),
                                Err(e) => {
                                    shell_log(
                                        &handle,
                                        &format!("pins: emit failed (will retry next pass): {e}"),
                                    );
                                }
                            }
                        }
                        // G5: at most once per user-set daily hour, refresh the
                        // briefing note from everything changed since the last
                        // note, then notify (gated). The note is written even
                        // when the notification is suppressed. Only stamp the daily
                        // gate + clear the accumulator once the write SUCCEEDS, so a
                        // failed write retries next pass instead of silently
                        // recording the day's note as done and dropping the changes.
                        let hour = read_settings(&handle)["briefingNoteHour"]
                            .as_u64()
                            .unwrap_or(9) as u32;
                        let now = lighthouse_core::config::now_ms();
                        if !note_changes.is_empty()
                            && lighthouse_core::briefings::note_due(
                                lighthouse_core::briefings::last_note_ms(),
                                now,
                                hour,
                            )
                        {
                            let mut changed_vec: Vec<_> = note_changes.values().cloned().collect();
                            changed_vec.sort_by(|a, b| a.id.cmp(&b.id)); // deterministic order
                            let md = lighthouse_core::briefings::compose_briefing_note(
                                &changed_vec,
                                now,
                            );
                            match lighthouse_core::vault::refresh_artifact(
                                "Lighthouse Notes",
                                "Lighthouse Briefing",
                                "md",
                                md.as_bytes(),
                            ) {
                                Ok(_) => {
                                    lighthouse_core::briefings::mark_note_run(now);
                                    let _ = handle.emit("vault-changed", ());
                                    maybe_notify(&handle, changed_vec.len());
                                    note_changes.clear();
                                }
                                Err(e) => shell_log(
                                    &handle,
                                    &format!("briefing note write failed (will retry): {e}"),
                                ),
                            }
                        }
                    }
                });
            }

            // Phase 5 watcher: event-driven tree/index freshness + a pushed
            // "vault-generation" event replacing the UI's 4 s poll.
            lighthouse_core::watch::start();

            // Pre-warm the retrieval index off the interactive path (bounded
            // threads inside): the first question after a launch — or after
            // linking a big folder — used to pay the whole corpus build.
            // Skipped in safe mode: a minimal boot does nothing optional.
            if !safe_mode() {
                tauri::async_runtime::spawn(async {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    lighthouse_core::vault::warm_index_async();
                });
            }
            {
                let handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    let mut last = lighthouse_core::watch::generation();
                    loop {
                        // While background-conserve has us suspended the UI is
                        // hidden, so park this 2 Hz poll: sleep long and skip
                        // the emit. `last` isn't advanced, so the first tick
                        // after resume fires one event if anything changed and
                        // the (now-visible) UI refreshes once.
                        let suspended = servers_suspended(&handle);
                        tokio::time::sleep(std::time::Duration::from_millis(
                            if suspended { 2000 } else { 500 },
                        ))
                        .await;
                        if suspended {
                            continue;
                        }
                        let now = lighthouse_core::watch::generation();
                        if now != last {
                            last = now;
                            let _ = handle.emit("vault-generation", now);
                        }
                    }
                });
            }

            // Boot diagnostics (LIGHTHOUSE_DIAG=1): capture early JS errors,
            // then report the webview's state + a live fetch probe into the
            // shell log — how headless CI smoke-tests prove the UI→IPC→engine
            // pipeline without a display.
            if std::env::var("LIGHTHOUSE_DIAG").map(|v| v == "1").unwrap_or(false) {
                let handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
                    if let Some(win) = main_window(&handle) {
                        let _ = win.eval(
                            "window.__LH_ERRORS=window.__LH_ERRORS||[];window.onerror=function(m,s,l){window.__LH_ERRORS.push(String(m)+' @'+s+':'+l)};window.addEventListener('unhandledrejection',function(e){window.__LH_ERRORS.push('rej: '+((e.reason&&e.reason.message)||String(e.reason)))});",
                        );
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                    if let Some(win) = main_window(&handle) {
                        let _ = win.eval(
                            "window.__TAURI_INTERNALS__.invoke('diag_report',{payload:JSON.stringify({ready:document.readyState,title:document.title,scripts:document.scripts.length,bodyLen:(document.body&&document.body.innerHTML.length)||0,tauri:!!window.__TAURI_INTERNALS__,fetchHead:String(window.fetch).slice(0,80),errors:window.__LH_ERRORS||['collector-not-installed']})});",
                        );
                        let _ = win.eval(
                            "fetch('/api/rag').then(function(r){return r.json()}).then(function(j){window.__TAURI_INTERNALS__.invoke('diag_report',{payload:'fetch-ok nodes='+(j.nodes?j.nodes.length:'?')+' desktop='+j.desktop})}).catch(function(e){window.__TAURI_INTERNALS__.invoke('diag_report',{payload:'fetch-fail '+String(e)})});",
                        );
                    }
                });
            }

            // CI boot smoke driver: once the webview has booted, drive one
            // real ask through the UI transport (window.fetch →
            // tauriTransport → IPC → engine) against the harness-seeded
            // vault, then exit with the verdict — 0 grounded answer with
            // references, 2 assertion failed, 3 never reported (webview or
            // transport never came up). This is the same binary a user
            // installs and the same pipeline a real ask takes; on Linux
            // runners it runs under Xvfb.
            if smoke {
                let handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    match main_window(&handle) {
                        Some(win) => {
                            let _ = win.eval(SMOKE_DRIVER_JS);
                        }
                        None => {
                            eprintln!("SMOKE FAIL: no main window");
                            handle.exit(3);
                            return;
                        }
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(120)).await;
                    eprintln!("SMOKE FAIL: timed out waiting for smoke_report");
                    handle.exit(3);
                });
            }

            // UI transport: bundled static UI ⇒ pure IPC, no TCP port at all.
            // No bundle (or LIGHTHOUSE_SERVE=1) ⇒ embedded loopback server.
            let ipc_ui = has_bundled_ui(&handle);
            let force_serve = std::env::var("LIGHTHOUSE_SERVE").map(|v| v == "1").unwrap_or(false);
            if !ipc_ui || force_serve {
                let handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    match start_embedded_server().await {
                        Ok(port) => {
                            eprintln!("embedded API on http://127.0.0.1:{port}");
                            if let Some(s) = handle.try_state::<ServerPort>() {
                                s.0.store(port, std::sync::atomic::Ordering::Relaxed);
                            }
                            if !ipc_ui {
                                if let Some(win) = main_window(&handle) {
                                    let url = format!("http://127.0.0.1:{port}")
                                        .parse()
                                        .expect("loopback url");
                                    let _ = win.navigate(url);
                                }
                                #[cfg(desktop)]
                                if let Some(w) = handle.get_webview_window(WIDGET_LABEL) {
                                    let url = format!("http://127.0.0.1:{port}/widget")
                                        .parse()
                                        .expect("loopback url");
                                    let _ = w.navigate(url);
                                }
                            }
                        }
                        Err(e) => eprintln!("embedded server failed to start: {e}"),
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Lighthouse")
        .run(|app, event| {
            // Desktop: widget position memory, boot-guard healthy-exit mark,
            // supervised-server shutdown, macOS Dock reopen.
            #[cfg(desktop)]
            desktop::on_run_event(app, &event);
            if let tauri::RunEvent::Exit = event {
                lighthouse_core::index::flush_now(); // don't lose the warm cache
            }
            #[cfg(not(desktop))]
            let _ = app;
        });
}
