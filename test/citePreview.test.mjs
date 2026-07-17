/**
 * Citation → in-app preview (time-savers, feature 4).
 *
 * References carry NO chunk id — the inspector's file-scoped test-search IS
 * the chunk locator: `inspect(fileId, citationQuery(snippet, question))`
 * re-runs the real per-file retrieval scorer, and the cited chunk comes back
 * as the top (containing) hit. This test drives the WHOLE round trip over a
 * fixture vault with multi-chunk files:
 *
 *   retrieve(question) → reference {fileId, snippet}   (the citation)
 *   citationQuery(snippet, question)                    (the derived locator)
 *   inspect(fileId, query).testSearch                   (the preview's hits)
 *   citedChunkIndex(hits, query)                        (the highlighted hit)
 *
 * and asserts the highlighted hit IS the cited chunk (its bounded text still
 * contains the snippet's core), plus the prev/next contract: hits arrive
 * sorted by score, deterministically. Accuracy across the cases is reported
 * as a diagnostic.
 *
 * Run: `node --test test/citePreview.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { citationQuery, citedChunkIndex } = await import("../src/lib/citePreview.ts");
const vaultMod = await import("../src/server/vault.ts");
const { inspect } = await import("../src/server/inspect.ts");

/** A throwaway vault; files start EXCLUDED (the conservative default). */
function freshVault() {
  const home = mkdtempSync(path.join(tmpdir(), "lh-cite-"));
  const vault = path.join(home, "vault");
  mkdirSync(path.join(vault, ".rag-vault"), { recursive: true });
  process.env.VAULT_DIR = vault;
  delete process.env.LIGHTHOUSE_APP_STATE_DIR;
  return vault;
}

const collapse = (s) => s.replace(/\s+/g, " ").trim();

// --- Fixture: a five-topic prose doc (~520 words ⇒ six overlapping 120-word
// chunks) and an 80-row ledger (⇒ three overlapping 30-row chunks). Distinct
// topics / one-off products let each question target a known region.

const FIELD_NOTES = [
  // Topic 1 — solar (chunk region: start of the document).
  `The solar panel installation on the northern roof finished ahead of schedule this spring.
The contractor mounted forty photovoltaic modules and rerouted the inverter cabling through
the east stairwell. Peak generation reached six kilowatts during the first sunny week, which
covers most of the daytime load for the workshop. Bird guards were fitted under every array
edge after the survey flagged nesting risk. The remaining work is a firmware update for the
export limiter and a final inspection by the utility before the feed-in agreement activates
at the end of the month.`,
  // Topic 2 — marketing budget.
  `Quarterly review of the marketing budget shows a nine percent overrun concentrated in paid
search campaigns. The overspend traces back to a bidding rule that never paused during the
product recall week, so impressions ran against a message the team had already withdrawn.
Print and events stayed under their allocations. Finance proposes clawing the difference back
from the fourth quarter contingency rather than cutting the newsletter sponsorships, and the
directors want a written guardrail: any automated campaign must carry a spend ceiling and an
owner who reviews it every Friday.`,
  // Topic 3 — warehouse holidays.
  `The annual holiday schedule for the warehouse team was agreed after two rounds of swaps.
Coverage over the December peak stays at eight pickers per shift, with overtime volunteers
taking the two public holidays at double rate. New starters keep their probation restriction
of one floating day per quarter. The rota tool now blocks any request that would drop forklift
certified staff below three on a shift, which was the failure that stalled loading bays last
year. Requests for next summer open in February and close at the end of March.`,
  // Topic 4 — penguin observations.
  `Penguin migration observations from the coastal research station recorded the earliest
arrival in eleven seasons. The first banded adelie appeared on the tide gauge camera nine days
before the historical median, and the colony count passed four hundred within a fortnight.
Krill sampling near the shelf edge suggests the early season tracks warmer surface water
rather than storm displacement. The station will keep the acoustic tags running through the
moult and share the clutch success numbers with the university group that maintains the
long-term dataset.`,
  // Topic 5 — database indexing.
  `Database indexing strategy for the customer table changed after the latency audit. The
composite index on region and signup date replaced two single-column indexes, cutting the
worst dashboard query from four seconds to under two hundred milliseconds. Nightly vacuum
now runs before the analytics export instead of after, so the planner statistics stay fresh
for the morning reports. The team also added a partial index for active subscriptions only,
which keeps the write amplification acceptable on the busiest shard. The next candidate is
the orders table join path.`,
].join("\n\n");

/** 80-row ledger; three one-off products pin questions to known row bands. */
function ledgerCsv() {
  const rows = ["date,region,product,amount,note"];
  for (let i = 1; i <= 80; i++) {
    let product = `standard-crate-${i}`;
    let note = `routine restock cycle ${i}`;
    if (i === 12) {
      product = "aurora-lamp";
      note = "showroom display replacement";
    }
    if (i === 52) {
      // Deliberately inside the 5-row overlap band of chunks 2 and 3
      // (rows 25–54 and 50–79) — the near-tie case for the locator.
      product = "zephyr-turbine";
      note = "expedited coastal order";
    }
    if (i === 71) {
      product = "quartz-gauge";
      note = "calibration lab purchase";
    }
    rows.push(`2025-03-${String((i % 28) + 1).padStart(2, "0")},R${(i % 4) + 1},${product},${i * 10},${note}`);
  }
  return rows.join("\n") + "\n";
}

function seed(vault) {
  writeFileSync(path.join(vault, "field-notes.md"), FIELD_NOTES);
  writeFileSync(path.join(vault, "ledger.csv"), ledgerCsv());
  vaultMod.setIncluded("field-notes.md", true);
  vaultMod.setIncluded("ledger.csv", true);
}

// --- citationQuery: snippet → clean locator query -------------------------

test("citationQuery uses a complete snippet verbatim (whitespace collapsed)", () => {
  assert.equal(citationQuery("short chunk text."), "short chunk text.");
  // Tabular snippets are multi-line; the query collapses to one line.
  assert.equal(
    citationQuery("date,region,amount\n2025-01-02,NE,10\n2025-01-03,NW,20"),
    "date,region,amount 2025-01-02,NE,10 2025-01-03,NW,20",
  );
  // All-single-char tokens are unscorable by the retrieval tokenizer
  // ([a-z0-9]{2,}) — that's a fallback case, not a verbatim one.
  assert.equal(citationQuery("a,b\n1,2\n3,4", "the question"), "the question");
});

test("citationQuery drops the clip mark AND the possibly mid-word final fragment", () => {
  assert.equal(citationQuery("alpha beta gamma delt…"), "alpha beta gamma");
  assert.equal(citationQuery("alpha beta gamma delt..."), "alpha beta gamma");
  // The 240-char cap can land exactly on a word boundary before the mark —
  // still drop the last word: one word of context is cheaper than a half-token.
  assert.equal(citationQuery("alpha beta gamma …"), "alpha beta");
});

test("citationQuery falls back to the question when the snippet has nothing scorable", () => {
  assert.equal(citationQuery("", "what changed last quarter"), "what changed last quarter");
  assert.equal(citationQuery("¡!¿? …", "what changed last quarter"), "what changed last quarter");
  assert.equal(citationQuery("", ""), "");
  assert.equal(citationQuery("…", "  "), "");
});

// --- citedChunkIndex: which hit gets highlighted ---------------------------

test("citedChunkIndex prefers the best-scored hit that still CONTAINS the query", () => {
  const hits = [
    { text: "an overlapping neighbor window without the full passage" },
    { text: "prefix words then the exact cited passage rides here" },
  ];
  assert.equal(citedChunkIndex(hits, "the exact cited passage"), 1);
  // Nothing contains it (e.g. the fallback-question query) → the top hit.
  assert.equal(citedChunkIndex(hits, "tokens from nowhere"), 0);
  // No usable query → the top hit; no hits at all → -1.
  assert.equal(citedChunkIndex(hits, "   "), 0);
  assert.equal(citedChunkIndex([], "anything"), -1);
});

// --- E2E round trip over the real retrieval scorer -------------------------

/** question → the file its citation should point at. */
const CASES = [
  { q: "when does the solar feed-in agreement activate", file: "field-notes.md" },
  { q: "why did the marketing budget overrun this quarter", file: "field-notes.md" },
  { q: "how many forklift certified staff must a warehouse shift keep", file: "field-notes.md" },
  { q: "how early did the penguins arrive this season", file: "field-notes.md" },
  { q: "what changed in the customer table indexing strategy", file: "field-notes.md" },
  { q: "what does the ledger say about the aurora lamp", file: "ledger.csv" },
  { q: "was the zephyr turbine order expedited", file: "ledger.csv" },
  { q: "who bought the quartz gauge", file: "ledger.csv" },
];

test("E2E: the citation's snippet relocates the cited chunk in the inspector", async (t) => {
  const vault = freshVault();
  seed(vault);

  let topHit = 0; // cited chunk came back as hits[0] (raw top-1)
  let located = 0; // the highlighted hit (citedChunkIndex) IS the cited chunk

  for (const { q, file } of CASES) {
    // 1. The citation, from the real cross-file retrieval.
    const { references } = await vaultMod.retrieve(q, ["field-notes.md", "ledger.csv"]);
    const ref = references.find((r) => r.fileId === file);
    assert.ok(ref, `"${q}" surfaces a ${file} reference`);
    assert.ok(ref.snippet.length > 0, "the reference carries a snippet");

    // 2. The derived locator query — the snippet's core, no clip fragment.
    const query = citationQuery(ref.snippet, q);
    assert.ok(query.length > 0, "a real snippet derives a non-empty query");
    assert.ok(!query.includes("…"), "the clip mark never reaches the query");

    // 3. The preview's hits: the SAME scorer, scoped to the one file.
    const insp = await inspect(ref.fileId, query);
    const hits = insp.testSearch ?? [];
    assert.ok(hits.length > 0, `inspect(${ref.fileId}) returns scored chunks`);

    // Prev/next contract: hits arrive sorted by score, non-increasing.
    for (let i = 1; i < hits.length; i++) {
      assert.ok(
        hits[i - 1].score >= hits[i].score,
        "testSearch hits are ordered by score (prev/next is deterministic)",
      );
    }

    // 4. The highlighted hit is the cited chunk: its bounded text still
    //    contains the snippet's core. (The snippet is the cited chunk's
    //    240-char prefix, and chunk overlap — 25 words / 5 rows — is shorter
    //    than the snippet, so only the true chunk can contain all of it.)
    const cited = citedChunkIndex(hits, query);
    assert.ok(cited >= 0, "a highlighted chunk exists");
    const containing = collapse(hits[cited].text).includes(query);
    assert.ok(
      containing,
      `"${q}": highlighted chunk must contain the snippet core\n  query: ${query}\n  hit: ${hits[cited].text}`,
    );
    located++;
    if (cited === 0) topHit++;
  }

  t.diagnostic(
    `snippet→query round-trip: highlighted-hit accuracy ${located}/${CASES.length}, ` +
      `raw top-1 ${topHit}/${CASES.length}`,
  );
  // The overlap-band case may legitimately near-tie a neighbor window at
  // hits[0]; the highlight logic must still land on the true cited chunk.
  assert.equal(located, CASES.length, "every citation relocates its cited chunk");
  assert.ok(topHit >= CASES.length - 1, "raw top-1 misses at most the overlap-band tie");
});

test("empty-snippet citation (listing answers) falls back to the question and still previews", async () => {
  const vault = freshVault();
  seed(vault);

  // Listing references carry snippet: "" — the preview opens on the question.
  const query = citationQuery("", "how early did the penguin colony arrive this season");
  assert.equal(query, "how early did the penguin colony arrive this season");
  const insp = await inspect("field-notes.md", query);
  const hits = insp.testSearch ?? [];
  assert.ok(hits.length > 0, "the fallback question still finds chunks");
  // On-topic, not positional: the question locates the penguin REGION of the
  // document (any of its overlapping windows), not one exact chunk — that
  // precision is what the snippet path above buys.
  assert.match(
    collapse(hits[citedChunkIndex(hits, query)].text),
    /penguin|adelie|colony/i,
    "the highlighted chunk is on-topic for the question",
  );
});
