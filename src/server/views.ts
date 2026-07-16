/**
 * Shaped views, TS twin (openspec: add-shaped-views). KEEP IN SYNC with
 * native views.rs: same record shape (camelCase on the wire: {id, name, sql,
 * reads {files [{fileId, tableName}], views [id]}, summary {text, source},
 * createdMs}), same versioned envelope `{v: 1, views: [...]}` written with
 * the shared atomic writer, same validation and error strings (name
 * sanitization with the table-name character rules, 64-char cap, reserved
 * keywords, case-insensitive uniqueness among views, no shadowing of a
 * current file table), same id minting, and the same DAG (cycle +
 * MAX_VIEW_DEPTH) and lifecycle (dependent-refusal + cascade) rules.
 *
 * Versioning posture (user data, not a cache): `v == 1` loads; an unknown or
 * missing version — or unparseable JSON — loads EMPTY for the session, and
 * the first subsequent write renames the unreadable file to
 * `views.json.bak-<epochms>` before writing a fresh v1 envelope. Nothing is
 * silently clobbered.
 *
 * PARITY (both divergences deliberate — analytics/DataFusion is Rust-engine-
 * only and this twin never executes SQL):
 *   - The definition guard is a conservative TEXTUAL single-SELECT check
 *     (guardViewSql) — `guard_sql`'s real parser is Rust-only, and the
 *     desktop re-guards before every execution regardless, so a definition
 *     this twin lets through still cannot execute unguarded anywhere.
 *   - Reads derivation is a FROM/JOIN identifier scan (collectTableNames)
 *     rather than an AST walk; the authoritative derivation is the Rust
 *     parser. The scan is conservative: what it can't resolve refuses the
 *     save, and an over-collected identifier (e.g. `EXTRACT(x FROM col)`)
 *     refuses rather than saving an unsound record.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { stateDir, writeJson } from "./config";
import { activeIncludedFileIds, listNodes } from "./vault";

/** Envelope version this engine reads and writes. */
const STORE_VERSION = 1;

/**
 * Depth cap for view-over-view stacking: a view over only files has depth 1;
 * referencing a view of depth d makes depth d+1. A definition whose depth
 * would EXCEED this is refused at save. KEEP IN SYNC with
 * views.rs::MAX_VIEW_DEPTH.
 */
export const MAX_VIEW_DEPTH = 3;

/** Names a view can never take (design.md "Names"). */
const RESERVED_NAMES = new Set([
  "select", "from", "where", "join", "group", "order", "by", "with", "union",
  "all", "as", "on", "limit", "table", "values",
]);

/** Where the one-line summary came from — the whole whitelist. */
export type ViewSummarySource = "question" | "model";

/** The provenance-labeled one-line summary a view card carries. */
export interface ViewSummary {
  text: string;
  source: ViewSummarySource;
}

/**
 * One source-file dependency with its name binding pinned at save: the table
 * name the definition's SQL uses for this file.
 */
export interface ViewFileRead {
  fileId: string;
  tableName: string;
}

/** Dependencies resolved at save, stored. */
export interface ViewReads {
  files: ViewFileRead[];
  views: string[];
}

export interface View {
  /**
   * Engine-minted, stable: `view-` + first 12 hex chars of
   * sha1(name \n sql \n createdMs) — see viewId. NOT derived from the
   * current name — rename keeps the id, so dependents' stored reads stay
   * valid forever.
   */
  id: string;
  /** Sanitized identifier, unique case-insensitively among views. */
  name: string;
  /** Exactly ONE read-only SELECT (guarded at save; desktop re-guards). */
  sql: string;
  /** Dependencies resolved at save. */
  reads: ViewReads;
  /** Provenance-labeled one-liner (question-derived or model-stated). */
  summary: ViewSummary;
  /** Creation instant (epoch ms). */
  createdMs: number;
}

/** A resolved source file handed to createViewWithTables: id + display name. */
export interface ViewSourceFile {
  fileId: string;
  name: string;
}

function viewsPath(): string {
  return path.join(stateDir(), "views.json");
}

/**
 * A readable v1 envelope's records, or `null` when the text is not one
 * (unknown/missing version, or unparseable JSON — the two read identically).
 * PARITY: this twin trusts the records array wholesale once the envelope
 * checks pass; the Rust engine's serde also rejects records with malformed
 * required fields — engine-written files always carry every field, so the
 * twins agree on every file they write.
 */
function parseStore(text: string): View[] | null {
  try {
    const parsed = JSON.parse(text) as { v?: unknown; views?: unknown } | null;
    if (parsed && parsed.v === STORE_VERSION && Array.isArray(parsed.views)) {
      return parsed.views as View[];
    }
  } catch {
    /* fall through — unparseable is unreadable */
  }
  return null;
}

type Loaded =
  | { kind: "records"; records: View[] }
  | { kind: "missing" }
  // Present but not a readable v1 envelope — reads empty for the session;
  // the next write baks the file first (never clobber silently).
  | { kind: "unreadable" };

function load(): Loaded {
  let text: string;
  try {
    text = fs.readFileSync(viewsPath(), "utf8");
  } catch {
    return { kind: "missing" };
  }
  const records = parseStore(text);
  return records ? { kind: "records", records } : { kind: "unreadable" };
}

/**
 * All saved views, creation order. A missing store reads empty; an
 * unreadable one reads empty FOR THE SESSION (see save's bak-on-write).
 */
export function listViews(): View[] {
  const loaded = load();
  return loaded.kind === "records" ? loaded.records.map(cloneView) : [];
}

function save(records: View[]): void {
  const target = viewsPath();
  // Versioning posture: an unreadable file (unknown/missing version, corrupt
  // JSON) is preserved as a `.bak-<epochms>` sibling before the fresh v1
  // write — a downgrade or corruption never silently clobbers newer data.
  // Rename, falling back to copy, both best-effort (mirrors views.rs).
  if (load().kind === "unreadable") {
    const bak = `${target}.bak-${Date.now()}`;
    try {
      fs.renameSync(target, bak);
    } catch {
      try {
        fs.copyFileSync(target, bak);
      } catch {
        /* best-effort — the write below still lands */
      }
    }
  }
  writeJson(target, { v: STORE_VERSION, views: records });
}

function cloneView(v: View): View {
  return {
    ...v,
    reads: {
      files: v.reads.files.map((f) => ({ ...f })),
      views: [...v.reads.views],
    },
    summary: { ...v.summary },
  };
}

/**
 * Stable engine-minted id: `view-` + first 12 hex chars of
 * sha1(name \n sql \n createdMs). KEEP IN SYNC with views.rs::view_id.
 */
function viewId(name: string, sql: string, createdMs: number): string {
  return `view-${crypto
    .createHash("sha1")
    .update(`${name}\n${sql}\n${createdMs}`)
    .digest("hex")
    .slice(0, 12)}`;
}

/**
 * Lowercased stem, non-alphanumerics folded to `_`, digit-safe: the SQL
 * table name a vault file registers under. KEEP IN SYNC with
 * analytics.rs::sanitize_table_name (this twin has no analytics module; the
 * views name rules and reads replay need the exact naming pipeline).
 */
export function sanitizeTableName(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const stem = (dot >= 0 ? fileName.slice(0, dot) : fileName).toLowerCase();
  let out = "";
  let lastUs = true; // also trims leading underscores
  for (const ch of stem) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) {
      out += ch;
      lastUs = false;
    } else if (!lastUs) {
      out += "_";
      lastUs = true;
    }
  }
  out = out.replace(/_+$/, "");
  if (!out) out = "table";
  return /^[0-9]/.test(out) ? `t_${out}` : out;
}

/**
 * A table name not already in `used`: the base, else base_2, base_3, … until
 * free. KEEP IN SYNC with analytics.rs::unique_table_name.
 */
export function uniqueTableName(base: string, used: string[]): string {
  if (!used.includes(base)) return base;
  for (let n = 2; ; n++) {
    const cand = `${base}_${n}`;
    if (!used.includes(cand)) return cand;
  }
}

/**
 * Normalize a user-entered view name with the SAME character rules as
 * sanitizeTableName (lowercase, [a-z0-9_], separators collapsed, trimmed,
 * t_ prefix on a leading digit) — WITHOUT the file-stem extension strip
 * ("q3.totals" is a dotted name, not a file name) and WITHOUT the "table"
 * fallback: an empty result is returned empty and refused by the caller.
 * Capped at 64 chars. KEEP IN SYNC with views.rs::normalize_view_name.
 */
export function normalizeViewName(raw: string): string {
  const lower = raw.toLowerCase();
  let out = "";
  let lastUs = true;
  for (const ch of lower) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) {
      out += ch;
      lastUs = false;
    } else if (!lastUs) {
      out += "_";
      lastUs = true;
    }
  }
  out = out.replace(/_+$/, "");
  if (/^[0-9]/.test(out)) out = `t_${out}`;
  return out.slice(0, 64).replace(/_+$/, "");
}

// --- Textual guard + reads scan (PARITY: Rust parses, this twin scans) ------------

/**
 * Blank out single-quoted string literals ('' escapes), double-quoted
 * identifiers, `--` line comments, and block comments — every replaced char
 * becomes a space so positions stay aligned. Keeps the guard and the reads
 * scan from matching keywords inside literals.
 */
function scrubSqlText(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      out += " ";
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          out += "  ";
          i += 2;
          continue;
        }
        const closed = sql[i] === "'";
        out += " ";
        i++;
        if (closed) break;
      }
    } else if (ch === '"') {
      out += " ";
      i++;
      while (i < sql.length && sql[i] !== '"') {
        out += " ";
        i++;
      }
      if (i < sql.length) {
        out += " ";
        i++;
      }
    } else if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") {
        out += " ";
        i++;
      }
    } else if (ch === "/" && sql[i + 1] === "*") {
      out += "  ";
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) {
        out += " ";
        i++;
      }
      if (i < sql.length) {
        out += "  ";
        i += 2;
      }
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** Statement kinds that write — word-boundary matched outside literals. */
const FORBIDDEN_WORDS =
  /\b(insert|update|delete|create|drop|alter|attach|copy|merge|truncate|replace|grant|set)\b/i;

/**
 * The twin's definition guard: `null` when the text looks like exactly one
 * read-only SELECT, else the refusal reason (error strings byte-identical to
 * guard_sql's where the checks correspond).
 *
 * PARITY: `analytics::guard_sql`'s real parser is Rust-only and remains the
 * authority — the desktop re-guards before EVERY execution, so nothing this
 * textual check lets through can ever run unguarded. It is deliberately
 * conservative: a word-boundary hit on any writing keyword refuses even
 * where Rust would allow it (e.g. the REPLACE() scalar function).
 */
export function guardViewSql(sql: string): string | null {
  const text = scrubSqlText(sql);
  // Exactly one statement: a `;` may be followed only by more semicolons
  // and whitespace (a trailing terminator), never by further content.
  const semi = text.indexOf(";");
  if (semi !== -1 && text.slice(semi + 1).replace(/;/g, " ").trim()) {
    return "expected exactly one SQL statement";
  }
  const trimmed = text.trim();
  if (!trimmed) return "expected exactly one SQL statement";
  if (!/^(select|with)\b/i.test(trimmed)) return "only SELECT queries are allowed";
  if (FORBIDDEN_WORDS.test(text)) return "only read-only SELECT queries are allowed";
  return null;
}

/** Words that end a FROM list / can never be a bare table alias. */
const CLAUSE_STOPPERS = new Set([
  "where", "join", "inner", "left", "right", "full", "cross", "natural",
  "group", "order", "limit", "having", "union", "intersect", "except", "on",
  "using", "offset", "fetch", "window", "select", "from", "with", "as",
]);

/**
 * The table names a definition references, per the twin's conservative scan:
 * identifiers immediately following FROM and JOIN keywords (comma-separated
 * FROM lists included, optional `[AS] alias` skipped), excluding CTE aliases
 * collected by a `name AS (` scan, deduped case-insensitively in appearance
 * order. Parenthesized subqueries are not descended into here — their own
 * FROM/JOIN keywords match the same global scan.
 *
 * PARITY: the authoritative derivation is views.rs::collect_table_names
 * (sqlparser AST table factors); this scan can over-collect (`EXTRACT(x
 * FROM col)` yields `col`), which REFUSES a save rather than mis-recording
 * it, and under-collect quoted table names (`FROM "My Table"` — blanked as
 * a quoted identifier), which the Rust engine refuses instead.
 */
export function collectTableNames(sql: string): string[] {
  const text = scrubSqlText(sql);
  const ctes = new Set<string>();
  for (const m of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s+as\s*\(/gi)) {
    ctes.add(m[1].toLowerCase());
  }
  const names: string[] = [];
  const seen = new Set<string>();
  const skipWs = (at: number): number => {
    let i = at;
    while (i < text.length && /\s/.test(text[i])) i++;
    return i;
  };
  const readIdent = (at: number): { name: string; end: number } | null => {
    const m = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(text.slice(at));
    return m ? { name: m[0], end: at + m[0].length } : null;
  };
  for (const m of text.matchAll(/\b(from|join)\b/gi)) {
    const isFrom = m[1].toLowerCase() === "from";
    let i = (m.index ?? 0) + m[0].length;
    for (;;) {
      i = skipWs(i);
      if (text[i] === "(") break; // subquery — its internals match the outer scan
      const ident = readIdent(i);
      if (!ident) break;
      const lower = ident.name.toLowerCase();
      if (!ctes.has(lower) && !seen.has(lower)) {
        seen.add(lower);
        names.push(ident.name);
      }
      i = ident.end;
      if (!isFrom) break; // JOIN takes exactly one relation
      // Optional `[AS] alias`, then a comma continues the FROM list.
      i = skipWs(i);
      const after = readIdent(i);
      if (after && after.name.toLowerCase() === "as") {
        const alias = readIdent(skipWs(after.end));
        if (alias) i = alias.end;
      } else if (after && !CLAUSE_STOPPERS.has(after.name.toLowerCase()) && !after.name.includes(".")) {
        i = after.end; // bare alias
      }
      i = skipWs(i);
      if (text[i] !== ",") break;
      i++;
    }
  }
  return names;
}

// --- DAG checks (pure — KEEP IN SYNC with views.rs) --------------------------------

/**
 * Whether a NEW definition (`newId`, reading `readViewIds`) would create a
 * cycle. DFS from each dependency with an explicit path stack: reaching the
 * new view's own id, or revisiting a node already ON THE CURRENT PATH (a
 * back edge — only possible in a hand-crafted store), is a cycle; a node
 * reached twice via different paths (a diamond) is legal DAG shape. KEEP IN
 * SYNC with views.rs::would_cycle.
 */
export function wouldCycle(records: View[], newId: string, readViewIds: string[]): boolean {
  const done = new Set<string>();
  const visit = (id: string, pathStack: string[]): boolean => {
    if (id === newId) return true;
    if (pathStack.includes(id)) return true;
    if (done.has(id)) return false;
    const v = records.find((r) => r.id === id);
    if (!v) {
      done.add(id);
      return false;
    }
    pathStack.push(id);
    for (const dep of v.reads.views) {
      if (visit(dep, pathStack)) return true;
    }
    pathStack.pop();
    done.add(id);
    return false;
  };
  return readViewIds.some((dep) => visit(dep, []));
}

/**
 * The depth a NEW definition reading `readViewIds` would have: 1 when it
 * reads only files, else 1 + the deepest referenced view. Cycle-safe on
 * synthetic graphs (a revisit answers past the cap). KEEP IN SYNC with
 * views.rs::view_depth.
 */
export function viewDepth(records: View[], readViewIds: string[]): number {
  const depthOf = (id: string, pathStack: string[]): number => {
    if (pathStack.includes(id)) return MAX_VIEW_DEPTH + 1; // cyclic (synthetic)
    const v = records.find((r) => r.id === id);
    if (!v || v.reads.views.length === 0) return 1;
    pathStack.push(id);
    const d = 1 + Math.max(...v.reads.views.map((dep) => depthOf(dep, pathStack)));
    pathStack.pop();
    return d;
  };
  if (readViewIds.length === 0) return 1;
  return 1 + Math.max(...readViewIds.map((dep) => depthOf(dep, [])));
}

function dependentsIn(records: View[], id: string): View[] {
  return records.filter((r) => r.reads.views.includes(id));
}

function transitiveDependentsIn(records: View[], id: string): View[] {
  const inSet = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of records) {
      if (!inSet.has(r.id) && r.reads.views.some((v) => inSet.has(v))) {
        inSet.add(r.id);
        grew = true;
      }
    }
  }
  return records.filter((r) => r.id !== id && inSet.has(r.id));
}

/**
 * The saved views that DIRECTLY read `id` — what the rename refusal names
 * and the inspector lists. KEEP IN SYNC with views.rs::dependents_of.
 */
export function dependentsOf(id: string): View[] {
  return dependentsIn(listViews(), id);
}

/**
 * The saved views that TRANSITIVELY read `id` — what the delete refusal and
 * the cascade confirmation show. KEEP IN SYNC with
 * views.rs::transitive_dependents.
 */
export function transitiveDependents(id: string): View[] {
  return transitiveDependentsIn(listViews(), id);
}

// --- Vault lookups (createView's public entry fetches these) -----------------------

/** KEEP IN SYNC with analytics::is_tabular — the table-registration gate. */
const TABULAR_EXT = [".csv", ".tsv", ".parquet", ".xlsx", ".xlsm", ".xls"];

function isTabularName(name: string): boolean {
  const n = name.toLowerCase();
  return TABULAR_EXT.some((e) => n.endsWith(e));
}

function isPdfName(name: string): boolean {
  return name.toLowerCase().endsWith(".pdf");
}

/** Display names for every file node in the walked tree, by id. */
function fileNamesById(): Map<string, string> {
  const map = new Map<string, string>();
  for (const n of listNodes()) {
    if (n.kind === "file") map.set(n.id, n.name);
  }
  return map;
}

/**
 * Table names the CURRENT catalog would give the vault's tabular files —
 * what a view name must not shadow (files always win a name collision).
 * Same enumeration as the Rust direct-execution path: active included ids →
 * display name → the tabular/PDF registration gate → sanitizeTableName.
 */
function currentFileTableNames(): string[] {
  const byId = fileNamesById();
  const out: string[] = [];
  for (const id of activeIncludedFileIds()) {
    const name = byId.get(id);
    if (name && (isTabularName(name) || isPdfName(name))) {
      out.push(sanitizeTableName(name));
    }
  }
  return out;
}

/**
 * Resolve the passed file ids to display names, keeping order. Ids that no
 * longer resolve (or aren't registrable as tables) simply contribute no
 * table name; a definition that references them is then refused as an
 * unknown table. KEEP IN SYNC with views.rs::resolve_files.
 */
function resolveFiles(fileIds: string[]): ViewSourceFile[] {
  const byId = fileNamesById();
  const out: ViewSourceFile[] = [];
  for (const fileId of fileIds) {
    const name = byId.get(fileId);
    if (name && (isTabularName(name) || isPdfName(name))) out.push({ fileId, name });
  }
  return out;
}

// --- CRUD --------------------------------------------------------------------------

/**
 * Create a view: validate the name, guard the definition, derive reads,
 * enforce the DAG rules, persist — throwing a human-readable reason at the
 * first offense and persisting NOTHING on refusal. The vault lookups are
 * fetched here; createViewWithTables is the deterministic core. KEEP IN
 * SYNC with views.rs::create.
 */
export function createView(
  name: string,
  sql: string,
  summary: ViewSummary,
  fileIds: string[],
): View {
  return createViewWithTables(name, sql, summary, resolveFiles(fileIds), currentFileTableNames());
}

/**
 * `createView` with the vault lookups supplied by the caller: `files` is the
 * resolved {fileId, name} list in fileIds order, `takenTableNames` the
 * current catalog's file table names (the name-shadowing check). KEEP IN
 * SYNC with views.rs::create_with_tables.
 */
export function createViewWithTables(
  name: string,
  sql: string,
  summary: ViewSummary,
  files: ViewSourceFile[],
  takenTableNames: string[],
): View {
  // 1. Name: sanitize, then refuse empty / reserved / any collision.
  const normalized = normalizeViewName(name);
  if (!normalized) throw new Error("a view needs a name");
  if (RESERVED_NAMES.has(normalized)) throw new Error(`"${normalized}" is a reserved word`);
  const records = listViews();
  if (records.some((r) => r.name.toLowerCase() === normalized)) {
    throw new Error(`a view named "${normalized}" already exists`);
  }
  if (takenTableNames.some((t) => t.toLowerCase() === normalized)) {
    throw new Error(`a table named "${normalized}" already exists in your files`);
  }

  // 2. Guard (PARITY: textual here; guard_sql's parser on the desktop).
  const guardErr = guardViewSql(sql);
  if (guardErr) throw new Error(guardErr);

  // 3. Reads: every referenced name must resolve to a saved view
  //    (case-insensitive name match) or to a table derived from the passed
  //    files by replaying register_tables' naming pipeline —
  //    sanitizeTableName over each display name, in fileIds order, with
  //    uniqueTableName suffix-on-collision.
  const referenced = collectTableNames(sql);
  const fileTables: { table: string; fileId: string }[] = [];
  const used: string[] = [];
  for (const f of files) {
    const base = uniqueTableName(sanitizeTableName(f.name), used);
    used.push(base);
    fileTables.push({ table: base, fileId: f.fileId });
  }
  const reads: ViewReads = { files: [], views: [] };
  for (const table of referenced) {
    const lower = table.toLowerCase();
    const view = records.find((r) => r.name.toLowerCase() === lower);
    if (view) {
      reads.views.push(view.id);
      continue;
    }
    const file = fileTables.find((f) => f.table === lower);
    if (file) {
      reads.files.push({ fileId: file.fileId, tableName: file.table });
      continue;
    }
    throw new Error(`unknown table in definition: ${table}`);
  }

  // 4. DAG: cycle (impossible by construction, checked anyway) + depth cap.
  const createdMs = Date.now();
  const id = viewId(normalized, sql, createdMs);
  if (wouldCycle(records, id, reads.views)) {
    throw new Error("that definition would create a cycle");
  }
  if (viewDepth(records, reads.views) > MAX_VIEW_DEPTH) {
    throw new Error(`view depth is capped at ${MAX_VIEW_DEPTH}`);
  }

  const view: View = {
    id,
    name: normalized,
    sql,
    reads,
    summary: { text: summary.text, source: summary.source },
    createdMs,
  };
  records.push(view);
  save(records);
  return cloneView(view);
}

/**
 * Rename a view — REFUSED with a message naming the dependent views while
 * any other view reads this one (dependent SQL is user-approved text;
 * silently rewriting it risks corrupting a definition where the old name
 * also appears as a column). Otherwise a pure store update: the id and
 * every stored reads are untouched everywhere. The new name passes the SAME
 * rules as create. KEEP IN SYNC with views.rs::rename.
 */
export function renameView(id: string, newName: string): View {
  const normalized = normalizeViewName(newName);
  if (!normalized) throw new Error("a view needs a name");
  if (RESERVED_NAMES.has(normalized)) throw new Error(`"${normalized}" is a reserved word`);
  const takenTableNames = currentFileTableNames();
  const records = listViews();
  const rec = records.find((r) => r.id === id);
  if (!rec) throw new Error("view not found");
  const deps = dependentsIn(records, id);
  if (deps.length > 0) {
    throw new Error(
      `"${rec.name}" can't be renamed while other views read it: ${deps
        .map((d) => d.name)
        .join(", ")}`,
    );
  }
  if (records.some((r) => r.id !== id && r.name.toLowerCase() === normalized)) {
    throw new Error(`a view named "${normalized}" already exists`);
  }
  if (takenTableNames.some((t) => t.toLowerCase() === normalized)) {
    throw new Error(`a table named "${normalized}" already exists in your files`);
  }
  rec.name = normalized;
  save(records);
  return cloneView(rec);
}

/**
 * Delete a view. While TRANSITIVE dependents exist the delete is refused
 * with that list unless `cascade` (sent only after the UI's explicit
 * confirmation showing it); cascade removes the view plus its transitive
 * dependents in ONE write. Returns the deleted ids, store (creation) order.
 * Sources are never touched by any path. KEEP IN SYNC with
 * views.rs::delete.
 */
export function deleteView(id: string, cascade: boolean): string[] {
  const records = listViews();
  const target = records.find((r) => r.id === id);
  if (!target) throw new Error("view not found");
  const dependents = transitiveDependentsIn(records, id);
  if (dependents.length > 0 && !cascade) {
    throw new Error(
      `"${target.name}" can't be deleted while other views read it: ${dependents
        .map((d) => d.name)
        .join(", ")}`,
    );
  }
  const doomed = new Set<string>([id, ...dependents.map((d) => d.id)]);
  const deleted = records.filter((r) => doomed.has(r.id)).map((r) => r.id);
  save(records.filter((r) => !doomed.has(r.id))); // the ONE write
  return deleted;
}
