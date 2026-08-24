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
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
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

// --- function-level resolution: a live module can still lose an item -------
//
// The module resolver above proves `lighthouse_shell::commands` exists. It does
// NOT prove `commands::add_paths` does — and 0.15.0 left exactly that behind:
// the vault-era copy-in/link-in-place door was deleted from the shell while the
// desktop crate kept wrapping it, so `lighthouse_shell::commands::add_paths`
// named a function that was gone. The module was alive, so nothing here caught
// it. This closes that gap by reading the ITEMS each engine module exports.

/** Public item names a module file exports — fns (incl. async/const/unsafe),
 *  types, consts, statics, macros, and anything re-exported by `pub use`. */
function itemsOf(crate, mod) {
  const src = path.join(NATIVE, crate, "src");
  const candidates = [path.join(src, `${mod}.rs`), path.join(src, mod, "mod.rs")];
  const file = candidates.find((c) => existsSync(c));
  if (!file) return null;
  const text = readFileSync(file, "utf8");
  const items = new Set();
  const decl =
    /^\s*pub(?:\([^)]*\))?\s+(?:(?:async|unsafe|const|extern\s+"[^"]*")\s+)*(?:fn|struct|enum|trait|type|const|static|mod|union)\s+([A-Za-z_][A-Za-z_0-9]*)/gm;
  for (const m of text.matchAll(decl)) items.add(m[1]);
  for (const m of text.matchAll(/^\s*pub use\s+([^;]+);/gm)) {
    for (const raw of m[1].replace(/[{}]/g, " ").split(",")) {
      const name = raw.trim().split("::").pop().split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z_][A-Za-z_0-9]*$/.test(name)) items.add(name);
    }
  }
  for (const m of text.matchAll(/^\s*#\[macro_export\][\s\S]*?macro_rules!\s+([A-Za-z_0-9]+)/gm)) {
    items.add(m[1]);
  }
  return items;
}

/** Every `<dep>::<mod>::<item>` a crate names. */
function referencedItems(crate, deps) {
  const src = path.join(NATIVE, crate, "src");
  const hits = new Map();
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p2 = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p2); continue; }
      if (!e.name.endsWith(".rs")) continue;
      const text = readFileSync(p2, "utf8");
      const rel = path.relative(ROOT, p2);
      for (const dep of deps) {
        const re = new RegExp(`\\b${dep}::([a-z_0-9]+)::([A-Za-z_][A-Za-z_0-9]*)`, "g");
        for (const m of text.matchAll(re)) hits.set(`${dep}::${m[1]}::${m[2]}`, rel);
      }
    }
  };
  walk(src);
  return hits;
}

/** Items a crate names that its dependency's module does not export. */
function danglingItems(crate, deps) {
  const out = [];
  for (const [full, where] of referencedItems(crate, deps)) {
    const [dep, mod, item] = full.split("::");
    const items = itemsOf(dep.replace(/_/g, "-"), mod);
    // An unknown MODULE is the other test's job; only judge live ones.
    if (items && !items.has(item)) out.push(`${full} (${where})`);
  }
  return out;
}

test("every engine ITEM the desktop crate names still exists", () => {
  const deps = ["lighthouse_core", "lighthouse_shell"];
  const referenced = referencedItems("lighthouse-desktop", deps);
  assert.ok(referenced.size > 20, `expected the desktop crate's engine calls, got ${referenced.size}`);
  assert.deepEqual(
    danglingItems("lighthouse-desktop", deps),
    [],
    "the desktop crate calls an engine item that no longer exists — it will not build",
  );
});

test("the item resolver agrees with rustc on a crate that DOES compile here", () => {
  // Anti-vacuity, same as the module resolver: lighthouse-server compiles in
  // this container, so a resolver that over-reports fails HERE, not silently.
  assert.deepEqual(
    danglingItems("lighthouse-server", ["lighthouse_core", "lighthouse_shell"]),
    [],
    "lighthouse-server compiles here, so this must be empty",
  );
});

// --- delimiter balance: the OTHER way the uncheckable crate breaks ----------
//
// The resolver above catches a call into a module that no longer exists. It
// cannot catch a SYNTAX break, and 0.15.0 produced one: deleting the launch
// watcher out of `lib.rs`'s `.setup(|app| { … })` left the deleted block's
// `});` and `}` behind, so the crate stopped parsing entirely. Nothing in this
// container noticed — `lighthouse-desktop` needs webkit/gtk to `cargo check`,
// and CI's android-portability job (`cargo check --target aarch64-linux-android
// -p lighthouse-desktop --lib`) is the first place it compiles.
//
// A full parser is overkill; unbalanced (), [] and {} is what an edit-deletion
// actually leaves behind, and that IS checkable from here. The scanner below
// walks Rust's literal forms so it never miscounts a delimiter inside one:
// line + (nesting) block comments, strings with escapes, raw/byte strings with
// their `#` hash counts, char literals, and lifetimes — `'a` looks exactly like
// an unterminated char literal and must not be read as one.

/** Newlines only, so a skipped span keeps the file's line numbering intact. */
function newlinesIn(src, from, to) {
  let out = "";
  for (let k = from; k < to && k < src.length; k++) if (src[k] === "\n") out += "\n";
  return out;
}

/** Strip comments and literals, leaving only code that can carry delimiters. */
function stripRustLiterals(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    if (c === "/" && c2 === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue; // the newline itself is left for the default arm to copy
    }
    if (c === "/" && c2 === "*") {
      let depth = 1;
      const from = i;
      i += 2;
      while (i < n && depth > 0) {
        if (src[i] === "/" && src[i + 1] === "*") { depth++; i += 2; }
        else if (src[i] === "*" && src[i + 1] === "/") { depth--; i += 2; }
        else i++;
      }
      out += newlinesIn(src, from, i);
      continue;
    }

    // Raw / byte strings: r"…", r#"…"#, br##"…"##, b"…"
    const raw = /^(b?r)(#*)"/.exec(src.slice(i, i + 16));
    if (raw) {
      const close = `"${raw[2]}`;
      const end = src.indexOf(close, i + raw[0].length);
      const from = i;
      i = end === -1 ? n : end + close.length;
      out += newlinesIn(src, from, i);
      continue;
    }
    if (c === "b" && c2 === '"') { i++; continue; } // fall through to the string arm

    if (c === '"') {
      const from = i;
      i++;
      while (i < n && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
      i++;
      out += newlinesIn(src, from, i);
      continue;
    }

    if (c === "'") {
      // A lifetime (`'a`, `'static`) vs a char literal (`'a'`, `'\n'`, `'\u{7}'`).
      const rest = src.slice(i, i + 12);
      const ch = /^'(\\(x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]{1,6}\}|.)|[^'\\])'/.exec(rest);
      if (ch) { i += ch[0].length; continue; }
      i++; // a lifetime tick carries no delimiter
      continue;
    }

    out += c;
    i++;
  }
  return out;
}

/** First unbalanced delimiter in `src`, or null. Reports a 1-indexed line. */
function delimiterFault(src) {
  const code = stripRustLiterals(src);
  const pairs = { ")": "(", "]": "[", "}": "{" };
  const stack = [];
  let line = 1;
  for (const ch of code) {
    if (ch === "\n") { line++; continue; }
    if (ch === "(" || ch === "[" || ch === "{") stack.push({ ch, line });
    else if (ch in pairs) {
      const top = stack.pop();
      if (!top) return `unexpected closing '${ch}' at line ${line}`;
      if (top.ch !== pairs[ch]) {
        return `'${top.ch}' opened at line ${top.line} closed by '${ch}' at line ${line}`;
      }
    }
  }
  if (stack.length) {
    const { ch, line: l } = stack[stack.length - 1];
    return `'${ch}' opened at line ${l} is never closed`;
  }
  return null;
}

const rustFilesUnder = (rel) => {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".rs")) out.push(path.relative(ROOT, full));
    }
  };
  walk(path.join(ROOT, rel));
  return out;
};

test("every .rs file in the uncheckable desktop crate has balanced delimiters", () => {
  const files = rustFilesUnder("native/crates/lighthouse-desktop/src");
  assert.ok(files.length >= 3, `expected the desktop crate's sources, got ${files.length}`);

  const faults = files
    .map((f) => [f, delimiterFault(readFileSync(path.join(ROOT, f), "utf8"))])
    .filter(([, fault]) => fault)
    .map(([f, fault]) => `${f}: ${fault}`);

  assert.deepEqual(
    faults,
    [],
    "the desktop crate does not parse — it cannot compile here, so this is the only local signal",
  );
});

test("the delimiter scanner agrees with rustc on crates that DO compile here", () => {
  // Same anti-vacuity rule as the resolver: run it over sources rustc has
  // already accepted. A scanner that mis-reads a lifetime, a raw string or a
  // nested block comment fails HERE rather than going quietly green above.
  const faults = [];
  for (const crate of ["lighthouse-core", "lighthouse-shell", "lighthouse-server"]) {
    for (const f of rustFilesUnder(`native/crates/${crate}/src`)) {
      const fault = delimiterFault(readFileSync(path.join(ROOT, f), "utf8"));
      if (fault) faults.push(`${f}: ${fault}`);
    }
  }
  assert.deepEqual(faults, [], "these crates compile, so the scanner must find nothing");
});
