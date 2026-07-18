// Vault-brief TS twin (src/server/vaultBrief.ts) — mirrors the Rust unit tests
// (vault_brief.rs) so the engine-drafted brief renders BYTE-FOR-BYTE across the
// two engines: composition sort order, singular/plural columns, the optional
// date range, and the empty-safe `null`. The expected string below MUST match
// the Rust test render_brief_pins_composition_and_tables.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { renderBrief, fileKind } = await import("../src/server/vaultBrief.ts");

test("renderBrief pins composition + tables byte-for-byte (PARITY)", () => {
  const brief = renderBrief(
    [
      ["CSV", 1],
      ["PDF", 3],
      ["XLSX", 1],
    ],
    [
      { table: "orders", columns: 4, dates: ["2024-01", "2024-03"] },
      { table: "flag", columns: 1 },
    ],
  );
  assert.equal(brief.name, "vault brief");
  const expected = [
    "Vault brief (engine-drafted from your files — edit to correct or extend; this is context, not a constraint):",
    "",
    "Files: 3 PDF, 1 CSV, 1 XLSX.",
    "",
    "Queryable tables:",
    "- orders (4 columns; dates 2024-01 to 2024-03)",
    "- flag (1 column)",
  ].join("\n");
  assert.equal(brief.text, expected);
});

test("renderBrief is deterministic and empty-safe", () => {
  assert.equal(renderBrief([], []), null, "nothing to say ⇒ null");
  assert.equal(renderBrief([["CSV", 0]], []), null, "zero-count kinds are pruned");
  const comp = [
    ["PDF", 2],
    ["CSV", 2],
  ];
  const tables = [{ table: "t", columns: 2 }];
  assert.equal(
    renderBrief(comp, tables).text,
    renderBrief(comp, tables).text,
    "same facts ⇒ same brief",
  );
});

test("fileKind reads the extension or nothing", () => {
  assert.equal(fileKind("orders.csv"), "CSV");
  assert.equal(fileKind("Q3.report.pdf"), "PDF");
  assert.equal(fileKind("README"), undefined);
  assert.equal(fileKind(".env"), undefined);
  assert.equal(fileKind("trailing."), undefined);
});
