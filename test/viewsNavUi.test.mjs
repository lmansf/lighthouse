// Shaped-views visibility + lifecycle UI (openspec: add-shaped-views §4-§5) —
// the Library nav, the view inspector, and the rename/delete lifecycle dialogs.
// The contracts mock is imported and exercised for real (the offline store the
// nav drives: list/create/rename/delete round trips, inspectView's rendered
// fields, and the reachable refusals shown verbatim). The JSX surfaces
// (ViewsNav, ViewInspector) can't load in node, so their guarantees are
// asserted structurally against the source — the boardsUi/investigationsUi
// house style. Live behavior is the E2E pass (§6).
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

const nav = read("src/features/views/ViewsNav.tsx");
const inspector = read("src/features/views/ViewInspector.tsx");
const store = read("src/stores/useViewsStore.ts");
const page = read("app/page.tsx");
const registry = read("src/shell/sidebarSections.tsx");

/** Reset the shared mock singleton between mock-driven tests. */
async function resetViews() {
  for (const v of await ragService.listViews()) {
    try {
      await ragService.deleteView(v.id, true);
    } catch {
      /* already gone */
    }
  }
}

const mk = (name, extra = {}) =>
  ragService.createView({
    name,
    sql: "SELECT 1",
    summaryText: "",
    summarySource: "model",
    fileIds: [],
    ...extra,
  });

// --- Mock store: the contract the nav + inspector lean on ----------------------------

test("the nav's list comes from listViews; a created view round-trips", async () => {
  await resetViews();
  assert.deepEqual(await ragService.listViews(), []);
  const v = await mk("Clean Sales", { sql: "SELECT * FROM sales", fileIds: ["sales.csv"] });
  assert.equal(v.name, "clean_sales", "the engine normalizes the name");
  assert.deepEqual((await ragService.listViews()).map((x) => x.name), ["clean_sales"]);
});

test("rename refusals throw the engine's human message (the nav shows it verbatim)", async () => {
  await resetViews();
  const a = await mk("a");
  await mk("b");
  // The dependents refusal is engine-only (the mock can't seed view-over-view
  // via createView); the reachable collision refusal proves refusals THROW a
  // human-readable reason — which the nav pipes straight into rename.error.
  await assert.rejects(() => ragService.renameView(a.id, "b"), /a view named "b" already exists/);
});

test("delete step one: viewDependents empty ⇒ deleteView(id) returns just its id", async () => {
  await resetViews();
  const v = await mk("solo", { fileIds: ["x.csv"] });
  assert.deepEqual(await ragService.viewDependents(v.id), { dependents: [], transitive: [] });
  // No-dependents path: cascade false, one id removed, nothing else touched.
  assert.deepEqual(await ragService.deleteView(v.id, false), [v.id]);
  assert.deepEqual(await ragService.listViews(), []);
});

test("inspectView returns exactly the fields the inspector renders; unknown id → {}", async () => {
  await resetViews();
  const v = await mk("shaped", {
    sql: "SELECT * FROM messy WHERE amount IS NOT NULL",
    summaryText: "cleaned amounts",
    summarySource: "model",
    fileIds: ["messy.csv"],
  });
  const insp = await ragService.inspectView(v.id);
  assert.equal(insp.id, v.id);
  assert.equal(insp.name, "shaped");
  assert.equal(insp.sql, "SELECT * FROM messy WHERE amount IS NOT NULL");
  assert.equal(insp.summary, "cleaned amounts");
  assert.equal(insp.summarySource, "model");
  assert.ok(Array.isArray(insp.sources) && insp.sources.length === 1, "one source file");
  assert.equal(insp.sources[0].savedAge, "just now", "freshness rides each source");
  assert.equal(typeof insp.localOnly, "boolean", "the local-only flag is present");
  assert.deepEqual(await ragService.inspectView("no-such-id"), {}, "unknown id is the empty {}");
});

// --- Library nav: list, empty state, row menu, mount ---------------------------------

test("ViewsNav lists views from the store and shows the quiet empty state", () => {
  assert.match(store, /ragService\.listViews\(\)/, "the store reads the list from the engine");
  assert.match(nav, /useViewsStore/, "the nav renders the shared session cache");
  assert.match(nav, /views\.map\(/, "one row per saved view");
  assert.ok(
    nav.includes("Saved views appear here — turn any answer into a reusable view."),
    "the empty state matches the design's quiet copy",
  );
  assert.match(nav, /aria-label="Library"/, "the section is titled Library (design wording)");
});

test("the row menu carries Inspect / Rename / Ask about this view / Delete", () => {
  for (const item of ["Inspect", "Rename", "Ask about this view", "Delete"]) {
    assert.ok(nav.includes(item), `the menu has ${item}`);
  }
  // Clicking a row (and Inspect) opens the inspector through the dispatched seam.
  assert.match(nav, /requestViewInspect\(v\.id\)/, "the row opens the inspector by view id");
  // "Ask about this view" reuses the existing ask seam (boards/widget hand-off).
  assert.match(
    nav,
    /new CustomEvent\("lighthouse:ask-question", \{ detail: \{ question: `Show me the \$\{v\.name\} view\.` \} \}\)/,
    "Ask reuses lighthouse:ask-question with a view-name starter",
  );
  // "New view" opens the already-built shaping dialog (the nav never shapes).
  assert.match(nav, /<ShapeViewDialog\s+open=\{shapeOpen\}/, "New view opens ShapeViewDialog");
});

test("ViewsNav (Library) sits above Investigations in the section registry", () => {
  // Sectioned sidebar (openspec: field-patch-0.12.5 §1): the sections live in the
  // registry now; the Files tree is the sidebar's top anchor.
  assert.match(registry, /import \{ ViewsNav \} from "@\/features\/views\/ViewsNav";/);
  // Library carries the "library" id and renders ViewsNav, above Investigations.
  assert.match(registry, /id: "library"[\s\S]*Component: ViewsNav/, "Library maps to ViewsNav");
  assert.match(registry, /Component: RecipesNav[\s\S]*Component: ViewsNav[\s\S]*Component: InvestigationsNav/, "Recipes → Library → Investigations");
  assert.match(page, /sidebar=\{<FileExplorer \/>\}/, "the file tree anchors the sidebar");
  assert.doesNotMatch(page, /<ViewsNav \/>/, "the section moved to the rail registry");
});

test("the local-only badge is sourced lazily from inspectView and cached", () => {
  assert.match(store, /\.inspectView\(id\)/, "the store hydrates local-only per id");
  assert.match(store, /localOnlyById/, "…into a cache keyed by view id");
  assert.match(nav, /localOnlyById\[v\.id\] === true/, "the row shows the lock from the cache");
  assert.match(nav, /Private — this device only/, "the lock uses the file-inspector language");
});

// --- View inspector: definition, labeled summary, sources, local-only, dependents ----

test("ViewInspector renders the definition SQL and the provenance-labeled summary", () => {
  assert.match(inspector, /inspectView\(viewId\)/, "it reads the inspection by id");
  assert.match(
    inspector,
    /<pre className=\{styles\.sql\}>\{data\.sql \?\? ""\}<\/pre>/,
    "the exact SELECT renders in a code block",
  );
  // Both provenance labels — a view never carries an unlabeled summary.
  assert.ok(inspector.includes("from your question"), "question-derived label");
  assert.ok(inspector.includes("described by the model"), "model-stated label");
  assert.match(inspector, /provenanceLabel\(data\.summarySource\)/, "the label is chosen by source");
});

test("ViewInspector renders sources with freshness, missing sources, views, dependents", () => {
  assert.match(inspector, /saved \$\{s\.savedAge\}/, "each source shows its saved-age freshness");
  assert.ok(inspector.includes("(no longer in the vault)"), "a missing source is honest, not dropped");
  // Builds-on (readsViews) and Used-by (dependents) notes.
  assert.ok(inspector.includes("Builds on"), "views it reads are shown");
  assert.match(inspector, /readsViews\.join\(", "\)/);
  assert.ok(inspector.includes("Used by"), "dependents note");
  assert.match(inspector, /dependents\.join\(", "\)/);
});

test("ViewInspector shows the local-only badge + explanation, and is read-only", () => {
  assert.match(inspector, /data\?\.localOnly === true/, "the effective-local-only flag drives the badge");
  assert.ok(
    inspector.includes("marked private, so it is never sent to a cloud"),
    "the one-line local-only explanation is present",
  );
  // Read-only: the inspector never mutates and never calls the model.
  for (const forbidden of [/ragService\.createView/, /ragService\.renameView/, /ragService\.deleteView/, /ragService\.shapeView/, /chatService/]) {
    assert.doesNotMatch(inspector, forbidden, "the inspector only reads inspectView");
  }
});

// --- Lifecycle: rename refusal verbatim + the two-step delete -------------------------

test("rename calls renameView and surfaces the engine's refusal verbatim", () => {
  assert.match(nav, /ragService\.renameView\(rename\.id, name\)/, "rename goes through the contract");
  assert.match(
    nav,
    /error: err instanceof Error \? err\.message : "the view could not be renamed"/,
    "the engine's message (which names dependents) is kept verbatim",
  );
  assert.match(nav, /\{rename\.error\}/, "…and rendered in the dialog");
  // The UI trims and nothing more — the engine owns the rule.
  assert.match(nav, /const name = rename\.name\.trim\(\)/);
});

test("delete is the two-step lifecycle: dependents first, cascade only on the explicit confirm", () => {
  // Step one always asks the engine what depends on it.
  assert.match(nav, /ragService\.viewDependents\(v\.id\)/, "openDelete reads the dependent list first");
  // Cascade is derived from the transitive list, and only sent on confirm.
  assert.match(nav, /const cascade = del\.transitive\.length > 0;/);
  assert.match(nav, /ragService\.deleteView\(del\.id, cascade\)/, "delete sends the derived cascade");
  // The with-dependents confirmation SHOWS the transitive list + a "Delete all N".
  assert.match(nav, /del\?\.transitive\.join\(", "\)/, "the transitive names are shown");
  assert.match(nav, /Delete all \$\{\(del\?\.transitive\.length \?\? 0\) \+ 1\}/, "an explicit Delete all N");
  // Source-untouched copy on BOTH branches.
  assert.ok(nav.includes("This never touches your source files."), "plain confirm: sources untouched");
  assert.ok(nav.includes("source files are never touched"), "cascade confirm: sources untouched");
  // Cancel persists nothing (no deleteView on the cancel path) and closes both.
  assert.match(nav, /onClick=\{\(\) => setDel\(null\)\}/, "Cancel just closes the delete dialog");
  // A deleted id closes an inspector open on it.
  assert.match(nav, /deletedSet\.has\(inspectId\)\) setInspectId\(null\)/);
});

test("the nav itself never calls the model or the shaping op (only the dialog it hosts does)", () => {
  assert.doesNotMatch(nav, /chatService/, "the nav never consults the model");
  assert.doesNotMatch(nav, /ragService\.shapeView/, "the nav never calls shapeView — the dialog owns that");
});
