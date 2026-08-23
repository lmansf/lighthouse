/**
 * The 0.15.0 ask in the TS twin (openspec: refocus-chat-attachments §1.8): a
 * question answered from a conversation's ATTACHMENTS, with no vault anywhere
 * in the path.
 *
 * PARITY: the twin of native/crates/lighthouse-core/tests/workspace_ask_test.rs
 * — the same claims, over the same corpus swap. Model-free by construction (a
 * config with no provider answers extractively), so this runs zero-network.
 *
 * Run: `node --test test/workspaceAsk.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const ws = await import("../src/server/workspace.ts");
const synth = await import("../src/server/synth.ts");

/** Fresh app-state root per test — appStateDir() re-reads the env var. */
function freshState(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lh-ask-${tag}-`));
  process.env.LIGHTHOUSE_APP_STATE_DIR = dir;
  // A vault dir that exists but is EMPTY: if any leg of the pipeline reached
  // for the vault instead of the workspace, it would find nothing and the
  // citation assertions below would fail rather than silently pass.
  process.env.VAULT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `lh-ask-${tag}-vault-`));
  return dir;
}

/** Drain the pipeline over one conversation's corpus; return text + citations. */
async function ask(question, conversationId) {
  const chunks = [];
  let text = "";
  for await (const c of synth.answerPipeline(
    question,
    [],
    [],
    [],
    { providerId: undefined, modelId: undefined, apiKey: undefined },
    {},
    [],
    new synth.Corpus(conversationId),
  )) {
    text += c.delta ?? "";
    chunks.push(c);
  }
  const cited = [
    ...new Set(chunks.flatMap((c) => (c.references ?? []).map((r) => r.name))),
  ].sort();
  return { text, cited };
}

test("an ask answers from its conversation's attachments alone", async () => {
  freshState("scope");
  ws.attach(
    "conv-1",
    "quarterly.md",
    Buffer.from("# Q3 revenue\nNortheast revenue rose sharply this quarter, led by hardware.\n"),
  );
  // A file attached to a DIFFERENT conversation must stay invisible here.
  ws.attach("conv-other", "secret.md", Buffer.from("# Secret\nProject Kestrel ships in May.\n"));

  const { cited } = await ask("What happened to Northeast revenue?", "conv-1");
  assert.ok(cited.includes("quarterly.md"), `the attachment is cited: ${cited}`);
  assert.ok(
    !cited.includes("secret.md"),
    "another conversation's attachment never joins the corpus",
  );

  // A conversation with nothing attached has nothing to cite.
  const empty = await ask("What happened to Northeast revenue?", "conv-empty");
  assert.deepEqual(empty.cited, [], "no attachments ⇒ no sources");
});

test("the same question over the vault corpus does not see the attachments", async () => {
  freshState("vault");
  ws.attach("conv-1", "quarterly.md", Buffer.from("# Q3\nNortheast revenue rose sharply.\n"));
  // A null conversation id selects the LEGACY vault corpus, which is empty
  // here — proof the two arms are actually distinct and the workspace answer
  // above came from the workspace.
  const { cited } = await ask("What happened to Northeast revenue?", null);
  assert.deepEqual(cited, [], "the vault arm sees an empty vault, not the workspace");
});

test("retrieval ranks within the conversation: the relevant attachment wins", async () => {
  freshState("rank");
  ws.attach("conv-1", "revenue.md", Buffer.from("# Revenue\nNortheast revenue rose sharply.\n"));
  ws.attach("conv-1", "hiring.md", Buffer.from("# Hiring\nWe opened twelve roles in support.\n"));

  const { cited } = await ask("What happened to Northeast revenue?", "conv-1");
  assert.ok(cited.includes("revenue.md"), `the matching file is cited: ${cited}`);
});
