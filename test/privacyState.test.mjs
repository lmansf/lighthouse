/**
 * Privacy legibility (0.12.1 §2) — the pure helpers behind the lock's two
 * states and the header's hidden-from-cloud count (src/lib/privacyState.ts).
 * `cloudProviderActive` is the UI mirror of the engine predicate that ARMS
 * local-only enforcement (synth.rs::is_cloud_provider ⇄
 * synth.ts::isCloudProvider), so its truth table is pinned case by case here;
 * the structural/cross-file guarantees live in privacyLegibility.test.mjs.
 *
 * Run: `node --test test/privacyState.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const {
  cloudProviderActive,
  hiddenFromCloudCount,
  hiddenFromCloudLabel,
  LOCAL_ONLY_SKIP_NOTE_RE,
} = await import("../src/lib/privacyState.ts");

// --- cloudProviderActive: the single rule, mirroring origin "device" ------------

test("cloudProviderActive: the device path (no provider / local) is NOT cloud", () => {
  // No provider chosen yet — the private local default (and the engine's
  // model-free extractive fallback) answer on this device.
  assert.equal(cloudProviderActive(null), false, "null provider = device");
  assert.equal(cloudProviderActive(undefined), false, "undefined provider = device");
  assert.equal(cloudProviderActive("local"), false, "the private model = device");
  // The engine's originOf treats a falsy provider id as device; the empty
  // string must not read as an armed cloud provider.
  assert.equal(cloudProviderActive(""), false, "empty id = device (engine: !providerId)");
});

test("cloudProviderActive: any named vendor is cloud — identity, not key presence", () => {
  assert.equal(cloudProviderActive("anthropic"), true);
  assert.equal(cloudProviderActive("openai"), true);
  // Even an id the catalog doesn't know is cloud: local-only fails CLOSED
  // toward privacy, exactly like the engine's is_cloud_provider.
  assert.equal(cloudProviderActive("some-future-vendor"), true);
});

// --- hiddenFromCloudCount: the set actually being withheld ----------------------

const file = (over = {}) => ({ kind: "file", ragIncluded: true, localOnly: true, ...over });

test("hiddenFromCloudCount counts marked files that are otherwise visible to AI", () => {
  assert.equal(hiddenFromCloudCount([]), 0, "empty vault");
  assert.equal(hiddenFromCloudCount([file(), file()]), 2, "marked + included files count");
  assert.equal(
    hiddenFromCloudCount([file({ ragIncluded: false })]),
    0,
    "a marked file already hidden from AI isn't withheld BY THE LOCK",
  );
  assert.equal(
    hiddenFromCloudCount([file({ localOnly: false }), file({ localOnly: undefined })]),
    0,
    "unmarked files (explicit false or absent flag) never count",
  );
  assert.equal(
    hiddenFromCloudCount([{ kind: "folder", ragIncluded: true, localOnly: true }]),
    0,
    "folders count only through their descendants' effective marks, not themselves",
  );
  assert.equal(
    hiddenFromCloudCount([
      file(),
      file({ ragIncluded: false }),
      { kind: "folder", ragIncluded: true, localOnly: true },
      file({ localOnly: false }),
    ]),
    1,
    "mixed tree: exactly the marked-and-included files",
  );
});

// --- hiddenFromCloudLabel: the header's exact copy, both plural forms ------------

test("hiddenFromCloudLabel: singular and plural forms are exact", () => {
  assert.equal(hiddenFromCloudLabel(1), "1 file hidden from cloud models");
  assert.equal(hiddenFromCloudLabel(2), "2 files hidden from cloud models");
  assert.equal(hiddenFromCloudLabel(41), "41 files hidden from cloud models");
});

// --- LOCAL_ONLY_SKIP_NOTE_RE: detects the engine note, nothing else --------------

test("skip-note regex matches the engine's emphasis TEXT for any count", () => {
  // What the em node's text looks like after markdown strips the _…_ syntax —
  // byte-shaped like synth.rs::local_only_skip_note ⇄ synth.ts::localOnlySkipNote.
  const one =
    "(1 file skipped — marked private (this device only), so the AI can't send it to a cloud model. Switch to the private model to include it.)";
  const many =
    "(12 files skipped — marked private (this device only), so the AI can't send them to a cloud model. Switch to the private model to include them.)";
  assert.match(one, LOCAL_ONLY_SKIP_NOTE_RE, "singular form");
  assert.match(many, LOCAL_ONLY_SKIP_NOTE_RE, "plural, multi-digit form");
});

test("skip-note regex rejects ordinary emphasis and lookalikes", () => {
  for (const text of [
    "really important", // ordinary italics in an answer
    "(3 files skipped — not found)", // a different skip shape
    "note: (1 file skipped — marked private …)", // must START at the paren
    "(one file skipped — marked private", // count must be numeric
    '(2 files skipped — the question named "a.md")', // the named-but-excluded note family
  ]) {
    assert.doesNotMatch(text, LOCAL_ONLY_SKIP_NOTE_RE, text);
  }
});
