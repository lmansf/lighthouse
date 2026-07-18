// SQL pretty-printer TS twin (usability patch §1) — src/lib/sqlFormat.ts.
//
// PARITY: the golden outputs pinned here are the SAME strings the Rust unit
// tests in native/crates/lighthouse-core/src/sqlfmt.rs assert. Sharing the
// goldens across both suites is how the twin is kept byte-identical to the
// engine (the Edit-SQL dialog and the answer fence must format a statement the
// same way). The AST-equivalence proof is Rust-only (SQL parsing is Rust-only);
// here we pin layout, idempotency, and string-literal preservation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { formatSql } = await import("../src/lib/sqlFormat.ts");

test("clause keywords break onto their own lines; case is preserved", () => {
  const got = formatSql("select a, b from t where a > 1 group by a order by b limit 10");
  assert.equal(got, "select a, b\nfrom t\nwhere a > 1\ngroup by a\norder by b\nlimit 10");
});

test("a narrow SELECT list stays inline", () => {
  assert.equal(formatSql("select a, b, c from t"), "select a, b, c\nfrom t");
});

test("a wide SELECT list breaks one column per line", () => {
  const got = formatSql(
    "select alpha_column, beta_column, gamma_column, delta_column, epsilon_column from wide_table",
  );
  assert.ok(got.startsWith("select\n  alpha_column,\n"), got);
  assert.ok(got.includes("\n  beta_column,\n"), got);
  assert.ok(got.includes("\n  epsilon_column\n"), got);
  assert.ok(got.endsWith("from wide_table"), got);
});

test("string literals are never reflowed (commas/keywords inside stay put)", () => {
  const got = formatSql("select x from t where name = 'a,  b   from c'");
  assert.ok(got.includes("'a,  b   from c'"), got);
});

test("function/aggregate calls stay tight", () => {
  const got = formatSql("select sum(amount), count(*) from t");
  assert.ok(got.includes("sum(amount)"), got);
  assert.ok(got.includes("count(*)"), got);
});

test("formatting is idempotent", () => {
  const corpus = [
    "select region, sum(x) from sales where y > 0 group by region order by sum(x) desc limit 5",
    "SELECT c.name, o.total FROM customers c INNER JOIN orders o ON c.id = o.customer_id",
    "WITH m AS (SELECT date_trunc('month', ts) AS x, SUM(v) AS s FROM t GROUP BY 1) SELECT x, s FROM m",
    "select case when x > 0 then 'pos' else 'neg' end as sign, count(*) from t group by 1",
  ];
  for (const sql of corpus) {
    const once = formatSql(sql);
    assert.equal(formatSql(once), once, `not idempotent:\n${once}`);
  }
});

test("a subquery indents its own clauses one step", () => {
  const got = formatSql("select r from (select region as r from sales where amount > 0) sub");
  assert.ok(got.includes("\n  from sales"), got);
  assert.ok(got.includes("\n  where amount > 0"), got);
});

test("empty / whitespace input is returned trimmed, never throws", () => {
  assert.equal(formatSql("   "), "");
  assert.equal(formatSql(""), "");
});
