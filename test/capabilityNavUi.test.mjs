// Capability map surface (openspec: add-deep-analysis §4.3/§4.4) — the
// Library-sibling "What you can do" gallery + the Investigate affordance. The
// contracts mock is imported and exercised for real (the offline aggregate the
// nav drives against: capabilityMap over an included tabular file vs nothing, and
// the investigate op's saved-note shape), and the JSX surface (CapabilityNav) —
// which can't load in node — is asserted structurally against the source, the
// recipesNavUi/standsOutNavUi house style. The Rust engine owns the real
// aggregate + battery; live behavior is the native/E2E pass.
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

const nav = read("src/features/capabilities/CapabilityNav.tsx");
const page = read("app/page.tsx");
const registry = read("src/shell/sidebarSections.tsx");

// --- Mock contract the gallery leans on --------------------------------------

test("capabilityMap returns an empty map with no included tabular file (twin/empty honesty)", async () => {
  const map = await ragService.capabilityMap([]);
  assert.deepEqual(map.tables, []);
  assert.deepEqual(map.suggestedInvestigations, [], "nothing analyzable ⇒ no investigations");
  assert.deepEqual(map.recipes, []);
});

test("capabilityMap aggregates tables + recipes + metrics + asks + one investigation per Date+Numeric table", async () => {
  // Add a tabular node so the mock's aggregate has something to resolve against.
  const { id } = await ragService.addReference("/data/capmap.csv");
  const map = await ragService.capabilityMap([id]);

  // The Date+Numeric table is listed, typed, and flagged investigable.
  const table = map.tables.find((t) => t.name === "capmap.csv");
  assert.ok(table, "the included tabular file is listed as a table");
  assert.equal(table.investigable, true, "a date+numeric table is investigable");
  assert.ok(
    table.columns.some((c) => c.kind === "date") && table.columns.some((c) => c.kind === "numeric"),
    "the typed columns carry the date + numeric shape",
  );

  // Exactly one "Investigate {table}" suggestion for the investigable table.
  assert.ok(
    map.suggestedInvestigations.some(
      (s) => s.table === "capmap.csv" && s.label === "Investigate capmap.csv",
    ),
    "an investigation is offered per date+numeric table",
  );

  // The recipes + metrics + asks the nav renders are aggregated here.
  assert.ok(map.recipes.length >= 1, "the table's recipes are aggregated");
  assert.ok(map.recipes.some((r) => r.table === "capmap.csv"), "recipes name the table they run on");
  assert.ok(map.metrics.length >= 1, "a metric is aggregated");
  assert.ok(map.suggestedAsks.length >= 1 && typeof map.suggestedAsks[0].question === "string");

  await ragService.removeReference(id);
});

test("investigate returns a saved note (id + name) the affordance can reveal", async () => {
  const saved = await ragService.investigate("capmap.csv");
  assert.equal(typeof saved.savedId, "string");
  assert.ok(saved.savedId.length > 0, "a saved node id comes back");
  assert.ok(/\.md$/.test(saved.savedName), "the saved artifact is a markdown note");
  // The Standard report carries no template suffix.
  assert.equal(saved.savedName, "Investigate capmap.csv.md", "Standard note is unsuffixed");
});

test("a templated investigate names the note with the template suffix (mirrors the engine)", async () => {
  // The mock's saved name mirrors the Rust `ReportTemplate::title_suffix`, so a
  // templated reveal shows the same titled note the desktop engine would write.
  const imrad = await ragService.investigate("capmap.csv", undefined, "imrad");
  assert.equal(imrad.savedName, "Investigate capmap.csv — Scientific method.md");
  const bluf = await ragService.investigate("capmap.csv", undefined, "bluf");
  assert.equal(bluf.savedName, "Investigate capmap.csv — Business report.md");
});

// --- The gallery: fetch, tables, Investigate affordance, asks, empty ---------

test("CapabilityNav is a titled, accessible nav that fetches the capability map", () => {
  assert.match(nav, /aria-label="What you can do"/, "the section is a titled nav (accessible)");
  assert.match(nav, /useRagStore/, "it subscribes the shared vault session store");
  assert.match(
    nav,
    /\.capabilityMap\(includedKey\.split\("\\n"\)\)/,
    "the aggregate comes from the engine's capabilityMap op",
  );
  assert.match(nav, /map\.tables\.map\(/, "one block per analyzable table");
});

test("CapabilityNav shows the Investigate affordance ONLY for an investigable table", () => {
  assert.match(nav, /t\.investigable \?/, "the affordance is gated on the investigable flag");
  assert.ok(nav.includes("Investigate"), "the affordance is labeled Investigate");
  assert.match(nav, /onClick=\{\(\) => investigate\(t\.name\)\}/, "it runs investigate for that table");
});

test("investigating runs the op then reveals the written note in the tree", () => {
  assert.match(
    nav,
    /ragService\.investigate\(table, undefined, template\)/,
    "it calls the investigate op, threading the optional template",
  );
  assert.match(
    nav,
    /new CustomEvent\("lighthouse:reveal-node", \{ detail: \{ id: savedId \} \}\)/,
    "the saved note is revealed via the chat-citation reveal seam",
  );
});

test("the Investigate affordance offers the Standard report + both templates (add-report-templates)", () => {
  // The affordance is a menu: Standard (no template), Scientific method (imrad),
  // Business report (bluf) — the three shapes the engine's investigate_templated
  // renders. The engine numbers are identical across them; a template only adds
  // narrated framing, so the UI passes only the wire tag.
  assert.match(nav, /investigate\(t\.name\)/, "Standard report runs the untemplated op");
  assert.match(nav, /investigate\(t\.name, "imrad"\)/, "Scientific method passes the imrad tag");
  assert.match(nav, /investigate\(t\.name, "bluf"\)/, "Business report passes the bluf tag");
  assert.ok(
    nav.includes("Scientific method") && nav.includes("Business report") && nav.includes("Standard report"),
    "all three shapes are labeled in the menu",
  );
  // The signature carries the optional template through (typed by the contract).
  assert.match(
    nav,
    /function investigate\(table: string, template\?: ReportTemplate\)/,
    "the handler threads an optional ReportTemplate",
  );
});

test("CapabilityNav renders the table's recipes + metrics and the suggested asks", () => {
  assert.match(nav, /map\.recipes\.filter\(\(r\) => r\.table === t\.name\)/, "recipes are grouped under their table");
  assert.match(nav, /map\.metrics\.filter\(\(m\) => m\.entity === t\.name\)/, "metrics are grouped under their table");
  assert.match(nav, /map\.suggestedAsks\.map\(/, "the suggested asks render as tap-to-ask rows");
  assert.match(
    nav,
    /new CustomEvent\("lighthouse:ask-question"/,
    "a suggested ask seeds the chat via the existing ask seam (no new op)",
  );
});

test("CapabilityNav shows a loading state and the honest 'nothing investigable' empty state", () => {
  assert.match(nav, /<Spinner/, "a spinner covers the in-flight aggregate");
  assert.match(nav, /loaded && !hasAnything/, "the empty state is gated on a completed load");
  assert.ok(
    nav.includes("Nothing to investigate yet"),
    "the empty state honestly says nothing is investigable (not an error)",
  );
});

test("CapabilityNav refreshes on the included set + views-changed, keyed by value", () => {
  assert.match(nav, /includedFileIds\.join\("\\n"\)/, "keyed by the included-file VALUE, not identity");
  assert.match(nav, /\[includedKey, viewsNonce\]/, "the fetch re-arms on the included set + views-changed");
  assert.match(nav, /addEventListener\("lighthouse:views-changed"/, "a saved view can add/drop a capability");
});

test("CapabilityNav never invokes the model — every figure comes from the engine map", () => {
  assert.doesNotMatch(nav, /chatService/, "the panel never consults the model");
  // No fabricated numbers: the component renders map fields, it computes none.
  assert.doesNotMatch(nav, /Math\.(random|round|floor)/, "the panel templates no figures of its own");
});

// --- Registry order (openspec: field-patch-0.12.5 §1): the sections moved from
// app/page.tsx into the SectionRail registry; the Files tree is the top anchor.

test("CapabilityNav sits between Semantic and Recipes in the section registry", () => {
  assert.match(registry, /import \{ CapabilityNav \} from "@\/features\/capabilities\/CapabilityNav";/);
  assert.match(registry, /Component: SemanticNav[\s\S]*Component: CapabilityNav[\s\S]*Component: RecipesNav/, "the capability map sits between Semantic and Recipes");
  // The full rail order is pinned here too.
  assert.match(
    registry,
    /Component: InsightsNav[\s\S]*Component: SemanticNav[\s\S]*Component: CapabilityNav[\s\S]*Component: RecipesNav[\s\S]*Component: ViewsNav[\s\S]*Component: InvestigationsNav/,
    "insights → semantic → capabilities → recipes → library → investigations",
  );
  // The Files tree anchors the sidebar; the sections no longer stack in page.
  assert.match(page, /sidebar=\{<FileExplorer \/>\}/, "the file tree anchors the sidebar");
  assert.doesNotMatch(page, /<CapabilityNav \/>/, "the section moved to the rail registry");
});
