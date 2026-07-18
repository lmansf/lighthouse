// Ask type-ahead ranker (src/lib/askTypeahead.ts) — the pure half of the
// time-savers autocomplete. Pins the prefix-over-subsequence dominance, the
// recency/frequency ordering, dedupe (and pin/history merging), the
// empty-draft gate, the row cap, lastAsk recall, and determinism. Store
// gating (history-off = session asks only) is wiring — the module just ranks
// whatever it's given.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { askSuggestions, lastAsk, ghostCompletion, ASK_SUGGESTION_LIMIT } = await import(
  "../src/lib/askTypeahead.ts"
);

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;
/** history item shorthand: text, ts, optional count. */
const h = (text, ts, count) => (count === undefined ? { text, ts } : { text, ts, count });
const opts = (extra = {}) => ({ now: NOW, ...extra });

test("empty or blank draft suggests nothing (the popover only opens with input)", () => {
  const sources = { history: [h("regional churn breakdown", NOW)], pins: ["sales tax rules"] };
  assert.deepEqual(askSuggestions("", sources, opts()), []);
  assert.deepEqual(askSuggestions("   \n ", sources, opts()), []);
});

test("prefix beats subsequence regardless of recency and frequency", () => {
  const sources = {
    history: [
      // Stale one-off, but the draft is its PREFIX…
      h("revenue by region", NOW - 300 * DAY),
      // …vs fresh and much-asked, but only a scattered subsequence of "rev".
      h("regional revenue trends", NOW, 9),
    ],
  };
  const got = askSuggestions("rev", sources, opts());
  assert.equal(got.length, 2);
  assert.equal(got[0].text, "revenue by region");
  assert.ok(got[0].score > got[1].score, "prefix outscores subsequence");
});

test("matching is case-insensitive", () => {
  const got = askSuggestions("REV", { history: [h("Revenue by region", NOW)] }, opts());
  assert.equal(got.length, 1);
  assert.equal(got[0].text, "Revenue by region");
});

test("equal match quality: newer beats older (recency tiebreak)", () => {
  const sources = {
    history: [h("churn by quarter", NOW - 10 * DAY), h("churn by region", NOW - 1 * DAY)],
  };
  const got = askSuggestions("churn by", sources, opts());
  assert.deepEqual(
    got.map((s) => s.text),
    ["churn by region", "churn by quarter"],
  );
});

test("frequency boosts a repeat over a same-age one-off", () => {
  const sources = {
    history: [h("weekly revenue table", NOW - DAY), h("weekly report summary", NOW - DAY, 6)],
  };
  const got = askSuggestions("weekly", sources, opts());
  assert.deepEqual(
    got.map((s) => s.text),
    ["weekly report summary", "weekly revenue table"],
  );
});

test("identical asks dedupe into one row, merging recency and frequency", () => {
  const sources = {
    history: [
      h("Regional churn breakdown", NOW - 9 * DAY),
      h("regional churn breakdown", NOW - 1 * DAY), // same ask, newer + recased
      h("regional revenue", NOW - 1 * DAY),
    ],
  };
  const got = askSuggestions("regional", sources, opts());
  assert.equal(got.length, 2, "duplicates collapse");
  // Merged row: newest occurrence's casing, and its count-of-2 outranks the
  // equally-recent one-off.
  assert.equal(got[0].text, "regional churn breakdown");
  assert.equal(got[0].source, "history");
});

test("pins rank as suggestions; a pinned twin of a history ask keeps the pin label", () => {
  // Pin-only source.
  const pinOnly = askSuggestions(
    "quart",
    { history: [], pins: ["quarterly forecast vs actuals"] },
    opts(),
  );
  assert.equal(pinOnly.length, 1);
  assert.equal(pinOnly[0].source, "pin");
  assert.equal(pinOnly[0].text, "quarterly forecast vs actuals");

  // Same text in both sources → ONE row, labeled "pin".
  const merged = askSuggestions(
    "open invoices",
    { history: [h("open invoices by customer", NOW - DAY)], pins: ["Open invoices by customer"] },
    opts(),
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, "pin");
});

test("history-off shape: ranks whatever it's given (session asks + pins only)", () => {
  const got = askSuggestions(
    "sales",
    { history: [h("sales by store this month", NOW)], pins: ["sales tax rules"] },
    opts(),
  );
  assert.deepEqual(got.map((s) => s.source).sort(), ["history", "pin"]);
});

test("matches on collapsed whitespace but returns the ask verbatim", () => {
  const got = askSuggestions(
    "compare q1 and",
    { history: [h("compare Q1\nand Q2 revenue", NOW)] },
    opts(),
  );
  assert.equal(got.length, 1);
  assert.equal(got[0].text, "compare Q1\nand Q2 revenue");
});

test("caps at the limit (default 6)", () => {
  const history = Array.from({ length: 10 }, (_, i) => h(`report ${i} please`, NOW - i * DAY));
  assert.equal(ASK_SUGGESTION_LIMIT, 6);
  assert.equal(askSuggestions("report", { history }, opts()).length, 6);
  assert.equal(askSuggestions("report", { history }, opts({ limit: 3 })).length, 3);
});

test("lastAsk recalls the newest ask; ties go to the later entry; pins never recall", () => {
  assert.equal(lastAsk({ history: [] }), null);
  assert.equal(lastAsk({ history: [], pins: ["pinned question"] }), null);
  assert.equal(
    lastAsk({ history: [h("first", 100), h("second", 200), h("third", 150)] }),
    "second",
  );
  // Uniform timestamps (one conversation's transcript): the LAST ask wins.
  assert.equal(lastAsk({ history: [h("older ask", 100), h("newer ask", 100)] }), "newer ask");
  // Blank entries never recall.
  assert.equal(lastAsk({ history: [h("  ", 999), h("real ask", 1)] }), "real ask");
});

test("deterministic: identical inputs give identical output; score ties break by text", () => {
  const sources = {
    history: [h("beta question", NOW - DAY), h("alpha question", NOW - DAY)],
  };
  const a = askSuggestions("question", sources, opts());
  const b = askSuggestions("question", sources, opts());
  assert.deepEqual(a, b);
  assert.equal(a.length, 2);
  assert.equal(a[0].score, a[1].score, "equal signals score equally");
  assert.deepEqual(
    a.map((s) => s.text),
    ["alpha question", "beta question"],
  );
});

// --- §22.1 ghost autocomplete (ghostCompletion) ------------------------------

test("ghost completes a caseless literal prefix, preserving source casing", () => {
  const out = ghostCompletion(
    "total sales",
    { history: [{ text: "Total Sales by Region", ts: 1_000 }], pins: [] },
    { now: 2_000 },
  );
  assert.equal(out, " by Region");
});

test("ghost needs at least three typed characters", () => {
  const sources = { history: [{ text: "total sales by region", ts: 1_000 }] };
  assert.equal(ghostCompletion("to", sources, { now: 2_000 }), null);
  assert.equal(ghostCompletion("tot", sources, { now: 2_000 }), "al sales by region");
});

test("ghost prefers the fresher history hit; exact match ghosts nothing", () => {
  const now = 10_000_000_000;
  const sources = {
    history: [
      { text: "total sales by region", ts: now - 100 },
      { text: "total sales by store", ts: now - 90 * 24 * 3600 * 1000 },
    ],
  };
  assert.equal(ghostCompletion("total sales by ", sources, { now }), "region");
  assert.equal(ghostCompletion("total sales by region", sources, { now }), null);
});

test("ghost draws on pins and extras (curated, recency-neutral)", () => {
  const now = 10_000_000_000;
  assert.equal(
    ghostCompletion("open p1", { history: [], pins: ["open P1 tickets by priority"] }, { now }),
    " tickets by priority",
  );
  assert.equal(
    ghostCompletion(
      "monthly tr",
      { history: [], extras: ["Monthly trend of amount"] },
      { now },
    ),
    "end of amount",
  );
});

test("ghost is deterministic on ties (lexicographic text)", () => {
  const now = 5_000;
  const sources = {
    history: [],
    pins: ["show all pdfs", "show all parquet files"],
  };
  assert.equal(ghostCompletion("show all p", sources, { now }), "arquet files");
});
