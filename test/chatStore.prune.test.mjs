/**
 * Unit test for chat-history auto-expiry (src/stores/useChatStore.ts → pruneByAge).
 *
 * Chat history is opt-in and, once saved, self-cleaning: conversations untouched
 * for over two weeks are dropped automatically (on load and on save) — EXCEPT the
 * active conversation, which is kept even when it's older, so a chat you're in the
 * middle of never disappears. `now` is injected so the fortnight boundary is
 * testable to the millisecond instead of waiting two real weeks.
 *
 * Run: `node --test test/chatStore.prune.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { pruneByAge } = await import("../src/stores/useChatStore.ts");

const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000; // a fixed "now" so the cutoff is deterministic

/** A conversation last touched `ageMs` before NOW. */
function conv(id, ageMs) {
  return { id, title: id, createdAt: NOW - ageMs, updatedAt: NOW - ageMs, messages: [] };
}

test("keeps conversations touched within the last two weeks", () => {
  const kept = pruneByAge(
    [conv("fresh", 1000), conv("oneWeek", 7 * 24 * 60 * 60 * 1000)],
    "none",
    NOW,
  );
  assert.deepEqual(kept.map((c) => c.id), ["fresh", "oneWeek"]);
});

test("drops conversations untouched for over two weeks", () => {
  const kept = pruneByAge([conv("old", TWO_WEEKS_MS + 1000)], "none", NOW);
  assert.deepEqual(kept, []);
});

test("keeps the active conversation even when it is older than two weeks", () => {
  const kept = pruneByAge(
    [conv("staleActive", TWO_WEEKS_MS + 5000), conv("staleOther", TWO_WEEKS_MS + 5000)],
    "staleActive",
    NOW,
  );
  assert.deepEqual(kept.map((c) => c.id), ["staleActive"]);
});

test("boundary: exactly two weeks old is kept (cutoff is inclusive)", () => {
  const kept = pruneByAge([conv("edge", TWO_WEEKS_MS)], "none", NOW);
  assert.deepEqual(kept.map((c) => c.id), ["edge"]);
});

test("boundary: one millisecond past two weeks is dropped", () => {
  const kept = pruneByAge([conv("justPast", TWO_WEEKS_MS + 1)], "none", NOW);
  assert.deepEqual(kept, []);
});
