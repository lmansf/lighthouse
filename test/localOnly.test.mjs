/**
 * Local-only marks ("Private — this device only", openspec: add-local-only-
 * marks) in the TS twin. Mirrors native/crates/lighthouse-core/tests/
 * local_only_test.rs: the ancestor-wins resolver via the public shareable gate,
 * migration tolerance for an old state.json, the byte-pinned cross-engine parity
 * fixture (identical retrieval candidate ids under a cloud provider), and an
 * end-to-end assertion — over a MOCKED cloud endpoint whose outbound request we
 * intercept — that a marked file's content/column-names never reach the prompt
 * body while the honest skip note renders.
 *
 * Run: `node --test test/localOnly.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

register("./_ts-extensionless-hook.mjs", import.meta.url);

/** A throwaway vault, files start EXCLUDED (the conservative default). */
function freshVault() {
  const home = mkdtempSync(path.join(tmpdir(), "lh-localonly-"));
  const vault = path.join(home, "vault");
  mkdirSync(path.join(vault, ".rag-vault"), { recursive: true });
  process.env.VAULT_DIR = vault;
  delete process.env.LIGHTHOUSE_APP_STATE_DIR;
  return vault;
}

const vaultMod = await import("../src/server/vault.ts");

// --- Resolver + gate (via the public shareable set) ------------------------------

test("a folder mark privatizes its subtree only on the cloud path (ancestor-wins)", async () => {
  const vault = freshVault();
  const { setIncluded, setLocalOnly, shareableFileIds, activeIncludedFileIds } =
    vaultMod;
  writeFileSync(path.join(vault, "public.md"), "public content");
  mkdirSync(path.join(vault, "docs"), { recursive: true });
  writeFileSync(path.join(vault, "docs", "a.md"), "alpha");
  writeFileSync(path.join(vault, "docs", "b.md"), "beta");
  for (const id of ["public.md", "docs/a.md", "docs/b.md"]) setIncluded(id, true);

  setLocalOnly("docs", true);

  // Device path: the mark is inert — the full included set is shareable.
  assert.deepEqual(shareableFileIds(false).sort(), ["docs/a.md", "docs/b.md", "public.md"]);
  assert.equal(activeIncludedFileIds().length, 3, "active set is never narrowed by a mark");
  // Cloud path: the whole marked subtree drops; the sibling stays.
  assert.deepEqual(shareableFileIds(true), ["public.md"]);
});

test("setLocalOnly writes only the target — no descendant cascade", async () => {
  const vault = freshVault();
  const { setIncluded, setLocalOnly, shareableFileIds } = vaultMod;
  mkdirSync(path.join(vault, "docs"), { recursive: true });
  writeFileSync(path.join(vault, "docs", "a.md"), "alpha");
  writeFileSync(path.join(vault, "docs", "b.md"), "beta");
  for (const id of ["docs/a.md", "docs/b.md"]) setIncluded(id, true);

  // Mark then UNMARK the folder: with a cascade the children would keep a
  // stamped `true`; with none, clearing the folder frees the whole subtree.
  setLocalOnly("docs", true);
  assert.deepEqual(shareableFileIds(true), [], "subtree withheld while folder marked");
  setLocalOnly("docs", false);
  assert.deepEqual(shareableFileIds(true).sort(), ["docs/a.md", "docs/b.md"], "no cascade");
});

test("a mark rides a move and a rename", async () => {
  const vault = freshVault();
  const { setIncluded, setLocalOnly, moveNode, renameNode, shareableFileIds } =
    vaultMod;
  mkdirSync(path.join(vault, "src"), { recursive: true });
  mkdirSync(path.join(vault, "dst"), { recursive: true });
  writeFileSync(path.join(vault, "src", "keep.md"), "x");
  setIncluded("src/keep.md", true);
  setLocalOnly("src/keep.md", true);

  assert.equal(moveNode("src/keep.md", "dst").newId, "dst/keep.md");
  assert.deepEqual(shareableFileIds(true), [], "mark rode the move");
  assert.deepEqual(shareableFileIds(false), ["dst/keep.md"]);

  assert.equal(renameNode("dst/keep.md", "kept.md").newId, "dst/kept.md");
  assert.deepEqual(shareableFileIds(true), [], "mark rode the rename");
});

test("an old state.json (no localOnly) loads as unmarked with inclusion preserved", async () => {
  const vault = freshVault();
  const { shareableFileIds, activeIncludedFileIds } = vaultMod;
  writeFileSync(path.join(vault, "a.md"), "alpha");
  // A pre-change state file: `included` present, NO `localOnly` key.
  writeFileSync(
    path.join(vault, ".rag-vault", "state.json"),
    JSON.stringify({ sourceAvailable: true, included: { "a.md": true }, references: {} }),
  );
  assert.deepEqual(activeIncludedFileIds(), ["a.md"], "inclusion preserved");
  assert.deepEqual(shareableFileIds(true), ["a.md"], "nothing local-only ⇒ cloud sees it");
});

// --- Cross-engine parity (same fixture as the Rust twin) -------------------------

test("parity: identical retrieval candidate ids under a cloud provider", async () => {
  const vault = freshVault();
  const { setIncluded, setLocalOnly, retrieve } = vaultMod;
  writeFileSync(path.join(vault, "quarterly report.md"), "quarterly revenue report growth summary");
  writeFileSync(
    path.join(vault, "salaries.md"),
    "quarterly revenue report confidential salary figures",
  );
  for (const id of ["quarterly report.md", "salaries.md"]) setIncluded(id, true);
  setLocalOnly("salaries.md", true);

  const ids = ["quarterly report.md", "salaries.md"];
  // Cloud: the marked file drops even though it matches the query best.
  const cloud = await retrieve("quarterly revenue report", ids, 5, [], [], true);
  assert.deepEqual(
    cloud.references.map((r) => r.fileId),
    ["quarterly report.md"],
    "cloud candidate ids match the Rust twin",
  );
  // Device: both files are candidates (mark inert).
  const device = await retrieve("quarterly revenue report", ids, 5, [], [], false);
  assert.deepEqual(device.references.map((r) => r.fileId).sort(), ["quarterly report.md", "salaries.md"]);
});

// --- End-to-end over a mocked cloud endpoint -------------------------------------

/** A minimal OpenAI-compatible streaming Response the twin's SSE reader accepts. */
function sseResponse(text) {
  const enc = new TextEncoder();
  const frames = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n`,
    "data: [DONE]\n",
  ];
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          read() {
            if (i < frames.length) return Promise.resolve({ done: false, value: enc.encode(frames[i++]) });
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    },
  };
}

test("a marked file's content never reaches the outbound cloud prompt; the skip note renders", async () => {
  const vault = freshVault();
  const { setIncluded, setLocalOnly } = vaultMod;
  const { answerPipeline } = await import("../src/server/synth.ts");

  writeFileSync(
    path.join(vault, "public.md"),
    "The quarterly revenue report shows steady growth this period.",
  );
  // The marked file ALSO matches the query, so its exclusion is by the mark, not
  // by relevance. Distinctive secret content + a column name that must not leak.
  writeFileSync(
    path.join(vault, "private.csv"),
    "region,revenue,secret_note\nquarterly,report,TOPSECRET_999999\n",
  );
  for (const id of ["public.md", "private.csv"]) setIncluded(id, true);
  setLocalOnly("private.csv", true);

  const cfg = { providerId: "openai", modelId: "gpt-5-mini", apiKey: "sk-test" };
  const outbound = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    if (typeof opts?.body === "string") outbound.push(opts.body);
    return sseResponse("Here is a grounded summary.");
  };
  let text = "";
  let finalFiles = [];
  try {
    for await (const chunk of answerPipeline(
      "summarize the quarterly revenue report",
      ["public.md", "private.csv"],
      [],
      [],
      cfg,
    )) {
      text += chunk.delta ?? "";
      if (chunk.done && chunk.references) finalFiles = chunk.references.map((r) => r.fileId);
    }
  } finally {
    globalThis.fetch = realFetch;
  }

  const allOutbound = outbound.join("\n");
  assert.ok(outbound.length > 0, "the cloud model was actually called (a real prompt went out)");
  // The exclusion is meaningful: the shareable file DID reach the prompt…
  assert.ok(allOutbound.includes("steady growth"), "the shareable file's content is in the prompt");
  // …but none of the marked file's content, column names, or name did.
  for (const needle of ["TOPSECRET_999999", "secret_note", "private.csv"]) {
    assert.ok(!allOutbound.includes(needle), `outbound prompt leaked local-only material: ${needle}`);
  }
  assert.ok(!finalFiles.includes("private.csv"), `citations must exclude the marked file: ${finalFiles}`);
  // The honest skip note renders (byte-shared template with the Rust twin).
  assert.ok(text.includes("1 file skipped — marked private"), `skip note must render: ${text}`);
});
