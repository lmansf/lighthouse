/**
 * The semantic layer, TS twin (openspec: add-semantic-layer §1). KEEP IN SYNC
 * with native semantic.rs: same record shapes (camelCase on the wire), the
 * same versioned envelope `{v: 1, metrics, synonyms, entities, joinHints}`
 * written with the shared atomic writer, the same id minting, the same
 * validation and error strings, the same CRUD/lifecycle (metric rename/delete
 * refuse or cascade against dependent synonyms), and the same local-only
 * propagation.
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
import { activeIncludedFileIds, listNodes, localOnlySubset } from "./vault";
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

/** A named entity: a name bound to a table, its key columns, a description. */
export interface Entity {
  name: string;
  table: string;
  keyColumns: string[];
  description: string;
}

/** A curated join hint: how two entities relate. */
export interface JoinHint {
  leftEntity: string;
  leftColumn: string;
  rightEntity: string;
  rightColumn: string;
  description: string;
}

/** The four record kinds — the full store, or the posture-eligible subset. */
export interface SemanticSet {
  metrics: Metric[];
  synonyms: Synonym[];
  entities: Entity[];
  joinHints: JoinHint[];
}

// --- Store (versioned envelope, bak-on-write — the views.ts posture) ---------------

function semanticPath(): string {
  return path.join(stateDir(), "semantic.json");
}

function emptySet(): SemanticSet {
  return { metrics: [], synonyms: [], entities: [], joinHints: [] };
}

/**
 * A readable v1 envelope's records, or `null` when the text is not one
 * (unknown/missing version, or unparseable JSON — the two read identically).
 * PARITY: this twin trusts the arrays wholesale once the envelope checks pass;
 * the Rust engine's serde also rejects records with malformed required fields.
 */
function parseStore(text: string): SemanticSet | null {
  try {
    const parsed = JSON.parse(text) as { v?: unknown } & Partial<SemanticSet>;
    if (
      parsed &&
      parsed.v === STORE_VERSION &&
      Array.isArray(parsed.metrics) &&
      Array.isArray(parsed.synonyms) &&
      Array.isArray(parsed.entities) &&
      Array.isArray(parsed.joinHints)
    ) {
      return {
        metrics: parsed.metrics,
        synonyms: parsed.synonyms,
        entities: parsed.entities,
        joinHints: parsed.joinHints,
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
  // Key order is the byte contract with the Rust engine.
  writeJson(target, {
    v: STORE_VERSION,
    metrics: set.metrics,
    synonyms: set.synonyms,
    entities: set.entities,
    joinHints: set.joinHints,
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
    entities: set.entities.map((e) => ({ ...e, keyColumns: [...e.keyColumns] })),
    joinHints: set.joinHints.map((j) => ({ ...j })),
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

/**
 * Whether an entity's table is effectively local-only: its `table` resolves to
 * a saved view that is local-only, or to a current file that is. Entities carry
 * no stored `reads`, so eligibility resolves the table at ask time. KEEP IN
 * SYNC with semantic.rs::entity_effectively_local_only.
 */
function entityEffectivelyLocalOnly(table: string): boolean {
  const t = table.trim().toLowerCase();
  if (!t) return false;
  const viewRecords = listViews();
  const v = viewRecords.find((r) => r.name.toLowerCase() === t);
  if (v) return viewEffectivelyLocalOnly(v, viewRecords);
  const byId = new Map<string, string>();
  for (const n of listNodes()) if (n.kind === "file") byId.set(n.id, n.name);
  return activeIncludedFileIds().some((id) => {
    const name = byId.get(id);
    return (
      !!name &&
      isRegistrable(name) &&
      sanitizeTableName(name) === t &&
      localOnlySubset([id], true).length > 0
    );
  });
}

/**
 * The definitions usable under an ask's posture (§1.4) — the ONE gate that
 * governs §2 prompt injection AND the §3/§5 cache key. Device: everything.
 * Cloud: drop local-only metrics + entities over local-only tables, then any
 * synonym naming a dropped metric and any join hint touching a dropped entity.
 * KEEP IN SYNC with semantic.rs::eligible_for_posture.
 */
export function eligibleForPosture(isCloud: boolean): SemanticSet {
  const store = listSemantic();
  if (!isCloud) return store;
  const droppedMetrics = new Set<string>();
  const metrics = store.metrics.filter((m) => {
    const keep = !metricEffectivelyLocalOnly(m.reads);
    if (!keep) droppedMetrics.add(m.name.toLowerCase());
    return keep;
  });
  const droppedEntities = new Set<string>();
  const entities = store.entities.filter((e) => {
    const keep = !entityEffectivelyLocalOnly(e.table);
    if (!keep) droppedEntities.add(e.name.toLowerCase());
    return keep;
  });
  const synonyms = store.synonyms.filter((s) => !droppedMetrics.has(s.canonical.toLowerCase()));
  const joinHints = store.joinHints.filter(
    (j) =>
      !droppedEntities.has(j.leftEntity.toLowerCase()) &&
      !droppedEntities.has(j.rightEntity.toLowerCase()),
  );
  return { metrics, synonyms, entities, joinHints };
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
// dev twin has no analytics branch, and the §2.4 curated-vs-heuristic join-hint
// merge + `curatedJoinPairs` are Rust-only (there is no heuristic join_hints
// here). What the twin DOES mirror, byte-identically, is the rendered block
// itself: `renderBlock` produces the SAME label strings + `SEMANTIC_FEWSHOTS`
// lines as semantic.rs::render_block (ts-twin.md rule 2), so the two engines
// agree on every business-definitions string. Change these in lockstep with
// semantic.rs.

/** Block label (rendered `[n] business definitions`). KEEP IN SYNC with BLOCK_NAME. */
const BLOCK_NAME = "business definitions";
const BLOCK_HEADER =
  "Business definitions for this vault (curated meanings — prefer these over guessing; write SQL that uses each metric's exact definition):";
const METRICS_HEADER = "Metrics (name = definition):";
const SYNONYMS_HEADER = "Synonyms (term → canonical column or metric):";
const ENTITIES_HEADER = "Entities (name: table (key columns) — description):";
const CURATED_JOIN_HEADER = "Curated join hints (authoritative — prefer over inferred joins):";
const EXAMPLES_HEADER = "Examples (a defined term expands to its metric definition):";

// Per-kind caps — keep the NEWEST N of each kind. KEEP IN SYNC with semantic.rs.
const MAX_BLOCK_METRICS = 24;
const MAX_BLOCK_SYNONYMS = 24;
const MAX_BLOCK_ENTITIES = 12;
const MAX_BLOCK_JOIN_HINTS = 12;

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
 * semantic.rs::render_block. Fixed order: metrics, synonyms, entities, curated
 * join hints, then examples (only with a metric present). `null` when nothing
 * is eligible (keeps the prompt byte-identical to today). KEEP IN SYNC.
 */
export function renderBlock(set: SemanticSet): { name: string; text: string } | null {
  const metrics = newestFirst(set.metrics, MAX_BLOCK_METRICS);
  const synonyms = newestFirst(set.synonyms, MAX_BLOCK_SYNONYMS);
  const entities = newestFirst(set.entities, MAX_BLOCK_ENTITIES);
  const hints = newestFirst(set.joinHints, MAX_BLOCK_JOIN_HINTS);

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
  if (entities.length > 0) {
    const lines = [ENTITIES_HEADER];
    for (const e of entities) {
      const cols = e.keyColumns.length > 0 ? ` (${e.keyColumns.join(", ")})` : "";
      lines.push(`- ${e.name}: ${e.table}${cols}${descSuffix(e.description)}`);
    }
    sections.push(lines.join("\n"));
  }
  if (hints.length > 0) {
    const lines = [CURATED_JOIN_HEADER];
    for (const j of hints) {
      lines.push(
        `- ${j.leftEntity}.${j.leftColumn} = ${j.rightEntity}.${j.rightColumn}${descSuffix(j.description)}`,
      );
    }
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
 * Create an entity: a `name` bound to a `table`, key columns, a description.
 * Name sanitizes with the metric rules, unique case-insensitively; `table` not
 * empty. KEEP IN SYNC with semantic.rs::create_entity.
 */
export function createEntity(
  name: string,
  table: string,
  keyColumns: string[],
  description: string,
): Entity {
  const normalized = normalizeName(name);
  if (!normalized) throw new Error("an entity needs a name");
  if (RESERVED_NAMES.has(normalized)) throw new Error(`"${normalized}" is a reserved word`);
  const t = table.trim();
  if (!t) throw new Error("an entity needs a table");
  const store = listSemantic();
  if (store.entities.some((e) => e.name.toLowerCase() === normalized)) {
    throw new Error(`an entity named "${normalized}" already exists`);
  }
  const entity: Entity = { name: normalized, table: t, keyColumns: [...keyColumns], description };
  store.entities.push(entity);
  save(store);
  return { ...entity, keyColumns: [...entity.keyColumns] };
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

/** Delete an entity by its name (case-insensitive). */
export function deleteEntity(name: string): void {
  const store = listSemantic();
  const before = store.entities.length;
  store.entities = store.entities.filter((e) => e.name.toLowerCase() !== name.toLowerCase());
  if (store.entities.length === before) throw new Error("entity not found");
  save(store);
}
