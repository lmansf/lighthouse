/**
 * Executable parity rule 2: the grounded-answer SYSTEM_PROMPT must be
 * BYTE-IDENTICAL between the two engines — TS (src/server/llm.ts) and Rust
 * (native/crates/lighthouse-core/src/llm.rs). Until this test, that parity
 * rested on manual discipline; now drift is a red test.
 *
 * The TS side is the REAL runtime value (the module's exported constant); the
 * Rust side is extracted from the source and decoded — resilient to both the
 * escaped `"…\n…"` form used today and a raw `r#"…"#` form, so a refactor of
 * the literal's spelling doesn't break the check.
 *
 * The Style section is additionally pinned to an inline snapshot so any edit
 * to the answer style (e.g. the lead-with-the-number rule) shows up here as a
 * reviewed diff, never as a silent change.
 *
 * Run: `node --test test/promptParity.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { SYSTEM_PROMPT } = await import("../src/server/llm.ts");

const RUST_LLM_RS = fileURLToPath(
  new URL("../native/crates/lighthouse-core/src/llm.rs", import.meta.url),
);

/**
 * Extract and decode the `const SYSTEM_PROMPT: &str = …;` literal from llm.rs.
 * Handles the escaped double-quoted form (what the file uses today) and the
 * raw-string form (`r"…"`, `r#"…"#`, …) in case the literal is ever reshaped.
 * Unknown escapes fail loudly so the test never silently compares garbage.
 */
function rustSystemPrompt(src) {
  const decl = src.match(/const\s+SYSTEM_PROMPT\s*:\s*&str\s*=\s*/);
  assert.ok(decl, "llm.rs declares `const SYSTEM_PROMPT: &str`");
  let i = decl.index + decl[0].length;

  // Raw form: r"…" / r#"…"# / r##"…"## — content is verbatim.
  if (src[i] === "r") {
    let hashes = 0;
    let j = i + 1;
    while (src[j] === "#") {
      hashes += 1;
      j += 1;
    }
    assert.equal(src[j], '"', "raw string literal opens with a quote");
    const closer = `"${"#".repeat(hashes)}`;
    const end = src.indexOf(closer, j + 1);
    assert.notEqual(end, -1, "raw string literal is terminated");
    return src.slice(j + 1, end);
  }

  // Escaped form: scan character-wise, decoding Rust string escapes.
  assert.equal(src[i], '"', "SYSTEM_PROMPT is a string literal");
  i += 1;
  let out = "";
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"') return out;
    if (ch !== "\\") {
      out += ch;
      i += 1;
      continue;
    }
    const esc = src[i + 1];
    i += 2;
    switch (esc) {
      case "n":
        out += "\n";
        break;
      case "t":
        out += "\t";
        break;
      case "r":
        out += "\r";
        break;
      case "0":
        out += "\0";
        break;
      case '"':
        out += '"';
        break;
      case "'":
        out += "'";
        break;
      case "\\":
        out += "\\";
        break;
      case "x": {
        out += String.fromCharCode(parseInt(src.slice(i, i + 2), 16));
        i += 2;
        break;
      }
      case "u": {
        assert.equal(src[i], "{", "Rust \\u escape uses braces");
        const close = src.indexOf("}", i);
        assert.notEqual(close, -1, "\\u{…} escape is terminated");
        out += String.fromCodePoint(parseInt(src.slice(i + 1, close), 16));
        i = close + 1;
        break;
      }
      default:
        assert.fail(`unhandled Rust escape \\${esc} in SYSTEM_PROMPT — extend the decoder`);
    }
  }
  assert.fail("unterminated SYSTEM_PROMPT string literal");
}

/** A prompt section: from its heading line to the next blank line (or EOF). */
function section(prompt, heading) {
  const start = prompt.indexOf(`${heading}\n`);
  assert.notEqual(start, -1, `prompt has a "${heading}" section`);
  const end = prompt.indexOf("\n\n", start);
  return prompt.slice(start, end === -1 ? prompt.length : end);
}

test("SYSTEM_PROMPT is byte-identical across the TS and Rust engines", () => {
  const rust = rustSystemPrompt(readFileSync(RUST_LLM_RS, "utf8"));
  // Strict string equality first (a mismatch prints a readable diff)…
  assert.equal(rust, SYSTEM_PROMPT, "llm.rs SYSTEM_PROMPT drifted from llm.ts");
  // …then literal byte equality of the UTF-8 encodings, per parity rule 2.
  assert.ok(
    Buffer.from(rust, "utf8").equals(Buffer.from(SYSTEM_PROMPT, "utf8")),
    "UTF-8 bytes differ between the engines",
  );
});

test("Style section matches the reviewed snapshot (lead with the number)", () => {
  const expected = [
    "Style:",
    '- Lead with the answer itself: for a numeric ask the FIRST line is the figure with its unit and label (e.g. "$4.2M — total Q3 revenue."); otherwise it is one direct sentence. Elaborate after that line, as concisely as the question allows.',
    "- Format for readability with Markdown: headings, **bold**, bullet/numbered lists, tables, and `code`/fenced code where they help. The interface renders Markdown.",
    "- Inline HTML also renders (sanitized to a safe allowlist), so reach for it when Markdown falls short: <sub>/<sup> for units and footnote marks, <br> for line breaks inside table cells, <details><summary> to fold long detail, <mark> to highlight the key figure, <kbd> for keys. Scripts, images, iframes, styles, and event handlers are stripped — never rely on them.",
  ].join("\n");
  assert.equal(
    section(SYSTEM_PROMPT, "Style:"),
    expected,
    "Style section changed — update this snapshot in the same review as the prompt edit",
  );
});

test("lead-with-the-number composes with the chart directive contract", () => {
  // The Style rule puts the figure on the FIRST line; the Charts section must
  // still pin the (optional) chart-request fence to the END of the answer.
  const charts = section(SYSTEM_PROMPT, "Charts:");
  assert.match(
    charts,
    /end your answer with ONE lighthouse-chart-request fence/,
    "Charts section no longer pins the fence to the end of the answer",
  );
});
