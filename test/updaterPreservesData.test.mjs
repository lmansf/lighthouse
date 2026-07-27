// §5 — Settings/files/model preservation across an in-place update.
//
// The updater PR promises the user that "Update & relaunch" keeps their
// settings, files, and local model (UpdateNotice's reassurance line). That
// promise is only true because of two structural invariants, and both are
// subtle enough that a well-meaning refactor could quietly break them without
// any test noticing — until a field report of "the update wiped my settings".
// So pin them as source facts here (container-testable: this reads the Rust as
// text, no webkit/gtk needed — unlike the desktop crate's own integration
// tests, which only compile in CI):
//
//   1. An update WRITES ONLY to the app bundle / installer target. The macOS
//      in-place swap locates the running `.app` via current_exe(), stages on
//      that bundle's own volume, and swaps it by rename — it never touches the
//      app-data base. The download itself stages under app_data_base/updates,
//      co-located with app-data (which an update never deletes), never inside
//      the bundle.
//   2. All USER DATA resolves through the install-independent app_data_base
//      (or the user's Documents for the vault) — never relative to the running
//      executable. So replacing the bundle cannot move settings, models,
//      connectors, or the vault out from under an install.
//
// The preserved set (asserted below, so this test doubles as its
// documentation): lighthouse-settings.json (which holds the vaultDir pointer),
// the models dir, the connectors dir, the LIGHTHOUSE_APP_STATE_DIR (secrets /
// sealed keys / signed-in profile), and the vault folder itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const SUPERVISE = "native/crates/lighthouse-desktop/src/desktop/supervise.rs";
const LIB = "native/crates/lighthouse-desktop/src/lib.rs";

test("the update download stages under app-data, never inside the bundle", () => {
  const s = read(SUPERVISE);
  // update_now: `let dir = crate::app_data_base(&app) … .join("updates");`
  assert.match(
    s,
    /app_data_base\(&app\)[\s\S]{0,120}\.join\("updates"\)/,
    "update_now must stage the download under app_data_base/updates (co-located with " +
      "app-data, which an update never removes) — not inside the app bundle",
  );
});

test("the macOS in-place swap touches ONLY the app bundle", () => {
  const s = read(SUPERVISE);
  const at = s.indexOf("fn install_macos_app_archive");
  assert.ok(at >= 0, "install_macos_app_archive (the in-place swap) must exist");
  // It is the last fn in the file; slice from its start to EOF is that function.
  const fn = s.slice(at);

  // Locate the running bundle from the executable, not from any data dir.
  assert.match(fn, /current_exe\(\)/, "the swap must locate the bundle via current_exe()");
  // Stage on the bundle's OWN volume so the swap is a cheap rename, then swap
  // the bundle by rename (never a copy over live app-data).
  assert.match(fn, /\.lighthouse-update-staged/, "the swap must stage on the bundle's volume");
  assert.match(fn, /fs::rename\(&app_dir/, "the swap must replace the bundle by rename");

  // The load-bearing invariant: the swap must NOT reach into the app-data base.
  // If a future edit made it resolve or write anything under app_data_base, an
  // update could clobber settings/keys/models — exactly what this pins against.
  assert.ok(
    !fn.includes("app_data_base"),
    "the in-place swap must never touch app_data_base — it replaces the bundle only",
  );
});

test("all user data resolves install-independently (app_data_base / Documents), never from the executable", () => {
  const lib = read(LIB);

  // The settings file (which carries the vaultDir pointer) is rooted at the
  // pinned, install-independent app_data_base.
  const settings = lib.slice(lib.indexOf("fn settings_file("), lib.indexOf("fn read_settings("));
  assert.ok(settings.length > 0, "settings_file must exist");
  assert.match(settings, /app_data_base\(app\)/, "settings_file must resolve through app_data_base");

  // Models + connectors (and the whole app-state dir) are set from app_data_base
  // in bootstrap_env, so a bundle swap leaves the downloaded model in place.
  const boot = lib.slice(lib.indexOf("fn bootstrap_env("));
  assert.match(boot, /app_data_base\(app\)/, "bootstrap_env must root app-data at app_data_base");
  assert.match(boot, /LIGHTHOUSE_MODELS_DIR/, "bootstrap_env must set the models dir under app-data");
  assert.match(boot, /LIGHTHOUSE_CONNECTORS_DIR/, "bootstrap_env must set the connectors dir under app-data");

  // The strongest pin: NO user-data path in lib.rs is derived from the running
  // executable's location. If someone rooted data at current_exe() (i.e. inside
  // the install dir), an in-place bundle swap would strand it — a red build here
  // is far cheaper than that field report.
  assert.ok(
    !lib.includes("current_exe"),
    "no user-data path in lib.rs may be derived from current_exe() — data must be " +
      "install-independent so an update that replaces the bundle preserves it",
  );
});

test("the vault default is the user's Documents (install-independent), not the app dir", () => {
  const lib = read(LIB);
  const vault = lib.slice(lib.indexOf("fn vault_dir_setting("), lib.indexOf("fn bootstrap_env("));
  assert.ok(vault.length > 0, "vault_dir_setting must exist");
  // The vault lives under the user's Documents (or a policy root / app_data_base
  // fallback) — a location no app update ever writes to.
  assert.match(vault, /document_dir\(\)/, "the vault default must be the user's Documents dir");
});
