# Crate split — lighthouse-shell (§40 Phase A: the cut line)

GOAL: everything except the thin Tauri wrapper `cargo check`s in the Linux
dev container (no webkit/gtk); desktop-only code physically separated;
behavior BYTE-IDENTICAL. Mechanical only. Phase B must not contradict this
doc without updating it.

## Inventory — lighthouse-desktop today (by real dependency surface)

| Module | Lines | tauri refs | Class | Verdict |
|---|---|---|---|---|
| src/commands.rs | 2,303 | 41 | mixed (a)+(b) | SPLIT: core-only bodies move; tauri-typed commands stay |
| src/lib.rs | 771 | 15 | (b) builder/setup + (a) bootstrap_env logic | stays whole (Phase B correction: every env/dir helper threads `app: &AppHandle` — app_data_base, document_dir — so extraction is a seam rewrite, not a move; 80% rule) |
| src/main.rs | 11 | 1 | (b) | stays |
| src/desktop/boot_guard.rs | 130 | 0 | (a) — pure, zero tauri | MOVES (its module cfg gate disappears) |
| src/desktop/mod.rs | 462 | 22 | (c) | stays |
| src/desktop/supervise.rs | 877 | 3 | (c) | stays |
| src/desktop/tray.rs | 247 | 5 | (c) | stays |
| src/desktop/whisper.rs | 554 | 3 | (c) | stays |
| src/desktop/widget.rs | 505 | 9 | (c) | stays |
| gen/apple (Swift) | — | — | (d) | untouched |

### commands.rs, function by function

MOVE to lighthouse-shell (core-only bodies; the wrapper keeps a thin
`#[tauri::command]` delegation): `rag_list`, the `rag_op` op dispatch,
`profile_get`/`profile_op`, `connect_op`, `model_uninstall`, `open_node`,
`add_paths`, `watch_generation`, `diag_report`,
`private_model_availability_impl` + the LHFMBridge ensure glue +
`start_content_size_observer` (their `#[cfg(target_os = "ios")]` objc arms
are cfg'd out on Linux, and `cargo check` does not link — container-checkable
by construction), plus the pure helpers (`string_array`, `err_string`,
`percent_decode`). Phase B addition: `open_with_os` (widget.rs, pure std) also
moves — to the SHELL CRATE ROOT so the moved `open_node` body's
`crate::open_with_os(&abs)` call stays byte-identical — and widget.rs
re-exports it (`pub use lighthouse_shell::open_with_os;`) so the wrapper's
tray/supervise/reveal call sites resolve unchanged.

STAY in the wrapper (the 80%-that-ships list — each body is dominated by a
tauri plugin/type, and a trait seam would be a rewrite, not a move):

- `chat_ask` — streams via `app.emit` per delta; the emit loop IS the body.
- `upload_file` — takes `tauri::ipc::Request<'_>` (a tauri type in the
  signature contract).
- `settings_get`/`settings_set` — restart/emit plumbing woven through.
- `model_status`/`model_download` — progress emits woven through.
- `diagnostics`/`smoke_report`/`shell_log_excerpt` — read the shell log via
  app paths/handles.
- `pick_link_paths` (dialog plugin), `reveal_node` (opener plugin),
  `update_state`/`update_now` (updater plugin), `widget_*`/`show_main`
  (desktop window management).

Seams (Phase B ground truth): exactly ONE proved necessary — the
vault-changed seam. `rag_op` broadcasts `app.emit("vault-changed", ())` at
20 sites; the moved body takes
`vault_changed: &(dyn Fn() + Send + Sync)` and calls it at those same 20
sites, and the wrapper's delegation supplies the emit closure. A function
argument, not a trait framework. The log seam this section originally
presumed was NOT needed — no moved body calls `shell_log` (logging lives in
the stay-list bodies and lib.rs).

## The mined branch — origin/claude/mobile-s2-crate-split (c56ccc9)

Its cut line (the 1,761-line `main.rs` → `lib.rs` conversion + the
`src/desktop/*` module split + platform-scoped capabilities) ALREADY LANDED
on main via the mobile arc — the branch's merge-base predates everything
recent and its remaining delta is superseded history plus the
add-mobile-apps openspec records. KEEP: the precedent that the app crate
name, `gen/apple`, and `tauri.conf.json` never move (it proved `tauri ios
build` survives internal restructuring). DISCARD: everything else — no
unmerged code is worth salvaging. §40 extends the same line one level
deeper: crate boundary instead of module boundary.

## The decided layout

- NEW `native/crates/lighthouse-shell` (workspace member,
  `version.workspace = true`): depends on lighthouse-core (+ serde/serde_json/
  anyhow as needed), NEVER on tauri. Holds the moved (a) code as plain
  functions with their bodies byte-identical (imports adjusted; any forced
  signature change is listed in the PR body).
- `lighthouse-desktop` remains the Tauri APP crate — name, `gen/apple`,
  `tauri.conf.json`, bundle identifiers all UNTOUCHED (the `tauri ios build`
  hard constraint). It shrinks to: the builder/setup (lib.rs), the
  `#[tauri::command]` delegations, the stay-list commands above, and
  `src/desktop/*` behind the single `#[cfg(desktop)] mod desktop;` gate.
- Gate accounting (Phase B correction): boot_guard's module gate disappears
  (the re-export sits inside the already-gated `mod desktop`). The `#[cfg]`
  forks INSIDE moved bodies (`desktop` / `not(desktop) + ios` arms of
  open_node, private_model_availability_impl, start_content_size_observer)
  move WITH the bodies, byte-identical. That requires the shell crate to
  define the `desktop`/`mobile` cfg aliases itself: tauri-build emits them
  for the APP crate only and cfgs never cross crate boundaries, so
  lighthouse-shell has a 5-line `build.rs` re-deriving them from the same
  rule (mobile = ios | android). Without it every `#[cfg(desktop)]` arm
  would silently compile out — a behavior change. The one `mod desktop`
  gate in the wrapper remains BY DESIGN: the wrapper crate is both the
  desktop and the iOS app, so its desktop-only module tree keeps exactly
  one gate at the root — down from per-module/per-body soup.

## The container gate (Phase B §2)

`cargo check -p lighthouse-core -p lighthouse-shell -p lighthouse-cli
-p lighthouse-server -p lighthouse-mcp` runs in the dev container AND as a
per-PR CI job. The grep-verify blind spot shrinks to the wrapper's
delegation layer + the stay-list bodies. CLAUDE.md's blind-spot note updates
to name that smaller reality.

## Stamps

Cargo.lock's `lighthouse-*` family goes FIVE → SIX. CLAUDE.md's stamp
section already bumps by pattern; only its parenthetical count note changes.
The §39 check-stamps tripwire asserts AGREEMENT (collecting crates by
pattern), not count — confirmed by reading scripts/check-stamps.mjs; it
passes unchanged.
