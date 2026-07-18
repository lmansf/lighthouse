# Lighthouse — working agreements

## Versioning policy (owner directive, 2026-07-14)

Stay on the **0.11.x** line: every release is a PATCH bump — 0.11.1, 0.11.2,
0.11.3, … — regardless of whether it carries fixes or new features. Only a
**major overhaul** (a rewrite-scale change, explicitly approved by the owner)
moves the minor version (0.12.0). Do not bump minor for ordinary feature
releases.

## Release mechanics (post-0.11.0 — Electron retired)

- Version stamps live in FIVE files and must move together:
  `package.json`, `package-lock.json` (×2 stamps), `native/Cargo.toml`
  (workspace version), `native/crates/lighthouse-desktop/tauri.conf.json`,
  and `native/Cargo.lock` (every `lighthouse-*` crate — FIVE as of 0.12.6;
  the workspace grew past the original three, so bump by pattern, not count).
- Pipeline: bump → PR → squash-merge to main → `desktop-release.yml`
  (workflow_dispatch on main; empty `release_tag` derives v<version> from
  package.json; runs JS checks + the 3-OS `release-smoke.yml` gate, creates
  the draft release, builds native Tauri bundles, regenerates latest*.yml
  manifests) → `publish-release.yml` (`release_tag`, `body`; flips draft →
  public latest). The legacy Electron `release.yml` is deleted;
  `archive/electron-shell` preserves the last Electron-era tree.
- `release-smoke.yml` (also per-PR on native/shell paths): release build of
  the real binary + wire-protocol grounded-ask test + exhaustive settings
  round-trip (`settings_test.rs` — no-`..` destructuring makes a new
  settings field a compile error until covered) + LIGHTHOUSE_SMOKE=1 boot
  of the built app answering one zero-network ask (exit code = verdict).
- `CACHE_VERSION` moves in lockstep across `native/.../extract.rs`,
  `src/server/extract.ts`, and the assertion in
  `native/.../tests/extract_test.rs` — bump all three or native CI goes red.
- The desktop crate (`lighthouse-desktop`) does NOT compile in the dev
  container (no webkit/gtk); grep every call site when changing a shared
  engine signature — a missed one only surfaces in the desktop-release build.
- The two engines are twins: Rust (`native/crates/lighthouse-core`) ships;
  TS (`src/server/`) mirrors it byte-compatibly. Prompts/labels/trigger rules
  stay byte-identical; PARITY comments mark deliberate divergences.
