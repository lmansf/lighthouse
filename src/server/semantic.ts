/**
 * The semantic layer, TS twin (openspec: add-semantic-layer §1). KEEP IN SYNC
 * with native semantic.rs: same record shapes (camelCase on the wire), the
 * same versioned envelope `{v: 1, metrics, synonyms}` written with the shared
 * atomic writer, the same id minting, the same validation and error strings,
 * the same CRUD/lifecycle (metric rename/delete refuse or cascade against
 * dependent synonyms), and the same local-only propagation. (Declared join
 * hints + their backing entities were removed in field-patch-0.12.5 §3 for
 * having no authoring UI; a v1 file that still carries `entities`/`joinHints`
 * keys loads cleanly — the keys are ignored and dropped on the next write.)
 *
 * A METRIC names a messy DEFINITION once — `{id, name, expression,
 * description, entity, reads, summary, createdMs}` — with the same store
 * machinery as a shaped view (views.ts). Its `reads`/`summary` REUSE the view
 * types verbatim, and the name rules REUSE views' `normalizeViewName` +
 * `RESERVED_NAMES`, so a metric's wire and name sanitization are byte-identical
 * to a view's.
 *
 * NAMING: the existing `DesktopSettings.semanticSearch` is the UNRELATED
 * hybrid-embedding retrieval toggle; this module is the semantic LAYER
 * (business meaning). It adds NO setting — the store is the state.
 *
 * PARITY (deliberate divergences — analytics/DataFusion is Rust-engine-only):
 *   - The definition guard reuses views' conservative TEXTUAL single-SELECT
 *     check (`guardViewSql`) and the `reads` derivation reuses the FROM/JOIN
 *     identifier scan (`collectTableNames`); the authoritative guard + AST walk
 *     are Rust-only, and the desktop re-guards before every execution.
 *   - The name-shadow check needs the column catalog (Rust-only), so this
 *     twin's `createMetric` passes NO columns and skips it;
 *     `createMetricWithContext` still takes the columns param for symmetry.
 *   - This twin never certifies/reconciles an answer (§3/§4 are Rust-only).
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { stateDir, writeJson } from "./config";
import { listNodes, localOnlySubset } from "./vault";
import {
  RESERVED_NAMES,
  collectTableNames,
  guardViewSql,
  listViews,
  normalizeViewName as normalizeName,
  sanitizeTableName,
  uniqueTableName,
  viewEffectivelyLocalOnly,
  type View,
  type ViewReads,
  type ViewSummary,
} from "./views";

/** Envelope version this engine reads and writes. */
const STORE_VERSION = 1;

/**
 * Placeholder projection alias for a synthesized metric definition — the guard
 * and the reads scan don't depend on it. KEEP IN SYNC with
 * analytics.rs::METRIC_ALIAS.
 */
const METRIC_ALIAS = "metric_value";

// --- Records (camelCase wire) ------------------------------------------------------

/**
 * A canonical metric: a business name bound to a guarded, re-runnable
 * aggregation `expression` over a named `entity`. `reads`/`summary` reuse the
 * view types (byte-identical wire).
 */
export interface Metric {
  /** `metric-` + first 12 hex of sha1(name \n expression \n createdMs). */
  id: string;
  /** Sanitized identifier, unique case-insensitively among metrics. */
  name: string;
  /** The aggregation EXPRESSION (guard-validated at save), not a statement. */
  expression: string;
  /** The authored business meaning, rendered into the prompt block (§2). */
  description: string;
  /** The entity (table / saved view) the expression aggregates over. */
  entity: string;
  /** Dependencies derived from the synthesized definition (view `reads`). */
  reads: ViewReads;
  /** Provenance-labeled one-liner (the "Define as metric" precedent). */
  summary: ViewSummary;
  /** Creation instant (epoch ms). */
  createdMs: number;
}

/** A colloquial term mapped to a canonical column OR metric name. */
export interface Synonym {
  term: string;
  canonical: string;
}

/** The two record kinds — the full store, or the posture-eligible subset. */
export interface SemanticSet {
  metrics: Metric[];
  synonyms: Synonym[];
}

// --- Store (versioned envelope, bak-on-write — the views.ts posture) ---------------

function semanticPath(): string {
  return path.join(stateDir(), "semantic.json");
}

function emptySet(): SemanticSet {
  return { metrics: [], synonyms: [] };
}

/**
 * A readable v1 envelope's records, or `null` when the text is not one
 * (unknown/missing version, or unparseable JSON — the two read identically).
 * PARITY: this twin trusts the arrays wholesale once the envelope checks pass;
 * the Rust engine's serde also rejects records with malformed required fields.
 * A legacy file that still carries `entities`/`joinHints` keys loads cleanly —
 * the keys are ignored (never required), mirroring serde's unknown-field posture.
 */
function parseStore(text: string): SemanticSet | null {
  try {
    const parsed = JSON.parse(text) as { v?: unknown } & Partial<SemanticSet>;
    if (
      parsed &&
      parsed.v === STORE_VERSION &&
      Array.isArray(parsed.metrics) &&
      Array.isArray(parsed.synonyms)
    ) {
      return {
        metrics: parsed.metrics,
        synonyms: parsed.synonyms,
      };
    }
  } catch {
    /* fall through — unparseable is unreadable */
  }
  return null;
}

type Loaded =
  | { kind: "records"; records: SemanticSet }
  | { kind: "missing" }
  // Present but not a readable v1 envelope — reads empty for the session; the
  // next write baks the file first (never clobber silently).
  | { kind: "unreadable" };

function load(): Loaded {
  let text: string;
  try {
    text = fs.readFileSync(semanticPath(), "utf8");
  } catch {
    return { kind: "missing" };
  }
  const records = parseStore(text);
  return records ? { kind: "records", records } : { kind: "unreadable" };
}

/** The whole semantic layer. KEEP IN SYNC with semantic.rs::list. */
export function listSemantic(): SemanticSet {
  const loaded = load();
  return loaded.kind === "records" ? cloneSet(loaded.records) : emptySet();
}

function save(set: SemanticSet): void {
  const target = semanticPath();
  // Versioning posture: an unreadable file is preserved as a `.bak-<epochms>`
  // sibling before the fresh v1 write (mirrors semantic.rs / views.ts).
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
  // Key order is the byte contract with the Rust engine. (No entities/joinHints
  // keys — the declared-join machinery was removed in field-patch-0.12.5 §3.)
  writeJson(target, {
    v: STORE_VERSION,
    metrics: set.metrics,
    synonyms: set.synonyms,
  });
}

function cloneMetric(m: Metric): Metric {
  return {
    ...m,
    reads: { files: m.reads.files.map((f) => ({ ...f })), views: [...m.reads.views] },
    summary: { ...m.summary },
  };
}

function cloneSet(set: SemanticSet): SemanticSet {
  return {
    metrics: set.metrics.map(cloneMetric),
    synonyms: set.synonyms.map((s) => ({ ...s })),
  };
}

/**
 * Stable engine-minted id: `<prefix>-` + first 12 hex of
 * sha1(name \n expression \n createdMs). KEEP IN SYNC with semantic.rs::mint_id.
 */
function mintId(prefix: string, name: string, expression: string, createdMs: number): string {
  return `${prefix}-${crypto
    .createHash("sha1")
    .update(`${name}\n${expression}\n${createdMs}`)
    .digest("hex")
    .slice(0, 12)}`;
}

// --- Definition guard (PARITY: textual here; guard_sql's parser on the desktop) -----

/**
 * Guard a metric definition: synthesize `SELECT <expression> AS metric_value
 * FROM <entity>`, run views' textual single-SELECT guard, and return the table
 * names the definition references (the FROM/JOIN scan). Throws the guard's
 * reason on refusal. KEEP IN SYNC with analytics.rs::guard_metric_expression.
 *
 * PARITY: `guard_sql`'s real parser + AST walk are Rust-only; this reuses the
 * same conservative textual check + FROM/JOIN scan the shaped-view twin uses.
 */
export function guardMetricExpression(expression: string, entity: string): string[] {
  const sql = `SELECT ${expression} AS ${METRIC_ALIAS} FROM ${entity}`;
  const guardErr = guardViewSql(sql);
  if (guardErr) throw new Error(guardErr);
  return collectTableNames(sql);
}

// --- Local-only propagation + posture (§1.4) ---------------------------------------

/** Pure propagation over `reads` given the resolved view records. */
function readsLocalOnly(reads: ViewReads, viewRecords: View[]): boolean {
  if (reads.files.some((f) => localOnlySubset([f.fileId], true).length > 0)) {
    return true;
  }
  return reads.views.some((vid) => {
    const v = viewRecords.find((r) => r.id === vid);
    return v ? viewEffectivelyLocalOnly(v, viewRecords) : false;
  });
}

/**
 * TRANSITIVE local-only propagation for a metric's `reads`: local-only when any
 * read file carries an effective mark, or any read view is
 * `viewEffectivelyLocalOnly`. KEEP IN SYNC with
 * semantic.rs::metric_effectively_local_only.
 */
export function metricEffectivelyLocalOnly(reads: ViewReads): boolean {
  return readsLocalOnly(reads, listViews());
}

/** KEEP IN SYNC with analytics::is_tabular — the table-registration gate. */
const TABULAR_EXT = [".csv", ".tsv", ".parquet", ".xlsx", ".xlsm", ".xls"];
function isRegistrable(name: string): boolean {
  const n = name.toLowerCase();
  return n.endsWith(".pdf") || TABULAR_EXT.some((e) => n.endsWith(e));
}

// --- Env-gated per-kind ablation hook (openspec: field-patch-0.12.5 §3) ------------
//
// PARITY: mirrors semantic.rs's `Ablation`. The MEASUREMENT instrument for the
// business-definitions study — each surviving hand-authored kind (metric
// definitions, column synonyms) can be made ineligible for a run via an
// environment gate, with NO shipped setting, applied at the ONE posture seam so
// an ablated kind vanishes from every consumer at once. Ships INERT: with no
// LIGHTHOUSE_ABLATE_* variable set, `applyAblation` is a no-op and the eligible
// set is byte-identical to today. A measurement instrument only: NO setting, NO
// UI, NOT on the wire. (The declared joins — joinHints + backing entities — were
// removed in field-patch-0.12.5 §3, so the JOINS gate is gone.)

interface Ablation {
  metrics: boolean;
  synonyms: boolean;
}

/**
 * A gate is ON only for exactly `1`/`true` (trimmed, case-insensitive); any
 * other value — including empty, `0`, `false` — is OFF, so a stray or blank
 * variable can never silently ablate. KEEP IN SYNC with semantic.rs::ablate_flag.
 */
function ablateFlag(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v === "1" || v === "true";
}

function ablationFromEnv(): Ablation {
  return {
    metrics: ablateFlag(process.env.LIGHTHOUSE_ABLATE_METRICS),
    synonyms: ablateFlag(process.env.LIGHTHOUSE_ABLATE_SYNONYMS),
  };
}

/**
 * Zero out the ablated kinds in place, as if the store held none of that kind.
 * KEEP IN SYNC with semantic.rs::Ablation::apply.
 */
function applyAblation(a: Ablation, set: SemanticSet): void {
  if (a.metrics) set.metrics = [];
  if (a.synonyms) set.synonyms = [];
}

/**
 * The definitions usable under an ask's posture (§1.4) — the ONE gate that
 * governs §2 prompt injection AND the §3/§5 cache key. Device: everything.
 * Cloud: drop local-only metrics, then any synonym naming a dropped metric.
 * KEEP IN SYNC with semantic.rs::eligible_for_posture.
 */
export function eligibleForPosture(isCloud: boolean): SemanticSet {
  const store = listSemantic();
  // §3 ablation hook (openspec: field-patch-0.12.5): inert with no env var set,
  // so this is byte-identical to today unless a LIGHTHOUSE_ABLATE_* gate is on.
  // `listSemantic` returned a fresh clone, so mutating it never touches the store.
  applyAblation(ablationFromEnv(), store);
  if (!isCloud) return store;
  const droppedMetrics = new Set<string>();
  const metrics = store.metrics.filter((m) => {
    const keep = !metricEffectivelyLocalOnly(m.reads);
    if (!keep) droppedMetrics.add(m.name.toLowerCase());
    return keep;
  });
  const synonyms = store.synonyms.filter((s) => !droppedMetrics.has(s.canonical.toLowerCase()));
  return { metrics, synonyms };
}

// --- Applicable semantics (openspec: add-semantic-layer §6.1) ----------------------

/**
 * One metric surfaced for the semantic nav: enough to list, ask about, and
 * manage it (`id` the rename/delete ops name). `localOnly` drives the per-row
 * lock badge — a cloud posture's eligible set already excludes local-only
 * metrics, so it is only ever true on a device ask. KEEP IN SYNC with
 * `MetricCard` in meta.rs / src/contracts/types.ts.
 */
export interface MetricCard {
  id: string;
  name: string;
  expression: string;
  description: string;
  entity: string;
  localOnly: boolean;
}

/** One synonym surfaced for the semantic nav. KEEP IN SYNC with `SynonymCard`. */
export interface SynonymCard {
  term: string;
  canonical: string;
}

/**
 * One auto-derived "save as metric" proposal (openspec: field-patch-0.12.5
 * §3.4). KEEP IN SYNC with `SuggestedMetric` in meta.rs / src/contracts/types.ts.
 */
export interface SuggestedMetric {
  expression: string;
  entity: string;
  occurrences: number;
  certified: boolean;
}

/**
 * The semantic definitions applicable to the current tables, plus the §3.4
 * auto-derived PROPOSALS (never stored until the user accepts). KEEP IN SYNC
 * with `SemanticCards` in meta.rs / src/contracts/types.ts. PARITY: the column
 * catalog + SQL mining are Rust-only, so this dev twin always returns EMPTY
 * `suggested*` arrays (the shipped Rust engine computes the real proposals).
 */
export interface SemanticCards {
  metrics: MetricCard[];
  synonyms: SynonymCard[];
  suggestedSynonyms: SynonymCard[];
  suggestedMetrics: SuggestedMetric[];
}

/**
 * The posture-eligible metrics/synonyms whose tables are in the included set —
 * the nav's card shape (openspec §6.1). PARITY: `list` needs NO analytics (a
 * metric carries its `reads`), so the twin computes the IDENTICAL subset as
 * meta.rs::applicable_semantics — only op:"defineMetric" is Rust-only. Metrics
 * gate on their `reads` intersecting `included`; synonyms ride when their
 * canonical names a surfaced metric or names no metric at all (a column
 * synonym). KEEP IN SYNC with meta.rs::applicable_semantics. PARITY: the §3.4
 * `suggested*` proposals need the column catalog + SQL mining (Rust-only), so
 * this twin returns them EMPTY — the shipped Rust engine fills them.
 */
export function applicableSemantics(included: string[], isCloud: boolean): SemanticCards {
  const set = eligibleForPosture(isCloud);
  const inc = new Set(included);
  const viewRecords = listViews();
  const metrics: MetricCard[] = set.metrics
    .filter((m) => metricReadsIncluded(m, inc, viewRecords))
    .map((m) => ({
      id: m.id,
      name: m.name,
      expression: m.expression,
      description: m.description,
      entity: m.entity,
      localOnly: metricEffectivelyLocalOnly(m.reads),
    }));
  const surfaced = new Set(metrics.map((m) => m.name.toLowerCase()));
  const allMetrics = new Set(set.metrics.map((m) => m.name.toLowerCase()));
  const synonyms: SynonymCard[] = set.synonyms
    .filter((s) => {
      const canon = s.canonical.toLowerCase();
      return surfaced.has(canon) || !allMetrics.has(canon);
    })
    .map((s) => ({ term: s.term, canonical: s.canonical }));
  return { metrics, synonyms, suggestedSynonyms: [], suggestedMetrics: [] };
}

/** Whether a metric's transitive source files intersect the included set: its
 *  own `reads.files`, or any read view whose transitive sources do. */
function metricReadsIncluded(m: Metric, included: Set<string>, viewRecords: View[]): boolean {
  if (m.reads.files.some((f) => included.has(f.fileId))) return true;
  const seen = new Set<string>();
  return m.reads.views.some((vid) => viewFilesIncluded(vid, viewRecords, included, seen));
}

/** Whether a view's transitive source files intersect `included` (cycle-tolerant). */
function viewFilesIncluded(
  viewId: string,
  records: View[],
  included: Set<string>,
  seen: Set<string>,
): boolean {
  if (seen.has(viewId)) return false;
  seen.add(viewId);
  const v = records.find((r) => r.id === viewId);
  if (!v) return false;
  if (v.reads.files.some((f) => included.has(f.fileId))) return true;
  return v.reads.views.some((pid) => viewFilesIncluded(pid, records, included, seen));
}

// --- Resolver (§1.6) ---------------------------------------------------------------

/**
 * The model-free metric resolver: a metric NAME to its stored expression, no
 * model call. `undefined` for an unknown name. KEEP IN SYNC with
 * semantic.rs::resolve_metric.
 */
export function resolveMetric(name: string): string | undefined {
  const trimmed = name.trim();
  return listSemantic().metrics.find((m) => m.name.toLowerCase() === trimmed.toLowerCase())
    ?.expression;
}

// --- §2 prompt block: resolution into NL→SQL ---------------------------------------
//
// PARITY: the analytics-branch prompt injection is RUST-ONLY (synth.rs) — this
// dev twin has no analytics branch. What the twin DOES mirror, byte-identically,
// is the rendered block itself: `renderBlock` produces the SAME label strings +
// `SEMANTIC_FEWSHOTS` lines as semantic.rs::render_block (ts-twin.md rule 2), so
// the two engines agree on every business-definitions string. Change these in
// lockstep with semantic.rs. (The entities + curated-join sections were removed
// in field-patch-0.12.5 §3.)

/** Block label (rendered `[n] business definitions`). KEEP IN SYNC with BLOCK_NAME. */
const BLOCK_NAME = "business definitions";
const BLOCK_HEADER =
  "Business definitions for this vault (curated meanings — prefer these over guessing; write SQL that uses each metric's exact definition):";
const METRICS_HEADER = "Metrics (name = definition):";
const SYNONYMS_HEADER = "Synonyms (term → canonical column or metric):";
const EXAMPLES_HEADER = "Examples (a defined term expands to its metric definition):";

// Per-kind caps — keep the NEWEST N of each kind. KEEP IN SYNC with semantic.rs.
const MAX_BLOCK_METRICS = 24;
const MAX_BLOCK_SYNONYMS = 24;

/**
 * Blessed question→SQL pairs demonstrating a metric reference EXPANDING to its
 * definition — rendered in the block when a metric is present. KEEP IN SYNC
 * with semantic.rs::SEMANTIC_FEWSHOTS (byte-identical rendered lines).
 */
const SEMANTIC_FEWSHOTS: [string, string][] = [
  [
    "revenue by region",
    "SELECT region, SUM(amount) FILTER (WHERE status = 'paid') AS revenue FROM sales GROUP BY region ORDER BY revenue DESC",
  ],
  [
    "gmv by month (gmv is the revenue metric)",
    "SELECT substr(order_date, 1, 7) AS month, SUM(amount) FILTER (WHERE status = 'paid') AS revenue FROM sales GROUP BY month ORDER BY month",
  ],
];

/** Keep the newest `cap` records, newest-first (the register_tables slot-cap idiom). */
function newestFirst<T>(items: T[], cap: number): T[] {
  return cap <= 0 ? [] : items.slice(-cap).reverse();
}

/** A trailing ` — description` clause, or empty (never a bare `— `). */
function descSuffix(description: string): string {
  const d = description.trim();
  return d ? ` — ${d}` : "";
}

/**
 * The pure renderer over an already-posture-filtered set — byte-identical to
 * semantic.rs::render_block. Fixed order: metrics, synonyms, then examples (only
 * with a metric present). `null` when nothing is eligible (keeps the prompt
 * byte-identical to today). KEEP IN SYNC.
 */
export function renderBlock(set: SemanticSet): { name: string; text: string } | null {
  const metrics = newestFirst(set.metrics, MAX_BLOCK_METRICS);
  const synonyms = newestFirst(set.synonyms, MAX_BLOCK_SYNONYMS);

  const sections: string[] = [];
  if (metrics.length > 0) {
    const lines = [METRICS_HEADER];
    for (const m of metrics) lines.push(`- ${m.name} = ${m.expression}${descSuffix(m.description)}`);
    sections.push(lines.join("\n"));
  }
  if (synonyms.length > 0) {
    const lines = [SYNONYMS_HEADER];
    for (const s of synonyms) lines.push(`- ${s.term} → ${s.canonical}`);
    sections.push(lines.join("\n"));
  }
  // Metric-expansion examples ride only when a metric exists (byte-identical
  // gate to semantic.rs), so an empty/metric-free store adds nothing.
  if (metrics.length > 0) {
    const lines = [EXAMPLES_HEADER];
    for (const [q, sql] of SEMANTIC_FEWSHOTS) lines.push(`Q: ${q}\nSQL: ${sql}`);
    sections.push(lines.join("\n"));
  }
  if (sections.length === 0) return null;
  return { name: BLOCK_NAME, text: `${BLOCK_HEADER}\n\n${sections.join("\n\n")}` };
}

/**
 * The business-definitions block for an ask's posture — the §1
 * `eligibleForPosture` gate then `renderBlock`. KEEP IN SYNC with
 * semantic.rs::prompt_block. PARITY: the twin never injects it (no analytics
 * branch); this exists so the label strings stay byte-pinned.
 */
export function promptBlock(isCloud: boolean): { name: string; text: string } | null {
  return renderBlock(eligibleForPosture(isCloud));
}

// --- Dependency helpers (pure) -----------------------------------------------------

/** The synonyms whose canonical names `metricName` (case-insensitive). */
function dependentSynonyms(synonyms: Synonym[], metricName: string): Synonym[] {
  return synonyms.filter((s) => s.canonical.toLowerCase() === metricName.toLowerCase());
}

// --- CRUD (§1.5) -------------------------------------------------------------------

/**
 * Create a metric. PARITY: the column catalog is Rust-only, so this twin's
 * public entry passes NO columns (skips the name-shadow check);
 * createMetricWithContext still accepts a columns param for symmetry. KEEP IN
 * SYNC with semantic.rs::create_metric.
 */
export function createMetric(
  name: string,
  expression: string,
  description: string,
  entity: string,
  summary: ViewSummary,
  fileIds: string[],
): Metric {
  const files = resolveFiles(fileIds);
  return createMetricWithContext(name, expression, description, entity, summary, files, []);
}

/** A resolved source file handed to createMetricWithContext: id + display name. */
export interface SemanticSourceFile {
  fileId: string;
  name: string;
}

function resolveFiles(fileIds: string[]): SemanticSourceFile[] {
  const byId = new Map<string, string>();
  for (const n of listNodes()) if (n.kind === "file") byId.set(n.id, n.name);
  const out: SemanticSourceFile[] = [];
  for (const fileId of fileIds) {
    const name = byId.get(fileId);
    if (name && isRegistrable(name)) out.push({ fileId, name });
  }
  return out;
}

/**
 * `createMetric` with the vault lookups supplied by the caller: `files` in
 * fileIds order, `entityColumns` the entity's columns (the name-shadow check).
 * KEEP IN SYNC with semantic.rs::create_metric_with_context.
 */
export function createMetricWithContext(
  name: string,
  expression: string,
  description: string,
  entity: string,
  summary: ViewSummary,
  files: SemanticSourceFile[],
  entityColumns: string[],
): Metric {
  // 1. Name: sanitize, then refuse empty / reserved / a shadowed column.
  const normalized = normalizeName(name);
  if (!normalized) throw new Error("a metric needs a name");
  if (RESERVED_NAMES.has(normalized)) throw new Error(`"${normalized}" is a reserved word`);
  if (entityColumns.some((c) => c.toLowerCase() === normalized)) {
    throw new Error(`"${normalized}" is already a column of ${entity}`);
  }
  // An empty/whitespace expression parses leniently (Rust) / scans clean
  // (here), so refuse it explicitly rather than persist an empty definition.
  if (!expression.trim()) throw new Error("a metric needs an expression");
  const store = listSemantic();
  if (store.metrics.some((m) => m.name.toLowerCase() === normalized)) {
    throw new Error(`a metric named "${normalized}" already exists`);
  }

  // 2. Guard (PARITY: textual here; guard_sql's parser on the desktop).
  const referenced = guardMetricExpression(expression, entity);

  // 3. Reads: every referenced name must resolve to a saved view or a table
  //    derived from the passed files by replaying register_tables' pipeline.
  const viewRecords = listViews();
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
    const view = viewRecords.find((r) => r.name.toLowerCase() === lower);
    if (view) {
      reads.views.push(view.id);
      continue;
    }
    const file = fileTables.find((f) => f.table === lower);
    if (file) {
      reads.files.push({ fileId: file.fileId, tableName: file.table });
      continue;
    }
    throw new Error(`unknown entity in definition: ${table}`);
  }

  // 4. Mint the id + persist (key order is the byte contract).
  const createdMs = Date.now();
  const metric: Metric = {
    id: mintId("metric", normalized, expression, createdMs),
    name: normalized,
    expression,
    description,
    entity,
    reads,
    summary: { text: summary.text, source: summary.source },
    createdMs,
  };
  store.metrics.push(metric);
  save(store);
  return cloneMetric(metric);
}

/**
 * Create a synonym: a colloquial `term` mapped to a `canonical` column/metric
 * name. Term unique case-insensitively; neither empty. KEEP IN SYNC with
 * semantic.rs::create_synonym.
 */
export function createSynonym(term: string, canonical: string): Synonym {
  const t = term.trim();
  const c = canonical.trim();
  if (!t) throw new Error("a synonym needs a term");
  if (!c) throw new Error("a synonym needs a canonical name");
  const store = listSemantic();
  if (store.synonyms.some((s) => s.term.toLowerCase() === t.toLowerCase())) {
    throw new Error(`a synonym for "${t}" already exists`);
  }
  const synonym: Synonym = { term: t, canonical: c };
  store.synonyms.push(synonym);
  save(store);
  return { ...synonym };
}

/**
 * Rename a metric — REFUSED with a message naming the dependent synonyms while
 * any synonym maps to it; otherwise a pure store update (id + reads untouched).
 * KEEP IN SYNC with semantic.rs::rename_metric.
 */
export function renameMetric(id: string, newName: string): Metric {
  const normalized = normalizeName(newName);
  if (!normalized) throw new Error("a metric needs a name");
  if (RESERVED_NAMES.has(normalized)) throw new Error(`"${normalized}" is a reserved word`);
  const store = listSemantic();
  const rec = store.metrics.find((m) => m.id === id);
  if (!rec) throw new Error("metric not found");
  const deps = dependentSynonyms(store.synonyms, rec.name);
  if (deps.length > 0) {
    throw new Error(
      `"${rec.name}" can't be renamed while synonyms map to it: ${deps
        .map((s) => s.term)
        .join(", ")}`,
    );
  }
  if (store.metrics.some((m) => m.id !== id && m.name.toLowerCase() === normalized)) {
    throw new Error(`a metric named "${normalized}" already exists`);
  }
  rec.name = normalized;
  save(store);
  return cloneMetric(rec);
}

/**
 * Delete a metric. While dependent synonyms exist the delete is refused with
 * that list unless `cascade`; cascade removes the metric plus every synonym
 * that maps to it in ONE write. Returns the deleted metric id. KEEP IN SYNC
 * with semantic.rs::delete_metric.
 */
export function deleteMetric(id: string, cascade: boolean): string {
  const store = listSemantic();
  const metric = store.metrics.find((m) => m.id === id);
  if (!metric) throw new Error("metric not found");
  const depTerms = dependentSynonyms(store.synonyms, metric.name).map((s) => s.term);
  if (depTerms.length > 0 && !cascade) {
    throw new Error(
      `"${metric.name}" can't be deleted while synonyms map to it: ${depTerms.join(", ")}`,
    );
  }
  save({
    ...store,
    metrics: store.metrics.filter((m) => m.id !== id),
    synonyms: store.synonyms.filter(
      (s) => s.canonical.toLowerCase() !== metric.name.toLowerCase(),
    ),
  });
  return metric.id;
}

/** Delete a synonym by its term (case-insensitive). */
export function deleteSynonym(term: string): void {
  const store = listSemantic();
  const before = store.synonyms.length;
  store.synonyms = store.synonyms.filter((s) => s.term.toLowerCase() !== term.toLowerCase());
  if (store.synonyms.length === before) throw new Error("synonym not found");
  save(store);
}

// --- Auto-derived PROPOSALS (openspec: field-patch-0.12.5 §3.4) --------------------

/**
 * Curated business-data abbreviations, `[full, abbrev]` — the STRONG SIGNAL a
 * synonym proposal requires. Matched against the WHOLE (lowercased) column name
 * in BOTH directions; there is deliberately NO substring / stem / subsequence
 * guessing, because real-world abbreviations are irregular (`qty`↔`quantity`
 * drops interior letters, `rgn`↔`region` drops vowels) and any fuzzy rule loose
 * enough to catch them ALSO merges unrelated columns that merely share a stem
 * (`region`↔`regularization`, `amount`↔`amortization`). A curated dictionary
 * can only ever fire on a known pair, so there are no false-positive merges.
 * KEEP IN SYNC with semantic.rs::ABBREVIATIONS (same pairs, same order).
 */
const ABBREVIATIONS: [string, string][] = [
  ["amount", "amt"],
  ["quantity", "qty"],
  ["region", "rgn"],
  ["number", "num"],
  ["description", "desc"],
  ["category", "cat"],
  ["customer", "cust"],
  ["account", "acct"],
  ["department", "dept"],
  ["revenue", "rev"],
  ["average", "avg"],
  ["transaction", "txn"],
  ["reference", "ref"],
  ["balance", "bal"],
  ["percent", "pct"],
  ["organization", "org"],
  ["identifier", "ident"],
  ["address", "addr"],
];

/**
 * PROPOSE column synonyms from a column inventory (openspec §3.4). For each
 * column that exactly matches one side of a known abbreviation pair, propose a
 * synonym mapping the OTHER form to that column (`{term: otherForm, canonical:
 * column}`). CONSERVATIVE — no false-positive merges: ONLY the curated
 * `ABBREVIATIONS` dictionary fires (a strong signal), never a stem/substring
 * guess, so `region`/`regularization` never merge; a pair is skipped when BOTH
 * forms are already columns (ambiguous); a proposal duplicating an existing
 * synonym `term` is skipped. Deterministic (input column order, then dictionary
 * order), de-duplicated by term. NOTHING is written — the user accepts each via
 * the guarded `createSynonym`. KEEP IN SYNC with semantic.rs::propose_synonyms.
 */
export function proposeSynonyms(columns: string[], existing: Synonym[]): Synonym[] {
  const cols = columns.map((c) => c.trim().toLowerCase()).filter((c) => c.length > 0);
  const colSet = new Set(cols);
  const existingTerms = new Set(existing.map((s) => s.term.trim().toLowerCase()));
  const seen = new Set<string>();
  const out: Synonym[] = [];
  for (const col of cols) {
    for (const [full, abbrev] of ABBREVIATIONS) {
      let term: string;
      if (col === full) term = abbrev;
      else if (col === abbrev) term = full;
      else continue;
      // Both forms present as columns ⇒ ambiguous; skip. Also skip the identity
      // and any term an existing (or already-proposed) synonym owns.
      if (colSet.has(term) || term === col) continue;
      if (existingTerms.has(term) || seen.has(term)) continue;
      seen.add(term);
      out.push({ term, canonical: col });
    }
  }
  return out;
}
