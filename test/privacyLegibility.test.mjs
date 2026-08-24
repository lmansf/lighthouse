/**
 * Privacy legibility (0.12.1 §2) — "Private — this device only" made VISIBLE.
 * The enforcement itself is engine-side and already proven end-to-end
 * (localOnly.test.mjs ⇄ local_only_test.rs); this suite pins the PRESENTATION
 * layer that makes it legible, in the boardsUi.test.mjs house style: the pure
 * helpers are exercised for real, and the JSX surfaces (FileExplorer,
 * FileInspector, ChatPanel, FirstRunTour) are asserted structurally against
 * the source since they can't load in node. The last tests prove the engine
 * emitters were NOT touched: the skip-note templates are byte-pinned in both
 * engines, and the UI's provider rule is checked against the TS twin's
 * isCloudProvider truth table for real.
 *
 * Run: `node --test test/privacyLegibility.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { cloudProviderActive, hiddenFromCloudLabel, LOCAL_ONLY_SKIP_NOTE_RE } = await import(
  "../src/lib/privacyState.ts"
);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const inspector = read("src/features/chat/FileInspector.tsx");
const chat = read("src/features/chat/ChatPanel.tsx");
const tour = read("src/features/help/FirstRunTour.tsx");
const helper = read("src/lib/privacyState.ts");

// --- One rule, one place -------------------------------------------------------

test("the provider rule lives in privacyState and every surface imports it", () => {
  assert.match(
    helper,
    /KEEP IN SYNC with synth\.rs::is_cloud_provider/,
    "the helper names the engine predicate it mirrors",
  );
  for (const [name, src] of [
    ["FileInspector", inspector],
    ["ChatPanel", chat],
  ]) {
    assert.match(
      src,
      /from "@\/lib\/privacyState"/,
      `${name} derives cloud-vs-local from the shared helper, not an inline rule`,
    );
    assert.match(src, /cloudProviderActive\(/, `${name} calls the single rule`);
  }
});
