# Lighthouse — working agreements

## Versioning policy (owner directive, 2026-07-14)

Stay on the **0.11.x** line: every release is a PATCH bump — 0.11.1, 0.11.2,
0.11.3, … — regardless of whether it carries fixes or new features. Only a
**major overhaul** (a rewrite-scale change, explicitly approved by the owner)
moves the minor version (0.12.0). Do not bump minor for ordinary feature
releases.

## Release mechanics (as of 0.11.0)

- Version stamps live in FIVE files and must move together:
  `package.json`, `package-lock.json` (×2 stamps), `native/Cargo.toml`
  (workspace version), `native/crates/lighthouse-desktop/tauri.conf.json`,
  and `native/Cargo.lock` (×3 lighthouse crates).
- Pipeline: bump → PR → squash-merge to main → `release.yml`
  (workflow_dispatch on main; derives v<version> from package.json; drafts
  the release + latest*.yml) → `desktop-release.yml`
  (`release_tag`, `replace_electron: true`; native Tauri bundles) →
  `publish-release.yml` (`release_tag`, `body`; flips draft → public latest).
- `CACHE_VERSION` moves in lockstep across `native/.../extract.rs`,
  `src/server/extract.ts`, and the assertion in
  `native/.../tests/extract_test.rs` — bump all three or native CI goes red.
- The desktop crate (`lighthouse-desktop`) does NOT compile in the dev
  container (no webkit/gtk); grep every call site when changing a shared
  engine signature — a missed one only surfaces in the desktop-release build.
- The two engines are twins: Rust (`native/crates/lighthouse-core`) ships;
  TS (`src/server/`) mirrors it byte-compatibly. Prompts/labels/trigger rules
  stay byte-identical; PARITY comments mark deliberate divergences.
