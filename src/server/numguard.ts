/**
 * §44 §2: the numeric TRUST GUARD twin — the byte-identical mirror of
 * native/crates/lighthouse-core/src/numguard.rs. Keeps the constitution's
 * promise ("every number about data is engine-verified or it is not shown") on
 * the RAG paths: when a numeric ask over tabular data is not backed by an
 * engine figure, the model's prose must degrade to an honest number-free reply
 * rather than narrate a number from raw chunks.
 *
 * The analytics branch is Rust-only, so on the twin this guard protects the
 * single-shot RAG path (profileable CSV hits ride their profile as context);
 * the tokenizer, verified-set membership, and the byte-pinned degradation copy
 * match the Rust twin exactly (test/numguard.test.mjs pins the parity).
 */

/**
 * Every numeric token in `text`, normalized: commas stripped, surrounding dots
 * trimmed, kept only when it carries a digit. "$4,200.50" → "4200.50",
 * "2024-10" → {"2024","10"}, "row 7." → "7". Ported verbatim from
 * reports.rs/numguard.rs so the tokenization never drifts.
 */
export function numberTokens(text: string): Set<string> {
  const out = new Set<string>();
  let cur = "";
  const flush = () => {
    if (cur === "") return;
    const cleaned = cur.replace(/,/g, "");
    const trimmed = cleaned.replace(/^\.+/, "").replace(/\.+$/, "");
    if (/[0-9]/.test(trimmed)) out.add(trimmed);
    cur = "";
  };
  for (const c of text) {
    if ((c >= "0" && c <= "9") || ((c === "." || c === ",") && cur !== "")) {
      cur += c;
    } else {
      flush();
    }
  }
  flush();
  return out;
}

/**
 * A token set plus each token's integer part, so "400" faithfully cites
 * "400.25" without loosening the gate to arbitrary rounding.
 */
export function withIntegerParts(tokens: Set<string>): Set<string> {
  const out = new Set(tokens);
  for (const t of tokens) {
    const dot = t.indexOf(".");
    if (dot > 0) out.add(t.slice(0, dot));
  }
  return out;
}

/**
 * The engine-verified number set from one or more AUTHORITATIVE sources (a SQL
 * result table's markdown, a table profile) — the only digits an answer about
 * tabular data may state.
 */
export function verifiedSet(sources: string[]): Set<string> {
  const all = new Set<string>();
  for (const s of sources) for (const t of numberTokens(s)) all.add(t);
  return withIntegerParts(all);
}

/**
 * Remove `[n]` / `[1, 2]` citation markers so a reference index never reads as
 * a data figure. Only bracketed spans that are entirely digits/commas/spaces
 * (and carry at least one digit) are stripped; prose brackets are untouched.
 */
export function stripCitationMarkers(s: string): string {
  const chars = [...s];
  let out = "";
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === "[") {
      let j = -1;
      for (let k = i + 1; k < chars.length && k <= i + 24; k++) {
        if (chars[k] === "]") {
          j = k;
          break;
        }
      }
      if (j >= 0) {
        const inner = chars.slice(i + 1, j).join("");
        const citation =
          inner.length > 0 &&
          [...inner].every((c) => (c >= "0" && c <= "9") || c === "," || c === " ") &&
          /[0-9]/.test(inner);
        if (citation) {
          i = j + 1;
          continue;
        }
      }
    }
    out += chars[i];
    i += 1;
  }
  return out;
}

/**
 * True when `answer` states a numeric token the engine did not produce — a
 * number absent from the verified set (after citation markers are stripped).
 */
export function answerHasUnverifiedNumber(answer: string, verified: Set<string>): boolean {
  const cited = numberTokens(stripCitationMarkers(answer));
  for (const t of cited) if (!verified.has(t)) return true;
  return false;
}

/**
 * The byte-pinned honest degradation. KEEP IN SYNC with
 * numguard.rs::number_free_degradation.
 */
export function numberFreeDegradation(file: string, columns: string[]): string {
  const f = file === "" ? "this file" : file;
  let examples: string;
  if (columns.length >= 3) {
    examples = `"average ${columns[0]}" or "total ${columns[1]} by ${columns[2]}"`;
  } else if (columns.length === 2) {
    examples = `"average ${columns[0]}" or "total ${columns[1]}"`;
  } else if (columns.length === 1) {
    examples = `"average ${columns[0]}"`;
  } else {
    examples = `"average <column>" or "total <x> by <y>"`;
  }
  return (
    `I can read ${f}, but I couldn't compute a verified statistic for that. ` +
    `Try phrasing it as ${examples} — I only show numbers Lighthouse computed from the data.`
  );
}
