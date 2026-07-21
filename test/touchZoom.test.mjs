/**
 * Touch posture: the screen is zoom-LOCKED, and an answer landing never pops the
 * keyboard on iPhone/iPad (owner directive — iPad/iPhone are the design target).
 *
 * Two guarantees, both structural properties of source a node runner can't mount:
 *  1. The root viewport locks scale — `maximum-scale=1` + `user-scalable=no` — so
 *     iOS neither focus-zooms when the composer takes focus nor pinch-zooms. Kept
 *     with viewport-fit=cover for the notch/home-indicator safe areas.
 *  2. The chat composer's POST-STREAM focus hand-back is gated on a fine pointer
 *     (`!coarsePointer`), so a finished answer never programmatically focuses the
 *     composer on touch — that would pop the on-screen keyboard (and, historically,
 *     the iOS focus-zoom) uninvited. Desktop keeps the hand-back.
 *
 * Live behavior is the iOS/E2E pass; here we pin WHERE the guards live so a
 * refactor can't silently re-enable the zoom or the keyboard-pop.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");
const layout = read("app/layout.tsx");
const chat = read("src/features/chat/ChatPanel.tsx");

test("the root viewport locks scale (no focus-zoom, no pinch-zoom)", () => {
  // Next maps these to <meta name="viewport" … maximum-scale=1, user-scalable=no>.
  assert.match(layout, /maximumScale:\s*1\b/, "maximum-scale=1 blocks the iOS focus-zoom");
  assert.match(layout, /userScalable:\s*false\b/, "user-scalable=no blocks pinch-zoom");
  // The safe-area unlock stays — the frame must still clear the notch / home bar.
  assert.match(layout, /viewportFit:\s*"cover"/, "viewport-fit=cover is kept for safe areas");
});

test("a finished answer does not focus the composer on touch (no uninvited keyboard)", () => {
  // The post-stream hand-back must be gated on a fine pointer. Assert the guard
  // and the focus call co-occur in one window (the settled-turn branch).
  const guarded =
    /!coarsePointer\s*&&[\s\S]{0,240}?composerRef\.current\?\.focus\(\)/.test(chat);
  assert.ok(guarded, "the post-stream composerRef focus is gated behind !coarsePointer");
});

test("mount-autofocus is likewise suppressed on touch (belt-and-suspenders)", () => {
  // The other uninvited path — focusing on mount — is already coarse-gated; keep
  // it pinned so both entry points stay touch-safe together.
  assert.match(
    chat,
    /if\s*\(coarsePointer\)\s*return;[\s\S]{0,80}?composerRef\.current\?\.focus\(\)/,
    "mount autofocus early-returns on a coarse pointer",
  );
});
