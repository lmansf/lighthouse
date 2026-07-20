/**
 * fp4 §1: the iOS add-files control must be a <label> with an OVERLAID file
 * input, so activating it is a DIRECT user gesture on the input — the only
 * thing an iOS WKWebView opens a document picker for. It must NEVER be a
 * programmatic `.click()` on a display:none / hidden input (iOS silently opens
 * nothing) nor a Fluent Menu item (the dismissal strips the gesture). This
 * source pin proves the mobile add path can't regress to the broken pattern.
 *
 * Run: `node --test test/mobileAddFiles.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(
  new URL("../src/features/explorer/FileExplorer.tsx", import.meta.url),
  "utf8",
);

test("the mobile add control is a <label> with an overlaid file input (WKWebView-safe)", () => {
  assert.match(src, /const mobileAddControl = \(/, "mobileAddControl render helper exists");
  assert.match(
    src,
    /<label className=\{styles\.mobileAddBtn\} data-mobile-add>/,
    "it renders a <label> tagged data-mobile-add",
  );
  assert.match(
    src,
    /<input\s+type="file"\s+multiple\s+className=\{styles\.mobileAddInput\}/s,
    "with an overlaid <input type=file multiple> (mobileAddInput)",
  );
  // The label's own input drives the real add path (sendFiles), never a .click().
  const helperStart = src.indexOf("const mobileAddControl");
  const helper = src.slice(helperStart, helperStart + 900);
  assert.match(helper, /onChange=\{\(e\) => \{\s*sendFiles\(e\.target\.files/, "onChange feeds sendFiles");
  assert.doesNotMatch(helper, /\.click\(\)/, "the mobile add control never calls .click()");
});

test("the overlay input is visually hidden but hit-testable — opacity:0, NOT display:none", () => {
  assert.match(
    src,
    /mobileAddInput:\s*\{[^}]*opacity:\s*0/s,
    "the overlay input is opacity:0 (stays hit-testable so WKWebView opens the picker)",
  );
  assert.doesNotMatch(
    src,
    /mobileAddInput:\s*\{[^}]*display:\s*["']none/s,
    "the overlay input is never display:none (WKWebView won't open a picker for one)",
  );
});

test("both add affordances use the label control on a mobile shell (isMobile-gated)", () => {
  // Toolbar add: direct label control on mobile, Browse menu on desktop/web.
  assert.match(
    src,
    /\{isMobile \? \(\s*mobileAddControl\("Add files"\)\s*\) : \(\s*<Menu>/s,
    "toolbar add is the label control on mobile, the Browse menu otherwise",
  );
  // Empty-state add: label control on mobile, Browse button on desktop.
  assert.match(
    src,
    /\{isMobile \? \(\s*mobileAddControl\("Add files…"\)/s,
    "empty-state add is the label control on mobile",
  );
});
