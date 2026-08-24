/**
 * The three export DOORS in src/lib/reportExport.ts.
 *
 * Why this file exists. reportExport.test.mjs beside it is named for this
 * module but exercises `composeReportHtml` — which lives in evidencePack.ts.
 * The door module itself had no test at all, and the PR-scoped mutation
 * harness said so bluntly: 4.5%, one mutant killed out of 22. Everything that
 * decides WHERE a report goes and what happens when the user says no was
 * unpinned.
 *
 * These paths matter beyond formatting. Since 0.15.0 an export is the ONLY
 * way a report leaves the app (the vault folders it used to write into are
 * gone), and a cancelled save must read as cancelled — not as a failure the
 * UI reports as an error, and not as a success that claims a file exists.
 *
 * `window`/`document` are stubbed per test: this module is DOM-facing, so the
 * browser fallback is exercised for real rather than asserted structurally.
 *
 * Run: `node --test test/reportExportActions.test.mjs`
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { exportReportHtml, exportReportMarkdown, printReport } = await import(
  "../src/lib/reportExport.ts"
);

/** Install a minimal window/document/URL/Blob so the browser arm can run. */
function stubDom({ bridge = null, withDocument = true } = {}) {
  const clicks = [];
  const revoked = [];
  globalThis.window = { lighthouseDesktop: bridge ?? undefined, setTimeout: (fn) => fn() };
  if (bridge) globalThis.window.lighthouseDesktop = bridge;
  if (withDocument) {
    globalThis.document = {
      createElement: () => {
        const a = {};
        a.click = () => clicks.push({ href: a.href, download: a.download });
        return a;
      },
    };
  } else {
    delete globalThis.document;
  }
  globalThis.Blob = class {
    constructor(parts, opts) {
      this.parts = parts;
      this.type = opts?.type;
    }
  };
  globalThis.URL = {
    createObjectURL: (b) => `blob:${b.type}:${String(b.parts[0]).length}`,
    revokeObjectURL: (u) => revoked.push(u),
  };
  return { clicks, revoked };
}

/** The module revokes its object URL on the next macrotask, deliberately, so
 *  the revoke cannot beat the download. Let that tick land inside the test —
 *  otherwise node:test flags the stub teardown as post-test activity. */
const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(async () => {
  await tick();
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.Blob;
  delete globalThis.URL;
});

const INPUT = { title: "Q3 revenue", markdown: "# Q3\n\nRevenue rose.\n", generatedAt: 0 };

// --- the desktop arm: the native save dialog --------------------------------

test("a saved file reports ok with the name the OS dialog returned", async () => {
  const seen = [];
  stubDom({
    bridge: {
      saveFile: async (hint, ext, content) => {
        seen.push({ hint, ext, content });
        return "Q3 revenue.html";
      },
    },
  });
  const res = await exportReportHtml(INPUT);
  assert.deepEqual(res, { ok: true, name: "Q3 revenue.html" });
  assert.equal(seen[0].ext, "html", "html export asks for the html extension");
  assert.equal(seen[0].hint, "Q3 revenue");
  assert.ok(seen[0].content.startsWith("<!doctype html>"), "the composed document is what is saved");
});

test("a DISMISSED dialog is cancelled, not an error — the UI must not cry failure", async () => {
  // The bridge resolves null when the user backs out. Reporting that as an
  // error would surface a red notice for a deliberate choice.
  stubDom({ bridge: { saveFile: async () => null } });
  const res = await exportReportHtml(INPUT);
  assert.deepEqual(res, { ok: false, cancelled: true });
  assert.equal(res.error, undefined, "cancelled carries no error text");
  assert.equal(res.name, undefined, "and claims no saved file");
});

test("an empty name from the dialog is also cancelled, never a zero-length success", async () => {
  stubDom({ bridge: { saveFile: async () => "" } });
  assert.deepEqual(await exportReportHtml(INPUT), { ok: false, cancelled: true });
});

test("a throwing bridge becomes an error carrying its message, not cancelled", async () => {
  stubDom({ bridge: { saveFile: async () => { throw new Error("disk full"); } } });
  const res = await exportReportHtml(INPUT);
  assert.equal(res.ok, false);
  assert.equal(res.error, "disk full");
  assert.equal(res.cancelled, undefined, "a real failure is not a cancellation");
});

test("a non-Error throw still yields an honest generic message", async () => {
  stubDom({ bridge: { saveFile: async () => { throw "nope"; } } });
  const res = await exportReportHtml(INPUT);
  assert.deepEqual(res, { ok: false, error: "save failed" });
});

test("markdown export sends the RAW markdown and the md extension", async () => {
  const seen = [];
  stubDom({
    bridge: {
      saveFile: async (hint, ext, content) => {
        seen.push({ hint, ext, content });
        return "notes.md";
      },
    },
  });
  const res = await exportReportMarkdown("My notes", "# Heading\n\nbody");
  assert.deepEqual(res, { ok: true, name: "notes.md" });
  assert.equal(seen[0].ext, "md");
  assert.equal(seen[0].content, "# Heading\n\nbody", "markdown is not composed to HTML");
});

// --- the filename hint ------------------------------------------------------

test("the hint trims, collapses runs of whitespace, and caps at 60 characters", async () => {
  const seen = [];
  const bridge = { saveFile: async (hint) => { seen.push(hint); return "x.md"; } };
  stubDom({ bridge });
  await exportReportMarkdown("   spaced    out\n\ttitle  ", "body");
  assert.equal(seen[0], "spaced out title");

  await exportReportMarkdown("z".repeat(80), "body");
  assert.equal(seen[1].length, 60, "capped at exactly 60");
  assert.equal(seen[1], "z".repeat(60));

  await exportReportMarkdown("y".repeat(60), "body");
  assert.equal(seen[2].length, 60, "exactly 60 passes through untouched");
});

test("a blank title falls back to `Report`, never to an empty filename", async () => {
  const seen = [];
  stubDom({ bridge: { saveFile: async (hint) => { seen.push(hint); return "Report.md"; } } });
  await exportReportMarkdown("   \n\t ", "body");
  assert.equal(seen[0], "Report");
});

// --- the browser arm: an anchor download ------------------------------------

test("with no desktop bridge the browser downloads, naming the file hint.ext", async () => {
  const { clicks } = stubDom({ bridge: null });
  const res = await exportReportMarkdown("My notes", "# body");
  await tick();
  assert.deepEqual(res, { ok: true, name: "My notes.md" });
  assert.equal(clicks.length, 1, "exactly one download was triggered");
  assert.equal(clicks[0].download, "My notes.md");
});

test("the blob carries the right MIME type per extension", async () => {
  const { clicks } = stubDom({ bridge: null });
  await exportReportMarkdown("m", "# body");
  await tick();
  assert.match(clicks[0].href, /^blob:text\/markdown:/, "markdown gets text/markdown");

  const second = stubDom({ bridge: null });
  await exportReportHtml(INPUT);
  await tick();
  assert.match(second.clicks[0].href, /^blob:text\/html:/, "html gets text/html");
});

test("the object URL is revoked after the click, not before it", async () => {
  const { clicks, revoked } = stubDom({ bridge: null });
  await exportReportMarkdown("m", "# body");
  assert.equal(clicks.length, 1, "the click happens first, synchronously");
  assert.equal(revoked.length, 0, "and the revoke has NOT happened yet");
  await tick();
  assert.equal(revoked.length, 1, "revoked exactly once, on the next tick");
  assert.equal(revoked[0], clicks[0].href, "and it revoked the URL it handed out");
});

test("with neither a bridge nor a document the export refuses honestly", async () => {
  stubDom({ bridge: null, withDocument: false });
  assert.deepEqual(await exportReportMarkdown("m", "# body"), {
    ok: false,
    error: "no save target",
  });
  await tick();
});

// --- the print door ---------------------------------------------------------

test("printReport returns false when there is no window at all", () => {
  delete globalThis.window;
  assert.equal(printReport(INPUT), false);
});

test("printReport returns false when the popup is blocked", () => {
  stubDom({ bridge: null });
  globalThis.window.open = () => null;
  assert.equal(printReport(INPUT), false, "a blocked popup is a caller-visible false");
});

test("printReport writes the self-contained document, closes it, and prints", () => {
  stubDom({ bridge: null });
  const written = [];
  let closed = false;
  let printed = false;
  let focused = false;
  globalThis.window.open = () => ({
    document: { write: (h) => written.push(h), close: () => { closed = true; } },
    focus: () => { focused = true; },
    print: () => { printed = true; },
  });
  assert.equal(printReport(INPUT), true);
  assert.equal(written.length, 1);
  assert.ok(written[0].startsWith("<!doctype html>"), "the composed report, not raw markdown");
  assert.ok(written[0].includes("Q3 revenue"));
  assert.ok(closed, "the document is closed so the browser finishes parsing");
  assert.ok(focused && printed, "the deferred callback focuses then prints");
});

test("printReport still returns true when the print call itself throws", () => {
  // The opened tab is a readable, printable copy even if print() is refused,
  // so swallowing there must not turn into a false (which would make the
  // caller fall back and export a second copy).
  stubDom({ bridge: null });
  globalThis.window.open = () => ({
    document: { write: () => {}, close: () => {} },
    focus: () => { throw new Error("focus refused"); },
    print: () => {},
  });
  assert.equal(printReport(INPUT), true);
});
