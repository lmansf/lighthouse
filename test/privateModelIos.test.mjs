/**
 * iOS private model — field report "the local model didn't load on my iPhone"
 * (0.13.8). Three root-cause classes, each pinned here so it cannot regress:
 *
 *  1. SYMBOL SURVIVAL: Rust resolves the Swift shim (`lighthouse_fm_ensure`,
 *     PrivateModelServer.swift @_cdecl) at RUNTIME via dlsym — zero link-time
 *     references. A release archive's dead-strip + symbol strip can silently
 *     drop exactly such symbols, making dlsym return NULL and the probe report
 *     "requires iOS 26 or later" on a perfectly eligible device. The fix pins
 *     the symbol into the dyld export trie via `-Wl,-exported_symbol` — and it
 *     must live in the COMMITTED pbxproj (what `tauri ios build` actually
 *     drives; project.yml is inert at build time — the fp3 §1 lesson) in BOTH
 *     configurations, with project.yml kept in honest parity.
 *
 *  2. TRANSIENT UNAVAILABILITY LATCH: `useOnDeviceModel` used to probe once and
 *     latch even on failure — but "Apple Intelligence is not enabled" and
 *     "model still preparing" are user-fixable mid-session. Available latches;
 *     unavailable must re-probe (throttled) and on return to the foreground.
 *
 *  3. SILENT HIDING: the probe's honest `reason` was discarded, so an eligible
 *     user saw the private option simply not exist. The store must KEEP the
 *     reason and Settings must render it.
 *
 * Live behavior is the on-device/TestFlight pass; here we pin WHERE the guards
 * and flags live. Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const APPLE = "native/crates/lighthouse-desktop/gen/apple";
const pbxproj = read(`${APPLE}/lighthouse-desktop.xcodeproj/project.pbxproj`);
const projectYml = read(`${APPLE}/project.yml`);
const swift = read(`${APPLE}/Sources/lighthouse-desktop/PrivateModelServer.swift`);
// §40 crate split: the availability impl + FM-bridge glue live in the
// tauri-free lighthouse-shell crate (the wrapper keeps a thin delegation).
const commands = read("native/crates/lighthouse-shell/src/commands.rs");
const store = read("src/stores/useOnDeviceModel.ts");
const settings = read("src/features/settings/SettingsMenu.tsx");

// --- 1. The dlsym'd shim symbol survives release archives -------------------

test("the pbxproj exports _lighthouse_fm_ensure in BOTH configurations (the real build)", () => {
  const flags = pbxproj.match(/-Wl,-exported_symbol,_lighthouse_fm_ensure/g) ?? [];
  assert.equal(
    flags.length,
    2,
    "release AND debug OTHER_LDFLAGS pin the shim into the export trie (dlsym-only symbols are what strip removes)",
  );
  // The weak framework link stays — older-iOS launches must not hard-load it.
  assert.ok(
    (pbxproj.match(/-weak_framework/g) ?? []).length >= 2,
    "FoundationModels remains weak-linked alongside the export pin",
  );
});

test("project.yml carries the same export flag (honest parity with the inert spec)", () => {
  assert.match(projectYml, /-Wl,-exported_symbol,_lighthouse_fm_ensure/);
});

test("the contract endpoints stay consistent: Swift @_cdecl name = Rust dlsym name", () => {
  assert.match(swift, /@_cdecl\("lighthouse_fm_ensure"\)/, "the Swift shim exports the C symbol");
  assert.match(
    commands,
    /b"lighthouse_fm_ensure\\0"/,
    "Rust dlsym looks up the exact same symbol name",
  );
});

// --- 2. Unavailable does not latch; available does --------------------------

test("the store latches ONLY on available; unavailable re-probes (throttled + foreground)", () => {
  assert.match(store, /if \(available\) settled = true;/, "available latches for the session");
  assert.doesNotMatch(
    store,
    /settled = true;\s*\n\s*void probe\(\);/,
    "the mobile path no longer latches before the probe answers",
  );
  assert.match(store, /RETRY_MS/, "unavailable re-probes are throttled, not per-render");
  assert.match(
    store,
    /addEventListener\("visibilitychange"/,
    "returning to the foreground re-probes — the 'enabled Apple Intelligence in Settings, came back' flow",
  );
});

// --- 3. The honest reason is kept and rendered -------------------------------

test("the store keeps the shell's unavailability reason instead of discarding it", () => {
  assert.match(store, /reason: string \| null/, "the state carries reason");
  assert.match(store, /typeof reply\.reason === "string" \? reply\.reason : null/);
});

test("Settings renders the honest reason when the on-device backend is unavailable", () => {
  assert.match(settings, /reason: onDeviceReason/, "SettingsMenu reads the reason from the store");
  assert.match(
    settings,
    /Private model on this device: \{onDeviceReason\}\./,
    "the reason renders as an inert hint instead of the option silently not existing",
  );
});

test("the Rust probe returns per-code honest reasons for the roster to show", () => {
  assert.match(commands, /"Apple Intelligence is not enabled on this device"/);
  assert.match(commands, /"this device is not eligible for Apple Intelligence"/);
  assert.match(commands, /"the on-device model is still preparing — try again shortly"/);
  assert.match(commands, /"reason": reason/, "the unavailable reply carries the reason");
});

test("the boot probe's verdict lands in shell.log (field diagnosability)", () => {
  const lib = read("native/crates/lighthouse-desktop/src/lib.rs");
  assert.match(
    lib,
    /let verdict = commands::private_model_availability_impl\(\);\s*\n\s*shell_log\(app\.handle\(\), &format!\("private-model probe: \{verdict\}"\)\);/,
    "every mobile boot logs the FM verdict — the opt-in bug report attaches shell.log",
  );
});

// --- 4. The ObjC-runtime bridge (0.13.9 — the dlsym route failed ON DEVICE) --
// 0.13.8 shipped with the export-trie pin applied (verified in the build log)
// and STILL read the symbol-absent verdict on an iPhone 17 / iOS 26.5.2 / SDK
// 26.5 build — runtime symbol lookup into the main executable is unreliable in
// release archives. The ObjC runtime finds class metadata BY NAME
// (__objc_classlist), immune to symbol tables, export tries, and stripping.

test("the bridge is reachable through the ObjC runtime, not just dlsym", () => {
  assert.ok(swift.includes('@objc(LHFMBridge)'), "the Swift bridge class pins its ObjC name");
  assert.ok(swift.includes('@objc(ensure:)'), "the selector is pinned against Swift renames");
  assert.ok(
    commands.includes('objc_getClass(b"LHFMBridge\\0"'),
    "Rust resolves the bridge class by name FIRST",
  );
  assert.ok(
    commands.includes('sel_registerName(b"ensure:\\0"'),
    "Rust messages the pinned selector",
  );
  assert.match(
    commands,
    /class_getClassMethod\(cls, sel\)/,
    "the selector is verified before objc_msgSend — the probe can never raise",
  );
  assert.ok(
    commands.includes('libc::dlsym(libc::RTLD_DEFAULT, name)'),
    "the dlsym route stays as a fallback behind the ObjC lookup",
  );
});

test("a missing bridge reads as a BUILD defect (-6), never as the phone's OS", () => {
  assert.match(swift, /FM_BUILD_UNSUPPORTED: Int32 = -6/, "Swift names the build-defect code");
  assert.match(
    swift,
    /return FM_BUILD_UNSUPPORTED\s*\n\s*#endif/,
    "compiled-without-FM returns the build-defect code, not FM_OS_TOO_OLD",
  );
  assert.match(
    commands,
    /return -6; \/\/ shim absent from this binary/,
    "an unresolvable shim is -6 in Rust too",
  );
  assert.ok(
    commands.includes(
      `"this app build doesn't include on-device model support — update the app"`,
    ),
    "-6 maps to copy that names the build, not the phone",
  );
  assert.ok(
    commands.includes('"the on-device private model requires iOS 26 or later"'),
    "-3 keeps its meaning for the genuine old-OS case",
  );
});

test("CI asserts the bridge boarded the app binary before TestFlight upload", () => {
  const wf = read(".github/workflows/mobile-bootstrap.yml");
  const guard = wf.indexOf("Assert the private-model bridge boarded the app binary");
  const upload = wf.indexOf("name: Upload to TestFlight");
  assert.ok(guard !== -1, "the bridge tripwire step exists");
  assert.ok(upload !== -1 && guard < upload, "the tripwire gates the TestFlight upload");
  assert.ok(
    wf.includes("grep -c '^LHFMBridge$'"),
    "the guard checks the ObjC class name in the shipped binary (survives stripping)",
  );
  // grep -q exits at the first match; llvm-strings then errors on the closed
  // pipe and pipefail vetoes the hit (run 26 failed a healthy binary this
  // way). The guard must count to EOF instead — a -q anywhere in the step is
  // a regression to the SIGPIPE-vulnerable shape.
  const step = wf.slice(guard, upload);
  assert.ok(
    !step.includes("grep -q"),
    "the tripwire never uses grep -q (early exit breaks the strings pipe under pipefail)",
  );
  assert.ok(
    step.includes('FOUND=$(strings "$BIN" | grep -c \'^LHFMBridge$\' || true)'),
    "the verdict is a counted read-to-EOF, guarded against the zero-match exit",
  );
});
