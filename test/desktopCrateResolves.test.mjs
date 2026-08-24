/**
 * The grep-verify blind spot, made mechanical.
 *
 * `lighthouse-desktop` does NOT compile in the dev container (no webkit/gtk),
 * so `cargo check` never sees it and every other suite is blind to it. CLAUDE.md
 * says to grep its call sites by hand when a shared engine signature changes —
 * which is exactly what failed during the 0.15.0 deletions: `chat_ask` kept
 * calling `lighthouse_core::investigations::resolve_ask_context` for four
 * commits after that module was deleted, and nothing caught it until a manual
 * audit. `desktop-release.yml` would have.
 *
 * So: resolve every module the desktop crate names from those crates — both
 * qualified `lighthouse_core::<mod>::` paths AND the names inside a
 * `use lighthouse_core::{a, b, c};` list — against the modules those crates
 * actually declare. It is a coarse check — module-level, not item-level — but
 * it catches the whole class of "deleted a module, left a caller behind", which
 * is the one that reached a release build.
 *
 * The use-list half was added after the first version missed
 * `use lighthouse_core::{local_model, profile, settings, vault};` four commits
 * into the vault deletion: qualified paths were all clean, and the import alone
 * would still have failed the release build.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NATIVE = path.join(ROOT, "native", "crates");

/** Every name reachable as `<crate>::<name>`: the `pub mod x;` declarations,
 *  the src/x.rs files, and the crate root's own public items (a `use
 *  lighthouse_shell::open_with_os;` names a fn, not a module — both forms are
 *  legitimate, and both break the same way when the target is deleted). */
function modulesOf(crate) {
  const src = path.join(NATIVE, crate, "src");
  const lib = path.join(src, "lib.rs");
  const declared = new Set();
  if (existsSync(lib)) {
    const text = readFileSync(lib, "utf8");
    for (const m of text.matchAll(/^\s*pub mod ([a-z_0-9]+)\s*;/gm)) declared.add(m[1]);
    const item = /^\s*pub (?:(?:async|unsafe|const)\s+)*(?:fn|struct|enum|trait|type|const|static)\s+([A-Za-z_0-9]+)/gm;
    for (const m of text.matchAll(item)) declared.add(m[1]);
  }
  // A `pub mod` can also be a directory module (src/x/mod.rs) — both count.
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith(".rs") && e.name !== "lib.rs" && e.name !== "main.rs") {
      declared.add(e.name.replace(/\.rs$/, ""));
    }
  }
  return declared;
}

/** Every module of `deps` named anywhere under a crate's src/ — as a qualified
 *  `<crate>::<mod>::` path, or as a name inside `use <crate>::{a, b};`. */
function referencedPaths(crate, deps) {
  const src = path.join(NATIVE, crate, "src");
  const hits = new Map(); // "dep::mod" -> file it appeared in
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.name.endsWith(".rs")) {
        const text = readFileSync(p, "utf8");
        const rel = path.relative(ROOT, p);
        for (const dep of deps) {
          for (const m of text.matchAll(new RegExp(`\\b${dep}::([a-z_0-9]+)::`, "g"))) {
            hits.set(`${dep}::${m[1]}`, rel);
          }
          // `use lighthouse_core::{local_model, profile, vault};` — a braced
          // import list of MODULE names, which never carries a `::` suffix.
          for (const m of text.matchAll(new RegExp(`use ${dep}::\\{([^}]*)\\}`, "g"))) {
            for (const raw of m[1].split(",")) {
              const name = raw.trim().split(/\s/)[0];
              if (/^[a-z_][a-z_0-9]*$/.test(name)) hits.set(`${dep}::${name}`, rel);
            }
          }
          // `use lighthouse_core::vault;` — a single un-braced module import.
          for (const m of text.matchAll(new RegExp(`use ${dep}::([a-z_][a-z_0-9]*)\\s*;`, "g"))) {
            hits.set(`${dep}::${m[1]}`, rel);
          }
        }
      }
    }
  };
  walk(src);
  return hits;
}

test("every engine module the desktop crate names still exists", () => {
  const known = {
    lighthouse_core: modulesOf("lighthouse-core"),
    lighthouse_shell: modulesOf("lighthouse-shell"),
  };
  // Sanity: the reader works at all. If these ever come back empty the test
  // would pass vacuously, which is worse than failing.
  assert.ok(known.lighthouse_core.size > 10, "lighthouse-core modules were read");
  assert.ok(known.lighthouse_shell.size > 0, "lighthouse-shell modules were read");

  const referenced = referencedPaths("lighthouse-desktop", Object.keys(known));
  assert.ok(referenced.size > 5, "the desktop crate's engine calls were read");

  const dangling = [];
  for (const [full, where] of referenced) {
    const [dep, mod] = full.split("::");
    if (!known[dep].has(mod)) dangling.push(`${full} (${where})`);
  }
  assert.deepEqual(
    dangling,
    [],
    "the desktop crate calls into engine modules that no longer exist — it will not build",
  );
});

test("the same check covers the other crates the container cannot fully verify", () => {
  // lighthouse-desktop is the only crate excluded from `cargo check` here, but
  // running the resolver over a crate that DOES compile proves the resolver
  // itself agrees with rustc rather than being permanently, silently green.
  const known = { lighthouse_core: modulesOf("lighthouse-core") };
  const referenced = referencedPaths("lighthouse-server", ["lighthouse_core"]);
  const dangling = [...referenced]
    .filter(([full]) => !known.lighthouse_core.has(full.split("::")[1]))
    .map(([full, where]) => `${full} (${where})`);
  assert.deepEqual(dangling, [], "lighthouse-server compiles here, so this must be empty");
});
