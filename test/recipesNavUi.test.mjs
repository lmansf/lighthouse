// Recipes surface (openspec: add-recipes §3.1) — the Library-sibling Recipes
// gallery + the chat empty-state recipe chips. The contracts mock is imported
// and exercised for real (the offline list the nav/chips drive:
// applicableRecipes over an included tabular file vs nothing), and the
// run-recipe seam (RECIPE_CUE_PREFIX / runRecipeQuestion) is pinned. The JSX
// surfaces (RecipesNav, ChatPanel) can't load in node, so their guarantees are
// asserted structurally against the source — the viewsNavUi/boardsUi house
// style. Live behavior is the E2E pass (§5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { ragService } = await import("../src/contracts/mocks/rag.mock.ts");
const { RECIPE_CUE_PREFIX, runRecipeQuestion } = await import("../src/contracts/types.ts");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const nav = read("src/features/recipes/RecipesNav.tsx");
const page = read("app/page.tsx");
const registry = read("src/shell/sidebarSections.tsx");
const chat = read("src/features/chat/ChatPanel.tsx");

// --- The run-recipe seam: the EXISTING ask event carries a recipe cue --------

test("runRecipeQuestion builds the recipe cue the engine parses before the model gate", () => {
  assert.equal(RECIPE_CUE_PREFIX, "run-recipe:");
  assert.equal(
    runRecipeQuestion("variance-vs-last-period", "sales.csv"),
    "run-recipe:variance-vs-last-period on sales.csv",
  );
});

// --- Mock contract the nav + chips lean on -----------------------------------

test("applicableRecipes returns [] with no included tabular file (twin/empty honesty)", async () => {
  assert.deepEqual(await ragService.applicableRecipes([]), []);
});

test("applicableRecipes returns a file-derived subset for an included tabular file", async () => {
  // Add a tabular node so the mock's file-derived subset has something to
  // resolve against, then pass its id as the included set.
  const { id } = await ragService.addReference("/data/sales.csv");
  const cards = await ragService.applicableRecipes([id]);
  assert.ok(cards.length >= 1, "at least one recipe applies to a tabular file");
  for (const c of cards) {
    assert.equal(typeof c.id, "string");
    assert.equal(typeof c.name, "string");
    assert.equal(typeof c.summary, "string");
    assert.equal(c.table, "sales.csv", "each card names the file it runs on");
  }
  // The data-quality audit needs nothing, so it always applies.
  assert.ok(cards.some((c) => c.id === "data-quality-audit"), "the always-applicable audit is offered");
  await ragService.removeReference(id);
});

// --- Recipes gallery: list, run seam, empty state, mount ---------------------

test("RecipesNav lists applicableRecipes with a 'runnable on {table}' line", () => {
  assert.match(nav, /aria-label="Recipes"/, "the section is a titled nav (accessible)");
  assert.match(nav, /useRagStore/, "it subscribes the shared vault session store");
  assert.match(nav, /\.applicableRecipes\(includedKey\.split\("\\n"\)\)/, "the list comes from the engine");
  assert.match(nav, /recipes\.map\(/, "one row per applicable recipe");
  assert.match(nav, /runnable on \{r\.table\}/, "the subdued line names the table it runs on");
});

test("clicking a RecipesNav row runs the recipe through the EXISTING ask seam", () => {
  // No new event and no new op — the ViewsNav askAbout idiom, recipe-cued.
  assert.match(
    nav,
    /new CustomEvent\("lighthouse:ask-question", \{\s*detail: \{ question: runRecipeQuestion\(r\.id, r\.table\) \}/,
    "the row dispatches lighthouse:ask-question with the recipe-cued question",
  );
  assert.doesNotMatch(nav, /lighthouse:run-recipe/, "no bespoke run-recipe event is invented");
});

test("RecipesNav refreshes when the included set changes and on views-changed", () => {
  // The included set is the primary applicability signal (keyed by value to
  // skip the vault poll's no-op rebuilds), plus the ViewsNav refresh seam.
  assert.match(nav, /includedFileIds\.join\("\\n"\)/, "keyed by the included-file VALUE, not identity");
  assert.match(nav, /\[includedKey, viewsNonce\]/, "the fetch re-arms on the included set + views-changed");
  assert.match(nav, /addEventListener\("lighthouse:views-changed"/, "a saved view can add/drop a recipe");
});

test("RecipesNav renders the honest empty state and never crashes on []", () => {
  assert.match(nav, /loaded && recipes\.length === 0/, "the empty state is gated on a completed load");
  assert.ok(
    nav.includes("Recipes appear here when your files have the right columns"),
    "quiet empty-state copy in the ViewsNav register",
  );
});

test("RecipesNav sits between Capabilities and Library in the section registry", () => {
  // Sectioned sidebar (openspec: field-patch-0.12.5 §1): the sections live in the
  // registry now, not stacked in app/page.tsx.
  assert.match(registry, /import \{ RecipesNav \} from "@\/features\/recipes\/RecipesNav";/);
  assert.match(registry, /Component: CapabilityNav[\s\S]*Component: RecipesNav[\s\S]*Component: ViewsNav/, "Recipes sits between Capabilities and Library");
  // Library (ViewsNav) still leads Investigations, which is now last in the rail.
  assert.match(registry, /Component: ViewsNav[\s\S]*Component: InvestigationsNav/);
  // The Files tree anchors the sidebar; the sections are no longer in page.
  assert.match(page, /sidebar=\{<FileExplorer \/>\}/, "the file tree anchors the sidebar");
  assert.doesNotMatch(page, /<RecipesNav \/>/, "the section moved to the rail registry");
});

// --- Chat empty-state recipe chips -------------------------------------------

test("ChatPanel fetches applicable recipes for the empty state, same lifecycle as suggestedAsks", () => {
  assert.match(chat, /const \[recipeChips, setRecipeChips\]/, "empty-state recipe chips are state");
  assert.match(chat, /\.applicableRecipes\(includedKey\.split\("\\n"\)\)/, "keyed on the included set");
  assert.match(chat, /\}, \[emptyState, includedKey\]\);/, "gated to the empty state like engineAsks");
});

test("a recipe chip submits its recipe-cued question through the sendQuestion seam", () => {
  assert.match(
    chat,
    /onClick=\{\(\) => void sendQuestion\(runRecipeQuestion\(r\.id, r\.table\)\)\}/,
    "the chip runs the recipe via the same sendQuestion the suggested-ask chips use",
  );
  // Same chip styling as the suggested asks (secondary / small / circular).
  assert.match(chat, /key=\{`recipe:\$\{r\.id\}:\$\{r\.table\}`\}/, "recipe chips render in the suggest row");
});
