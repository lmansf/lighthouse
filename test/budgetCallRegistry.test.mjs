/**
 * §39 §3: the model-call budget registry floor. Every stream_answer /
 * streamAnswer call site is enumerated here (the §34 setCompactTab
 * grep-inventory idiom) and mapped to a CallType declared in the §32/§36
 * budget tables — so a NEW model call cannot ship without deciding its
 * output reserve and input budget in the one place that owns them. If this
 * test failed on your PR: you added (or moved) a model call; register its
 * call type in native/crates/lighthouse-core/src/budget.rs AND
 * src/server/budget.ts (or map it to an existing type), then update the
 * manifest below. See docs/CONVENTIONS.md ("The model-call budget rule").
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

/** The registered call types (mirrored enums in budget.rs / budget.ts). */
const CALL_TYPES = new Set(["Narration", "NlToSql", "ReportFraming"]);

/**
 * The manifest: every file that originates model calls, its call-site count,
 * and the budget call type those calls ride. Counts are exact on purpose —
 * a new site is a conscious registry decision, not a drive-by.
 */
const MANIFEST = [
  // The whole grounded-ask path (single-shot, map extracts, reduces, warm
  // call) rides the Narration reserves.
  { file: "native/crates/lighthouse-core/src/synth.rs", pattern: /llm::stream_answer\(/g, count: 14, callType: "Narration" },
  { file: "native/crates/lighthouse-core/src/views.rs", pattern: /llm::stream_answer\(/g, count: 1, callType: "Narration" },
  // The two report-framing calls (§38) ride the ReportFraming reserve.
  { file: "native/crates/lighthouse-core/src/reports.rs", pattern: /llm::stream_answer\(/g, count: 1, callType: "ReportFraming" },
  // The TS twin's ask path (reports are Rust-only; NL→SQL rides its own
  // non-streaming seam).
  { file: "src/server/synth.ts", pattern: /streamAnswer\(/g, count: 6, callType: "Narration" },
];

/** Strip //-comment lines so a doc reference to the idiom never counts. */
const stripComments = (text) =>
  text
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");

test("every model-call site maps to a registered budget call type (exact inventory)", () => {
  for (const m of MANIFEST) {
    assert.ok(
      CALL_TYPES.has(m.callType),
      `${m.file} maps to unregistered call type "${m.callType}" — declare it in ` +
        `budget.rs + budget.ts first (docs/CONVENTIONS.md, "The model-call budget rule")`,
    );
    const found = (stripComments(read(m.file)).match(m.pattern) ?? []).length;
    assert.equal(
      found,
      m.count,
      `${m.file}: expected ${m.count} model-call site(s), found ${found}.\n` +
        `A new stream_answer call site must declare its budget call type — register ` +
        `it in budget.rs/budget.ts (or map it to an existing CallType) and update ` +
        `this manifest. See docs/CONVENTIONS.md ("The model-call budget rule").`,
    );
  }
});

test("no model-call site exists OUTSIDE the manifest's files", () => {
  // Any engine file calling stream_answer/streamAnswer must be in the
  // manifest — a brand-new caller file is the loudest kind of new site.
  const rustCallers = ["synth.rs", "views.rs", "reports.rs"];
  const rustDir = "native/crates/lighthouse-core/src";
  for (const f of ["analytics.rs", "briefings.rs", "insights.rs", "recipes.rs", "llm.rs"]) {
    const text = stripComments(read(path.join(rustDir, f)));
    const calls = (text.match(/llm::stream_answer\(/g) ?? []).length;
    assert.equal(
      calls,
      0,
      `${f} now originates ${calls} model call(s) but is not in the registry manifest — ` +
        `add it WITH a declared call type (docs/CONVENTIONS.md)`,
    );
  }
  void rustCallers;
});

test("the registered call types exist in BOTH budget twins", () => {
  const rust = read("native/crates/lighthouse-core/src/budget.rs");
  const ts = read("src/server/budget.ts");
  for (const t of CALL_TYPES) {
    assert.ok(rust.includes(t), `budget.rs is missing CallType::${t}`);
  }
  for (const t of ["narration", "nl-to-sql", "report-framing"]) {
    assert.ok(ts.includes(`"${t}"`), `budget.ts is missing call type "${t}"`);
  }
});

test("stream_local is reached only through stream_answer (no direct outside callers)", () => {
  // The budget seam sits in stream_answer; a direct stream_local caller
  // would bypass it. llm.rs owns the only call.
  const rustDir = "native/crates/lighthouse-core/src";
  for (const f of ["synth.rs", "views.rs", "reports.rs", "analytics.rs", "briefings.rs"]) {
    const text = stripComments(read(path.join(rustDir, f)));
    assert.ok(
      !/stream_local\(/.test(text),
      `${f} calls stream_local directly — route through stream_answer so the ` +
        `budget seam applies (docs/CONVENTIONS.md)`,
    );
  }
});
