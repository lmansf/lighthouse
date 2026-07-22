/**
 * §33 §2: external links actually open — ONE seam, every call site. In the
 * Tauri shell the webview's window.open is not a reliable escape (on iOS it
 * silently does nothing), so src/lib/openExternal.ts routes through
 * tauri-plugin-opener's open_url command; plain web keeps window.open. These
 * pins hold the seam closed: no bare window.open outside the helper (and
 * reportExport's blank print shell — a document the app composes, not an
 * external URL), every migrated surface imports the helper, the capability
 * grants the command, and the always-works clipboard handoff exists.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

/** Every .ts/.tsx under src/, recursively. */
function sourceFiles(dir = path.join(ROOT, "src")) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

test("no bare window.open outside the seam (+ the documented print-shell exemption)", () => {
  const allowed = new Set([
    path.join(ROOT, "src/lib/openExternal.ts"), // the seam's own web fallback
    path.join(ROOT, "src/lib/reportExport.ts"), // blank print shell (not an external URL)
  ]);
  for (const file of sourceFiles()) {
    if (allowed.has(file)) continue;
    const src = readFileSync(file, "utf8");
    assert.ok(
      !src.includes("window.open("),
      `${path.relative(ROOT, file)} must route through src/lib/openExternal.ts`,
    );
  }
  // The exemption is exactly the blank shell, nothing sneakier.
  assert.match(read("src/lib/reportExport.ts"), /window\.open\("", "_blank"/);
});

test("the seam: plugin route in-shell, window.open on plain web", () => {
  const seam = read("src/lib/openExternal.ts");
  assert.match(seam, /if \(isDesktopShell\(\)\) \{/, "shell detection gates the route");
  assert.match(
    seam,
    /core\.invoke\("plugin:opener\|open_url", \{ url \}\)/,
    "the shell path is tauri-plugin-opener's open_url",
  );
  assert.match(
    seam,
    /import\("@tauri-apps\/api\/core"\)/,
    "lazy import — plain web never pulls the Tauri API through this seam",
  );
  assert.match(seam, /window\.open\(url, "_blank", "noopener,noreferrer"\)/);
});

test("the capability set grants the opener command (registered in lib.rs)", () => {
  const caps = read("native/crates/lighthouse-desktop/capabilities/default.json");
  assert.match(caps, /"opener:allow-open-url"/, "open_url explicitly granted");
  const shell = read("native/crates/lighthouse-desktop/src/lib.rs");
  assert.match(shell, /tauri_plugin_opener::init\(\)/, "plugin registered");
});

test("every external-open surface rides the seam", () => {
  for (const file of [
    "src/features/feedback/BugReport.tsx",
    "src/features/settings/SettingsMenu.tsx",
    "src/features/settings/SettingsPage.tsx",
    "src/features/chat/ChatPanel.tsx",
  ]) {
    assert.match(
      read(file),
      /import \{ openExternal \} from "@\/lib\/openExternal";/,
      `${file} imports the seam`,
    );
  }
  // Answer links: in-shell clicks preventDefault into the seam; plain web
  // keeps the ordinary target=_blank anchor.
  const chat = read("src/features/chat/ChatPanel.tsx");
  assert.match(chat, /if \(href && isDesktopShell\(\)\) \{\s*\n\s*e\.preventDefault\(\);\s*\n\s*openExternal\(href\);/);
});

test("the always-works clipboard handoff: full body + both destinations", async () => {
  const { buildFeedbackClipboard, FEEDBACK_EMAIL, FEEDBACK_ISSUES_URL } = await import(
    "../src/lib/feedbackLinks.ts"
  );
  const out = buildFeedbackClipboard({ kind: "idea", what: "More charts please", version: "0.14.3", os: "macOS" });
  assert.ok(out.includes("More charts please"), "the composed body rides along");
  assert.ok(out.includes(`Email this to: ${FEEDBACK_EMAIL}`), "mail destination named");
  assert.ok(out.includes(`or open an issue: ${FEEDBACK_ISSUES_URL}`), "issue destination named");
  // No URL caps on the clipboard: a long log is carried in full.
  const long = buildFeedbackClipboard({ what: "x", log: "L".repeat(5000) });
  assert.ok(long.includes("L".repeat(5000)), "clipboard body is uncapped");
  // The dialog wires it to the tertiary button.
  const bug = read("src/features/feedback/BugReport.tsx");
  assert.match(bug, /buildFeedbackClipboard\(report\)/);
  assert.match(bug, /\{copied \? "Copied" : "Copy feedback"\}/);
});
