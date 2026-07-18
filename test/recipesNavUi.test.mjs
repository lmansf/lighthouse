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

test("RecipesNav lists the engine's applicable recipes with a 'runnable on {table}' line", () => {
  assert.match(nav, /aria-label="Recipes"/, "the section is a titled nav (accessible)");
  assert.match(nav, /useRagStore/, "it subscribes the shared vault session store");
  // §22.3: the fetch moved into the SHARED useValidatedChips hook (one
  // preloaded cache with the chat's empty-state chips); the engine op is
  // called there, and the nav only consumes it.
  assert.match(nav, /useValidatedChips\(includedFileIds\)/, "the list comes through the shared hook");
  assert.match(
    read("src/features/chat/useValidatedChips.ts"),
    /ragService\.applicableRecipes\(includedFileIds\)/,
    "…which calls the engine's applicableRecipes",
  );
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
  // §22.3: both signals live in the shared hook now — the included set is
  // folded by VALUE into the cache key (so the vault poll's no-op `nodes`
  // rebuilds cost nothing), and the views-changed listener bumps its nonce.
  const hook = read("src/features/chat/useValidatedChips.ts");
  // (Separator-agnostic on purpose: the hook's key joins the ids with a
  // non-printing sentinel byte that can't appear in an id.)
  assert.match(
    hook,
    /const key = `\$\{includedFileIds\.join\(/,
    "keyed by the included-file VALUE, not identity",
  );
  assert.match(hook, /addEventListener\("lighthouse:views-changed"/, "a saved view can add/drop a recipe");
  assert.match(nav, /useValidatedChips\(includedFileIds\)/, "the nav rides those signals via the hook");
});

test("RecipesNav renders the honest empty state and never crashes on []", () => {
  // §22.3: the hook serves its module cache instantly and revalidates behind
  // it, exposing no in-flight flag — so the note gates on the list alone. Its
  // copy is forward-looking either way ("appear here when…"), and a
  // first-visit revalidation replaces it as soon as recipes land.
  assert.match(nav, /recipes\.length === 0/, "the empty note renders only with no recipes");
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

test("ChatPanel sources its empty-state recipe chips from the shared validated hook", () => {
  // §22.3: the two per-surface fetch effects are gone — one hook (shared
  // module cache with RecipesNav) feeds asks AND recipes, re-keyed on the
  // included set / provider / investigation / views nonce, so a posture flip
  // can never serve stale chips. The hero keeps its old visual caps.
  assert.match(chat, /const validatedChips = useValidatedChips\(includedFileIds\);/);
  assert.match(chat, /validatedChips\.recipes\.slice\(0, 3\)/, "recipes keep the 3-chip hero cap");
  assert.match(chat, /validatedChips\.asks\.slice\(0, 4\)/, "asks keep the 4-chip hero cap");
  assert.doesNotMatch(
    chat,
    /ragService\s*\n?\s*\.applicableRecipes|ragService\s*\n?\s*\.suggestedAsks/,
    "no separate ChatPanel fetch remains — the hook is the one source",
  );
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
