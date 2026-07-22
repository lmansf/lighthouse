# Lighthouse — working agreements

Read docs/CONVENTIONS.md before changing shared systems — the house patterns,
each with its canonical example and the tripwire that enforces it.

## Versioning policy (owner directive, 2026-07-14)

Stay on the current line (**0.14.x** as of the Apple-feel release): every
release is a PATCH bump — 0.14.1, 0.14.2, … — regardless of whether it
carries fixes or new features. Only a **major overhaul** (a rewrite-scale
change, explicitly approved by the owner) moves the minor version.
Do not bump minor for ordinary feature releases.
(Owner designation, 2026-07-22: the §31 Apple-feel pass — token layer,
glass chrome, control swaps, icon registry — was designated the 0.14.0
overhaul.)

## Release mechanics (post-0.11.0 — Electron retired; iOS added in 0.13.x)

- Version stamps live in SEVEN files and must move together:
  `package.json`, `package-lock.json` (×2 stamps), `native/Cargo.toml`
  (workspace version), `native/crates/lighthouse-desktop/tauri.conf.json`,
  `native/Cargo.lock` (every `lighthouse-*` crate — SIX as of 0.14.6 with
  the §40 lighthouse-shell split; the workspace keeps growing past the
  original three, so bump by pattern, not count),
  and the two committed iOS project stamps:
  `native/crates/lighthouse-desktop/gen/apple/project.yml`
  (CFBundleShortVersionString + CFBundleVersion) and
  `native/crates/lighthouse-desktop/gen/apple/lighthouse-desktop_iOS/Info.plist`
  (CFBundleShortVersionString + CFBundleVersion). The committed
  CFBundleVersion is a baseline: the `ios-build` job re-syncs
  CFBundleShortVersionString from package.json and stamps CFBundleVersion
  with the CI run number at build time (TestFlight build uniqueness), so
  drift here breaks local builds' honesty, not CI.
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
  container (no webkit/gtk). Since the §40 crate split its tauri-free command
  bodies live in `lighthouse-shell`, which DOES check here — run
  `cargo check -p lighthouse-core -p lighthouse-shell -p lighthouse-cli
  -p lighthouse-server -p lighthouse-mcp` (CI runs the same as native.yml's
  container-check job). The grep-verify blind spot is only what remains in
  the wrapper: its delegation layer, the tauri-dependent stay-list bodies
  (chat_ask, upload_file, settings/model/widget/window commands), lib.rs,
  and src/desktop/* — grep those call sites when changing a shared engine
  signature; a missed one only surfaces in the desktop-release build.
- The two engines are twins: Rust (`native/crates/lighthouse-core`) ships;
  TS (`src/server/`) mirrors it byte-compatibly. Prompts/labels/trigger rules
  stay byte-identical; PARITY comments mark deliberate divergences.
