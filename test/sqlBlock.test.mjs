// SQL highlighter (usability patch §1) — src/features/chat/SqlBlock.tsx.
// The engine pretty-prints the "Query used" fence; this colours it. The
// safety-relevant property is that the tokenizer classifies for COLOUR only and
// never recolours the inside of a string literal as a keyword. Plus a
// structural check that ChatPanel wires the highlighter and the Edit-SQL dialog
// seeds a formatted draft.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { tokenizeSqlDisplay } = await import("../src/lib/sqlHighlight.ts");

test("keywords, strings, numbers, and identifiers are classified", () => {
  const pieces = tokenizeSqlDisplay("SELECT count(*) FROM t WHERE n = 42");
  const kinds = Object.fromEntries(
    pieces.filter((p) => p.cls !== "ws").map((p) => [p.text, p.cls]),
  );
  assert.equal(kinds["SELECT"], "keyword");
  assert.equal(kinds["FROM"], "keyword");
  assert.equal(kinds["WHERE"], "keyword");
  assert.equal(kinds["42"], "number");
  assert.equal(kinds["t"], "ident");
  // count() is a function, deliberately an identifier (calm block).
  assert.equal(kinds["count"], "ident");
});

test("a SQL keyword inside a string literal is NOT recoloured", () => {
  const pieces = tokenizeSqlDisplay("SELECT x FROM t WHERE s = 'FROM where select'");
  const str = pieces.find((p) => p.cls === "string");
  assert.ok(str, "the literal is one string piece");
  assert.equal(str.text, "'FROM where select'");
  // The words inside the string are not separate keyword pieces.
  const keywordTexts = pieces.filter((p) => p.cls === "keyword").map((p) => p.text);
  assert.deepEqual(keywordTexts, ["SELECT", "FROM", "WHERE"]);
});

test("whitespace is preserved verbatim (the engine's layout survives)", () => {
  const laidOut = "SELECT a, b\nFROM t";
  const rejoined = tokenizeSqlDisplay(laidOut)
    .map((p) => p.text)
    .join("");
  assert.equal(rejoined, laidOut);
});

test("ChatPanel wires the highlighter and a formatted Edit-SQL draft", () => {
  const src = readFileSync(path.join(ROOT, "src/features/chat/ChatPanel.tsx"), "utf8");
  assert.match(src, /import \{ SqlBlock \} from "@\/features\/chat\/SqlBlock"/);
  assert.match(src, /import \{ formatSql \} from "@\/lib\/sqlFormat"/);
  // The code override renders SqlBlock for a `language-sql` fence.
  assert.match(src, /includes\("language-sql"\)/);
  assert.match(src, /<SqlBlock code=\{String\(children \?\? ""\)\}/);
  // The Edit-SQL dialog opens on the pretty-printed query.
  assert.match(src, /setSqlDraft\(formatSql\(meta\.sql\)\)/);
});
