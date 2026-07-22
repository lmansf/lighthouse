/**
 * §39 §2: the seven-stamp lockstep tripwire, riding the JS gate. The script
 * (scripts/check-stamps.mjs) is the single source of truth for which stamps
 * exist; this test runs it as part of `npm test`, so any PR that moves one
 * stamp without the others goes red with the offenders named — the §33-era
 * staleness class caught where it starts.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { checkStamps, collectStamps } = await import("../scripts/check-stamps.mjs");

test("all seven stamp files agree on one version", () => {
  const { reference, offenders } = checkStamps();
  assert.match(reference, /^\d+\.\d+\.\d+$/, "the reference stamp parses as semver");
  assert.deepEqual(
    offenders.map((o) => `${o.label}: ${o.value}`),
    [],
    `version stamps drifted from ${reference} — all seven files move together ` +
      `(CLAUDE.md release mechanics; docs/CONVENTIONS.md)`,
  );
});

test("the inventory covers every stamp CLAUDE.md names (nothing silently unparsed)", () => {
  const stamps = collectStamps();
  // package.json + lock×2 + Cargo.toml + tauri.conf + ≥5 lighthouse-* crates
  // + project.yml×2 + Info.plist×2 = at least 14 readings.
  assert.ok(stamps.length >= 14, `only ${stamps.length} stamps collected`);
  assert.ok(
    !stamps.some((s) => s.value === "<MISSING>"),
    `unparsed stamp(s): ${stamps.filter((s) => s.value === "<MISSING>").map((s) => s.label)}`,
  );
  const crates = stamps.filter((s) => s.label.startsWith("native/Cargo.lock lighthouse-"));
  assert.ok(crates.length >= 5, "the lighthouse-* crate family is enumerated by pattern");
});
