/**
 * Local vault: turns a real directory of files into the contract's FileNode
 * tree, persists per-node inclusion flags, and runs real content retrieval
 * (TF-IDF cosine over the text of the *included* files only).
 *
 * No cloud, no database server — just the filesystem. Embeddings can later
 * replace `retrieve()` behind the same surface without touching the API or UI.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { DataSource, FileNode, RagReference } from "@/contracts";
import {
  VAULT_SOURCE_ID,
  vaultDir,
  stateDir,
  statePath,
  readJson,
  writeJson,
} from "./config";
import { effectiveDefaultInclusion } from "./profile";
import { isRichFile, extractRichText } from "./extract";

/** An item referenced in place (not copied) — its real absolute path on disk. */
interface Reference {
  path: string;
  name: string;
  kind: "file" | "folder";
}

/**
 * A bulk curation rule (openspec: add-curation-rules): `{scope folder, ONE
 * predicate, action}`, evaluated LIVE inside the effective-state resolvers as
 * a layer between explicit per-node flags and the global default. A rule never
 * writes `included`/`localOnly` — future arrivals are covered by construction,
 * and deleting a rule reverts exactly the nodes it was deciding. A hand-edited
 * rule with a missing/unknown predicate or action simply matches nothing.
 * KEEP IN SYNC with vault.rs::CurationRule — state.json is shared
 * byte-compatibly.
 */
export interface CurationRule {
  id: string;
  /** Scope folder node id; "" = the vault root (vault-resident files only —
   *  a linked root (`extN`) is its own folder scope). */
  scope: string;
  /** Predicate (exactly one of kind/ext/glob, add-time validated). */
  kind?: string; // "tabular" | "document" | "image"
  /** Lowercase extension list, stored dot-less (e.g. ["xlsx","csv"]). */
  ext?: string[];
  /** Glob over the path RELATIVE to the scope — `*`, `**`, `?` only. */
  glob?: string;
  action: string; // "include" | "exclude" | "local-only" | "clear"
}

interface VaultState {
  sourceAvailable: boolean;
  /** Explicit inclusion overrides keyed by node id; absent ⇒ excluded. */
  included: Record<string, boolean>;
  /**
   * Explicit "Private — this device only" marks keyed by node id; absent ⇒ not
   * local-only. Ancestor-wins (see isEffectivelyLocalOnly). Like `included`, the
   * `raw.localOnly ?? {}` read below makes this additively migration-safe: an
   * old state.json with no localOnly key loads as an empty map. state.json is
   * intentionally UN-versioned — that tolerance IS the migration story.
   * KEEP IN SYNC with vault.rs.
   */
  localOnly: Record<string, boolean>;
  /**
   * External references keyed by a synthetic node-id prefix (e.g. "ext0"). Their
   * content lives at `path` on disk and is read in place — no copy is made.
   */
  references: Record<string, Reference>;
  /**
   * Bulk curation rules (openspec: add-curation-rules) — a RESOLUTION layer,
   * never per-node writes. Definition order matters (within one scope the
   * last-defined rule wins). The `raw.rules ?? []` read below keeps an old
   * state.json (no `rules` key) loading rule-less — the established
   * un-versioned migration story. KEEP IN SYNC with vault.rs.
   */
  rules: CurationRule[];
}

function loadState(): VaultState {
  // Construct fresh objects each call so a missing state file never aliases a
  // shared default that setIncluded() would then mutate for the process life.
  const raw = readJson<Partial<VaultState>>(statePath(), {});
  return {
    sourceAvailable: raw.sourceAvailable ?? true,
    included: { ...(raw.included ?? {}) },
    localOnly: { ...(raw.localOnly ?? {}) },
    references: { ...(raw.references ?? {}) },
    rules: [...(raw.rules ?? [])],
  };
}

/** True when `child` is `parent` or lives beneath it on disk. */
function isWithin(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

/** True when either path contains the other (overlapping subtrees). */
function pathsOverlap(a: string, b: string): boolean {
  return isWithin(a, b) || isWithin(b, a);
}

/** Which reference, if any, owns a node id (`extN` itself or `extN/...`). */
function refIdOf(id: string, refs: Record<string, Reference>): string | null {
  for (const refId of Object.keys(refs)) {
    if (id === refId || id.startsWith(`${refId}/`)) return refId;
  }
  return null;
}

/**
 * Resolve a node id to an absolute path on disk. Vault-relative ids map under
 * the vault directory; referenced ids (`extN/...`) map under their registered
 * real path. Both reject paths that escape their base.
 */
// Component-wise containment. A raw `abs.startsWith(base + path.sep)` string
// test FALSE-REJECTS on Windows: `path.resolve` separator-normalizes `abs`
// (backslashes) while `base` keeps whatever slashes the vault dir carried — a
// shell-provided path is forward/mixed — so an in-vault file fails the prefix
// test and its content reads empty though it is listed and included. Using
// path.relative (which normalizes both sides) is separator-agnostic and, by
// rejecting any `..` component, escape-safe.
// PARITY: the Rust engine uses `Path::starts_with` (native/.../vault.rs
// safe_abs) for the same decision.
function isWithinBase(base: string, abs: string): boolean {
  if (abs === base) return true;
  const rel = path.relative(base, abs);
  return rel !== "" && !rel.split(path.sep).includes("..") && !path.isAbsolute(rel);
}

function resolveAbs(id: string, state: VaultState): string {
  const refId = refIdOf(id, state.references);
  if (!refId) return safeAbs(id);
  const base = path.resolve(state.references[refId].path);
  const sub = id.slice(refId.length).replace(/^\//, "");
  const abs = path.resolve(base, sub);
  if (!isWithinBase(base, abs)) {
    throw new Error("path escapes the reference");
  }
  return abs;
}
function saveState(s: VaultState): void {
  writeJson(statePath(), s);
  invalidateWalkCache(); // inclusion flags and references feed the walked tree
}

/**
 * Short-lived snapshot of the walked tree. A walk is a full synchronous
 * recursive scan of the vault AND every linked folder; with a large tree (a
 * whole desktop linked in, thousands of files) re-walking on every API call
 * blocks the server's event loop and the entire app reads as frozen. Every
 * in-app mutation invalidates the snapshot immediately, so app actions never
 * see stale data; the TTL only bounds how long a change made OUTSIDE the app
 * (files copied in by hand) can go unnoticed between scans.
 */
const WALK_TTL_MS = 3_000;
let walkCache: { root: string; nodes: FileNode[]; at: number } | null = null;

function invalidateWalkCache(): void {
  walkCache = null;
}

/**
 * Resolve a node id to its real absolute path on disk (vault file or referenced
 * item), refusing any path that escapes the vault / its reference. Used to open
 * a file in its native application from a chat citation.
 */
export function resolveNodePath(nodeId: string): string {
  return resolveAbs(nodeId, loadState());
}

/**
 * Whether absent inclusion flags default to INCLUDED. Honors the user's explicit
 * onboarding/Preferences choice (`include` ⇒ new files are searchable by
 * default, the user opts pieces out; `exclude` ⇒ nothing in until toggled on);
 * with no explicit choice the default is `exclude` (the conservative,
 * privacy-preserving original behavior — the A/B variant that used to pick it
 * was deleted with the experiment machinery). Resolved once per walk and
 * threaded into isEffectivelyIncluded so a big tree isn't re-reading the
 * preference per node.
 */
function defaultIncluded(): boolean {
  return effectiveDefaultInclusion() === "include";
}

// --- curation rules: evaluation (openspec: add-curation-rules) -----------------
//
// Rules are a resolution layer for FILES: explicit flags (own, then the
// existing ancestor semantics) always win; rules decide only where today's
// code fell through to the default. Folders never take the rule layer — a
// rule "applies to every matching file under its scope", and folder eyes in
// the explorer derive from their descendants anyway. KEEP IN SYNC with the
// vault.rs rules-evaluation section.

/** Rule actions / kinds the engine accepts (add-time whitelist). */
const RULE_ACTIONS = new Set(["include", "exclude", "local-only", "clear"]);
const RULE_KINDS = new Set(["tabular", "document", "image"]);

/** `kind:"tabular"` — the catalog gate. KEEP IN SYNC with analytics::is_tabular. */
const RULE_TABULAR_EXT = new Set(["csv", "tsv", "parquet", "xlsx", "xlsm", "xls"]);

/**
 * `kind:"document"` — the prose document formats THIS twin extracts or reads
 * (.pdf/.docx via ./extract plus the prose documents of TEXT_EXT). PARITY:
 * .doc/.pptx/.odt/.odp/.rtf are Rust-only extraction — name-match-only here,
 * so kind rules deliberately don't match them (an honest degrade, never a
 * fake); ext/glob rules are full-fidelity both sides.
 */
const RULE_DOCUMENT_EXT = new Set([
  "pdf", "docx", "md", "markdown", "txt", "text", "rst", "html", "htm",
]);

/**
 * `kind:"image"` — OCR is Rust-only, so images are name-match-only in this
 * twin and `kind:"image"` matches NOTHING here (PARITY: the desktop engine
 * matches its OCR raster set).
 */
const RULE_IMAGE_EXT = new Set<string>([]);

/**
 * Validate a rule glob: `/`-separated, wildcards `*`/`**`/`?` only, no empty
 * segments, `**` only as a whole segment, no backslashes. Returns the
 * segments, or throws the human-readable reason. KEEP IN SYNC with
 * vault.rs::parse_rule_glob.
 */
function parseRuleGlob(glob: string): string[] {
  if (!glob.trim()) throw new Error("glob must not be empty");
  if (glob.includes("\\")) throw new Error("glob uses / as its separator");
  if (glob.startsWith("/") || glob.endsWith("/") || glob.includes("//")) {
    throw new Error("glob must not have empty segments");
  }
  const segs = glob.split("/");
  for (const s of segs) {
    if (s.includes("**") && s !== "**") throw new Error("** must stand alone between slashes");
  }
  return segs;
}

/**
 * `*` / `?` within ONE path segment (never crosses `/`). Linear two-pointer
 * backtracking, so a pathological pattern can't go exponential. KEEP
 * BYTE-IDENTICAL in behavior with vault.rs::glob_segment_matches.
 */
function globSegmentMatches(pat: string, seg: string): boolean {
  let p = 0;
  let s = 0;
  let star = -1;
  let mark = 0;
  while (s < seg.length) {
    if (p < pat.length && (pat[p] === "?" || pat[p] === seg[s])) {
      p += 1;
      s += 1;
    } else if (p < pat.length && pat[p] === "*") {
      star = p;
      mark = s;
      p += 1;
    } else if (star !== -1) {
      p = star + 1;
      mark += 1;
      s = mark;
    } else {
      return false;
    }
  }
  while (p < pat.length && pat[p] === "*") p += 1;
  return p === pat.length;
}

/** Segment-wise glob match; `**` spans zero or more whole segments. KEEP IN
 *  SYNC with vault.rs::glob_segments_match. */
function globSegmentsMatch(pat: string[], pathSegs: string[]): boolean {
  if (pat.length === 0) return pathSegs.length === 0;
  if (pat[0] === "**") {
    if (globSegmentsMatch(pat.slice(1), pathSegs)) return true; // zero segments
    return pathSegs.length > 0 && globSegmentsMatch(pat, pathSegs.slice(1));
  }
  if (pathSegs.length === 0) return false;
  return (
    globSegmentMatches(pat[0], pathSegs[0]) && globSegmentsMatch(pat.slice(1), pathSegs.slice(1))
  );
}

/**
 * The path of `id` RELATIVE to `scope` when the scope contains it, else null.
 * Scope "" (the vault root) contains every vault-resident id but NOT linked
 * (`extN…`) subtrees — a linked root is its own folder scope. The scope
 * folder itself is never "under" its own scope. KEEP IN SYNC with
 * vault.rs::scope_rel.
 */
function scopeRel(scope: string, id: string, state: VaultState): string | null {
  if (scope === "") return refIdOf(id, state.references) === null ? id : null;
  if (!id.startsWith(`${scope}/`)) return null;
  return id.slice(scope.length + 1);
}

/** Scope depth for deepest-scope-wins ordering ("" = 0). */
function scopeDepth(scope: string): number {
  return scope === "" ? 0 : scope.split("/").length;
}

/** Lowercased dot-less extension of a basename ("" when none). */
function bareExtOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Does the rule's predicate match a FILE at `rel` (path relative to the
 * rule's scope)? A stored rule that fails to evaluate — missing/unknown
 * predicate, unparseable glob — matches nothing (the layer falls through)
 * rather than breaking the walk. KEEP IN SYNC with
 * vault.rs::rule_predicate_matches.
 */
function rulePredicateMatches(rule: CurationRule, rel: string): boolean {
  const name = rel.split("/").pop() ?? rel;
  if (rule.kind !== undefined) {
    const bare = bareExtOf(name);
    if (rule.kind === "tabular") return RULE_TABULAR_EXT.has(bare);
    if (rule.kind === "document") return RULE_DOCUMENT_EXT.has(bare);
    if (rule.kind === "image") return RULE_IMAGE_EXT.has(bare);
    return false;
  }
  if (rule.ext !== undefined) {
    const bare = bareExtOf(name);
    return bare !== "" && rule.ext.includes(bare);
  }
  if (rule.glob !== undefined) {
    let pat: string[];
    try {
      pat = parseRuleGlob(rule.glob);
    } catch {
      return false;
    }
    return globSegmentsMatch(pat, rel.split("/"));
  }
  return false;
}

type RuleAxis = "inclusion" | "localOnly";

/**
 * Whether an action participates in an axis. `clear` is first-class on BOTH:
 * a scoped return-to-default that masks broader rules (inclusion → the global
 * default; local-only → unmarked).
 */
function axisAction(axis: RuleAxis, action: string): boolean {
  return axis === "inclusion"
    ? action === "include" || action === "exclude" || action === "clear"
    : action === "local-only" || action === "clear";
}

/**
 * The matching rule that DECIDES a file on one axis: deepest scope wins;
 * within one scope the last-defined (highest index) wins. Null ⇒ the rule
 * layer falls through to the default. KEEP IN SYNC with vault.rs::winning_rule.
 */
function winningRule(id: string, state: VaultState, axis: RuleAxis): CurationRule | null {
  let best: { depth: number; idx: number; rule: CurationRule } | null = null;
  for (let idx = 0; idx < state.rules.length; idx++) {
    const rule = state.rules[idx];
    if (!axisAction(axis, rule.action)) continue;
    const rel = scopeRel(rule.scope, id, state);
    if (rel === null) continue;
    if (!rulePredicateMatches(rule, rel)) continue;
    const depth = scopeDepth(rule.scope);
    if (!best || depth > best.depth || (depth === best.depth && idx > best.idx)) {
      best = { depth, idx, rule };
    }
  }
  return best?.rule ?? null;
}

/**
 * Which layer decided a flag. The boolean resolvers AND the inspector's
 * attribution both read this one decision, so "what resolved" and "why" can
 * never disagree. KEEP IN SYNC with vault.rs::FlagDecision.
 */
type FlagDecision =
  | { layer: "ancestor" }
  | { layer: "explicit"; value: boolean }
  | { layer: "rule"; rule: CurationRule }
  | { layer: "default" };

function inclusionDecision(id: string, state: VaultState, isFile: boolean): FlagDecision {
  const parts = id.split("/");
  let prefix = "";
  for (let i = 0; i < parts.length - 1; i++) {
    prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
    if (state.included[prefix] === false) return { layer: "ancestor" }; // excluded ancestor
  }
  if (state.included[id] !== undefined) return { layer: "explicit", value: state.included[id] };
  if (isFile) {
    const rule = winningRule(id, state, "inclusion");
    if (rule) return { layer: "rule", rule };
  }
  return { layer: "default" };
}

function localOnlyDecision(id: string, state: VaultState, isFile: boolean): FlagDecision {
  const parts = id.split("/");
  let prefix = "";
  for (let i = 0; i < parts.length - 1; i++) {
    prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
    if (state.localOnly[prefix] === true) return { layer: "ancestor" }; // marked ancestor
  }
  if (state.localOnly[id] !== undefined) return { layer: "explicit", value: state.localOnly[id] };
  if (isFile) {
    const rule = winningRule(id, state, "localOnly");
    if (rule) return { layer: "rule", rule };
  }
  return { layer: "default" };
}

/**
 * Effective inclusion. Precedence (spec-pinned, openspec add-curation-rules):
 * explicit ancestor exclusion (the existing ancestor-wins semantics — a rule
 * can never resurrect an excluded subtree) → explicit own flag → matching
 * rules (FILES only: deepest scope, then last-defined; `clear` yields the
 * default and masks shallower rules) → the global default. Consequences, by
 * design:
 *  - exclude: anything new (added from the computer, anywhere) defaults out;
 *  - include: anything new defaults in until the user opts it out;
 *  - an excluded folder forces every descendant out, even a file moved in
 *    later that carried an included flag (ancestor exclusion wins);
 *  - an internal move preserves the node's own flag (see moveNode), but the
 *    ancestor rule above still applies at its new location.
 * Exported for the node twin's precedence tests. KEEP IN SYNC with
 * vault.rs::is_effectively_included.
 */
export function isEffectivelyIncluded(
  id: string,
  state: VaultState,
  defaultIn = defaultIncluded(),
  isFile = true,
): boolean {
  const d = inclusionDecision(id, state, isFile);
  if (d.layer === "ancestor") return false;
  if (d.layer === "explicit") return d.value;
  if (d.layer === "rule") {
    if (d.rule.action === "include") return true;
    if (d.rule.action === "exclude") return false;
    return defaultIn; // "clear": a scoped return-to-default
  }
  return defaultIn;
}

/**
 * Effective "Private — this device only" state. ANCESTOR-WINS: a node is
 * local-only when it OR any ancestor carries an explicit `true`; a child's own
 * `false` cannot override a marked ancestor (the safe direction). An explicit
 * OWN flag — either way — beats rules ("explicit user state always beats
 * rules": a rule can only ADD privacy where the user hasn't spoken, and never
 * removes an explicit mark). With no explicit state, matching `local-only`
 * rules mark the file (`clear` masks them back to unmarked); absence means not
 * local-only. Exported for the node twin's tests. KEEP IN SYNC with
 * vault.rs::is_effectively_local_only.
 */
export function isEffectivelyLocalOnly(id: string, state: VaultState, isFile = true): boolean {
  const d = localOnlyDecision(id, state, isFile);
  if (d.layer === "ancestor") return true;
  if (d.layer === "explicit") return d.value;
  if (d.layer === "rule") return d.rule.action === "local-only"; // "clear" → unmarked
  return false;
}

/**
 * Wire attribution for the inspector ("why is this flag what it is"): which
 * layer decided. `ruleName` is the generated display name so the panel can say
 * `included by rule "spreadsheets in /reports"`. KEEP IN SYNC with
 * vault.rs::FlagAttribution and the FileInspection shape in contracts.
 */
export interface FlagAttribution {
  source: "explicit" | "ancestor" | "rule" | "default";
  ruleId?: string;
  ruleName?: string;
}

function attributionOf(d: FlagDecision): FlagAttribution {
  if (d.layer === "rule") {
    return { source: "rule", ruleId: d.rule.id, ruleName: ruleDisplayName(d.rule) };
  }
  return { source: d.layer };
}

/** Attribution sibling of isEffectivelyIncluded for ONE file — computed on
 *  demand (the inspector's single file), never stored. */
export function inclusionAttribution(fileId: string): FlagAttribution {
  return attributionOf(inclusionDecision(fileId, loadState(), true));
}

/** Attribution sibling of isEffectivelyLocalOnly for ONE file. */
export function localOnlyAttribution(fileId: string): FlagAttribution {
  return attributionOf(localOnlyDecision(fileId, loadState(), true));
}

/**
 * Extensions read directly as UTF-8 text. Rich binary formats (pdf/docx/xlsx)
 * are decoded via parsers in ./extract and are *not* listed here.
 */
// .xml deliberately absent: app-generated sidecar/config XML in linked folders
// kept surfacing as AI sources (0.6.x field report). The files stay visible in
// the explorer — they just never become chunks. KEEP IN SYNC with vault.rs.
const TEXT_EXT = new Set([
  ".md", ".markdown", ".txt", ".text", ".rst", ".csv", ".tsv", ".json",
  ".yaml", ".yml", ".log", ".html", ".htm", ".js", ".ts", ".tsx",
  ".jsx", ".py", ".java", ".go", ".rb", ".rs", ".c", ".h", ".cpp", ".sh",
  ".sql", ".toml", ".ini", ".env", ".css",
]);

const MIME: Record<string, string> = {
  ".md": "text/markdown", ".markdown": "text/markdown", ".txt": "text/plain",
  ".csv": "text/csv", ".json": "application/json", ".pdf": "application/pdf",
  ".html": "text/html", ".htm": "text/html",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
  ".xls": "application/vnd.ms-excel",
};

const isTextFile = (name: string) => TEXT_EXT.has(path.extname(name).toLowerCase());
const mimeOf = (name: string) => MIME[path.extname(name).toLowerCase()];

/** A node id is its POSIX-relative path from the vault root (stable + unique). */
function walk(root: string): FileNode[] {
  if (walkCache && walkCache.root === root && Date.now() - walkCache.at < WALK_TTL_MS) {
    return walkCache.nodes;
  }
  const nodes = walkUncached(root);
  walkCache = { root, nodes, at: Date.now() };
  return nodes;
}

function walkUncached(root: string): FileNode[] {
  const out: FileNode[] = [];
  const state = loadState();
  const defaultIn = defaultIncluded(); // resolve the variant once for this walk
  // Rules resolve FILES only (folders keep explicit-flags + default), so the
  // node kind threads through — see the rules-evaluation section above.
  const included = (id: string, isFile: boolean) =>
    isEffectivelyIncluded(id, state, defaultIn, isFile);
  // Effective local-only (ancestor-wins), carried on each node so the explorer
  // can render the lock without re-resolving.
  const localOnly = (id: string, isFile: boolean) => isEffectivelyLocalOnly(id, state, isFile);

  const recurse = (absDir: string, parentId: string | null) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue; // skip .rag-vault and dotfiles
      const abs = path.join(absDir, e.name);
      const id = path.relative(root, abs).split(path.sep).join("/");
      if (e.isDirectory()) {
        out.push({
          id, parentId, sourceId: VAULT_SOURCE_ID, name: e.name,
          kind: "folder", ragIncluded: included(id, false), localOnly: localOnly(id, false),
        });
        recurse(abs, id);
      } else if (e.isFile()) {
        let size: number | undefined;
        try {
          size = fs.statSync(abs).size;
        } catch {
          size = undefined;
        }
        out.push({
          id, parentId, sourceId: VAULT_SOURCE_ID, name: e.name,
          kind: "file", mimeType: mimeOf(e.name), size,
          ragIncluded: included(id, true), localOnly: localOnly(id, true),
        });
      }
    }
  };
  recurse(root, null);

  // Referenced items (added via "Link…"): read in place under an `extN` prefix.
  for (const [refId, ref] of Object.entries(state.references)) {
    let exists = true;
    try {
      fs.statSync(ref.path);
    } catch {
      exists = false;
    }
    if (ref.kind === "file") {
      let size: number | undefined;
      try {
        size = fs.statSync(ref.path).size;
      } catch {
        size = undefined;
      }
      out.push({
        id: refId, parentId: null, sourceId: VAULT_SOURCE_ID, name: ref.name,
        kind: "file", mimeType: mimeOf(ref.name), size,
        ragIncluded: included(refId, true), localOnly: localOnly(refId, true), external: true,
      });
      continue;
    }
    out.push({
      id: refId, parentId: null, sourceId: VAULT_SOURCE_ID, name: ref.name,
      kind: "folder", ragIncluded: included(refId, false), localOnly: localOnly(refId, false), external: true,
    });
    if (!exists) continue;

    const recurseExt = (absDir: string, parentId: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(absDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const abs = path.join(absDir, e.name);
        const rel = path.relative(ref.path, abs).split(path.sep).join("/");
        const id = `${refId}/${rel}`;
        if (e.isDirectory()) {
          out.push({
            id, parentId, sourceId: VAULT_SOURCE_ID, name: e.name,
            kind: "folder", ragIncluded: included(id, false), localOnly: localOnly(id, false), external: true,
          });
          recurseExt(abs, id);
        } else if (e.isFile()) {
          let size: number | undefined;
          try {
            size = fs.statSync(abs).size;
          } catch {
            size = undefined;
          }
          out.push({
            id, parentId, sourceId: VAULT_SOURCE_ID, name: e.name,
            kind: "file", mimeType: mimeOf(e.name), size,
            ragIncluded: included(id, true), localOnly: localOnly(id, true), external: true,
          });
        }
      }
    };
    recurseExt(ref.path, refId);
  }
  return out;
}

export function listSources(): DataSource[] {
  const state = loadState();
  return [{
    id: VAULT_SOURCE_ID,
    name: "Local Vault",
    kind: "folder",
    available: state.sourceAvailable,
  }];
}

export function listNodes(parentId?: string | null): FileNode[] {
  const all = walk(vaultDir());
  // A full-tree listing (no parentId) returns everything; a specific parentId
  // (including null for roots) filters to that parent's children.
  if (parentId === undefined) return all;
  return all.filter((n) => n.parentId === parentId);
}

/** Toggle a node and (for folders) all of its descendants. */
export function setIncluded(nodeId: string, value: boolean): void {
  const all = walk(vaultDir());
  const target = new Set<string>([nodeId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of all) {
      if (n.parentId && target.has(n.parentId) && !target.has(n.id)) {
        target.add(n.id);
        grew = true;
      }
    }
  }
  const state = loadState();
  for (const id of target) state.included[id] = value;
  saveState(state);
}

/**
 * Mark/unmark a node "Private — this device only". Writes ONLY the target's own
 * flag — NO descendant cascade (contrast setIncluded above): isEffectivelyLocalOnly's
 * ancestor-walk already privatizes the whole subtree by resolution. Setting a
 * child `false` beneath a marked ancestor is inert (ancestor wins).
 * KEEP IN SYNC with vault.rs::set_local_only.
 */
export function setLocalOnly(nodeId: string, value: boolean): void {
  const state = loadState();
  state.localOnly[nodeId] = value;
  saveState(state);
}

export function setSourceAvailable(available: boolean): void {
  const state = loadState();
  state.sourceAvailable = available;
  saveState(state);
}

// --- curation rules: CRUD + display (openspec: add-curation-rules) --------------

/**
 * Generated display name from predicate + scope — e.g. "spreadsheets in
 * /reports". Derived on demand (never stored, so it can't go stale). KEEP
 * BYTE-IDENTICAL with vault.rs::rule_display_name.
 */
export function ruleDisplayName(rule: CurationRule): string {
  const predicate =
    rule.kind !== undefined
      ? rule.kind === "tabular"
        ? "spreadsheets"
        : rule.kind === "document"
          ? "documents"
          : rule.kind === "image"
            ? "images"
            : `${rule.kind} files`
      : rule.ext !== undefined
        ? `${rule.ext.map((e) => `.${e}`).join("/")} files`
        : rule.glob !== undefined
          ? `files matching ${rule.glob}`
          : "files"; // degenerate stored rule — matches nothing anyway
  const place = rule.scope === "" ? "the vault" : `/${rule.scope}`;
  return `${predicate} in ${place}`;
}

/** Mint a short random rule id ("r" + 8 hex chars), re-rolled on collision. */
function mintRuleId(existing: CurationRule[]): string {
  for (;;) {
    const id = `r${randomBytes(4).toString("hex")}`;
    if (!existing.some((r) => r.id === id)) return id;
  }
}

/** All stored rules, definition order. */
export function listRules(): CurationRule[] {
  return loadState().rules;
}

/**
 * Validate + add a rule; the id is minted engine-side. Exactly ONE predicate
 * (kind | ext | glob) must be given; kinds/actions are whitelisted; the glob
 * must parse; extensions normalize to lowercase dot-less. Throws the
 * human-readable reason (the route surfaces it as a 400). Saving goes through
 * saveState, so a rule write invalidates the walk cache exactly like a flag
 * write. KEEP IN SYNC with vault.rs::add_rule.
 */
export function addRule(input: {
  scope: string;
  kind?: string;
  ext?: string[];
  glob?: string;
  action: string;
}): CurationRule {
  const { scope, kind, ext, glob, action } = input;
  if (!RULE_ACTIONS.has(action)) {
    throw new Error("action must be include, exclude, local-only, or clear");
  }
  if (
    scope.includes("\\") ||
    scope.startsWith("/") ||
    scope.endsWith("/") ||
    scope.includes("//")
  ) {
    throw new Error("invalid scope");
  }
  const picked =
    Number(kind !== undefined) + Number(ext !== undefined) + Number(glob !== undefined);
  if (picked !== 1) throw new Error("exactly one of kind, ext, or glob is required");
  if (kind !== undefined && !RULE_KINDS.has(kind)) {
    throw new Error("kind must be tabular, document, or image");
  }
  let extNorm: string[] | undefined;
  if (ext !== undefined) {
    extNorm = ext.map((e) => e.trim().replace(/^\.+/, "").toLowerCase()).filter(Boolean);
    if (extNorm.length === 0) throw new Error("ext needs at least one extension");
    const bad = extNorm.find((e) => !/^[a-z0-9]+$/.test(e));
    if (bad !== undefined) throw new Error(`invalid extension "${bad}"`);
  }
  if (glob !== undefined) {
    try {
      parseRuleGlob(glob);
    } catch (err) {
      throw new Error(`invalid glob: ${err instanceof Error ? err.message : "unparseable"}`);
    }
  }
  const state = loadState();
  const rule: CurationRule = {
    id: mintRuleId(state.rules),
    scope,
    ...(kind !== undefined ? { kind } : {}),
    ...(extNorm !== undefined ? { ext: extNorm } : {}),
    ...(glob !== undefined ? { glob } : {}),
    action,
  };
  state.rules.push(rule);
  saveState(state); // invalidates the walk cache like a flag write
  return rule;
}

/**
 * Remove a rule by id (idempotent). Only the rule's own layer disappears:
 * every node it was deciding reverts to the next layer down — explicit flags
 * are untouched by construction (rules never wrote any).
 */
export function removeRule(id: string): void {
  const state = loadState();
  const before = state.rules.length;
  state.rules = state.rules.filter((r) => r.id !== id);
  if (state.rules.length !== before) saveState(state);
}

/**
 * A rule enriched for the UI: generated display name, a human scope label, and
 * whether the scope folder currently exists (an orphaned rule matches nothing
 * but is kept for cleanup — the folder may return, e.g. an unplugged linked
 * root). KEEP IN SYNC with vault.rs::RuleListing.
 */
export type RuleListing = CurationRule & {
  name: string;
  scopeLabel: string;
  orphaned: boolean;
};

/** Human label for a rule scope: "" → "Vault"; a linked subtree renders under
 *  its link's display name instead of the synthetic `extN`. */
function scopeLabelOf(scope: string, state: VaultState): string {
  if (scope === "") return "Vault";
  const refId = refIdOf(scope, state.references);
  if (refId !== null) {
    const name = state.references[refId].name;
    const rest = scope.slice(refId.length).replace(/^\//, "");
    return rest ? `${name}/${rest}` : name;
  }
  return scope;
}

function enrichWith(rule: CurationRule, state: VaultState, folderIds: Set<string>): RuleListing {
  return {
    ...rule,
    name: ruleDisplayName(rule),
    scopeLabel: scopeLabelOf(rule.scope, state),
    orphaned: rule.scope !== "" && !folderIds.has(rule.scope),
  };
}

/** Enrich one rule for the wire (the `add` response). */
export function enrichRule(rule: CurationRule): RuleListing {
  const state = loadState();
  const folderIds = new Set(
    walk(vaultDir())
      .filter((n) => n.kind === "folder")
      .map((n) => n.id),
  );
  return enrichWith(rule, state, folderIds);
}

/** Every rule enriched for the UI (Preferences list + folder dialogs). */
export function rulesListing(): RuleListing[] {
  const state = loadState();
  const folderIds = new Set(
    walk(vaultDir())
      .filter((n) => n.kind === "folder")
      .map((n) => n.id),
  );
  return state.rules.map((r) => enrichWith(r, state, folderIds));
}

/** Resolve a vault-relative id to an absolute path, refusing to escape the vault. */
function safeAbs(relId: string): string {
  const base = vaultDir();
  const abs = path.resolve(base, relId);
  if (!isWithinBase(base, abs)) {
    throw new Error("path escapes the vault");
  }
  return abs;
}

/**
 * Move a file/folder within the vault (an *internal* move), preserving its
 * inclusion setting and that of its subtree. This is what distinguishes an
 * internal move from an external add: an external add is only ever discovered
 * by a fresh scan and so defaults to excluded, whereas an internal move carries
 * its flags across. The ancestor-exclusion rule in isEffectivelyIncluded still
 * governs the effective result at the destination.
 */
export function moveNode(fromId: string, toParentId: string | null): { newId: string } {
  if (!fromId) throw new Error("fromId required");
  const fromAbs = safeAbs(fromId);
  const name = path.basename(fromId);
  const newId = toParentId ? `${toParentId}/${name}` : name;
  const toAbs = safeAbs(newId);
  if (!fs.existsSync(fromAbs)) throw new Error("source not found");
  if (fs.existsSync(toAbs)) throw new Error("destination already exists");

  fs.mkdirSync(path.dirname(toAbs), { recursive: true });
  fs.renameSync(fromAbs, toAbs);

  // Remap the node and every descendant's inclusion + local-only flags onto the
  // new prefix (both maps move together — see renameNode). Rule SCOPES remap
  // too: a rule follows its folder like the flags do, instead of silently
  // orphaning on an in-app move (orphaning is for deletion).
  const state = loadState();
  state.included = remapPrefix(state.included, fromId, newId);
  state.localOnly = remapPrefix(state.localOnly, fromId, newId);
  remapRuleScopes(state.rules, fromId, newId);
  saveState(state);
  return { newId };
}

/**
 * Remap rule scopes onto a moved/renamed folder's new id (the scope itself and
 * any scope beneath it) — the rules analog of remapPrefix, so a rule travels
 * with its folder exactly like the per-node flags do. Scope-relative globs
 * survive untouched by construction. KEEP IN SYNC with
 * vault.rs::remap_rule_scopes.
 */
function remapRuleScopes(rules: CurationRule[], oldId: string, newId: string): void {
  for (const r of rules) {
    if (r.scope === oldId) r.scope = newId;
    else if (r.scope.startsWith(`${oldId}/`)) r.scope = newId + r.scope.slice(oldId.length);
  }
}

/**
 * Remap a per-node flag map onto a new id prefix (the node itself and every
 * `${old}/…` descendant), leaving unrelated keys untouched. Shared by move and
 * rename so the `included` and `localOnly` maps stay migrated in lockstep.
 * KEEP IN SYNC with vault.rs::remap_prefix.
 */
function remapPrefix(
  map: Record<string, boolean>,
  oldId: string,
  newId: string,
): Record<string, boolean> {
  const next: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(map)) {
    if (k === oldId) next[newId] = v;
    else if (k.startsWith(`${oldId}/`)) next[newId + k.slice(oldId.length)] = v;
    else next[k] = v;
  }
  return next;
}

/**
 * Rename a node in place (same parent, new basename), carrying its inclusion
 * flags and its subtree's. Refuses empty / dotfile / separator names and an
 * existing destination. Vault-resident nodes only.
 */
export function renameNode(id: string, newName: string): { newId: string } {
  if (!id) throw new Error("id required");
  const clean = newName.trim();
  if (!clean || clean.startsWith(".") || clean.includes("/") || clean.includes("\\")) {
    throw new Error("invalid name");
  }
  const fromAbs = safeAbs(id);
  if (!fs.existsSync(fromAbs)) throw new Error("source not found");
  const slash = id.lastIndexOf("/");
  const newId = slash >= 0 ? `${id.slice(0, slash)}/${clean}` : clean;
  if (newId === id) return { newId }; // no-op rename
  const toAbs = safeAbs(newId);
  if (fs.existsSync(toAbs)) throw new Error("destination already exists");
  fs.renameSync(fromAbs, toAbs);
  // Remap the node and every descendant's inclusion + local-only flags onto the
  // new prefix (same as moveNode), plus any rule scopes anchored at or beneath it.
  const state = loadState();
  state.included = remapPrefix(state.included, id, newId);
  state.localOnly = remapPrefix(state.localOnly, id, newId);
  remapRuleScopes(state.rules, id, newId);
  saveState(state);
  return { newId };
}

/**
 * Create an empty folder under a parent (or the vault root when null). Returns
 * its id. Refuses empty / dotfile / separator names and existing paths.
 */
export function createFolder(parentId: string | null, name: string): { newId: string } {
  const clean = name.trim();
  if (!clean || clean.startsWith(".") || clean.includes("/") || clean.includes("\\")) {
    throw new Error("invalid folder name");
  }
  const newId = parentId ? `${parentId}/${clean}` : clean;
  const abs = safeAbs(newId);
  if (fs.existsSync(abs)) throw new Error("a file or folder with that name already exists");
  fs.mkdirSync(abs, { recursive: true });
  invalidateWalkCache(); // a new (empty, excluded) folder no state write announced
  return { newId };
}

/**
 * Write an uploaded file into the vault (optionally under a folder). The name is
 * reduced to a basename and collisions get a " (n)" suffix, so a client can
 * never write outside the vault or clobber an existing file. No state entry is
 * created, so an uploaded file is EXCLUDED by default like any external add.
 */
export function addFile(name: string, bytes: Buffer, destParentId: string | null = null): { newId: string } {
  const safeName = path.basename(name).trim();
  if (!safeName || safeName.startsWith(".")) throw new Error("invalid filename");
  const ext = path.extname(safeName);
  const base = safeName.slice(0, safeName.length - ext.length);

  let finalId = destParentId ? `${destParentId}/${safeName}` : safeName;
  let abs = safeAbs(finalId);
  for (let i = 1; fs.existsSync(abs); i++) {
    const alt = `${base} (${i})${ext}`;
    finalId = destParentId ? `${destParentId}/${alt}` : alt;
    abs = safeAbs(finalId);
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
  invalidateWalkCache(); // a new file exists that no state write announced
  return { newId: finalId };
}

/**
 * Write an artifact into a named vault folder ("Lighthouse Results",
 * "Lighthouse Notes") — openspec: add-answer-artifacts. The name hint is
 * REPAIRED, never rejected (separators and control chars become dashes,
 * leading dots shed, length capped), then addFile supplies the collision
 * suffix — an existing file is never overwritten. KEEP IN SYNC with
 * native vault.rs::write_artifact.
 */
export function writeArtifact(
  subdir: string,
  nameHint: string,
  ext: string,
  bytes: Buffer,
): { id: string; name: string } {
  let clean = [...nameHint]
    .slice(0, 80)
    .map((c) => {
      const code = c.charCodeAt(0);
      // Control chars = C0 + DEL + C1, matching Rust's char::is_control().
      return c === "/" || c === "\\" || code < 32 || (code >= 127 && code <= 159) ? "-" : c;
    })
    .join("")
    .trim()
    .replace(/^\.+/, "")
    .trim();
  if (!clean) clean = "result";
  const { newId } = addFile(`${clean}.${ext}`, bytes, subdir);
  return { id: newId, name: newId.split("/").pop() ?? newId };
}

/**
 * Write/OVERWRITE a fixed-name artifact in a named vault folder (the G5
 * briefing-note refresh). Same hint sanitization as `writeArtifact` but NO
 * collision suffix — the file is replaced in place. `safeAbs`-guarded against
 * vault escape; invalidates the walk cache. KEEP IN SYNC with
 * lighthouse-core::vault::refresh_artifact.
 */
export function refreshArtifact(
  subdir: string,
  nameHint: string,
  ext: string,
  bytes: Buffer,
): { id: string; name: string } {
  let clean = [...nameHint]
    .slice(0, 80)
    .map((c) => {
      const code = c.charCodeAt(0);
      return c === "/" || c === "\\" || code < 32 || (code >= 127 && code <= 159) ? "-" : c;
    })
    .join("")
    .trim()
    .replace(/^\.+/, "")
    .trim();
  if (!clean) clean = "result";
  const id = `${subdir}/${clean}.${ext}`;
  const abs = safeAbs(id); // rejects any vault escape
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes); // truncating overwrite — replaces in place
  invalidateWalkCache();
  return { id, name: id.split("/").pop() ?? id };
}

// --- G6 cross-conversation recall -------------------------------------------

/** Auto-exported past-chat notes live here. KEEP IN SYNC with vault.rs. */
export const CHATS_SUBDIR = "Lighthouse Notes/Chats";

/**
 * Classify a retrieved node id as a past-conversation note or an ordinary file,
 * purely by its vault-relative path. The trailing slash matters. KEEP IN SYNC
 * with lighthouse-core::vault::source_kind_of.
 */
export function sourceKindOf(fileId: string): "file" | "conversation" {
  return fileId.startsWith("Lighthouse Notes/Chats/") ? "conversation" : "file";
}

/**
 * G6: how much a recall cue lifts past-conversation candidates before ranking.
 * KEEP IN SYNC with lighthouse-core::synth::CONV_BOOST. (Lives here, not in
 * synth.ts, so `retrieve` can use it without a synth↔vault import cycle.)
 */
export const CONV_BOOST = 1.5;

/**
 * Recall preference for the current investigation (openspec:
 * add-investigations): where `CONV_BOOST` applies, a conversation note
 * BELONGING to the ask's investigation (its filename's `[cid8]` matches a
 * preferred conversation id) is lifted this much FURTHER — preference, not
 * exclusion: global notes still surface, ordered after. Applied in
 * `retrieve`. PARITY: keep identical to
 * lighthouse-core::synth::INVESTIGATION_BOOST.
 */
export const INVESTIGATION_BOOST = 1.3;

/**
 * G6: 8 hex chars of SHA-1(conversationId) — collision-resistant, stable,
 * and independent of the (mutable) title. THE one derivation of the `[cid8]`
 * key: `writeConversationNote` brackets it into the note's filename, and
 * `retrieve`'s investigation preference (openspec: add-investigations)
 * recomputes it from preferred conversation ids to recognize those same
 * filenames — extracted here so the two can never drift. KEEP IN SYNC with
 * vault.rs::conversation_cid8.
 */
function conversationCid8(conversationId: string): string {
  return createHash("sha1").update(conversationId).digest("hex").slice(0, 8);
}

/**
 * The `[cid8]` key a conversation-note FILENAME carries (the
 * `"<title> [<cid8>].md"` format `writeConversationNote` produces), or null
 * for any other id. The LAST ` [` wins, so a title that itself contains
 * brackets still yields the engine-appended key. KEEP IN SYNC with
 * vault.rs::note_cid8_of.
 */
function noteCid8Of(fileId: string): string | null {
  if (!fileId.endsWith("].md")) return null;
  const stem = fileId.slice(0, -"].md".length);
  const at = stem.lastIndexOf(" [");
  return at === -1 ? null : stem.slice(at + 2);
}

/** Anchored recall frames. KEEP BYTE-IDENTICAL with the Rust RECALL_FRAMES. */
const RECALL_FRAMES = [
  "what did i ask", "what did i conclude", "what did we conclude",
  "what did i say", "what did i decide", "did i ask", "have i asked",
  "what did i find", "what have i asked",
];

/**
 * G6 recall meta-cue: does the question ask what the USER previously asked,
 * said, concluded, decided, or found? Anchored frames (not loose keywords) so
 * ordinary questions never trigger. It BIASES retrieval toward conversation
 * notes; it never short-circuits to a model-free answer. Pure; normalization
 * matches `crossDocCue`. KEEP BYTE-IDENTICAL with lighthouse-core::synth::recall_cue.
 */
export function recallCue(question: string): boolean {
  const lower = question.toLowerCase();
  let norm = "";
  let lastSpace = true;
  for (const ch of lower) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) {
      norm += ch;
      lastSpace = false;
    } else if (!lastSpace) {
      norm += " ";
      lastSpace = true;
    }
  }
  const padded = ` ${norm.trim()} `;
  return RECALL_FRAMES.some((f) => padded.includes(` ${f} `));
}

/**
 * G6: write/OVERWRITE the auto-exported note for ONE conversation under
 * `CHATS_SUBDIR`. Filename = sanitized title + a short, stable id derived from
 * the conversation id (`"<title> [<cid8>].md"`), so it is human-scannable yet
 * keyed by conversation. A prior note for the same conversation under a changed
 * title is removed first. `safeAbs`-guarded; walk cache invalidated. KEEP IN SYNC
 * with lighthouse-core::vault::write_conversation_note.
 */
export function writeConversationNote(
  conversationId: string,
  title: string,
  bytes: Buffer,
): { id: string; name: string } {
  // The dedup key in brackets (shared derivation — see conversationCid8).
  const cid8 = conversationCid8(conversationId);
  let clean = [...title]
    .slice(0, 80)
    .map((c) => {
      const code = c.charCodeAt(0);
      return c === "/" || c === "\\" || code < 32 || (code >= 127 && code <= 159) ? "-" : c;
    })
    .join("")
    .trim()
    .replace(/^\.+/, "")
    .trim();
  if (!clean) clean = "Conversation";
  const filename = `${clean} [${cid8}].md`;
  const id = `${CHATS_SUBDIR}/${filename}`;
  const abs = safeAbs(id); // rejects any vault escape
  const dir = path.dirname(abs);
  fs.mkdirSync(dir, { recursive: true });
  // Remove a prior note for this same conversation under a different title.
  const suffix = ` [${cid8}].md`;
  try {
    for (const fname of fs.readdirSync(dir)) {
      if (fname.endsWith(suffix) && fname !== filename) {
        try {
          fs.rmSync(path.join(dir, fname));
        } catch {
          /* best-effort cleanup */
        }
      }
    }
  } catch {
    /* dir may not exist yet */
  }
  fs.writeFileSync(abs, bytes); // truncating overwrite — one current note per chat
  invalidateWalkCache();
  return { id, name: filename };
}

/**
 * G6 fail-closed opt-out: remove the entire auto-exported `Chats/` folder.
 * Idempotent. KEEP IN SYNC with lighthouse-core::vault::purge_conversation_notes.
 */
export function purgeConversationNotes(): void {
  const abs = safeAbs(CHATS_SUBDIR);
  if (fs.existsSync(abs)) {
    fs.rmSync(abs, { recursive: true, force: true });
    invalidateWalkCache();
  }
}

/**
 * Register a file or folder *in place* (a reference / link) instead of copying
 * it into the vault — this is how the app adds existing files without making a
 * second copy. The path must be an existing absolute path. Re-linking the same
 * path returns the existing reference. Excluded by default, like any new add.
 */
export function addReference(inputPath: string): { id: string; kind: "file" | "folder" } {
  const abs = path.resolve(inputPath);
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new Error("path not found");
  }
  const kind: "file" | "folder" = st.isDirectory() ? "folder" : "file";
  const state = loadState();

  // Never link a path that overlaps the vault (inside it, or an ancestor that
  // contains it) — those files are already first-class vault items and linking
  // them would re-enumerate the same content under a second `extN` id.
  if (pathsOverlap(abs, vaultDir())) {
    throw new Error("overlaps the vault");
  }
  // Re-linking the exact same path is idempotent; reject anything that overlaps
  // an existing reference so the same file can't be indexed twice (which would
  // duplicate retrieval hits and skew the TF-IDF scoring).
  for (const [id, r] of Object.entries(state.references)) {
    const rp = path.resolve(r.path);
    if (rp === abs) return { id, kind: r.kind };
    // A path INSIDE an already-linked folder is already indexed as a descendant
    // of that reference. Resolve it to that existing node id (the same id the
    // walk produces) instead of re-linking, so a drop of an already-covered file
    // succeeds idempotently rather than failing as an overlap.
    if (r.kind === "folder" && isWithin(rp, abs)) {
      const rel = path.relative(rp, abs).split(path.sep).join("/");
      return { id: `${id}/${rel}`, kind };
    }
    if (pathsOverlap(abs, rp)) {
      throw new Error("overlaps an existing reference");
    }
  }

  let i = 0;
  let id = `ext${i}`;
  while (state.references[id]) id = `ext${++i}`;
  state.references[id] = { path: abs, name: path.basename(abs) || abs, kind };
  saveState(state);
  return { id, kind };
}

/**
 * Remove a node from the vault — non-destructively. A linked (referenced) item
 * is simply unlinked, leaving the user's real external files untouched. A
 * vault-resident file or folder is MOVED to a recoverable trash directory
 * (`.rag-vault/trash/<date>/…`) rather than deleted, and its inclusion flags
 * (and its subtree's) are dropped. The trash lives under the hidden state dir,
 * so it never reappears in the tree, and can be restored by hand.
 */
/** A token returned by removeFromVault; pass to restoreFromVault to undo. Both
 *  the inclusion and local-only flags round-trip. `localOnly` is optional so an
 *  older token (from before this change) still restores its inclusion. */
export type RestoreDescriptor =
  | { kind: "unlink"; root: string; path: string; included: Record<string, boolean>; localOnly?: Record<string, boolean> }
  | { kind: "flags"; included: Record<string, boolean>; localOnly?: Record<string, boolean> }
  | { kind: "trash"; id: string; trashPath: string; included: Record<string, boolean>; localOnly?: Record<string, boolean> };

/** Collect + drop a per-node flag map's entries for a node and its subtree,
 *  returning the removed (id → bool) pairs so a restore can put them back
 *  exactly. Used for BOTH `included` and `localOnly`. */
function takeFlagSubtree(
  map: Record<string, boolean>,
  nodeId: string,
): Record<string, boolean> {
  const taken: Record<string, boolean> = {};
  for (const k of Object.keys(map)) {
    if (k === nodeId || k.startsWith(`${nodeId}/`)) {
      taken[k] = map[k];
      delete map[k];
    }
  }
  return taken;
}

export function removeFromVault(nodeId: string): RestoreDescriptor {
  const state = loadState();
  const refId = refIdOf(nodeId, state.references);
  // The reference root itself: unlink the whole link; never move or delete the
  // real external files. Restore re-links the same real path.
  if (refId === nodeId) {
    const realPath = state.references[nodeId]?.path ?? "";
    const included = takeFlagSubtree(state.included, nodeId);
    const localOnly = takeFlagSubtree(state.localOnly, nodeId);
    delete state.references[nodeId];
    saveState(state);
    return { kind: "unlink", root: nodeId, path: realPath, included, localOnly };
  }
  // A node *inside* a linked folder: unlinking the whole reference here would
  // drop every sibling too, and we must never touch the user's real external
  // files. Scope the removal to just this node's subtree by dropping its
  // inclusion + local-only flags; the link itself stays intact.
  if (refId) {
    const included = takeFlagSubtree(state.included, nodeId);
    const localOnly = takeFlagSubtree(state.localOnly, nodeId);
    saveState(state);
    return { kind: "flags", included, localOnly };
  }
  const abs = safeAbs(nodeId); // refuses to escape the vault
  if (abs === vaultDir()) throw new Error("cannot remove the vault root");
  const included = takeFlagSubtree(state.included, nodeId);
  const localOnly = takeFlagSubtree(state.localOnly, nodeId);
  if (fs.existsSync(abs)) {
    const day = new Date().toISOString().slice(0, 10);
    const trashDir = path.join(stateDir(), "trash", day);
    fs.mkdirSync(trashDir, { recursive: true });
    let dest = path.join(trashDir, path.basename(nodeId));
    const ext = path.extname(dest);
    const base = dest.slice(0, dest.length - ext.length);
    for (let i = 1; fs.existsSync(dest); i++) dest = `${base} (${i})${ext}`;
    fs.renameSync(abs, dest);
    saveState(state);
    return { kind: "trash", id: nodeId, trashPath: dest, included, localOnly };
  }
  saveState(state);
  return { kind: "flags", included, localOnly };
}

/**
 * Reverse a removeFromVault using the descriptor it returned. Non-destructive:
 * refuses to overwrite if something now occupies the original location. Returns
 * the node's (possibly new) id.
 */
export function restoreFromVault(desc: RestoreDescriptor): { id?: string; ok?: boolean } {
  if (desc.kind === "unlink") {
    if (!desc.path) throw new Error("nothing to restore");
    const { id: newRoot } = addReference(desc.path); // may get a fresh extN id
    const state = loadState();
    // Older descriptors carry no localOnly key — absent ⇒ nothing to restore,
    // the same serde-default tolerance state.json itself relies on.
    const remap = (k: string): string =>
      k === desc.root
        ? newRoot
        : k.startsWith(`${desc.root}/`)
          ? `${newRoot}/${k.slice(desc.root.length + 1)}`
          : k;
    for (const [k, v] of Object.entries(desc.included)) state.included[remap(k)] = v;
    for (const [k, v] of Object.entries(desc.localOnly ?? {})) state.localOnly[remap(k)] = v;
    saveState(state);
    return { id: newRoot };
  }
  if (desc.kind === "flags") {
    const state = loadState();
    for (const [k, v] of Object.entries(desc.included)) state.included[k] = v;
    for (const [k, v] of Object.entries(desc.localOnly ?? {})) state.localOnly[k] = v;
    saveState(state);
    return { ok: true };
  }
  // trash: move the file back to its original location, refusing to clobber.
  const abs = safeAbs(desc.id);
  if (fs.existsSync(abs)) throw new Error("something already exists at the original location");
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.renameSync(desc.trashPath, abs);
  const state = loadState();
  for (const [k, v] of Object.entries(desc.included)) state.included[k] = v;
  for (const [k, v] of Object.entries(desc.localOnly ?? {})) state.localOnly[k] = v;
  saveState(state);
  return { id: desc.id };
}

/** Drop a reference (unlink). Leaves the real files on disk untouched. */
export function removeReference(refId: string): void {
  const state = loadState();
  if (!state.references[refId]) return;
  delete state.references[refId];
  for (const k of Object.keys(state.included)) {
    if (k === refId || k.startsWith(`${refId}/`)) delete state.included[k];
  }
  for (const k of Object.keys(state.localOnly)) {
    if (k === refId || k.startsWith(`${refId}/`)) delete state.localOnly[k];
  }
  saveState(state);
}

/**
 * File ids currently included on disk — the single source of truth for what
 * chat may see. Returns empty if the vault source is toggled unavailable.
 * This is what makes inclusion changes hot: the next answer reads this fresh,
 * so unselecting a file (or hiding the source) drops it immediately.
 */
export function activeIncludedFileIds(): string[] {
  const state = loadState();
  if (!state.sourceAvailable) return [];
  const defaultIn = defaultIncluded();
  return walk(vaultDir())
    .filter((n) => n.kind === "file" && isEffectivelyIncluded(n.id, state, defaultIn, true))
    .map((n) => n.id);
}

/**
 * The SHAREABLE set — the master gate for anything a provider could receive. On
 * the local/extractive path (`isCloud` false) it equals activeIncludedFileIds():
 * local-only marks are INERT, so on-device answers are byte-identical to today.
 * When a CLOUD provider is active it is the active-included set MINUS every
 * effectively-local-only id. Retrieval, doc-focus, cross-doc, and meta/catalog
 * answers all start here. KEEP IN SYNC with vault.rs::shareable_file_ids.
 */
export function shareableFileIds(isCloud: boolean): string[] {
  const ids = activeIncludedFileIds();
  if (!isCloud) return ids;
  const state = loadState();
  return ids.filter((id) => !isEffectivelyLocalOnly(id, state, true));
}

/**
 * The shareable candidate set with each file's CURRENT freshness key
 * (`mtimeMs:size`), in one walk + one state load: the answer cache's
 * candidate-digest input (openspec: add-answer-cache). Inherits every gate the
 * answer respects via `shareableFileIds`; an unreadable file participates with
 * an empty key (readable⇄unreadable is itself an answer-changing event).
 * KEEP IN SYNC with vault.rs::shareable_freshness_keys — same SHAPE, but the
 * twin stats mtime+size itself (PARITY: no persistent index here), so the
 * VALUES are twin-local and the twins never share a cache file.
 */
export function shareableFreshnessKeys(isCloud: boolean): [string, string][] {
  const state = loadState();
  return shareableFileIds(isCloud).map((id) => {
    let key = "";
    try {
      const st = fs.statSync(resolveAbs(id, state));
      key = `${st.mtimeMs}:${st.size}`;
    } catch {
      /* unreadable — the empty key still participates in the digest */
    }
    return [id, key];
  });
}

/**
 * Drop effectively-local-only ids from `ids` when a cloud provider is active;
 * pass `ids` through unchanged on the device path. The reusable filter the two
 * gate-BYPASSERS (attachments, doc-focus) apply at their own choke points.
 * KEEP IN SYNC with vault.rs::shareable_subset.
 */
export function shareableSubset(ids: string[], isCloud: boolean): string[] {
  if (!isCloud) return ids.slice();
  const state = loadState();
  return ids.filter((id) => !isEffectivelyLocalOnly(id, state, true));
}

/**
 * The effectively-local-only ids among `ids` — the files a cloud answer must
 * DROP solely for being marked private. Empty on the device path. Drives the
 * honest skip note. KEEP IN SYNC with vault.rs::local_only_subset.
 */
export function localOnlySubset(ids: string[], isCloud: boolean): string[] {
  if (!isCloud) return [];
  const state = loadState();
  return ids.filter((id) => isEffectivelyLocalOnly(id, state, true));
}

/**
 * Per-file read cap. A vault can hold very large text files (e.g. a 150 MB CSV
 * dataset); reading and chunking one whole would stall — or OOM — a query. The
 * first slice is more than enough for relevance matching, so we cap the read.
 */
const MAX_TEXT_BYTES = 1_000_000;

/**
 * Read a file's text, or "" for unsupported/binary types. Resolves the node id
 * to its real path first, so referenced files (whose id is a synthetic `extN`
 * with no extension) are read — and type-checked — by their true path. Files
 * larger than MAX_TEXT_BYTES are read up to that prefix only.
 */
async function readText(nodeId: string, state: VaultState): Promise<string> {
  let abs: string;
  try {
    abs = resolveAbs(nodeId, state);
  } catch {
    return "";
  }
  return readTextAbs(abs);
}

/**
 * Read text from an absolute path — used for vault files and for the local
 * mirror of a cloud (SharePoint) file. Rich formats (pdf/docx/xlsx) go through
 * the parser with its own size handling and cache; plain text is read directly,
 * capped at MAX_TEXT_BYTES.
 */
export async function readTextAbs(abs: string): Promise<string> {
  if (isRichFile(abs)) return extractRichText(abs, path.extname(abs).toLowerCase());
  if (!isTextFile(abs)) return "";
  try {
    let size = 0;
    try {
      size = fs.statSync(abs).size;
    } catch {
      size = 0;
    }
    if (size <= MAX_TEXT_BYTES) return fs.readFileSync(abs, "utf8");
    // Large file: read only the first MAX_TEXT_BYTES so it can't blow up memory
    // or stall the query. Enough text to match on.
    const fd = fs.openSync(abs, "r");
    try {
      const buf = Buffer.allocUnsafe(MAX_TEXT_BYTES);
      const read = fs.readSync(fd, buf, 0, MAX_TEXT_BYTES, 0);
      return buf.subarray(0, read).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

const STOP = new Set(
  "the a an and or of to in is are for on with as at by from this that it be do does have any there my our your you me i".split(
    " ",
  ),
);
function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]{2,}/g)?.filter((t) => !STOP.has(t)) ?? [];
}

/** Crude singularizer so "cards" matches "card". */
function singular(t: string): string {
  return t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t;
}

/** Searchable tokens from a file's name and path (so it's findable by what it's
 *  called, not only by its contents). */
function nameTokensOf(id: string, name: string): string[] {
  return tokenize(`${id.replace(/\//g, " ")} ${name}`);
}

/** Extension-ish tokens that don't count as "naming" a file in a question. */
const EXT_TOKENS = new Set([
  "xlsx", "xlsm", "xls", "csv", "tsv", "pdf", "docx", "doc", "md", "txt", "parquet",
  "pptx", "json", "html", "log",
]);

/**
 * Vault files the question NAMES (every meaningful name token appears in the
 * question) that are NOT currently included — feeds the deterministic
 * "it exists but the AI can't see it" note in the answer pipeline. KEEP IN
 * SYNC with vault.rs::named_but_excluded. Returns display names, capped at 2.
 */
export function namedButExcluded(question: string): string[] {
  const qtokens = tokenize(question).map(singular);
  if (qtokens.length === 0) return [];
  const active = new Set(activeIncludedFileIds());
  const out: string[] = [];
  for (const node of walk(vaultDir())) {
    if (node.kind !== "file" || active.has(node.id)) continue;
    const meaningful = tokenize(node.name).filter((t) => t.length >= 3 && !EXT_TOKENS.has(t));
    if (meaningful.length === 0 || !meaningful.some((t) => t.length >= 4)) continue;
    const allPresent = meaningful.every((nt0) => {
      const nt = singular(nt0);
      return qtokens.some((q) => q === nt || q.includes(nt) || (q.length >= 3 && nt.includes(q)));
    });
    if (allPresent) {
      out.push(node.name);
      if (out.length === 2) break;
    }
  }
  return out;
}

/**
 * How strongly the query matches a file's name/path tokens. Substring matching
 * lets "credit"/"card" hit a file literally named "creditcard.csv", and the
 * singularizer bridges "cards"→"card". `strong` requires a real (≥4-char) word
 * to match, so noise like "csv" alone doesn't qualify a file.
 */
function nameMatch(qTokens: string[], nameToks: string[]): { hits: number; strong: boolean } {
  let hits = 0;
  let strong = false;
  for (const raw of qTokens) {
    const q = singular(raw);
    if (q.length < 3) continue;
    const hit = nameToks.some((nt0) => {
      const nt = singular(nt0);
      return nt === q || nt.includes(q) || (nt.length >= 3 && q.includes(nt));
    });
    if (hit) {
      hits++;
      if (raw.length >= 4) strong = true;
    }
  }
  return { hits, strong };
}

/**
 * The named-file pin's target, if any: the single file whose meaningful
 * name/path tokens the question covers substantially enough to read as "the
 * user named this file". Deliberately conservative — the pin FORCES a file
 * into the top-k, so a weak or ambiguous match must select nothing (0.6.2
 * field report: a lone generic token shared with a filename pinned irrelevant
 * files). KEEP IN SYNC with vault.rs::pinned_named_file. Rules:
 *   - coverage: the question must mention at least half of the file's unique
 *     meaningful name tokens (len ≥ 3, extension tokens dropped);
 *   - specificity: ≥ 2 covered tokens, or a single-token name whose token is
 *     ≥ 5 chars ("resume" can pin, "plan" never does);
 *   - uniqueness: two files with the same coverage signature mean the phrase
 *     is generic (meeting-notes-1/2/3…) — pin nothing.
 */
export function pinnedNamedFile(
  qtokens: string[],
  files: { id: string; toks: string[] }[],
): string | null {
  let best: { id: string; c: number; m: number } | null = null;
  let ambiguous = false;
  for (const f of files) {
    const uniq = [
      ...new Set(f.toks.map(singular).filter((t) => t.length >= 3 && !EXT_TOKENS.has(t))),
    ];
    if (uniq.length === 0) continue;
    const covered = uniq.filter((nt) =>
      qtokens.some((q0) => {
        const q = singular(q0);
        return q.length >= 3 && (q === nt || nt.includes(q) || q.includes(nt));
      }),
    );
    const c = covered.length;
    const m = uniq.length;
    const specific = c >= 2 || (m === 1 && (covered[0]?.length ?? 0) >= 5);
    if (c * 2 < m || !specific) continue;
    if (!best) {
      best = { id: f.id, c, m };
      continue;
    }
    // Compare coverage fractions via cross-multiplication (c/m vs bc/bm),
    // then absolute covered count. An exact tie on both is the
    // generic-siblings case.
    const lhs = c * best.m;
    const rhs = best.c * m;
    if (lhs > rhs || (lhs === rhs && c > best.c)) {
      best = { id: f.id, c, m };
      ambiguous = false;
    } else if (lhs === rhs && c === best.c) {
      ambiguous = true;
    }
  }
  return best && !ambiguous ? best.id : null;
}

// --- catalog / listing queries -----------------------------------------------
interface Listing {
  label: string;
  match: (name: string) => boolean;
}

const LISTING_EXT: Record<string, string[]> = {
  dataset: [".csv", ".tsv", ".xlsx", ".xlsm", ".xls", ".parquet", ".json", ".arrow", ".feather"],
  spreadsheet: [".csv", ".tsv", ".xlsx", ".xlsm", ".xls"],
  document: [".md", ".markdown", ".txt", ".text", ".rst", ".doc", ".docx", ".pdf", ".rtf", ".odt"],
  pdf: [".pdf"],
};

// Catalog scaffolding tokens — verbs, determiners, and quantifiers that frame a
// "list my files" request but carry no content of their own.
const LISTING_FILLER = new Set([
  "show", "me", "list", "give", "please", "can", "could", "would", "you", "display",
  "name", "names", "enumerate", "tell", "what", "which", "how", "many", "much",
  "are", "there", "is", "do", "does", "did", "i", "we", "my", "our", "the", "a",
  "an", "all", "every", "each", "of", "in", "on", "to", "get", "see", "view",
  "find", "catalog", "catalogue", "count", "number", "total", "available",
  "included", "uploaded", "stored", "have", "has", "any",
]);
// Catalog nouns (singular/plural) that name the kind being enumerated.
const LISTING_NOUN = new Set([
  "file", "files", "dataset", "datasets", "document", "documents", "doc", "docs",
  "pdf", "pdfs", "spreadsheet", "spreadsheets", "csv", "csvs", "table", "tables",
  "source", "sources",
]);
// File-type qualifiers ("csv files", "pdf documents") — extension-like adjectives
// mapped to the concrete extensions they name. A named type narrows the listing
// to exactly those extensions, overriding the broad noun-based kind.
const LISTING_QUALIFIER: Record<string, string[]> = {
  csv: [".csv"], tsv: [".tsv"], xlsx: [".xlsx"], xlsm: [".xlsm"], xls: [".xls"],
  parquet: [".parquet"], json: [".json"], arrow: [".arrow"], feather: [".feather"],
  md: [".md", ".markdown"], markdown: [".md", ".markdown"],
  txt: [".txt", ".text"], text: [".txt", ".text"], rst: [".rst"], rtf: [".rtf"],
  odt: [".odt"], docx: [".docx"], xml: [".xml"], html: [".html"],
};

/**
 * Detect a catalog-style query ("show me all files", "list my datasets", "how
 * many documents") — which should ENUMERATE the included set rather than rank by
 * relevance — and which file kind it refers to. Returns null for an ordinary
 * content question (e.g. "what's in the budget file": singular, no list cue).
 */
function listingIntent(query: string): Listing | null {
  const q = query.toLowerCase();
  const m = q.match(/\b(file|dataset|document|doc|pdf|spreadsheet|csv|table|source)(s)?\b/);
  if (!m) return null;
  const plural = Boolean(m[2]);
  const verb = /\b(show|list|give|display|name|what|which|how many|enumerate|tell)\b/.test(q);
  if (!verb) return null;
  // A singular noun needs an explicit "all/every/list/how many" cue so a content
  // question about one file ("summarize the report file") doesn't trip this.
  const strong = /\b(all|every|each|list|how many|enumerate|catalog|catalogue)\b/.test(q);
  if (!plural && !strong) return null;

  // Only a pure catalog request should enumerate. Strip the catalog scaffolding
  // (verbs, determiners, the catalog noun, and any file-type qualifier); if any
  // meaningful content token survives, this is a content question — e.g. "which
  // documents mention the lawsuit" — so fall through to relevance ranking.
  const tokens = q.match(/[a-z0-9]+/g) ?? [];
  const residual = tokens.filter(
    (t) => !LISTING_FILLER.has(t) && !LISTING_NOUN.has(t) && !LISTING_QUALIFIER[t],
  );
  if (residual.length > 0) return null;

  // A named file-type qualifier (including a catalog noun that is itself a
  // concrete type, e.g. "csvs") narrows the listing to exactly its extensions,
  // overriding the broad noun-based kind below.
  const qualWords: string[] = [];
  const qualExts = new Set<string>();
  for (const t of tokens) {
    const base = LISTING_QUALIFIER[t]
      ? t
      : t.endsWith("s") && LISTING_QUALIFIER[t.slice(0, -1)]
        ? t.slice(0, -1)
        : null;
    if (base && !qualWords.includes(base)) {
      qualWords.push(base);
      for (const e of LISTING_QUALIFIER[base]) qualExts.add(e);
    }
  }
  if (qualExts.size > 0)
    return {
      label: `${qualWords.map((w) => w.toUpperCase()).join("/")} files`,
      match: (name) => qualExts.has(path.extname(name).toLowerCase()),
    };

  const noun = m[1];
  const kind =
    noun === "dataset" || noun === "csv" || noun === "table"
      ? "dataset"
      : noun === "spreadsheet"
        ? "spreadsheet"
        : noun === "document" || noun === "doc"
          ? "document"
          : noun === "pdf"
            ? "pdf"
            : "all";
  if (kind === "all") return { label: "files", match: () => true };
  const exts = new Set(LISTING_EXT[kind]);
  return {
    label: kind === "pdf" ? "PDFs" : `${kind}s`,
    match: (name) => exts.has(path.extname(name).toLowerCase()),
  };
}

/** Enumerate the included files matching a listing intent (capped for huge vaults). */
function buildListing(nodes: FileNode[], intent: Listing): Retrieved {
  const files = nodes.filter((n) => intent.match(n.name));
  if (files.length === 0)
    return {
      references: [],
      contexts: [{ name: `Included ${intent.label}`, text: `No included ${intent.label} found.`, score: 1 }],
    };
  const names = files.map((f) => f.name);
  // Cap the prose list at the same count as the citeable references below so
  // every named file has a corresponding clickable citation.
  const CAP = 50;
  const list =
    `${files.length} included ${intent.label}:\n` +
    names.slice(0, CAP).map((n) => `- ${n}`).join("\n") +
    (names.length > CAP ? `\n…and ${names.length - CAP} more` : "");
  const references: RagReference[] = files.slice(0, CAP).map((f) => ({
    fileId: f.id,
    name: f.name,
    snippet: "",
    score: 1,
    kind: sourceKindOf(f.id),
  }));
  return { references, contexts: [{ name: `Included ${intent.label}`, text: list, score: 1 }] };
}

interface Chunk { fileId: string; name: string; text: string; tf: Map<string, number>; }

function chunksOf(text: string, fileId: string, name: string): Chunk[] {
  const texts = chunkTextsNamed(name, text);
  return texts.map((slice) => {
    const tf = new Map<string, number>();
    for (const t of tokenize(slice)) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { fileId, name, text: slice, tf };
  });
}

/**
 * Structure-aware chunking (docs/analytics-beam.md, B1): tabular extracts
 * chunk by ROWS with the header line(s) prepended to every chunk, so a chunk
 * holding row 400 still carries its column names; prose keeps the 120-word
 * windows. KEEP BYTE-IDENTICAL with the Rust twin (vault.rs chunk_texts_named).
 */
export function chunkTextsNamed(name: string, text: string): string[] {
  const lower = name.toLowerCase();
  const tabular = [".csv", ".tsv", ".parquet", ".xlsx", ".xlsm", ".xls"].some((e) => lower.endsWith(e));
  if (tabular) return chunkTabular(name, text);
  return chunkTextsProse(text);
}

function chunkTabular(name: string, text: string): string[] {
  const ROWS = 30, ROW_OVERLAP = 5;
  const lower = name.toLowerCase();
  // Workbook extracts prepend the sheet name above each sheet's CSV; carry
  // BOTH the sheet line and the header row into every chunk.
  const headerLines =
    lower.endsWith(".xlsx") || lower.endsWith(".xlsm") || lower.endsWith(".xls") ? 2 : 1;
  const chunks: string[] = [];
  for (const block of text.split("\n\n")) {
    const lines = block
      .split("\n")
      .map((l) => l.replace(/\s+$/, ""))
      .filter((l) => l.trim() !== "");
    if (lines.length === 0) continue;
    const h = Math.min(headerLines, Math.max(0, lines.length - 1));
    if (lines.length <= h + 1) {
      chunks.push(lines.join("\n"));
      continue;
    }
    const header = lines.slice(0, h).join("\n");
    const data = lines.slice(h);
    for (let i = 0; i < data.length; i += ROWS - ROW_OVERLAP) {
      const body = data.slice(i, i + ROWS).join("\n");
      chunks.push(header ? `${header}\n${body}` : body);
      if (i + ROWS >= data.length) break;
    }
  }
  return chunks;
}

function chunkTextsProse(text: string): string[] {
  const words = text.split(/\s+/);
  const SIZE = 120, OVERLAP = 25;
  const out: string[] = [];
  for (let i = 0; i < words.length; i += SIZE - OVERLAP) {
    const slice = words.slice(i, i + SIZE).join(" ").trim();
    if (slice) out.push(slice);
    if (i + SIZE >= words.length) break;
  }
  return out;
}

export interface Retrieved {
  references: RagReference[];
  contexts: { name: string; text: string; score: number; kind?: "file" | "conversation" }[];
}

/** Bound total chunks scored per query so many/large files can't stall it. */
const MAX_TOTAL_CHUNKS = 4000;

/**
 * Retrieval over the included files. Combines TF-IDF cosine over file *content*
 * with a *filename/path* match — so a file is findable both by what it contains
 * and by what it's called. (A file literally named "creditcard.csv" answers
 * "do I have any credit cards?" even when its rows are anonymized numbers.)
 * `preferredConversationIds` (openspec: add-investigations) names the current
 * investigation's conversations so a recall cue can prefer THEIR notes over
 * global ones — empty means no preference (byte-identical to the
 * pre-investigations ranking).
 */
export async function retrieve(
  query: string,
  includedFileIds: string[],
  k = 5,
  external: { id: string; name: string; abs: string }[] = [],
  attachmentIds: string[] = [],
  isCloud = false,
  preferredConversationIds: string[] = [],
): Promise<Retrieved> {
  // Explicit per-question attachments: the user dragged/attached these specific
  // files to *this* question, so honor them directly and scope retrieval to only
  // them — even if they aren't in the global included set (the attach gesture is
  // the consent). They're still validated to real vault files by the `walk`
  // filter below, so a client can't name a file outside the vault.
  //
  // Otherwise, server-authoritative inclusion: intersect the caller's set with
  // what is actually included on disk right now, so unselecting a file (or
  // hiding the source) removes it from the very next answer — a stale client
  // cannot leak an excluded file into retrieval. (Cloud items arrive pre-filtered
  // in `external`, already scoped to enabled, mirrored files by the registry.)
  //
  // When a CLOUD provider is active (`isCloud`), both branches are narrowed to
  // the SHAREABLE set so an effectively-local-only file's content never reaches
  // the vendor: attachments filter at this bypasser's own choke point, and the
  // authoritative gate becomes shareableFileIds (which also blocks a stale
  // client from resurrecting an excluded OR a local-only file).
  let idset: Set<string>;
  if (attachmentIds.length > 0) {
    idset = new Set(shareableSubset(attachmentIds, isCloud));
  } else {
    const authoritative = new Set(shareableFileIds(isCloud));
    idset = new Set(includedFileIds.filter((id) => authoritative.has(id)));
  }
  // Mirrored cloud-connector items bypass the vault gate — drop any that are
  // effectively-local-only when cloud is active, at this choke point.
  if (isCloud && external.length > 0) {
    const state = loadState();
    external = external.filter((e) => !isEffectivelyLocalOnly(e.id, state, true));
  }
  const nodes = walk(vaultDir()).filter((n) => n.kind === "file" && idset.has(n.id));
  if (nodes.length === 0 && external.length === 0) return { references: [], contexts: [] };

  // Catalog/listing intent ("show me all files", "list my datasets") enumerates
  // vault files (cloud placeholders aren't part of the vault tree); content
  // retrieval below spans both the vault and mirrored cloud files.
  if (nodes.length > 0) {
    const listing = listingIntent(query);
    if (listing) return buildListing(nodes, listing);
  }

  const qtokens = tokenize(query);
  if (qtokens.length === 0) return { references: [], contexts: [] };

  const state = loadState();
  // Unified retrieval items: vault files (read by node id) and mirrored cloud
  // files (read by absolute mirror path). `pathFor` seeds name-token matching —
  // vault ids are real paths; cloud ids are opaque, so match on the name only.
  const items: { id: string; name: string; pathFor: string; read: () => Promise<string> }[] = [
    ...nodes.map((n) => ({ id: n.id, name: n.name, pathFor: n.id, read: () => readText(n.id, state) })),
    ...external.map((e) => ({ id: e.id, name: e.name, pathFor: "", read: () => readTextAbs(e.abs) })),
  ];
  const nameToks = new Map<string, string[]>();
  for (const it of items) nameToks.set(it.id, nameTokensOf(it.pathFor, it.name));
  const preview = new Map<string, string>(); // first content slice, for name-only hits
  const chunks: Chunk[] = [];
  for (const it of items) {
    const text = await it.read();
    if (text.trim()) {
      const cs = chunksOf(text, it.id, it.name);
      preview.set(it.id, cs[0]?.text.slice(0, 240) ?? "");
      for (const c of cs) {
        chunks.push(c);
        if (chunks.length >= MAX_TOTAL_CHUNKS) break;
      }
    }
    if (chunks.length >= MAX_TOTAL_CHUNKS) break;
  }

  // --- content scoring (TF-IDF cosine over chunks) ---
  let scored: { c: Chunk; score: number }[] = [];
  if (chunks.length > 0) {
    const df = new Map<string, number>();
    for (const c of chunks) for (const t of c.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    const N = chunks.length;
    const idf = (t: string) => Math.log((N + 1) / ((df.get(t) ?? 0) + 1)) + 1;
    const qtf = new Map<string, number>();
    for (const t of qtokens) qtf.set(t, (qtf.get(t) ?? 0) + 1);
    const vec = (tf: Map<string, number>) => {
      const v = new Map<string, number>();
      let norm = 0;
      for (const [t, f] of tf) {
        const w = f * idf(t);
        v.set(t, w);
        norm += w * w;
      }
      return { v, norm: Math.sqrt(norm) || 1 };
    };
    const q = vec(qtf);
    scored = chunks.map((c) => {
      const d = vec(c.tf);
      let dot = 0;
      for (const [t, w] of q.v) dot += w * (d.v.get(t) ?? 0);
      let score = dot / (q.norm * d.norm);
      // Nudge a chunk up when its file also matches by name (name + content).
      const nm = nameMatch(qtokens, nameToks.get(c.fileId) ?? []);
      if (nm.strong) score += 0.2 * (nm.hits / qtokens.length);
      return { c, score };
    });
  }

  // Build merged candidates: scored content chunks, plus a synthetic entry for
  // any file that matches by name but isn't already represented by its content.
  interface Cand { fileId: string; name: string; text: string; score: number }
  const cands: Cand[] = scored
    .filter((s) => s.score > 0)
    .map((s) => ({ fileId: s.c.fileId, name: s.c.name, text: s.c.text, score: s.score }));
  const present = new Set(cands.map((c) => c.fileId));
  for (const it of items) {
    if (present.has(it.id)) continue;
    const nm = nameMatch(qtokens, nameToks.get(it.id) ?? []);
    if (nm.hits === 0 || !nm.strong) continue;
    const pv = preview.get(it.id) ?? "";
    cands.push({
      fileId: it.id,
      name: it.name,
      text: pv || "(matched by file name; no readable text could be extracted)",
      score: 0.5 + 0.4 * (nm.hits / qtokens.length), // 0.5..0.9
    });
  }

  // G6 recall cue: "what did I ask/conclude about X" biases toward past-
  // conversation notes so synthesis draws on them. Deterministic — only scales
  // existing conversation-kind cands before the sort. KEEP IN SYNC with vault.rs.
  //
  // Investigation preference (openspec: add-investigations): where the cue
  // boosts conversation notes, a note BELONGING to the ask's investigation —
  // its filename's [cid8] matches a preferred conversation id, the same
  // derivation writeConversationNote bracketed in — is lifted a further
  // INVESTIGATION_BOOST. Preference, not exclusion: global notes keep their
  // CONV_BOOST and still surface, ordered after.
  if (recallCue(query)) {
    const preferredCid8s = new Set(preferredConversationIds.map(conversationCid8));
    for (const c of cands) {
      if (sourceKindOf(c.fileId) === "conversation") {
        c.score *= CONV_BOOST;
        if (preferredCid8s.size > 0) {
          const cid = noteCid8Of(c.fileId);
          if (cid !== null && preferredCid8s.has(cid)) c.score *= INVESTIGATION_BOOST;
        }
      }
    }
  }
  const sorted = cands.sort((a, b) => b.score - a.score);
  const top = sorted.slice(0, k);
  // Named-file guarantee: a question that strongly names a file MUST surface
  // that file — keyword-heavy chunks from other files can otherwise crowd it
  // out of the top-k (and the Rust engine's hybrid scores make that routine;
  // see vault.rs::retrieve). KEEP IN SYNC with the Rust twin.
  const named = pinnedNamedFile(
    qtokens,
    items.map((it) => ({ id: it.id, toks: nameToks.get(it.id) ?? [] })),
  );
  if (named && !top.some((c) => c.fileId === named)) {
    const best = sorted.find((c) => c.fileId === named);
    if (best) {
      if (top.length >= k && top.length > 0) top.pop();
      top.push(best);
    }
  }
  if (top.length === 0) return { references: [], contexts: [] };

  const max = top[0].score || 1;
  // one reference per file (best chunk), but keep all top chunks as context
  const seen = new Set<string>();
  const references: RagReference[] = [];
  for (const c of top) {
    if (seen.has(c.fileId)) continue;
    seen.add(c.fileId);
    references.push({
      fileId: c.fileId,
      name: c.name,
      snippet: c.text.slice(0, 240).trim() + (c.text.length > 240 ? "…" : ""),
      score: Math.min(1, c.score / max),
      kind: sourceKindOf(c.fileId),
    });
  }
  const contexts = top.map((c) => ({
    name: c.name,
    text: c.text,
    score: Math.min(1, c.score / max),
    kind: sourceKindOf(c.fileId),
  }));
  return { references, contexts };
}

/**
 * A file's display name + extracted text, for the synthesis pipeline: table
 * profiles need the full content; `previewChars` bounds the map-step fallback
 * used when a generic query's tokens miss the file's content entirely.
 */
export async function docText(
  fileId: string,
  previewChars?: number,
): Promise<{ name: string; text: string } | null> {
  const node = walk(vaultDir()).find((n) => n.kind === "file" && n.id === fileId);
  if (!node) return null;
  const text = await readText(fileId, loadState());
  if (!text.trim()) return null;
  return { name: node.name, text: previewChars ? text.slice(0, previewChars) : text };
}

/**
 * The single INCLUDED vault file the question NAMES, if any — the synth
 * pipeline's single-document-focus detector. Same conservative matcher as the
 * in-retrieve named pin (ambiguity ⇒ null), over the same `nameTokensOf`
 * tokens. KEEP IN SYNC with vault.rs::named_file_target.
 */
export function namedFileTarget(
  question: string,
  includedFileIds: string[],
): [string, string] | null {
  const qtokens = tokenize(question);
  if (qtokens.length === 0) return null;
  const included = new Set(includedFileIds);
  const files = walk(vaultDir())
    .filter((n) => n.kind === "file" && included.has(n.id))
    .map((n) => ({ id: n.id, name: n.name, toks: nameTokensOf(n.id, n.name) }));
  const id = pinnedNamedFile(qtokens, files);
  const hit = files.find((f) => f.id === id);
  return hit ? [hit.id, hit.name] : null;
}

/**
 * A document's display name + ORDERED chunk texts — the same byte-identical
 * chunker the index uses — for whole-document coverage in the synth pipeline
 * (doc-focus). Null when the file is missing or extracts empty. KEEP IN SYNC
 * with vault.rs::doc_chunks.
 */
export async function docChunks(fileId: string): Promise<[string, string[]] | null> {
  const doc = await docText(fileId);
  if (!doc) return null;
  const chunks = chunkTextsNamed(doc.name, doc.text);
  if (chunks.length === 0) return null;
  return [doc.name, chunks];
}
