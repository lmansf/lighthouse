// Deterministic, AST-preserving SQL pretty-printer — the TS twin of the Rust
// engine's `sqlfmt.rs` (usability patch §1).
//
// PARITY: byte-for-byte identical output to `format_sql` in
// `native/crates/lighthouse-core/src/sqlfmt.rs`. The Rust engine formats the
// SQL it writes into an answer's "Query used" fence; this twin formats the
// same statement wherever the UI shows it directly — the Edit-SQL dialog draft,
// a saved view's definition, an evidence pack. They MUST agree so the two
// surfaces read the same for the same statement. Any change here changes there.
//
// Safety invariant (same as the Rust doc): whitespace-only transform. Bytes
// inside string literals, quoted identifiers, and comments are preserved
// verbatim; no separator two adjacent tokens need is ever dropped. The result
// parses to the identical statement. (SQL parsing is Rust-only, so the
// AST-equivalence proof lives in the Rust suite; here we assert idempotency and
// token preservation.)

const SELECT_WRAP_WIDTH = 72;
const INDENT = "  ";

// Token kinds. A plain const object (not a TS `enum`) so Node's strip-only
// TypeScript loader in the test runner can execute this module unmodified.
const Kind = {
  Word: 0,
  Str: 1,
  Quoted: 2,
  Num: 3,
  Punct: 4,
  LineComment: 5,
  BlockComment: 6,
} as const;
type Kind = (typeof Kind)[keyof typeof Kind];

interface Tok {
  kind: Kind;
  text: string;
}

const CLAUSE_WORDS = new Set([
  "SELECT", "FROM", "WHERE", "HAVING", "LIMIT", "OFFSET", "WINDOW", "UNION",
  "INTERSECT", "EXCEPT", "VALUES", "WITH",
]);

const JOIN_WORDS = new Set([
  "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "ON", "USING",
]);

/** Format one SQL statement for display. Whitespace-only; see module docs. */
export function formatSql(sql: string): string {
  const toks = lex(sql);
  if (toks.length === 0) return sql.trim();
  return layout(toks);
}

// --- Tokenizer --------------------------------------------------------------

function isSpace(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";
}
function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}
function isAlpha(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
}
function isAlnum(c: string): boolean {
  return isDigit(c) || isAlpha(c);
}

function lex(sql: string): Tok[] {
  const n = sql.length;
  let i = 0;
  const out: Tok[] = [];
  while (i < n) {
    const c = sql[i];
    if (isSpace(c)) {
      i += 1;
      continue;
    }
    // Line comment.
    if (c === "-" && i + 1 < n && sql[i + 1] === "-") {
      const start = i;
      while (i < n && sql[i] !== "\n") i += 1;
      out.push({ kind: Kind.LineComment, text: sql.slice(start, i) });
      continue;
    }
    // Block comment.
    if (c === "/" && i + 1 < n && sql[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i + 1 < n && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i = Math.min(i + 2, n);
      out.push({ kind: Kind.BlockComment, text: sql.slice(start, i) });
      continue;
    }
    // String literal '...'; doubled '' escapes.
    if (c === "'") {
      const start = i;
      i += 1;
      for (;;) {
        if (i >= n) break;
        if (sql[i] === "'") {
          if (i + 1 < n && sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      out.push({ kind: Kind.Str, text: sql.slice(start, i) });
      continue;
    }
    // Quoted identifier "..."; doubled "" escapes.
    if (c === '"') {
      const start = i;
      i += 1;
      for (;;) {
        if (i >= n) break;
        if (sql[i] === '"') {
          if (i + 1 < n && sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      out.push({ kind: Kind.Quoted, text: sql.slice(start, i) });
      continue;
    }
    // Number.
    if (isDigit(c) || (c === "." && i + 1 < n && isDigit(sql[i + 1]))) {
      const start = i;
      i += 1;
      while (i < n) {
        const d = sql[i];
        if (isDigit(d) || d === "." || d === "_") {
          i += 1;
        } else if (
          (d === "e" || d === "E") &&
          i + 1 < n &&
          (isDigit(sql[i + 1]) || sql[i + 1] === "+" || sql[i + 1] === "-")
        ) {
          i += 2;
        } else {
          break;
        }
      }
      out.push({ kind: Kind.Num, text: sql.slice(start, i) });
      continue;
    }
    // Word.
    if (c === "_" || isAlpha(c)) {
      const start = i;
      i += 1;
      while (i < n) {
        const d = sql[i];
        if (d === "_" || d === "$" || isAlnum(d)) i += 1;
        else break;
      }
      out.push({ kind: Kind.Word, text: sql.slice(start, i) });
      continue;
    }
    // Punctuation: greedily take a known two-char operator, else one code unit.
    const two = sql.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "<>" || two === "!=" || two === "||" || two === "::" || two === "->") {
      out.push({ kind: Kind.Punct, text: two });
      i += 2;
      continue;
    }
    out.push({ kind: Kind.Punct, text: c });
    i += 1;
  }
  return out;
}

// --- Layout -----------------------------------------------------------------

function nextWordIs(toks: Tok[], idx: number, want: string): boolean {
  let j = idx + 1;
  while (j < toks.length && (toks[j].kind === Kind.LineComment || toks[j].kind === Kind.BlockComment)) j += 1;
  return j < toks.length && toks[j].kind === Kind.Word && toks[j].text.toUpperCase() === want;
}

/** Does token `idx` open a clause line, given raw paren depth and the current
 *  subquery's own depth? Returns true when it should break onto a new line. */
function isClauseAt(toks: Tok[], idx: number, depth: number, sub: number): boolean {
  if (depth !== sub) return false;
  const t = toks[idx];
  if (t.kind !== Kind.Word) return false;
  const w = t.text.toUpperCase();
  if ((w === "GROUP" || w === "ORDER" || w === "PARTITION") && nextWordIs(toks, idx, "BY")) return true;
  if (w === "UNION" && (nextWordIs(toks, idx, "ALL") || nextWordIs(toks, idx, "DISTINCT"))) return true;
  return CLAUSE_WORDS.has(w) || JOIN_WORDS.has(w);
}

function opensSubquery(toks: Tok[], idx: number): boolean {
  let j = idx + 1;
  while (j < toks.length && (toks[j].kind === Kind.LineComment || toks[j].kind === Kind.BlockComment)) j += 1;
  return (
    j < toks.length &&
    toks[j].kind === Kind.Word &&
    (toks[j].text.toUpperCase() === "SELECT" || toks[j].text.toUpperCase() === "WITH")
  );
}

interface Seg {
  indent: number;
  toks: number[];
}

function layout(toks: Tok[]): string {
  const segs: Seg[] = [];
  let cur: Seg = { indent: 0, toks: [] };
  let depth = 0;
  const substack: number[] = [];

  for (let i = 0; i < toks.length; i++) {
    const sub = substack.length ? substack[substack.length - 1] : 0;
    if (isClauseAt(toks, i, depth, sub)) {
      if (cur.toks.length > 0) {
        segs.push(cur);
        cur = { indent: substack.length, toks: [] };
      } else {
        cur.indent = substack.length;
      }
    }

    if (toks[i].kind === Kind.Punct) {
      if (toks[i].text === "(") {
        depth += 1;
        if (opensSubquery(toks, i)) substack.push(depth);
      } else if (toks[i].text === ")") {
        if (substack.length && substack[substack.length - 1] === depth) substack.pop();
        depth = Math.max(0, depth - 1);
      }
    }

    cur.toks.push(i);
  }
  if (cur.toks.length > 0) segs.push(cur);

  const lines: string[] = [];
  for (const seg of segs) {
    const pad = INDENT.repeat(seg.indent);
    const slice = seg.toks.map((k) => toks[k]);
    if (isSelectSeg(slice)) renderSelect(slice, pad, lines);
    else lines.push(pad + renderInline(slice));
  }
  return lines.join("\n");
}

function isSelectSeg(slice: Tok[]): boolean {
  return slice.length > 0 && slice[0].kind === Kind.Word && slice[0].text.toUpperCase() === "SELECT";
}

function renderSelect(slice: Tok[], pad: string, lines: string[]): void {
  let headEnd = 1;
  if (
    slice.length > 1 &&
    slice[1].kind === Kind.Word &&
    (slice[1].text.toUpperCase() === "DISTINCT" || slice[1].text.toUpperCase() === "ALL")
  ) {
    headEnd = 2;
  }
  const head = renderInline(slice.slice(0, headEnd));
  const body = slice.slice(headEnd);
  if (body.length === 0) {
    lines.push(pad + head);
    return;
  }
  const cols = splitTopCommas(body);
  const inline = `${pad}${head} ${cols.join(", ")}`;
  if ([...inline].length <= SELECT_WRAP_WIDTH || cols.length < 2) {
    lines.push(inline);
    return;
  }
  lines.push(pad + head);
  const colPad = pad + INDENT;
  cols.forEach((col, k) => {
    const comma = k + 1 < cols.length ? "," : "";
    lines.push(`${colPad}${col}${comma}`);
  });
}

function splitTopCommas(body: Tok[]): string[] {
  const cols: string[] = [];
  let depth = 0;
  let start = 0;
  body.forEach((t, k) => {
    if (t.kind === Kind.Punct) {
      if (t.text === "(") depth += 1;
      else if (t.text === ")") depth -= 1;
      else if (t.text === "," && depth === 0) {
        cols.push(renderInline(body.slice(start, k)));
        start = k + 1;
      }
    }
  });
  cols.push(renderInline(body.slice(start)));
  return cols;
}

function renderInline(slice: Tok[]): string {
  let out = "";
  for (let k = 0; k < slice.length; k++) {
    const t = slice[k];
    if (k === 0) {
      out += t.text;
      continue;
    }
    if (needsSpace(slice[k - 1], t)) out += " ";
    out += t.text;
  }
  return out;
}

function needsSpace(prev: Tok, cur: Tok): boolean {
  const p = prev.text;
  const c = cur.text;
  if (c === "," || c === ")" || c === "." || c === "::") return false;
  if (p === "(" || p === "." || p === "::") return false;
  if (c === "(") {
    const call = (prev.kind === Kind.Word && !isBareKeyword(p)) || p === ")";
    if (call) return false;
  }
  return true;
}

const BARE_KEYWORDS = new Set([
  "IN", "VALUES", "AND", "OR", "NOT", "ON", "USING", "FROM", "WHERE", "SELECT",
  "BETWEEN", "OVER", "ALL", "ANY", "EXISTS", "WHEN", "THEN", "ELSE", "AS", "BY",
  "UNION", "EXCEPT", "INTERSECT",
]);

function isBareKeyword(w: string): boolean {
  return BARE_KEYWORDS.has(w.toUpperCase());
}
