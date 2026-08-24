/**
 * Privacy legibility — the ONE provider rule, and the surface that states it.
 *
 * What this suite used to pin (0.12.1 §2) was "Private — this device only":
 * a per-file mark, its lock pill in the inspector and explorer, its rule
 * attribution, and the engine's "N files skipped — marked private" note. All
 * of that went with the vault in 0.15.0, and the release notes call the loss
 * out by name — you can no longer withhold ONE file from a cloud model while
 * it answers over the others.
 *
 * What survives is the part that was never per-file: whether a CLOUD provider
 * is answering THIS ask. That is one predicate, `cloudProviderActive`, and it
 * must keep mirroring the engine's `is_cloud_provider` rather than being
 * re-derived inline anywhere. ChatPanel is now its only consumer, because the
 * ask's provider choice is the whole privacy story.
 *
 * Run: `node --test test/privacyLegibility.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { cloudProviderActive } = await import("../src/lib/privacyState.ts");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const chat = read("src/features/chat/ChatPanel.tsx");
const helper = read("src/lib/privacyState.ts");

// --- One rule, one place -------------------------------------------------------

test("the provider rule lives in privacyState and names the engine it mirrors", () => {
  assert.match(
    helper,
    /KEEP IN SYNC with synth\.rs::is_cloud_provider/,
    "the helper names the engine predicate it mirrors",
  );
  assert.match(
    chat,
    /from "@\/lib\/privacyState"/,
    "ChatPanel derives cloud-vs-local from the shared helper, not an inline rule",
  );
  assert.match(chat, /cloudProviderActive\(/, "ChatPanel calls the single rule");
});

test("no surface re-derives the cloud rule inline", () => {
  // The failure this guards is a second copy drifting from the engine: some
  // component testing `providerId === "local"` (or a list of vendor ids) to
  // decide a PRIVACY statement, instead of calling the one helper.
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      const full = path.join(dir, e);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(e)) files.push(path.relative(ROOT, full));
    }
  };
  walk(path.join(ROOT, "src/features"));

  const offenders = [];
  for (const f of files) {
    const src = read(f);
    // A privacy claim is a line mentioning cloud/private/device NEAR a raw
    // provider comparison. `providerId === "local"` on its own is fine (the
    // provenance line legitimately distinguishes the on-device model).
    for (const line of src.split("\n")) {
      if (!/isCloudProvider|CLOUD_PROVIDERS/.test(line)) continue;
      if (f.endsWith("privacyState.ts")) continue;
      offenders.push(`${f}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], "cloud-vs-local must come from privacyState");
});

// --- The rule itself, exercised for real ---------------------------------------

test("cloudProviderActive: only a named cloud vendor counts as active", () => {
  assert.equal(cloudProviderActive("anthropic"), true, "a cloud vendor is active");
  assert.equal(cloudProviderActive("openai"), true, "so is another");
  assert.equal(cloudProviderActive("local"), false, "the on-device model is not cloud");
  assert.equal(cloudProviderActive(null), false, "no provider chosen is not cloud");
  assert.equal(cloudProviderActive(undefined), false, "neither is an absent one");
  assert.equal(cloudProviderActive(""), false, "nor an empty id");
});

test("the per-file local-only vocabulary is gone from the UI", () => {
  // The counterpart to the release note: if any of these come back without the
  // engine gate behind them, the UI would be promising enforcement that no
  // longer exists. That is worse than the honest loss.
  const files = ["src/features/chat/ChatPanel.tsx", "src/features/chat/FileInspector.tsx"];
  const offenders = [];
  for (const f of files) {
    for (const line of read(f).split("\n")) {
      if (/localOnly|localOnlyBy|"Private — this device only"/.test(line)) {
        offenders.push(`${f}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "per-file local-only marks were removed in 0.15.0; the ask's provider is the gate",
  );
});
