// Proactive insights surface (openspec: add-quant-depth §5) — the "What stands
// out" panel that shows a finding WITHOUT the user asking. The contracts mock is
// imported and exercised for real (the offline scan the panel drives against:
// ranked findings + the capped-coverage disclosure), and the JSX surface
// (InsightsNav) — which can't load in node — is asserted structurally against
// the source, the recipesNavUi/viewsNavUi house style. The Rust engine owns the
// real scan; live behavior is the native/E2E pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { ragService } = await import("../src/contracts/mocks/rag.mock.ts");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const nav = read("src/features/insights/InsightsNav.tsx");
const page = read("app/page.tsx");
const registry = read("src/shell/sidebarSections.tsx");

// --- Mock contract the panel leans on ----------------------------------------

test("insights() returns a ranked, bounded scan with the coverage counts", async () => {
  const scan = await ragService.insights();
  assert.ok(Array.isArray(scan.findings) && scan.findings.length > 0, "the sample has findings");
  assert.equal(typeof scan.tablesScanned, "number", "tablesScanned rides the scan");
  assert.equal(typeof scan.tablesAvailable, "number", "tablesAvailable rides the scan");
  // The sample is capped (scanned < available) so the disclosure is exercised.
  assert.ok(
    scan.tablesAvailable > scan.tablesScanned,
    "the sample is capped so the 'scanned N of M' disclosure has something to show",
  );
});

test("each finding carries a table, a whitelisted kind, a verbatim headline, magnitude, and SQL", async () => {
  const { findings } = await ragService.insights();
  const kinds = new Set(["anomaly", "mover", "changepoint"]);
  for (const f of findings) {
    assert.equal(typeof f.table, "string");
    assert.ok(kinds.has(f.kind), `kind ${f.kind} is one of anomaly|mover|changepoint`);
    assert.ok(typeof f.headline === "string" && f.headline.length > 0, "an engine headline is present");
    assert.equal(typeof f.magnitude, "number");
    assert.ok(typeof f.sql === "string" && /select/i.test(f.sql), "the finding carries its guarded SELECT");
  }
  // One of each detector kind is represented in the sample.
  assert.deepEqual(
    new Set(findings.map((f) => f.kind)),
    new Set(["anomaly", "mover", "changepoint"]),
  );
});

test("findings arrive pre-ranked, most notable first (non-increasing magnitude)", async () => {
  const { findings } = await ragService.insights();
  for (let i = 1; i < findings.length; i += 1) {
    assert.ok(
      findings[i - 1].magnitude >= findings[i].magnitude,
      "the sample is already ranked by magnitude — the panel renders in order",
    );
  }
});

// --- The panel: fetch, verbatim headlines, badges, disclosure, empty, loading ---

test("InsightsNav is a titled, accessible nav that fetches insights on show", () => {
  assert.match(nav, /aria-label="What stands out"/, "the section is a titled nav (accessible)");
  assert.match(nav, /ragService\s*\n?\s*\.insights\(\)/, "the list comes from the engine's insights op");
  assert.match(nav, /useRagStore/, "it subscribes the shared vault session store for the refresh signal");
});

test("InsightsNav computes on show + on the vault-change signal, not a background poll", () => {
  // Keyed by the tabular-file VALUE (the RecipesNav idiom): a real catalog
  // change re-scans; idle polls (same key) and inclusion toggles do not.
  assert.match(nav, /const tableKey = useMemo\(/, "a stable vault-change key is derived");
  assert.match(nav, /\}, \[tableKey\]\);/, "the fetch re-arms only on a catalog change");
  assert.doesNotMatch(nav, /setInterval|setTimeout/, "no always-on background poll is introduced");
});

test("each finding row renders the kind badge, the source table, and the headline VERBATIM", () => {
  assert.match(nav, /findings\.map\(/, "one row per finding");
  // The engine headline is rendered as-is — never rewritten by the model.
  assert.match(nav, /\{f\.headline\}/, "the headline renders verbatim");
  assert.match(nav, /\{f\.table\}/, "the source table is shown");
  // A small badge per kind, with the three detector labels.
  assert.match(nav, /<Badge/, "a Fluent badge marks the kind");
  for (const label of ["Anomaly", "Mover", "Changepoint"]) {
    assert.ok(nav.includes(label), `the badge map carries the ${label} label`);
  }
});

test("InsightsNav discloses a capped scan and never presents it as exhaustive", () => {
  assert.match(nav, /scan\.tablesAvailable > scan\.tablesScanned/, "capped = available exceeds scanned");
  assert.match(
    nav,
    /Scanned \{scan\.tablesScanned\} of \{scan\.tablesAvailable\} tables\./,
    "the disclosure reads 'Scanned N of M tables.'",
  );
});

test("InsightsNav shows a loading state and the honest empty state", () => {
  assert.match(nav, /<Spinner/, "a spinner covers the in-flight scan");
  assert.match(nav, /loaded && findings\.length === 0/, "the empty state is gated on a completed load");
  assert.ok(
    nav.includes("Nothing stands out right now"),
    "the empty state honestly says nothing stands out (not an error)",
  );
});

test("InsightsNav is the collapsible 'What stands out' card", () => {
  assert.match(nav, /aria-expanded=\{!collapsed\}/, "the header toggles the card open/closed");
  assert.match(nav, /setCollapsed\(/, "collapse is stateful");
});

test("InsightsNav never invokes the model — it only presents the engine's scan", () => {
  assert.doesNotMatch(nav, /chatService/, "the panel never consults the model");
  assert.doesNotMatch(nav, /ask-question/, "the proactive panel needs no ask — it shows unprompted");
});

// --- Sectioned sidebar (openspec: field-patch-0.12.5 §1): the six sections moved
// out of app/page.tsx into the SectionRail registry; the Files tree is the top
// anchor. InsightsNav ("What stands out") leads the registry, above SemanticNav.
test("InsightsNav leads the sidebar section registry, above SemanticNav", () => {
  assert.match(registry, /import \{ InsightsNav \} from "@\/features\/insights\/InsightsNav";/);
  // First in SIDEBAR_SECTIONS, immediately above Business definitions.
  assert.match(registry, /Component: InsightsNav[\s\S]*Component: SemanticNav/, "What stands out leads");
  // The full top-to-bottom order the rail renders (the new pinned adjacency).
  assert.match(
    registry,
    /Component: InsightsNav[\s\S]*Component: SemanticNav[\s\S]*Component: CapabilityNav[\s\S]*Component: RecipesNav[\s\S]*Component: ViewsNav[\s\S]*Component: InvestigationsNav/,
    "insights → semantic → capabilities → recipes → library → investigations",
  );
  // The Files tree is now the sidebar anchor; the sections no longer stack in page.
  assert.match(page, /sidebar=\{<FileExplorer \/>\}/, "the file tree anchors the sidebar");
  assert.doesNotMatch(page, /<InsightsNav \/>/, "the section moved to the rail registry");
});
