/**
 * §57: the RAG transport must resolve `fetch` at CALL time, never capture it.
 *
 * Why this pin exists. `ragTransport.ts` is evaluated during import (it exports
 * a module-scope singleton), which is strictly BEFORE `Providers` installs the
 * Tauri IPC interceptor that patches `window.fetch`. From 0.14.18 the
 * constructor default was a bare `= fetch`, so the singleton captured the
 * unpatched native fetch forever: every `/api/rag` call left the IPC bridge,
 * hit the Tauri asset origin, 404'd, and the vault tree never loaded on desktop
 * or iOS. Uploads still committed, so the app looked like it "just reset".
 *
 * Why the existing suite missed it entirely:
 *   1. node never exercises the module-eval-before-interceptor ordering — there
 *      is no window.fetch patch here, so a captured reference looks identical
 *      to a resolved one.
 *   2. the same line also invoked native fetch with `this` bound to the
 *      transport instance, which a browser rejects with "Illegal invocation";
 *      Node's undici tolerates an unbound receiver, so nothing failed.
 * Both are pinned below, plus a directory-wide structural check so the CLASS of
 * bug cannot come back on a future transport.
 *
 * Run: node --test test/ragTransport.fetch.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const { RagTransport, ragTransport } = await import("../src/contracts/real/ragTransport.ts");

const okResponse = (body = {}) => ({ ok: true, status: 200, json: async () => body });

// --- the regression pin: call-time resolution -------------------------------

test("a transport built with the DEFAULT uses whatever globalThis.fetch is at CALL time", async () => {
  // Construct FIRST, patch AFTER — exactly the ordering the Tauri shell has.
  const transport = new RagTransport();

  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (input, init) => {
    seen.push({ input, init });
    return okResponse({ sources: [], nodes: [], desktop: true });
  };
  try {
    const tree = await transport.getTree();
    assert.equal(seen.length, 1, "the patched global was used, not a captured reference");
    assert.equal(seen[0].input, "/api/rag");
    assert.equal(tree.desktop, true, "the patched response is what got decoded");
  } finally {
    globalThis.fetch = original;
  }
});

test("the exported singleton — constructed at import — also honors a later patch", async () => {
  // This is the one that actually shipped broken: `export const ragTransport =
  // new RagTransport()` runs at module evaluation, long before any patch.
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return okResponse({ sources: [], nodes: [], desktop: false });
  };
  try {
    await ragTransport.getTree();
    assert.ok(called, "the module-scope singleton must not hold a stale fetch");
  } finally {
    globalThis.fetch = original;
  }
});

test("an explicitly injected transport still wins over the global (DI is intact)", async () => {
  const injected = async () => okResponse({ sources: [], nodes: [], desktop: false });
  const transport = new RagTransport(injected);

  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("the injected request must be used, not the global");
  };
  try {
    const tree = await transport.getTree();
    assert.deepEqual(tree.nodes, []);
  } finally {
    globalThis.fetch = original;
  }
});

// --- the receiver pin: no unbound native fetch ------------------------------

test("the default calls fetch with a global receiver (browsers throw otherwise)", async () => {
  const transport = new RagTransport();
  const original = globalThis.fetch;
  // Chromium/WebKit throw "Illegal invocation" when native fetch is called with
  // a foreign `this`. undici does not, so reproduce the browser's rule here.
  globalThis.fetch = function (input, init) {
    assert.ok(
      this === undefined || this === globalThis,
      "fetch must not be invoked with the transport instance as its receiver",
    );
    void input;
    void init;
    return Promise.resolve(okResponse({ sources: [], nodes: [], desktop: false }));
  };
  try {
    await transport.getTree();
  } finally {
    globalThis.fetch = original;
  }
});

// --- the structural pin: nothing under contracts/ may capture fetch ---------

const tsFilesUnder = (rel) => {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) out.push(path.relative(ROOT, full));
    }
  };
  walk(path.join(ROOT, rel));
  return out;
};

test("no module-scope value under src/contracts/ captures a bare `fetch`", () => {
  const offenders = [];
  for (const file of tsFilesUnder("src/contracts")) {
    const src = read(file);
    // A constructor/function default of a bare `fetch` identifier freezes the
    // reference at construction. `= (input, init) => fetch(...)` is fine — the
    // call happens later — so only flag `= fetch` as a whole identifier.
    if (/=\s*fetch\s*[),]/.test(src)) offenders.push(`${file} (default parameter '= fetch')`);
    // Same trap via a module-scope alias.
    if (/^(?:const|let|var)\s+\w+\s*=\s*(?:globalThis\.|window\.)?fetch\s*;/m.test(src)) {
      offenders.push(`${file} (module-scope alias of fetch)`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `capture freezes the pre-interceptor fetch (§57). Resolve it at call time instead:\n  ${offenders.join("\n  ")}`,
  );
});

test("the transport's own default is the call-time wrapper form", () => {
  const src = read("src/contracts/real/ragTransport.ts");
  assert.match(
    src,
    /constructor\(request: RagFetch = \(input, init\) => fetch\(input, init\)\)/,
    "the default must call fetch, not name it",
  );
});
