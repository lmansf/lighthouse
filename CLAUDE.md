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
(Owner designation, 2026-08-23: the chat-attachments refocus — persistent
vault dropped for the session workspace, openspec
`refocus-chat-attachments`, sign-off recorded in its proposal — is the
0.15.0 overhaul. Shipped 2026-08-24: **0.15.0** is the current line, and
patch bumps resume from 0.15.1.)

## Release mechanics (post-0.11.0 — Electron retired; iOS added in 0.13.x)

- Version stamps live in SEVEN files and must move together:
  `package.json`, `package-lock.json` (×2 stamps), `native/Cargo.toml`
  (workspace version), `native/crates/lighthouse-desktop/tauri.conf.json`,
  `native/Cargo.lock` (every `lighthouse-*` crate — SIX as of 0.15.0; the
  workspace keeps growing past the original three, so bump by pattern, not
  count),
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
- The in-app updater ships **armed-but-inert** (as of the v0.14.19 Phase-B
  completion): the whole verified-in-place path — download + minisign-verify +
  install-on-consent, macOS `.app` swap, on-focus recheck, settings preserved —
  is gated behind `HAS_UPDATER_KEY` (CI) / the baked `LIGHTHOUSE_UPDATER_PUBKEY`
  (shell). Absent keys → releases stay **notify-only** ("Get it" opens the
  releases page; nothing is downloaded-and-run). Flipping it live is
  maintainer-gated (`docs/signing.md`), and the CI installer+`.sig` co-presence
  assertion only bites once the key is set — so releases keep shipping unsigned
  until then.
- **The desktop crate DOES compile in the dev container — install the headers.**
  This was long recorded as impossible, and 0.15.0 paid for the belief: three
  separate breaks in `lighthouse-desktop` (a syntax error, a call into a deleted
  fn, two arity mismatches) reached CI because nothing here ever compiled it.
  One apt install fixes that permanently:

      apt-get install -y --no-install-recommends libgtk-3-dev libwebkit2gtk-4.1-dev
      cargo check --workspace --all-targets          # desktop crate included

  (If apt errors with "dpkg was interrupted", run `dpkg --configure -a` first,
  then `apt-get update`.) Do this BEFORE changing any shared engine signature —
  the real compiler over the whole workspace beats every grep, and it is the
  only way to see the wrapper's delegation layer, the tauri-dependent stay-list
  bodies (chat_ask, upload_file, settings/model/widget/window commands), lib.rs,
  and src/desktop/*.
- **The JS side needs a REAL `node_modules` here too, for the same reason.**
  A partial install leaves `@fluentui/react-components` unresolved, which makes
  `useStyles()` type as `any` — so `styles.aKeyYouJustDeleted` type-checks
  vacuously in this container and is a TS2339 in CI. 0.15.0 shipped 23 such
  errors that way. Install with:

      npm install --no-save --no-audit --no-fund   # after dropping the `xlsx` dep

  `xlsx` is fetched from cdn.sheetjs.com, which the agent proxy denies (403);
  temporarily remove that ONE dependency from package.json, install, then
  restore package.json (it carries a version stamp — never commit it edited).
  With that in place `npx tsc --noEmit` and `npm run lint` both run for real.
  Only `src/server/extract.ts` keeps an xlsx-induced implicit-any that CI,
  which has the package, does not see.
- **Never trust a tsc "baseline diff" you captured mid-work.** It absorbs your
  own breakage and then reports no new errors. Run the full `tsc --noEmit` and
  read every line.
- Without the headers, `cargo check -p lighthouse-core -p lighthouse-shell
  -p lighthouse-cli -p lighthouse-server -p lighthouse-mcp` is the fallback
  (CI's native.yml container-check job runs exactly that), and
  `test/desktopCrateResolves.test.mjs` is the safety net: it resolves every
  engine MODULE and ITEM the desktop crate names and checks every one of its
  .rs files for balanced delimiters. It cannot catch an arity or type
  mismatch — only the compiler does that. CI's android-portability job
  (`cargo check --target aarch64-linux-android -p lighthouse-desktop --lib`)
  is the last line.
- The two engines are twins: Rust (`native/crates/lighthouse-core`) ships;
  TS (`src/server/`) mirrors it byte-compatibly. Prompts/labels/trigger rules
  stay byte-identical; PARITY comments mark deliberate divergences.
- `lighthouse-desktop` is the ONE crate `cargo check` never sees here, and
  0.15.0 broke it once (a `use lighthouse_core::{…, vault}` outlived the
  module). `test/desktopCrateResolves.test.mjs` now resolves every engine
  module that crate names — qualified paths AND braced import lists — so the
  grep-verify blind spot is mechanical. It runs in `npm test`; keep it green.
