/**
 * Per-answer provenance stamp (privacy-legibility, Section 1B) — TS twin of
 * native/crates/lighthouse-core/tests/provenance_test.rs. The engine stamps the
 * FINAL chunk with `meta { origin, excerptCount, sourceFileCount }`; this asserts
 * the stamp AGREES with what the transport choke point (app/api/chat) records in
 * the audit log for the SAME answer: `meta.origin` ⇔ the audit `provider`
 * (device⇔local/none), and `meta.sourceFileCount` ⇔ `fileIds.length`.
 *
 * A vault meta-answer ("What's new this week?") is model-free, so every provider
 * — including a cloud one — runs with zero network yet still stamps its origin.
 *
 * Run: `node --test test/provenance.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

register("./_ts-extensionless-hook.mjs", import.meta.url);

/** How app/api/chat/route.ts derives the audit record's `provider`. */
const auditProvider = (cfg) => cfg.providerId ?? "none";

/** Drive the async pipeline to completion and return its terminating chunk. */
async function finalChunkFor(answerPipeline, cfg) {
  let done = null;
  for await (const chunk of answerPipeline(
    "What's new this week?",
    ["sales.csv", "notes.md"],
    [],
    [],
    cfg,
  )) {
    if (chunk.done) done = chunk;
  }
  assert.ok(done, "pipeline emits a terminating chunk");
  return done;
}

test("stamp origin and source count agree with the audit record", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "lh-prov-"));
  const vault = path.join(home, "vault");
  mkdirSync(vault, { recursive: true });
  process.env.VAULT_DIR = vault;
  writeFileSync(
    path.join(vault, "sales.csv"),
    "date,region,amount\n2026-01-05,NE,100\n2026-01-06,NW,50\n",
  );
  writeFileSync(path.join(vault, "notes.md"), "# planning\nsome prose\n");

  const { listNodes, setIncluded } = await import("../src/server/vault.ts");
  const { answerPipeline } = await import("../src/server/synth.ts");

  // Walk once (populates the tree), then make both files visible to AI.
  listNodes();
  setIncluded("sales.csv", true);
  setIncluded("notes.md", true);

  // The three provider shapes the choke point distinguishes: the private local
  // model, the model-free fallback (no provider), and a cloud vendor.
  const cases = [
    { providerId: "local", modelId: null, apiKey: null },
    { providerId: null, modelId: null, apiKey: null },
    { providerId: "anthropic", modelId: "claude-opus-4-8", apiKey: null },
  ];

  for (const cfg of cases) {
    const provider = auditProvider(cfg); // what the audit would record
    const chunk = await finalChunkFor(answerPipeline, cfg);
    assert.ok(chunk.meta, "final chunk carries a provenance stamp");
    const fileIds = (chunk.references ?? []).map((r) => r.fileId);

    const expectedOrigin =
      provider === "local" || provider === "none" ? "device" : provider;
    assert.equal(
      chunk.meta.origin,
      expectedOrigin,
      `stamp origin must agree with the audit provider "${provider}"`,
    );
    assert.equal(
      chunk.meta.sourceFileCount,
      fileIds.length,
      "stamp sourceFileCount must equal the audit fileIds length",
    );
    assert.equal(chunk.meta.excerptCount, 0, "a model-free answer sent no excerpts");
    assert.equal(chunk.meta.sourceFileCount, 2, "both included files are cited");
  }

  rmSync(home, { recursive: true, force: true });
});
