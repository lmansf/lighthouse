// Pure SQL display tokenizer for the "Query used" highlighter (usability patch
// §1). Kept out of the React component (src/features/chat/SqlBlock.tsx) so it's
// unit-testable in node like the other src/lib helpers.
//
// Display-only: it classifies spans for COLOUR and preserves every byte,
// including whitespace — the engine already laid the SQL out (sqlfmt.rs), we
// only paint it. String and quoted-identifier spans are emitted whole so a SQL
// keyword sitting inside a string is never recoloured.

export type SqlPieceCls =
  | "keyword"
  | "string"
  | "number"
  | "comment"
  | "punct"
  | "ident"
  | "ws";

export interface SqlPiece {
  cls: SqlPieceCls;
  text: string;
}

// Reserved words that read as keywords. Functions (count, sum, date_trunc…)
// stay identifiers — colouring only the grammar words keeps the block calm.
export const SQL_KEYWORDS = new Set([
  "SELECT", "FROM", "WHERE", "GROUP", "BY", "ORDER", "HAVING", "LIMIT", "OFFSET",
  "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "OUTER", "CROSS", "ON", "USING",
  "AS", "AND", "OR", "NOT", "IN", "IS", "NULL", "LIKE", "ILIKE", "BETWEEN",
  "CASE", "WHEN", "THEN", "ELSE", "END", "DISTINCT", "ALL", "UNION", "INTERSECT",
  "EXCEPT", "WITH", "OVER", "PARTITION", "ASC", "DESC", "TRUE", "FALSE", "CAST",
  "WINDOW", "VALUES", "EXISTS", "ANY", "INTERVAL", "DATE", "TIMESTAMP",
]);

function isSpace(c: string) {
  return c === " " || c === "\t" || c === "\n" || c === "\r";
}
function isDigit(c: string) {
  return c >= "0" && c <= "9";
}
function isAlpha(c: string) {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
}

/** Scan SQL into coloured pieces, preserving whitespace verbatim. */
export function tokenizeSqlDisplay(sql: string): SqlPiece[] {
  const out: SqlPiece[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    if (isSpace(c)) {
      const s = i;
      while (i < n && isSpace(sql[i])) i += 1;
      out.push({ cls: "ws", text: sql.slice(s, i) });
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      const s = i;
      while (i < n && sql[i] !== "\n") i += 1;
      out.push({ cls: "comment", text: sql.slice(s, i) });
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const s = i;
      i += 2;
      while (i + 1 < n && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i = Math.min(i + 2, n);
      out.push({ cls: "comment", text: sql.slice(s, i) });
      continue;
    }
    if (c === "'") {
      const s = i;
      i += 1;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i += 1;
          break;
        }
        i += 1;
      }
      out.push({ cls: "string", text: sql.slice(s, i) });
      continue;
    }
    if (c === '"') {
      const s = i;
      i += 1;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') { i += 2; continue; }
          i += 1;
          break;
        }
        i += 1;
      }
      out.push({ cls: "ident", text: sql.slice(s, i) });
      continue;
    }
    if (isDigit(c) || (c === "." && isDigit(sql[i + 1] ?? ""))) {
      const s = i;
      i += 1;
      while (i < n && (isDigit(sql[i]) || sql[i] === "." || sql[i] === "_" || sql[i] === "e" || sql[i] === "E")) i += 1;
      out.push({ cls: "number", text: sql.slice(s, i) });
      continue;
    }
    if (isAlpha(c)) {
      const s = i;
      i += 1;
      while (i < n && (isAlpha(sql[i]) || isDigit(sql[i]) || sql[i] === "$")) i += 1;
      const word = sql.slice(s, i);
      out.push({ cls: SQL_KEYWORDS.has(word.toUpperCase()) ? "keyword" : "ident", text: word });
      continue;
    }
    out.push({ cls: "punct", text: c });
    i += 1;
  }
  return out;
}
