/**
 * Quick provider switch (time-savers TS-8) — the engine-level proof that the
 * chat header's switch needs zero extra wiring, plus the pure arg-derivation
 * helpers behind the menu (src/lib/providerSwitch.ts).
 *
 * One session over a fixture vault holding a local-only-marked file, using the
 * localOnly.test.mjs mocked-endpoint pattern:
 *   1. select a keyed cloud provider (profile selectModel path) and ask —
 *      the marked file's content never reaches the outbound cloud prompt and
 *      the final chunk stamps `meta.origin` = that vendor id;
 *   2. switch to the private model exactly the way the header does (selectModel
 *      with NO key, then completeOnboarding) and ask again — `meta.origin` =
 *      "device" and the marked file NOW participates (its content rides in the
 *      prompt to the on-device endpoint; it is cited);
 *   3. the answer cache never cross-replays: the switched ask carries no
 *      `cachedAt` (provider+model are in the key), while switching BACK — again
 *      keylessly, proving the stored key survives — replays the first cloud
 *      answer verbatim with zero new egress.
 *
 * Run: `node --test test/providerSwitch.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

register("./_ts-extensionless-hook.mjs", import.meta.url);

// Pin key resolution to the STORED keys and the local endpoint to its default
// BEFORE the engine modules load (llm.ts snapshots LIGHTHOUSE_LOCAL_LLM_URL at
// import; profile.ts prefers env keys per call).
for (const v of [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "XAI_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "LIGHTHOUSE_LOCAL_LLM_URL",
  "LIGHTHOUSE_LOCAL_LLM_MODEL",
]) {
  delete process.env[v];
}

/** A throwaway vault, files start EXCLUDED (the conservative default). */
function freshVault() {
  const home = mkdtempSync(path.join(tmpdir(), "lh-provswitch-"));
  const vault = path.join(home, "vault");
  mkdirSync(path.join(vault, ".rag-vault"), { recursive: true });
  process.env.VAULT_DIR = vault;
  delete process.env.LIGHTHOUSE_APP_STATE_DIR;
  return vault;
}

const helpers = await import("../src/lib/providerSwitch.ts");
const vaultMod = await import("../src/server/vault.ts");
const profile = await import("../src/server/profile.ts");
const synthMod = await import("../src/server/synth.ts");
const cacheMod = await import("../src/server/answerCache.ts");

// --- Pure helpers: what the menu offers, and the args a switch sends ------------

test("switchChoices lists ONLY configured providers — keyed clouds in catalog order, local only when ready", () => {
  const { switchChoices, LOCAL_HINT } = helpers;

  // Keyed clouds only (local weights absent): catalog order, never the keys.
  assert.deepEqual(
    switchChoices(["openai", "anthropic"], false).map((c) => c.id),
    ["anthropic", "openai"],
  );
  // The private model leads once ready, carrying its on-device hint.
  const withLocal = switchChoices(["openai"], true);
  assert.deepEqual(
    withLocal.map((c) => c.id),
    ["local", "openai"],
  );
  assert.equal(withLocal[0].hint, LOCAL_HINT);
  assert.equal(withLocal[1].hint, undefined, "only the private model carries a hint");
  // Nothing configured (older engine: keyedProviders absent) ⇒ empty menu body.
  assert.deepEqual(switchChoices(undefined, false), []);
  // An unknown keyed id (removed vendor) never surfaces a dead row.
  assert.deepEqual(switchChoices(["cohere"], false), []);
});

test("switchArgs: first model on a provider hop, kept model on a re-pick, NEVER a key", () => {
  const { switchArgs } = helpers;

  // Hop to another provider ⇒ its first (curated-default) model, empty key.
  assert.deepEqual(switchArgs("openai", { providerId: "local", modelId: "lighthouse-local" }), {
    providerId: "openai",
    modelId: "gpt-5.1",
    apiKey: "",
  });
  // Re-pick the current provider ⇒ the current model survives.
  assert.deepEqual(switchArgs("openai", { providerId: "openai", modelId: "gpt-5-mini" }), {
    providerId: "openai",
    modelId: "gpt-5-mini",
    apiKey: "",
  });
  // A stale model id (catalog rotated) falls back to the first model.
  assert.equal(
    switchArgs("openai", { providerId: "openai", modelId: "gpt-4-turbo" }).modelId,
    "gpt-5.1",
  );
  // Switching to the private model targets its one model.
  assert.equal(
    switchArgs("local", { providerId: "openai", modelId: "gpt-5-mini" }).modelId,
    "lighthouse-local",
  );
});

test("shortProviderLabel: device path reads Private; vendors read their catalog label", () => {
  const { shortProviderLabel } = helpers;
  assert.equal(shortProviderLabel(null), "Private");
  assert.equal(shortProviderLabel("local"), "Private");
  assert.equal(shortProviderLabel("openai"), "OpenAI GPT");
  assert.equal(shortProviderLabel("mystery"), "mystery");
});

// --- End-to-end session over mocked endpoints ------------------------------------

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

const CLOUD_TEXT = "CLOUD_ANSWER_ea41 — grounded summary from the hosted model.";
const LOCAL_TEXT = "LOCAL_ANSWER_7c19 — grounded summary from the on-device model.";
const QUESTION = "summarize the quarterly revenue report";

test("a header switch re-points provenance, local-only enforcement, and the cache — with zero extra wiring", async () => {
  const vault = freshVault();
  cacheMod.resetStore(); // module-level LRU: isolate from any sibling test
  const { setIncluded, setLocalOnly } = vaultMod;
  const { answerPipeline } = synthMod;

  writeFileSync(
    path.join(vault, "public.md"),
    "The quarterly revenue report shows steady growth this period.",
  );
  // The marked file ALSO matches the query, so cloud exclusion is by the mark,
  // not by relevance; on the device path the SAME question must pull it in.
  writeFileSync(
    path.join(vault, "private.csv"),
    "region,revenue,secret_note\nquarterly,report,TOPSECRET_999999\n",
  );
  for (const id of ["public.md", "private.csv"]) setIncluded(id, true);
  setLocalOnly("private.csv", true);

  // Onboard onto a keyed cloud vendor (the one time a key is pasted), exactly
  // like the onboarding client: selectModel then completeOnboarding → "done".
  profile.selectModel("openai", "gpt-5-mini", "sk-test");
  profile.completeOnboarding();
  let state = profile.getState();
  assert.equal(state.step, "done");
  assert.ok(state.keyedProviders.includes("openai"), "the pasted key registered");

  // Route outbound traffic: the hosted vendor and the on-device server, each
  // answering with its own sentinel so a cross-replay would be unmistakable.
  const outbound = { cloud: [], local: [] };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const body = typeof opts?.body === "string" ? opts.body : "";
    if (u.includes("api.openai.com")) {
      outbound.cloud.push(body);
      return sseResponse(CLOUD_TEXT);
    }
    if (u.includes("127.0.0.1:8080")) {
      outbound.local.push(body);
      return sseResponse(LOCAL_TEXT);
    }
    throw new Error(`unexpected outbound request in test: ${u}`);
  };

  /** One ask, reading the model config fresh — exactly what the chat routes do
   *  per request (route.ts / routes.rs), so nothing can cache the provider
   *  mid-conversation. Settles text with the pipeline's own draft-replace rule. */
  async function ask(history = []) {
    const cfg = profile.modelConfig();
    let text = "";
    let draftActive = false;
    let final = null;
    for await (const chunk of answerPipeline(
      QUESTION,
      ["public.md", "private.csv"],
      [],
      history,
      cfg,
      {},
    )) {
      if (chunk.delta) {
        if (chunk.draft) {
          draftActive = true;
        } else if (draftActive) {
          draftActive = false;
          text = "";
        }
        text += chunk.delta;
      }
      if (chunk.done) final = chunk;
    }
    assert.ok(final, "pipeline emits a terminating chunk");
    return { text, final };
  }

  try {
    // --- Ask 1: the keyed cloud vendor. Enforcement ON, origin = vendor id. ---
    const a1 = await ask();
    assert.equal(outbound.cloud.length, 1, "the hosted vendor was actually called");
    const cloudPrompt = outbound.cloud[0];
    assert.ok(cloudPrompt.includes("steady growth"), "the shareable file reached the prompt");
    for (const needle of ["TOPSECRET_999999", "secret_note", "private.csv"]) {
      assert.ok(!cloudPrompt.includes(needle), `cloud prompt leaked local-only material: ${needle}`);
    }
    assert.equal(a1.final.meta.origin, "openai", "stamp names the vendor that answered");
    assert.equal(a1.final.meta.cachedAt, undefined, "first ask ran live");
    assert.ok(a1.text.includes(CLOUD_TEXT), "the cloud answer settled");
    assert.ok(
      a1.text.includes("1 file skipped — marked private"),
      "the honest skip note rode along",
    );
    assert.ok(
      !a1.final.references.some((r) => r.fileId === "private.csv"),
      "cloud citations exclude the marked file",
    );

    const history = [
      { role: "user", content: QUESTION },
      { role: "assistant", content: a1.text },
    ];

    // --- Switch to the private model EXACTLY like the header: the shared
    //     selectModel op with NO key, then completeOnboarding (selectModel
    //     parks the profile on the onboarding "inclusion" step — the switch
    //     must land back on "done", never re-entering onboarding). ---
    profile.selectModel("local", "lighthouse-local", "");
    profile.completeOnboarding();
    state = profile.getState();
    assert.equal(state.step, "done", "a header switch never re-enters onboarding");
    assert.equal(state.providerId, "local");
    assert.ok(
      state.keyedProviders.includes("openai"),
      "the keyless switch left the vendor's stored key alone",
    );

    // --- Ask 2 (same question, same session): device path. ---
    const a2 = await ask(history);
    assert.equal(outbound.local.length, 1, "the on-device server was actually called");
    assert.equal(outbound.cloud.length, 1, "nothing further left for the cloud vendor");
    const localPrompt = outbound.local[0];
    assert.ok(
      localPrompt.includes("TOPSECRET_999999"),
      "the marked file's content NOW participates (on-device only)",
    );
    assert.equal(a2.final.meta.origin, "device", "stamp follows the switch");
    assert.equal(
      a2.final.meta.cachedAt,
      undefined,
      "the switched ask must NOT replay the other provider's cached answer",
    );
    assert.ok(a2.text.includes(LOCAL_TEXT), "the on-device answer settled");
    assert.ok(!a2.text.includes(CLOUD_TEXT), "no cross-provider text bled through");
    assert.ok(
      a2.final.references.some((r) => r.fileId === "private.csv"),
      "the marked file is cited on the device path",
    );

    // --- Switch BACK keylessly; the stored key must still power the chat. ---
    profile.selectModel("openai", "gpt-5-mini", "");
    profile.completeOnboarding();
    const cfg = profile.modelConfig();
    assert.equal(cfg.providerId, "openai");
    assert.equal(cfg.apiKey, "sk-test", "the sealed key resolves after a keyless switch");

    // --- Ask 3: the cache replays ITS OWN provider's answer — verbatim, with
    //     the honesty stamp, and zero new egress. ---
    const a3 = await ask(history);
    assert.equal(typeof a3.final.meta.cachedAt, "number", "same provider + question ⇒ replay");
    assert.equal(a3.final.meta.origin, "openai", "the replayed stamp keeps its origin");
    assert.equal(a3.text, a1.text, "verbatim replay of the cloud answer");
    assert.equal(outbound.cloud.length, 1, "a replay dials nothing");
    assert.equal(outbound.local.length, 1, "a replay dials nothing (local either)");
  } finally {
    globalThis.fetch = realFetch;
  }
});
