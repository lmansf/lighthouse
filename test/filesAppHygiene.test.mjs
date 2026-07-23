/**
 * §41 §3 — Files-app hygiene: the engine's `.rag-vault` directory is an
 * implementation detail, and on iOS it no longer even lives beside the user's
 * documents (it moved to Application Support). No UI surface may point a user
 * at it:
 *
 *  - On iOS the Files app hides dotfolders, so "restore later from
 *    .rag-vault/trash" was ALREADY a dead end there — and after §41 the folder
 *    isn't under Documents at all.
 *  - On desktop the trash concept stays ("moved to the vault's trash"), but
 *    the literal dotpath is an internal name the UI must not teach.
 *
 * The engine tier (src/server/, the TS twin) may reference the path freely —
 * it OWNS it. This pin covers the tiers a user reads: features, stores, shell,
 * contracts, lib, and the app/ pages.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** UI tiers a user-facing string could live in. src/server is the engine's. */
const UI_DIRS = ["src/features", "src/stores", "src/shell", "src/contracts", "src/lib", "app"];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(name)) yield p;
  }
}

const isCommentLine = (line) => {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
};

test("no UI surface names .rag-vault outside code comments", () => {
  const offenders = [];
  for (const dir of UI_DIRS) {
    for (const file of walk(path.join(ROOT, dir))) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (line.includes(".rag-vault") && !isCommentLine(line)) {
          offenders.push(`${path.relative(ROOT, file)}:${i + 1}`);
        }
      });
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "user-visible strings must describe the concept (the vault's trash, the index) — never the internal dotpath",
  );
});

test("the remove dialog keeps its safety story without the internal path", () => {
  const explorer = readFileSync(
    path.join(ROOT, "src/features/explorer/FileExplorer.tsx"),
    "utf8",
  );
  // The reassurance the dialog exists to give:
  assert.match(explorer, /moved to the vault's trash and dropped from the index/);
  assert.match(
    explorer,
    /your real files stay where they are/,
    "linked items' files are never touched — the dialog must keep saying so",
  );
  // Undo is the restore affordance the app actually offers everywhere:
  assert.match(explorer, /You can Undo right after\./);
  // The dead end it must never re-teach (dotfolders are invisible in the
  // iOS Files app, and §41 moved the folder out of Documents entirely).
  // Comments may still name the path — rendered strings may not:
  const rendered = explorer
    .split("\n")
    .filter((l) => l.includes(".rag-vault/trash") && !isCommentLine(l));
  assert.deepEqual(rendered, [], "the dialog must not send users to .rag-vault/trash");
});
