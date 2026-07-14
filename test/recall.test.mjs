// Cross-conversation recall ranker (src/lib/recall.ts) — the pure half of
// add-conversation-recall. Pins the fail-closed rules (thin draft → nothing),
// the current-conversation exclusion, one-hit-per-conversation, and the
// score/recency ordering.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { recallRelated, recallTokens, MIN_SCORE, MIN_QUERY_TOKENS } = await import(
  "../src/lib/recall.ts"
);

function convo(id, title, updatedAt, turns) {
  // turns: [ [userText, assistantText], ... ]
  const messages = [];
  for (const [u, a] of turns) {
    messages.push({ role: "user", content: u });
    messages.push({ role: "assistant", content: a });
  }
  return { id, title, updatedAt, messages };
}

test("recallTokens drops stopwords and short tokens", () => {
  const t = recallTokens("What is the regional churn by Q3?");
  assert.ok(t.has("regional"));
  assert.ok(t.has("churn"));
  assert.ok(!t.has("the"), "stopword dropped");
  assert.ok(!t.has("is"), "short token dropped");
  assert.ok(!t.has("by"), "short stopword dropped");
});

test("a thin draft recalls nothing", () => {
  const convos = [convo("c1", "old", 10, [["regional churn breakdown", "here it is"]])];
  // One meaningful token ("churn") < MIN_QUERY_TOKENS.
  assert.deepEqual(recallRelated("churn", convos), []);
  assert.equal(MIN_QUERY_TOKENS, 2);
});

test("surfaces a relevant prior exchange and excludes the current chat", () => {
  const convos = [
    convo("c1", "Churn digging", 100, [["regional churn breakdown for the quarter", "NE up 4%"]]),
    convo("cur", "current", 200, [["something unrelated entirely", "ok"]]),
  ];
  const hits = recallRelated("regional churn breakdown", convos, { currentId: "cur" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].conversationId, "c1");
  assert.ok(hits[0].score >= MIN_SCORE);
  assert.equal(hits[0].question, "regional churn breakdown for the quarter");

  // The current conversation is never recalled, even if it would match.
  const selfHits = recallRelated("something unrelated entirely", convos, { currentId: "cur" });
  assert.ok(!selfHits.some((h) => h.conversationId === "cur"));
});

test("one hit per conversation, ranked by score then recency", () => {
  const convos = [
    convo("c1", "older strong", 10, [
      ["revenue by region and product line", "…"],
      ["revenue by region again please", "…"], // two matching turns, same convo
    ]),
    convo("c2", "newer weaker", 999, [["revenue trends overview", "…"]]),
  ];
  const hits = recallRelated("revenue by region", convos, { limit: 5 });
  // c1 collapses to ONE hit despite two matching turns.
  assert.equal(hits.filter((h) => h.conversationId === "c1").length, 1);
  // c1 scores higher (region+revenue) than c2 (revenue only, below threshold or lower),
  // so it ranks first even though c2 is newer.
  assert.equal(hits[0].conversationId, "c1");
});

test("no match → empty", () => {
  const convos = [convo("c1", "x", 1, [["apples and oranges", "fruit"]])];
  assert.deepEqual(recallRelated("quarterly revenue forecast", convos), []);
});
