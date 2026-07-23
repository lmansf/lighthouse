/**
 * §43 §6 pinned verdicts: the compact-dialog swipe-dismiss decisions, ported
 * from the §2 Sheet's proven handler (DISMISS_SLACK 80 / DISMISS_VELOCITY 0.5).
 * LhDialog wires the gesture; these two pure fns are the tested contract (the
 * runtime drag is on-device/visual acceptance).
 *
 *   - sheetDragArms: the discrimination that protects mid-content scrolling —
 *     a drag arms from the grabber/header always, from the body only at the top
 *     of its scroll.
 *   - sheetDragDismisses: flick OR past-slack → dismiss; else spring back; an
 *     upward offset never dismisses.
 *
 * Run: `node --test test/sheetDismiss.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { sheetDragArms, sheetDragDismisses, SHEET_DISMISS_SLACK, SHEET_DISMISS_VELOCITY } =
  await import("../src/shell/controls/sheetDismiss.ts");

test("the ported thresholds match the §2 Sheet's proven handler", () => {
  assert.equal(SHEET_DISMISS_SLACK, 80, "drag past 80px dismisses");
  assert.equal(SHEET_DISMISS_VELOCITY, 0.5, "a 0.5 px/ms downward flick dismisses");
});

test("sheetDragArms: the grabber/header always; the body only at scrollTop 0", () => {
  // From the grabber/header — arms regardless of where the content is scrolled.
  assert.equal(sheetDragArms({ fromHandle: true, atScrollTop: true }), true);
  assert.equal(sheetDragArms({ fromHandle: true, atScrollTop: false }), true, "the handle owns the drag");
  // From the body — arms only when the scroll is at the top.
  assert.equal(sheetDragArms({ fromHandle: false, atScrollTop: true }), true, "body at top can dismiss");
  assert.equal(
    sheetDragArms({ fromHandle: false, atScrollTop: false }),
    false,
    "a mid-content body drag scrolls, never dismisses",
  );
});

test("sheetDragDismisses: flick OR past-slack dismisses; small/upward drags spring back", () => {
  // A downward flick past the velocity threshold dismisses at any offset.
  assert.equal(sheetDragDismisses({ offset: 10, velocity: 0.6 }), true, "fast flick dismisses");
  assert.equal(sheetDragDismisses({ offset: 10, velocity: SHEET_DISMISS_VELOCITY }), false, "exactly at threshold holds");
  // A slow drag dragged past the slack dismisses.
  assert.equal(sheetDragDismisses({ offset: SHEET_DISMISS_SLACK + 1, velocity: 0 }), true, "past slack dismisses");
  assert.equal(sheetDragDismisses({ offset: SHEET_DISMISS_SLACK, velocity: 0 }), false, "exactly at slack holds");
  // A small, slow drag springs back.
  assert.equal(sheetDragDismisses({ offset: 30, velocity: 0.1 }), false, "a small drag springs back");
  // An upward (negative) offset with no downward velocity never dismisses.
  assert.equal(sheetDragDismisses({ offset: -200, velocity: -1 }), false, "an upward drag never dismisses");
});
