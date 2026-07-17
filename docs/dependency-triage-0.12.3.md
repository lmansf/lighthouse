# Dependency triage — 0.12.3 (openspec: add-usability-field-patch §5)

`cargo audit` over `native/Cargo.lock` (774 crates) at the 0.12.3 cut. `npm
audit` is clean (0). Triage below; the safe lockfile fix is applied in this
change, the breaking ones are flagged for a maintainer-reviewed dependency bump.

## Fixed here (safe, lockfile-only)

| Crate | Was | Now | Advisory | Why safe |
|---|---|---|---|---|
| `crossbeam-epoch` | 0.9.18 | 0.9.20 | RUSTSEC-2026-0204 (invalid pointer deref in `fmt::Pointer`) | Transitive; a patch bump within the existing requirement. `cargo update -p crossbeam-epoch --precise 0.9.20`. No source change; CI + release-smoke compile it. |

## Deferred — needs a maintainer-reviewed, tested dependency bump

| Crate | Was | Fix needs | Advisory | Why deferred |
|---|---|---|---|---|
| `lopdf` | 0.34.0 | ≥ 0.42.0 | RUSTSEC-2026-0187 (stack overflow via deeply nested PDF, 7.5) | A **direct** workspace dep (`lighthouse-core`). 0.34 → 0.42 is a pre-1.0 minor = BREAKING; the PDF extractor (`extract.rs`) likely needs API changes, and the fix must be validated against `extract_test.rs` + the desktop-release build. Not a safe lockfile-only bump. |
| `quick-xml` (transitive 0.31.0 / 0.36.2) | 0.31/0.36 | ≥ 0.41.0 | RUSTSEC-2026-0194 / 0195 (quadratic attr scan; unbounded namespace alloc, 7.5) | The DIRECT dep is already 0.41.0 (satisfies the advisory). The vulnerable copies are transitive (pulled by other crates at 0.31/0.36); they can't move to 0.41 without those parents updating — a `cargo update`/dep bump on the parents, maintainer-reviewed. |

## Not a vulnerability (informational)

- `atk` / `gdk` / `gtk` / `gdkwayland-sys` / … — "gtk-rs GTK3 bindings — no
  longer maintained." These are Tauri's Linux WebKitGTK stack (transitive via
  the desktop shell); an *unmaintained* warning, not a security advisory, and
  not independently fixable here — it resolves when Tauri moves off GTK3.

## Recommended follow-up

Open (or accept the Dependabot) PRs that bump `lopdf` to ≥ 0.42 and the parent
crates pinning old `quick-xml`, then run the native suite + the 3-OS
release-smoke to confirm the extractor path still passes before merge.
