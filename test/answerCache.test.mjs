/**
 * Answer cache (openspec: add-answer-cache) in the TS twin. Mirrors
 * native/crates/lighthouse-core/tests/answer_cache_test.rs over the SAME
 * fixture values: key composition (provider / model / attachments /
 * local-only marks / per-file freshness each re-key; normalization folds
 * case, whitespace, and trailing punctuation only), the history-gated store
 * (history-off writes nothing and deletes the disk mirror; history-on
 * round-trips a bounded LRU through disk), corrupt-store self-heal, and an
 * end-to-end replay over a MOCKED cloud provider whose calls we count:
 * ask (1 call) → re-ask (0 further calls, verbatim text/references, cachedAt
 * stamped) → touch the source file → re-ask runs live (2nd call).
 *
 * Run: `node --test test/answerCache.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

register("./_ts-extensionless-hook.mjs", import.meta.url);

/** A throwaway vault, files start EXCLUDED (the conservative default). */
function freshVault() {
  const home = mkdtempSync(path.join(tmpdir(), "lh-anscache-"));
  const vault = path.join(home, "vault");
  mkdirSync(path.join(vault, ".rag-vault"), { recursive: true });
  process.env.VAULT_DIR = vault;
  delete process.env.LIGHTHOUSE_APP_STATE_DIR;
  return vault;
}

const cache = await import("../src/server/answerCache.ts");
const vaultMod = await import("../src/server/vault.ts");

/** Where the persistence gate mirrors the store (no LIGHTHOUSE_APP_STATE_DIR
 *  in tests, so appStateDir falls back beside the vault state). */
const cacheFile = (vault) => path.join(vault, ".rag-vault", "answer-cache.json");

const entryOf = (text) => ({
  createdMs: 1000,
  text,
  references: [],
  meta: { origin: "device", excerptCount: 0, sourceFileCount: 0 },
});

const ALLOWED = { persistAllowed: true };
const DISALLOWED = {};

// --- Normalization (fixture shared with the Rust twin) ----------------------------

test("normalization folds case, whitespace, and trailing punctuation only", () => {
  const { normalizeQuestion } = cache;
  assert.equal(normalizeQuestion("What were Q3 sales?"), "what were q3 sales");
  assert.equal(normalizeQuestion("  what   WERE q3 sales?! "), "what were q3 sales");
  assert.equal(normalizeQuestion("what were q3 sales..."), "what were q3 sales");
  // Wording changes are DIFFERENT questions — no stemming, no synonyms.
  assert.notEqual(normalizeQuestion("what was q3 sales"), normalizeQuestion("what were q3 sales"));
  // Internal punctuation is meaning, not noise: only the TRAILING run folds.
  assert.equal(normalizeQuestion("what about v1.2?"), "what about v1.2");
  assert.notEqual(normalizeQuestion("50/50"), normalizeQuestion("50 50"));
  assert.equal(normalizeQuestion("???"), "");
});

test("keyFromParts: attachment order folds; every other component re-keys", () => {
  const { keyFromParts } = cache;
  const d = "digest";
  const base = keyFromParts("What were Q3 sales?", "openai", "gpt-5-mini", [], [], d);
  assert.equal(keyFromParts("  what   WERE q3 sales?! ", "openai", "gpt-5-mini", [], [], d), base);
  assert.notEqual(keyFromParts("What were Q4 sales?", "openai", "gpt-5-mini", [], [], d), base);
  assert.notEqual(keyFromParts("What were Q3 sales?", "anthropic", "gpt-5-mini", [], [], d), base);
  assert.notEqual(keyFromParts("What were Q3 sales?", "openai", "gpt-5", [], [], d), base);
  assert.notEqual(keyFromParts("What were Q3 sales?", "openai", "gpt-5-mini", [], [], "other"), base);
  assert.notEqual(keyFromParts("What were Q3 sales?", null, null, [], [], d), base);

  // The attachment SET is the component: order and duplicates fold.
  const withA = keyFromParts("q", "openai", null, ["a.md", "b.csv"], [], d);
  assert.equal(keyFromParts("q", "openai", null, ["b.csv", "a.md", "a.md"], [], d), withA);
  assert.notEqual(keyFromParts("q", "openai", null, [], [], d), withA);
  assert.notEqual(keyFromParts("q", "openai", null, ["a.md"], [], d), withA);
});

test("candidateDigest orders pairs and separates id from key", () => {
  const { candidateDigest } = cache;
  const ab = candidateDigest([
    ["a.md", "1:2"],
    ["b.md", "3:4"],
  ]);
  const ba = candidateDigest([
    ["b.md", "3:4"],
    ["a.md", "1:2"],
  ]);
  assert.equal(ab, ba, "pair order never changes the digest");
  assert.notEqual(
    candidateDigest([
      ["a.md", "1:9"],
      ["b.md", "3:4"],
    ]),
    ab,
    "a freshness change re-keys",
  );
  assert.notEqual(candidateDigest([["a.md", "1:2"]]), ab, "a membership change re-keys");
  assert.notEqual(
    candidateDigest([
      ["a.md1", ":2"],
      ["b.md", "3:4"],
    ]),
    ab,
    "the NUL boundary keeps id/key material apart",
  );
});

// --- Key composition over a real vault (fixture shared with the Rust twin) --------

test("provider, model, attachments, marks, and freshness each re-key", () => {
  const vault = freshVault();
  cache.resetStore();
  const { setIncluded, setLocalOnly } = vaultMod;
  writeFileSync(path.join(vault, "report.md"), "quarterly revenue summary");
  writeFileSync(path.join(vault, "private.csv"), "region,revenue\nNE,100\n");
  setIncluded("report.md", true);
  setIncluded("private.csv", true);

  const q = "What were Q3 sales?";
  const key = (question, provider, model, atts, cloud) =>
    cache.cacheKey(question, provider, model, atts, [], cloud);

  const base = key(q, "openai", "gpt-5-mini", [], true);
  assert.equal(key("  what   WERE q3 sales?! ", "openai", "gpt-5-mini", [], true), base);
  assert.notEqual(key("What were Q4 sales?", "openai", "gpt-5-mini", [], true), base);
  assert.notEqual(key(q, "anthropic", "gpt-5-mini", [], true), base);
  assert.notEqual(key(q, "openai", "gpt-5", [], true), base);

  const ab = key(q, "openai", "gpt-5-mini", ["report.md", "private.csv"], true);
  assert.equal(key(q, "openai", "gpt-5-mini", ["private.csv", "report.md"], true), ab);
  assert.notEqual(ab, base);
  assert.notEqual(key(q, "openai", "gpt-5-mini", ["report.md"], true), ab);

  // A local-only mark flip re-keys the CLOUD ask (the provider-effective set
  // shrank) and leaves the DEVICE ask alone (the mark is inert on-device).
  const deviceBase = key(q, "local", null, [], false);
  setLocalOnly("private.csv", true);
  assert.notEqual(key(q, "openai", "gpt-5-mini", [], true), base);
  assert.equal(key(q, "local", null, [], false), deviceBase);

  // Per-file freshness: touching a candidate (new mtime/size) re-keys.
  writeFileSync(path.join(vault, "report.md"), "quarterly revenue summary — updated");
  assert.notEqual(key(q, "local", null, [], false), deviceBase);
});

// --- The history gate --------------------------------------------------------------

test("history-off serves memory only and deletes the disk mirror", () => {
  const vault = freshVault();
  cache.resetStore();

  // An allowed insert writes through.
  cache.insert("k1", entryOf("one"), ALLOWED);
  assert.ok(existsSync(cacheFile(vault)), "history-on mirrors to disk");

  // A disallowed ask still hits IN MEMORY — and removes the disk file.
  assert.equal(cache.lookup("k1", DISALLOWED)?.text, "one");
  assert.ok(!existsSync(cacheFile(vault)), "history-off deletes the persisted cache");

  // Disallowed inserts never write anything.
  cache.insert("k2", entryOf("two"), DISALLOWED);
  assert.ok(!existsSync(cacheFile(vault)));
  assert.ok(cache.lookup("k2", DISALLOWED), "memory still serves");

  // Bypass skips the lookup itself, but the posture still applies.
  cache.insert("k3", entryOf("three"), ALLOWED);
  assert.ok(existsSync(cacheFile(vault)));
  assert.equal(cache.lookup("k3", { bypassCache: true }), null, "bypass always misses");
  assert.ok(!existsSync(cacheFile(vault)), "a bypassed disallowed ask still clears the mirror");
});

test("LRU is bounded at 64, a hit refreshes recency, and the store round-trips disk", () => {
  freshVault();
  cache.resetStore();

  for (let i = 0; i < 70; i += 1) cache.insert(`k${i}`, entryOf(`t${i}`), ALLOWED);
  assert.equal(cache.lookup("k0", ALLOWED), null);
  assert.equal(cache.lookup("k5", ALLOWED), null);
  assert.ok(cache.lookup("k6", ALLOWED));
  assert.ok(cache.lookup("k69", ALLOWED));

  // k6 was just read (most recent); the next eviction takes k7 instead.
  cache.insert("k70", entryOf("t70"), ALLOWED);
  assert.equal(cache.lookup("k7", ALLOWED), null, "least-recent evicts");
  assert.ok(cache.lookup("k6", ALLOWED), "a touched entry survives");

  // Round-trips disk: a fresh process (reset) reloads the same bounded set.
  cache.resetStore();
  assert.equal(cache.lookup("k69", ALLOWED)?.text, "t69");
  assert.equal(cache.lookup("k0", ALLOWED), null);
});

test("a corrupt or version-mismatched store is a miss and self-heals", () => {
  const vault = freshVault();
  cache.resetStore();

  // Corrupt file: reads as empty (miss ⇒ live), never an error.
  writeFileSync(cacheFile(vault), "{ not json");
  assert.equal(cache.lookup("k", ALLOWED), null);

  // The next allowed insert rewrites the store cleanly.
  cache.insert("k", entryOf("fresh"), ALLOWED);
  cache.resetStore();
  assert.equal(cache.lookup("k", ALLOWED)?.text, "fresh", "the rewritten store round-trips");

  // An envelope version bump reads as empty too (doubt means live).
  writeFileSync(
    cacheFile(vault),
    JSON.stringify({ v: 2, entries: [{ ...entryOf("x"), key: "k9" }] }),
  );
  cache.resetStore();
  assert.equal(cache.lookup("k9", ALLOWED), null, "version mismatch is a miss");

  // Malformed entries void the whole file (all-or-nothing, like the Rust twin).
  writeFileSync(
    cacheFile(vault),
    JSON.stringify({ v: 1, entries: [{ key: "k8", text: 42 }] }),
  );
  cache.resetStore();
  assert.equal(cache.lookup("k8", ALLOWED), null, "a malformed entry is a miss");
});

// --- End-to-end over a mocked cloud provider ---------------------------------------

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
            if (i < frames.length)
              return Promise.resolve({ done: false, value: enc.encode(frames[i++]) });
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    },
  };
}

/** Drive the pipeline like the UI does: settled text + all chunks. */
async function drive(gen) {
  let text = "";
  const chunks = [];
  for await (const chunk of gen) {
    if (chunk.delta) text += chunk.delta;
    chunks.push(chunk);
  }
  const done = chunks.find((c) => c.done);
  assert.ok(done, "pipeline emits a terminating chunk");
  return { text, chunks, done };
}

test("E2E: re-ask replays with ZERO provider calls; a touched file runs live", async () => {
  const vault = freshVault();
  cache.resetStore();
  const { setIncluded } = vaultMod;
  const { answerPipeline } = await import("../src/server/synth.ts");

  writeFileSync(
    path.join(vault, "report.md"),
    "The quarterly revenue report shows steady growth this period.",
  );
  setIncluded("report.md", true);

  const cfg = { providerId: "openai", modelId: "gpt-5-mini", apiKey: "sk-test" };
  const ask = () =>
    drive(answerPipeline("summarize the quarterly revenue report", ["report.md"], [], [], cfg, {}));

  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return sseResponse("Here is a grounded summary.");
  };
  try {
    // 1st ask: live — exactly one provider call, no replay stamp.
    const first = await ask();
    assert.equal(calls, 1, "the live ask called the provider once");
    assert.ok(first.done.meta, "final chunk carries the provenance stamp");
    assert.equal(first.done.meta.cachedAt, undefined, "a live answer carries no cachedAt");
    assert.ok(first.text.includes("grounded summary"));

    // 2nd ask, nothing changed: a verbatim replay with ZERO further provider
    // calls — byte-equal text and references, cachedAt stamped, and the whole
    // stream is exactly one text chunk + the final chunk.
    const second = await ask();
    assert.equal(calls, 1, "the replay made no model call");
    assert.equal(second.text, first.text, "replay is byte-verbatim");
    assert.deepEqual(second.done.references, first.done.references);
    assert.equal(typeof second.done.meta.cachedAt, "number", "replay stamps cachedAt");
    assert.equal(second.done.meta.origin, first.done.meta.origin, "origin stays the original's");
    assert.equal(second.chunks.length, 2, "one text chunk + one final chunk");
    // The verdict was absent (history off): nothing was ever written to disk.
    assert.ok(!existsSync(cacheFile(vault)), "memory-only by default — no disk mirror");

    // Touch the source file (content + size change) → the ask-time key
    // changes → the same question runs LIVE again.
    writeFileSync(
      path.join(vault, "report.md"),
      "The quarterly revenue report shows steady growth this period. Margins improved too.",
    );
    const third = await ask();
    assert.equal(calls, 2, "a touched candidate invalidates — the provider ran again");
    assert.equal(third.done.meta.cachedAt, undefined, "the fresh answer is live");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("recall preference joins the key only when non-empty (openspec: add-investigations)", () => {
  const { keyFromParts } = cache;
  const d = "digest";
  // Empty preference = the legacy key, byte-for-byte: pre-investigations
  // entries and asks outside any investigation keep hitting.
  const legacy = keyFromParts("q", "openai", null, ["a.md"], [], d);
  assert.equal(keyFromParts("q", "openai", null, ["a.md"], [], d), legacy);
  // A preference changes the key; the SET is the component (order/dupes fold).
  const withPref = keyFromParts("q", "openai", null, ["a.md"], ["c1", "c2"], d);
  assert.notEqual(withPref, legacy);
  assert.equal(keyFromParts("q", "openai", null, ["a.md"], ["c2", "c1", "c1"], d), withPref);
  assert.notEqual(keyFromParts("q", "openai", null, ["a.md"], ["c1"], d), withPref);
});
