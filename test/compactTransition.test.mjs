/**
 * §43 §3 pinned verdict: the compact page transition keeps the OUTGOING tab
 * mounted beneath the incoming during the slide, so the Chat base never flashes
 * between two pages, and a page yielding to Chat slides OUT (an exit) instead of
 * vanishing. compactPageLayers (src/shell/compactTransition) is the one pure
 * decision behind that — WHAT mounts, in WHICH slide phase, at WHAT z — and it
 * is exercised here for every tab→tab pair. The React frame-timing glue in
 * AppShell (park/release, transitionend/timeout) is on-device acceptance; this
 * is the house verdict-fn pin (CONVENTIONS "pure verdict-fn pattern").
 *
 * Run: `node --test test/compactTransition.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const {
  compactPageLayers,
  isCompactPageTab,
  PAGE_Z_REST,
  PAGE_Z_ENTER,
  PAGE_SLIDE_MS,
  PAGE_SLIDE_SLACK_MS,
} = await import("../src/shell/compactTransition.ts");

const TABS = ["chat", "files", "settings"];
const isPage = (t) => t === "files" || t === "settings";

test("the pinned constants: today's z-21 geometry, the incoming one above, a real fallback budget", () => {
  assert.equal(PAGE_Z_REST, 21, "a resting page keeps today's z-21 geometry (the constraint)");
  assert.equal(PAGE_Z_ENTER, 22, "the incoming page rides exactly one layer above");
  assert.ok(PAGE_Z_ENTER > PAGE_Z_REST, "incoming always stacks above a resting page");
  assert.equal(isCompactPageTab("files"), true);
  assert.equal(isCompactPageTab("settings"), true);
  assert.equal(isCompactPageTab("chat"), false, "Chat is the base, not a page layer");
  assert.ok(
    PAGE_SLIDE_MS > 0 && PAGE_SLIDE_SLACK_MS > 0,
    "the transitionend fallback timeout has a positive budget",
  );
});

test("settled (leaving === null): exactly the destination page, at rest, z-21 — the pre-§43 render", () => {
  assert.deepEqual(compactPageLayers("chat", null), [], "Chat is the base — it mounts no page layer");
  assert.deepEqual(compactPageLayers("files", null), [{ tab: "files", phase: "rest", z: 21 }]);
  assert.deepEqual(compactPageLayers("settings", null), [{ tab: "settings", phase: "rest", z: 21 }]);
  // leaving === active is a no-op transition — also settled.
  assert.deepEqual(compactPageLayers("files", "files"), [{ tab: "files", phase: "rest", z: 21 }]);
});

test("every tab→tab transition: the layer beneath the incoming is the OUTGOING tab, never Chat", () => {
  for (const from of TABS) {
    for (const to of TABS) {
      if (from === to) continue;
      const layers = compactPageLayers(to, from);
      const top = layers[layers.length - 1];
      if (isPage(to)) {
        // Into a page: the destination ENTERS on top at z-22.
        assert.deepEqual(top, { tab: to, phase: "enter", z: 22 }, `${from}→${to}: destination enters on top`);
        if (isPage(from)) {
          // Page→page: the tab you LEFT rests directly beneath — never Chat.
          assert.equal(layers.length, 2, `${from}→${to}: exactly two page layers`);
          assert.deepEqual(
            layers[0],
            { tab: from, phase: "rest", z: 21 },
            `${from}→${to}: the left page rests beneath the incoming`,
          );
          assert.ok(top.z > layers[0].z, `${from}→${to}: the incoming stacks above the outgoing`);
        } else {
          // Chat→page: Chat is the mounted base; the only layer is the entering page.
          assert.equal(layers.length, 1, `${from}→${to}: only the entering page (Chat is the base beneath)`);
        }
      } else {
        // Into Chat: the left page slides OUT (exit) over the revealed Chat base.
        assert.equal(layers.length, 1, `${from}→chat: only the exiting page`);
        assert.deepEqual(
          top,
          { tab: from, phase: "exit", z: 21 },
          `${from}→chat: the left page exits to reveal Chat`,
        );
      }
      // No layer is ever the Chat base — Chat is rendered unconditionally elsewhere.
      assert.ok(!layers.some((l) => l.tab === "chat"), `${from}→${to}: Chat is never a page layer`);
      // After the slide only the destination remains mounted.
      assert.deepEqual(
        compactPageLayers(to, null),
        isPage(to) ? [{ tab: to, phase: "rest", z: 21 }] : [],
        `${from}→${to}: settles to only the destination`,
      );
    }
  }
});

test("the three named acceptance cases render exactly as the spec calls for", () => {
  // Files→Settings shows Files underneath (never Chat): Settings enters ABOVE a
  // resting Files.
  assert.deepEqual(compactPageLayers("settings", "files"), [
    { tab: "files", phase: "rest", z: 21 },
    { tab: "settings", phase: "enter", z: 22 },
  ]);
  // Settings→Chat slides the Settings page OUT to reveal Chat (an exit, not an
  // instant vanish).
  assert.deepEqual(compactPageLayers("chat", "settings"), [{ tab: "settings", phase: "exit", z: 21 }]);
  // Chat→Files slides Files over Chat (unchanged): one entering layer, Chat base beneath.
  assert.deepEqual(compactPageLayers("files", "chat"), [{ tab: "files", phase: "enter", z: 22 }]);
});
