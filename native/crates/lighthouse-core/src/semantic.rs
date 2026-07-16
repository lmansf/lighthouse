//! The semantic layer: curated business meaning over vault tables
//! (openspec: add-semantic-layer §1).
//!
//! A METRIC names a messy DEFINITION once — `{id, name, expression,
//! description, entity, reads, summary, createdMs}` — exactly as a shaped view
//! (views.rs) names a messy TABLE once. The store machinery is lifted from
//! `views.rs` verbatim: the versioned envelope, `store_lock`, bak-on-write,
//! stable sha1 ids, name sanitization (the SAME `normalize_view_name` rules),
//! case-insensitive uniqueness, save-time guarding, dependency derivation, and
//! `eligible_for_posture`. Where a view registers a virtual table, a metric
//! instead (a) feeds its definition into the analytics prompt (§2) and (b)
//! certifies answers that used it (§3/§4).
//!
//! A metric's `expression` is a guarded, RE-RUNNABLE aggregation — the stored
//! value is `SUM(amount) FILTER (WHERE status='paid')`, NOT a full statement.
//! It is validated at save by synthesizing `SELECT <expression> AS <name> FROM
//! <entity>` and running the SAME `analytics::guard_sql` every executed query
//! passes (`analytics::guard_metric_expression`), so a saved metric is always
//! a read-only SELECT the engine can re-run. The synthesized statement's table
//! factors derive `reads` (the `views::collect_table_names` AST walk), so a
//! metric over a source file/view carries its dependencies and propagates
//! local-only exactly as a view does.
//!
//! NAMING: the existing `DesktopSettings.semantic_search` is the UNRELATED
//! hybrid-embedding retrieval toggle. This module is the semantic LAYER
//! (business meaning): module `semantic`, store `semantic.json`, capability
//! `semantic-layer`. It adds NO setting — the store is the state, the
//! shaped-views precedent — so `settings.rs` is untouched and the two never
//! collide on the wire.
//!
//! Versioning posture (user data, not a cache): the store is a versioned
//! envelope `{v: 1, metrics, synonyms, entities, joinHints}` in
//! `state_dir()/semantic.json`. `v == 1` loads; an unknown or missing version
//! — or unparseable JSON — loads EMPTY for the session, and the first
//! subsequent write renames the unreadable file to `semantic.json.bak-<epochms>`
//! before writing a fresh v1 envelope. Nothing is silently clobbered.
//!
//! The dev server twin (src/server/semantic.ts, KEEP IN SYNC) mirrors this
//! module byte-compatibly: same envelope, same ids, same validation and error
//! strings, same CRUD/lifecycle, same local-only propagation. PARITY: the
//! twin's definition guard is a conservative textual single-SELECT check and
//! its `reads` derivation a FROM/JOIN scan (guard_sql's parser is Rust-only),
//! and it never populates the certify/trust meta (analytics is Rust-only).

use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::path::PathBuf;

use crate::config::{now_ms, state_dir, write_json};
use crate::llm::Ctx;
// The store machinery + name rules are SHARED with shaped views: a metric's
// `reads`/`summary` are the view types verbatim (byte-identical wire), and the
// name sanitization + reserved list are the SAME rules (KEEP IN SYNC).
use crate::views::{
    normalize_view_name as normalize_name, FileRead, Reads, View, ViewSummary, RESERVED_NAMES,
};

/// Envelope version this engine reads and writes.
const STORE_VERSION: u32 = 1;

/// Serializes load-modify-save on the store (mirrors views' `store_lock`).
fn store_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
        .lock()
        .unwrap_or_else(|p| p.into_inner())
}

// --- Records (camelCase wire, serde-strict) ----------------------------------------
//
// Every field is required — a missing/malformed field makes the WHOLE store
// unreadable for the session (the bak-on-write posture preserves it), never a
// coerced default (the `views.rs` `SummarySource` posture). `reads` and
// `summary` reuse the view types so a metric's dependency + provenance wire is
// byte-identical to a view's.

/// A canonical metric: a business name bound to a guarded, re-runnable
/// aggregation `expression` over a named `entity`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Metric {
    /// Engine-minted, stable: `metric-` + first 12 hex chars of
    /// sha1(name \n expression \n createdMs) — see `mint_id`. NOT derived from
    /// the current name; rename keeps the id.
    pub id: String,
    /// Sanitized identifier (the `normalize_view_name` rules), unique
    /// case-insensitively among metrics, never shadowing a column of `entity`.
    pub name: String,
    /// The aggregation EXPRESSION (`SUM(amount) FILTER (WHERE status='paid')`),
    /// guard-validated at save and re-runnable — NOT a full statement.
    pub expression: String,
    /// The authored business meaning, rendered into the prompt block (§2).
    pub description: String,
    /// The entity (table / saved view) the expression aggregates over.
    pub entity: String,
    /// Dependencies derived from the synthesized definition (see `views::Reads`)
    /// — carries local-only propagation.
    pub reads: Reads,
    /// Provenance-labeled one-liner (question-derived or model-stated — the
    /// "Define as metric" / "Save as view" precedent).
    pub summary: ViewSummary,
    /// Creation instant (epoch ms).
    pub created_ms: i64,
}

/// A colloquial term mapped to a canonical column OR metric name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Synonym {
    /// The colloquial phrase as the analyst types it ("GMV"), matched
    /// case-insensitively; stored trimmed, never identifier-sanitized.
    pub term: String,
    /// A column name OR a metric name it resolves to.
    pub canonical: String,
}

/// A named entity: a friendly name bound to a table, its key columns, and a
/// description. (Record format + prompt rendering land in §1/§2; the full
/// relationship editor is a §6 follow-on.)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entity {
    /// Sanitized identifier (the `normalize_view_name` rules), unique
    /// case-insensitively among entities.
    pub name: String,
    /// The table (or saved view) this entity is.
    pub table: String,
    /// The key columns (for join hints and the model's mapping).
    pub key_columns: Vec<String>,
    /// What the entity is, in plain words.
    pub description: String,
}

/// A curated join hint: how two entities relate. Renders alongside the
/// engine's heuristic join hints and wins for the same table pair (§2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinHint {
    pub left_entity: String,
    pub left_column: String,
    pub right_entity: String,
    pub right_column: String,
    pub description: String,
}

/// The four record kinds of the semantic layer — the full store, or the
/// posture-eligible subset (`eligible_for_posture`). §2 renders these into the
/// prompt block; §5 folds the metrics into the answer-cache key.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticSet {
    pub metrics: Vec<Metric>,
    pub synonyms: Vec<Synonym>,
    pub entities: Vec<Entity>,
    pub join_hints: Vec<JoinHint>,
}

// --- Store (versioned envelope, bak-on-write — the views.rs posture) ----------------

fn semantic_path() -> PathBuf {
    state_dir().join("semantic.json")
}

/// The on-disk envelope: `{v, metrics, synonyms, entities, joinHints}`.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Store {
    v: u32,
    metrics: Vec<Metric>,
    synonyms: Vec<Synonym>,
    entities: Vec<Entity>,
    join_hints: Vec<JoinHint>,
}

impl Store {
    fn from_set(v: u32, set: &SemanticSet) -> Self {
        Store {
            v,
            metrics: set.metrics.clone(),
            synonyms: set.synonyms.clone(),
            entities: set.entities.clone(),
            join_hints: set.join_hints.clone(),
        }
    }
    fn into_set(self) -> SemanticSet {
        SemanticSet {
            metrics: self.metrics,
            synonyms: self.synonyms,
            entities: self.entities,
            join_hints: self.join_hints,
        }
    }
}

/// A readable v1 envelope's records, or `None` when the text is not one
/// (unknown/missing version, or unparseable JSON — the two read identically,
/// the module's versioning posture). PARITY: the TS twin trusts the arrays
/// wholesale once the envelope checks pass; here serde also rejects records
/// with malformed required fields (an out-of-whitelist summary source
/// included) — engine-written files always carry every field, so the twins
/// agree on every file they write.
fn parse_store(text: &str) -> Option<SemanticSet> {
    match serde_json::from_str::<Store>(text) {
        Ok(s) if s.v == STORE_VERSION => Some(s.into_set()),
        _ => None,
    }
}

enum Loaded {
    Records(SemanticSet),
    Missing,
    /// Present but not a readable v1 envelope — reads empty for the session;
    /// the next write baks the file first (never clobber silently).
    Unreadable,
}

fn load() -> Loaded {
    match std::fs::read_to_string(semantic_path()) {
        Ok(text) => match parse_store(&text) {
            Some(records) => Loaded::Records(records),
            None => Loaded::Unreadable,
        },
        Err(_) => Loaded::Missing,
    }
}

/// The whole semantic layer, creation order within each kind. A missing store
/// reads empty; an unreadable one reads empty FOR THE SESSION (see `save`'s
/// bak-on-write). KEEP IN SYNC with semantic.ts::listSemantic.
pub fn list() -> SemanticSet {
    match load() {
        Loaded::Records(records) => records,
        _ => SemanticSet::default(),
    }
}

fn save(set: &SemanticSet) {
    let path = semantic_path();
    // Versioning posture: an unreadable file (unknown/missing version, corrupt
    // JSON) is preserved as a `.bak-<epochms>` sibling before the fresh v1
    // write — a downgrade or corruption never silently clobbers newer data.
    // Rename, falling back to copy, both best-effort.
    if matches!(load(), Loaded::Unreadable) {
        let bak = path.with_file_name(format!("semantic.json.bak-{}", now_ms()));
        if std::fs::rename(&path, &bak).is_err() {
            let _ = std::fs::copy(&path, &bak);
        }
    }
    write_json(&path, &Store::from_set(STORE_VERSION, set));
}

/// Stable engine-minted id: `<prefix>-` + first 12 hex chars of
/// sha1(name \n expression \n createdMs) — the view_id idiom. The expression
/// rides in the hash so same-named creations in the same millisecond can't
/// collide. Generic over the prefix (`metric-`; `entity-` reserved for a
/// future entity id). KEEP IN SYNC with semantic.ts::mintId.
fn mint_id(prefix: &str, name: &str, expression: &str, created_ms: i64) -> String {
    let digest = Sha1::digest(format!("{name}\n{expression}\n{created_ms}").as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("{prefix}-{}", &hex[..12])
}

// --- Local-only propagation + posture (§1.4) ---------------------------------------

/// PURE local-only propagation over a definition's `reads` (testable on
/// synthetic graphs): local-only when any read file satisfies `file_local_only`
/// or any read view (resolved in `view_records`) is
/// `views::view_effectively_local_only`. The `metric_effectively_local_only`
/// wrapper binds the vault's ancestor-wins resolver.
fn reads_local_only(
    reads: &Reads,
    view_records: &[View],
    file_local_only: &dyn Fn(&str) -> bool,
) -> bool {
    if reads.files.iter().any(|f| file_local_only(&f.file_id)) {
        return true;
    }
    reads.views.iter().any(|vid| {
        view_records
            .iter()
            .find(|v| &v.id == vid)
            .is_some_and(|v| crate::views::view_effectively_local_only(v, view_records))
    })
}

/// TRANSITIVE local-only propagation for a metric definition (design.md
/// "Local-only propagation"): the `views::view_effectively_local_only` walk
/// over the definition's `reads` — any transitive source file marked
/// effectively local-only, or any read view that is, makes the metric
/// local-only. KEEP IN SYNC with semantic.ts::metricEffectivelyLocalOnly.
pub fn metric_effectively_local_only(reads: &Reads) -> bool {
    reads_local_only(reads, &crate::views::list(), &|id| {
        crate::vault::node_is_local_only(id)
    })
}

/// Whether an entity's table is effectively local-only: its `table` resolves to
/// a saved view that is local-only, or to a current file that is. Entities
/// carry no stored `reads` (their wire shape is `{name, table, keyColumns,
/// description}`), so eligibility resolves the table at ask time. KEEP IN SYNC
/// with semantic.ts::entityEffectivelyLocalOnly.
fn entity_effectively_local_only(table: &str) -> bool {
    let table = table.trim().to_lowercase();
    if table.is_empty() {
        return false;
    }
    let view_records = crate::views::list();
    if let Some(v) = view_records.iter().find(|v| v.name.to_lowercase() == table) {
        return crate::views::view_effectively_local_only(v, &view_records);
    }
    crate::vault::active_included_file_ids().iter().any(|id| {
        crate::vault::doc_path(id).is_some_and(|(name, _)| {
            (crate::analytics::is_tabular(&name) || crate::analytics::is_pdf(&name))
                && crate::analytics::sanitize_table_name(&name) == table
                && crate::vault::node_is_local_only(id)
        })
    })
}

/// The definitions usable under an ask's posture (§1.4) — the ONE gate that
/// governs §2 prompt injection AND the §3/§5 cache key. On a device ask every
/// definition is eligible (marks are inert locally). A cloud ask drops the
/// effectively-local-only metrics AND the entities over local-only tables, and
/// then anything that references a dropped definition (a synonym whose
/// canonical names a dropped metric, a join hint touching a dropped entity), so
/// a private table's meaning can never ride a view of itself into a vendor
/// prompt. KEEP IN SYNC with semantic.ts::eligibleForPosture.
pub fn eligible_for_posture(is_cloud: bool) -> SemanticSet {
    let store = list();
    if !is_cloud {
        return store;
    }
    let mut dropped_metrics: Vec<String> = Vec::new();
    let metrics: Vec<Metric> = store
        .metrics
        .into_iter()
        .filter(|m| {
            let keep = !metric_effectively_local_only(&m.reads);
            if !keep {
                dropped_metrics.push(m.name.to_lowercase());
            }
            keep
        })
        .collect();
    let mut dropped_entities: Vec<String> = Vec::new();
    let entities: Vec<Entity> = store
        .entities
        .into_iter()
        .filter(|e| {
            let keep = !entity_effectively_local_only(&e.table);
            if !keep {
                dropped_entities.push(e.name.to_lowercase());
            }
            keep
        })
        .collect();
    let synonyms: Vec<Synonym> = store
        .synonyms
        .into_iter()
        .filter(|s| !dropped_metrics.contains(&s.canonical.to_lowercase()))
        .collect();
    let join_hints: Vec<JoinHint> = store
        .join_hints
        .into_iter()
        .filter(|j| {
            !dropped_entities.contains(&j.left_entity.to_lowercase())
                && !dropped_entities.contains(&j.right_entity.to_lowercase())
        })
        .collect();
    SemanticSet {
        metrics,
        synonyms,
        entities,
        join_hints,
    }
}

// --- Resolver (§1.6) ---------------------------------------------------------------

/// The model-free metric resolver: a metric NAME to its stored expression, no
/// model call — a pure, testable lookup §2/§3/§4 and the eval floor share.
/// `None` for an unknown name. KEEP IN SYNC with semantic.ts::resolveMetric.
pub fn resolve_metric(name: &str) -> Option<String> {
    let name = name.trim();
    list()
        .metrics
        .into_iter()
        .find(|m| m.name.eq_ignore_ascii_case(name))
        .map(|m| m.expression)
}

// --- §2 prompt block: resolution into NL→SQL ---------------------------------------
//
// The posture-eligible definitions render into ONE deterministic `Ctx` — the
// "business definitions" block — spliced into the analytics prompt beside the
// table/view schema cards (synth.rs), so the model writes SQL that USES the
// agreed meaning of a term instead of re-guessing it. The block is model-free,
// fixed-order, and COUNT-CAPPED (newest-first, the `register_tables` slot-cap
// idiom) so it can never blow the 6144-token analytics window. Zero eligible
// definitions ⇒ `None` ⇒ nothing spliced ⇒ every analytics prompt string is
// byte-identical to the pre-semantic-layer prompt (pinned by a test).
//
// PARITY: the analytics-branch injection is Rust-only (the TS twin has no
// analytics branch), but `semantic.ts::renderBlock` mirrors every label string
// here BYTE-IDENTICALLY for the ctxs it can assemble (ts-twin.md rule 2). The
// header/label constants and `SEMANTIC_FEWSHOTS` below are the byte contract —
// change them in lockstep with semantic.ts.

/// The block's prompt label (rendered as `[n] business definitions`), lowercase
/// like the "join hints" card. KEEP IN SYNC with semantic.ts::BLOCK_NAME.
const BLOCK_NAME: &str = "business definitions";
/// Leading line of the block body. KEEP IN SYNC with semantic.ts::BLOCK_HEADER.
const BLOCK_HEADER: &str = "Business definitions for this vault (curated meanings — prefer these over guessing; write SQL that uses each metric's exact definition):";
const METRICS_HEADER: &str = "Metrics (name = definition):";
const SYNONYMS_HEADER: &str = "Synonyms (term → canonical column or metric):";
const ENTITIES_HEADER: &str = "Entities (name: table (key columns) — description):";
const CURATED_JOIN_HEADER: &str = "Curated join hints (authoritative — prefer over inferred joins):";
const EXAMPLES_HEADER: &str = "Examples (a defined term expands to its metric definition):";

// Per-kind caps: the block keeps the NEWEST N of each kind (the
// `register_tables` slot-cap idiom) so an ever-growing store can never blow the
// analytics window. KEEP IN SYNC with semantic.ts.
const MAX_BLOCK_METRICS: usize = 24;
const MAX_BLOCK_SYNONYMS: usize = 24;
const MAX_BLOCK_ENTITIES: usize = 12;
const MAX_BLOCK_JOIN_HINTS: usize = 12;

/// Blessed question→SQL pairs demonstrating a metric reference EXPANDING to its
/// stored definition — they ride in the block (metrics present) so the model
/// learns to substitute the agreed definition. Every SELECT passes `guard_sql`
/// (pinned by a test, the `SQL_FEWSHOTS` validating-test precedent). KEEP IN
/// SYNC with semantic.ts::SEMANTIC_FEWSHOTS (byte-identical rendered lines).
pub const SEMANTIC_FEWSHOTS: &[(&str, &str)] = &[
    (
        "revenue by region",
        "SELECT region, SUM(amount) FILTER (WHERE status = 'paid') AS revenue FROM sales GROUP BY region ORDER BY revenue DESC",
    ),
    (
        "gmv by month (gmv is the revenue metric)",
        "SELECT substr(order_date, 1, 7) AS month, SUM(amount) FILTER (WHERE status = 'paid') AS revenue FROM sales GROUP BY month ORDER BY month",
    ),
];

/// Keep the NEWEST `cap` records and render them newest-first — the
/// `register_tables` slot-cap idiom (there, singles sort `Reverse(mtime)` then
/// fill until the cap). The store appends in creation order, so the tail is the
/// newest; `rev().take(cap)` yields the newest, newest-first.
fn newest_first<T: Clone>(items: &[T], cap: usize) -> Vec<T> {
    items.iter().rev().take(cap).cloned().collect()
}

/// A trailing ` — description` clause when a definition carries one, else empty
/// (never a bare `— `). KEEP IN SYNC with semantic.ts::descSuffix.
fn desc_suffix(description: &str) -> String {
    let d = description.trim();
    if d.is_empty() {
        String::new()
    } else {
        format!(" — {d}")
    }
}

/// The business-definitions block for an ask's posture (openspec §2.1). Renders
/// the posture-eligible metrics, synonyms, entities, and curated join hints (the
/// §1 `eligible_for_posture` gate — local-only definitions are excluded on a
/// cloud ask), then metric-expansion examples. `None` when nothing is eligible
/// (empty store OR all filtered out), which keeps the prompt byte-identical to
/// today. KEEP IN SYNC with semantic.ts::promptBlock.
pub fn prompt_block(is_cloud: bool) -> Option<Ctx> {
    render_block(&eligible_for_posture(is_cloud))
}

/// The pure renderer over an already-posture-filtered set (testable without a
/// vault). Fixed section order: metrics, synonyms, entities, curated join hints,
/// then examples (only when a metric is present — they demonstrate metric
/// expansion). An all-empty set renders `None`. KEEP IN SYNC with
/// semantic.ts::renderBlock (byte-identical output).
fn render_block(set: &SemanticSet) -> Option<Ctx> {
    let metrics = newest_first(&set.metrics, MAX_BLOCK_METRICS);
    let synonyms = newest_first(&set.synonyms, MAX_BLOCK_SYNONYMS);
    let entities = newest_first(&set.entities, MAX_BLOCK_ENTITIES);
    let hints = newest_first(&set.join_hints, MAX_BLOCK_JOIN_HINTS);

    let mut sections: Vec<String> = Vec::new();
    if !metrics.is_empty() {
        let mut lines = vec![METRICS_HEADER.to_string()];
        for m in &metrics {
            lines.push(format!("- {} = {}{}", m.name, m.expression, desc_suffix(&m.description)));
        }
        sections.push(lines.join("\n"));
    }
    if !synonyms.is_empty() {
        let mut lines = vec![SYNONYMS_HEADER.to_string()];
        for s in &synonyms {
            lines.push(format!("- {} → {}", s.term, s.canonical));
        }
        sections.push(lines.join("\n"));
    }
    if !entities.is_empty() {
        let mut lines = vec![ENTITIES_HEADER.to_string()];
        for e in &entities {
            let cols = if e.key_columns.is_empty() {
                String::new()
            } else {
                format!(" ({})", e.key_columns.join(", "))
            };
            lines.push(format!("- {}: {}{}{}", e.name, e.table, cols, desc_suffix(&e.description)));
        }
        sections.push(lines.join("\n"));
    }
    if !hints.is_empty() {
        let mut lines = vec![CURATED_JOIN_HEADER.to_string()];
        for j in &hints {
            lines.push(format!(
                "- {}.{} = {}.{}{}",
                j.left_entity, j.left_column, j.right_entity, j.right_column,
                desc_suffix(&j.description)
            ));
        }
        sections.push(lines.join("\n"));
    }
    // Metric-expansion examples ride only when a metric exists; a metric-free or
    // empty store never adds them, so the byte-identical-prompt invariant holds.
    if !metrics.is_empty() {
        let mut lines = vec![EXAMPLES_HEADER.to_string()];
        for (q, sql) in SEMANTIC_FEWSHOTS {
            lines.push(format!("Q: {q}\nSQL: {sql}"));
        }
        sections.push(lines.join("\n"));
    }
    if sections.is_empty() {
        return None;
    }
    Some(Ctx {
        name: BLOCK_NAME.to_string(),
        text: format!("{BLOCK_HEADER}\n\n{}", sections.join("\n\n")),
        // Auxiliary guidance, like the heuristic join-hints card (score 0.0).
        score: 0.0,
    })
}

/// The normalized TABLE pairs the posture-eligible curated join hints name, for
/// the §2.4 merge: the heuristic `analytics::join_hints` drops a pair a curated
/// hint already covers (the curated hint WINS, rendered in the block above).
/// Each entity name resolves to its sanitized table (falling back to the name
/// as a literal table), so a pair compares to the heuristic hints' registered
/// table names. PARITY: Rust-only (the twin has no analytics/join_hints).
pub fn curated_join_pairs(is_cloud: bool) -> Vec<(String, String)> {
    let set = eligible_for_posture(is_cloud);
    set.join_hints
        .iter()
        .map(|j| {
            (
                resolved_table(&j.left_entity, &set.entities),
                resolved_table(&j.right_entity, &set.entities),
            )
        })
        .collect()
}

/// Resolve an entity name to the sanitized table it stands for (its stored
/// `table`, sanitized like a registered file table), falling back to treating
/// the name itself as a literal table when it is not a defined entity.
fn resolved_table(entity_name: &str, entities: &[Entity]) -> String {
    let table = entities
        .iter()
        .find(|e| e.name.eq_ignore_ascii_case(entity_name))
        .map(|e| e.table.as_str())
        .unwrap_or(entity_name);
    crate::analytics::sanitize_table_name(table)
}

// --- Dependency helpers (pure, testable on synthetic stores) -----------------------

/// The synonyms whose `canonical` names `metric_name` (case-insensitive) — a
/// metric's dependents, what the rename/delete refusals list. Pure so the
/// lifecycle rules are testable on synthetic stores (the views `dependents_in`
/// idiom).
fn dependent_synonyms<'a>(synonyms: &'a [Synonym], metric_name: &str) -> Vec<&'a Synonym> {
    synonyms
        .iter()
        .filter(|s| s.canonical.eq_ignore_ascii_case(metric_name))
        .collect()
}

// --- Vault lookups (create_metric's public entry fetches these) --------------------

/// Resolve the passed file ids to `(file_id, display_name, abs)`, keeping order
/// — the same per-id lookup + tabular/PDF gate the direct-execution path uses.
/// Ids that no longer resolve (or aren't registrable) contribute nothing; a
/// definition that references them is then refused as an unknown entity.
fn resolve_files(file_ids: &[String]) -> Vec<(String, String, PathBuf)> {
    file_ids
        .iter()
        .filter_map(|id| {
            let (name, abs) = crate::vault::doc_path(id)?;
            (crate::analytics::is_tabular(&name) || crate::analytics::is_pdf(&name))
                .then_some((id.clone(), name, abs))
        })
        .collect()
}

/// The column names of the passed files (sanitized like table names), for the
/// name-shadow rule. PARITY: the column catalog is Rust-only (catalog.rs); the
/// TS twin passes no columns (its `createMetric` skips the shadow check).
fn columns_of(files: &[(String, String, PathBuf)]) -> Vec<String> {
    crate::catalog::columns_for(files)
        .into_iter()
        .flat_map(|fc| fc.columns)
        .map(|c| c.name)
        .collect()
}

// --- CRUD (§1.5) -------------------------------------------------------------------

/// Create a metric: validate the name, guard the definition, derive `reads`,
/// persist — refusing with a human-readable reason at the first offense and
/// persisting NOTHING on refusal. The vault lookups (the entity's columns for
/// the name-shadow rule, the source files for `reads`) are fetched here;
/// `create_metric_with_context` is the deterministic core. KEEP IN SYNC with
/// semantic.ts::createMetric.
pub fn create_metric(
    name: &str,
    expression: &str,
    description: &str,
    entity: &str,
    summary: ViewSummary,
    file_ids: &[String],
) -> Result<Metric, String> {
    let resolved = resolve_files(file_ids);
    let files: Vec<(String, String)> = resolved
        .iter()
        .map(|(id, name, _)| (id.clone(), name.clone()))
        .collect();
    let columns = columns_of(&resolved);
    create_metric_with_context(
        name,
        expression,
        description,
        entity,
        summary,
        &files,
        &columns,
    )
}

/// `create_metric` with the vault lookups supplied by the caller: `files` is
/// the resolved `(file_id, display_name)` list in file_ids order, and
/// `entity_columns` are the entity's column names (the name-shadow check). KEEP
/// IN SYNC with semantic.ts::createMetricWithContext.
pub fn create_metric_with_context(
    name: &str,
    expression: &str,
    description: &str,
    entity: &str,
    summary: ViewSummary,
    files: &[(String, String)],
    entity_columns: &[String],
) -> Result<Metric, String> {
    // 1. Name: sanitize, then refuse empty / reserved / a shadowed column.
    let name = normalize_name(name);
    if name.is_empty() {
        return Err("a metric needs a name".to_string());
    }
    if RESERVED_NAMES.contains(&name.as_str()) {
        return Err(format!("\"{name}\" is a reserved word"));
    }
    if entity_columns.iter().any(|c| c.eq_ignore_ascii_case(&name)) {
        return Err(format!("\"{name}\" is already a column of {entity}"));
    }
    // An empty/whitespace expression parses as a lenient `SELECT  AS m FROM t`
    // (DataFusion tolerates it), so refuse it explicitly rather than persist an
    // empty definition.
    if expression.trim().is_empty() {
        return Err("a metric needs an expression".to_string());
    }
    let _guard = store_lock();
    let mut store = list();
    if store.metrics.iter().any(|m| m.name.eq_ignore_ascii_case(&name)) {
        return Err(format!("a metric named \"{name}\" already exists"));
    }

    // 2. Guard: synthesize `SELECT <expression> AS <name> FROM <entity>` and
    //    run the SAME read-only guard every executed query passes; the returned
    //    names are the definition's table factors (the AST walk).
    let referenced = crate::analytics::guard_metric_expression(expression, entity)?;

    // 3. Reads: every referenced name must resolve to a saved view
    //    (case-insensitive name match) or to a table derived from the passed
    //    files by replaying register_tables' naming pipeline — else the entity
    //    is unknown and the save is refused.
    let view_records = crate::views::list();
    let mut file_tables: Vec<(String, String)> = Vec::new(); // (table, file_id)
    let mut used: Vec<String> = Vec::new();
    for (file_id, display_name) in files {
        let base = crate::analytics::unique_table_name(
            &crate::analytics::sanitize_table_name(display_name),
            &used,
        );
        used.push(base.clone());
        file_tables.push((base, file_id.clone()));
    }
    let mut reads = Reads::default();
    for table in &referenced {
        let lower = table.to_lowercase();
        if let Some(v) = view_records.iter().find(|r| r.name.to_lowercase() == lower) {
            reads.views.push(v.id.clone());
        } else if let Some((table_name, file_id)) = file_tables.iter().find(|(t, _)| *t == lower) {
            reads.files.push(FileRead {
                file_id: file_id.clone(),
                table_name: table_name.clone(),
            });
        } else {
            return Err(format!("unknown entity in definition: {table}"));
        }
    }

    // 4. Mint the id + persist.
    let created_ms = now_ms();
    let metric = Metric {
        id: mint_id("metric", &name, expression, created_ms),
        name,
        expression: expression.to_string(),
        description: description.to_string(),
        entity: entity.to_string(),
        reads,
        summary,
        created_ms,
    };
    store.metrics.push(metric.clone());
    save(&store);
    Ok(metric)
}

/// Create a synonym: a colloquial `term` mapped to a `canonical` column or
/// metric name. The term is unique case-insensitively; neither may be empty.
/// `canonical` is NOT hard-validated (it may name a column this engine's twin
/// can't see) — the metric dependency check compares it at rename/delete time.
/// KEEP IN SYNC with semantic.ts::createSynonym.
pub fn create_synonym(term: &str, canonical: &str) -> Result<Synonym, String> {
    let term = term.trim().to_string();
    let canonical = canonical.trim().to_string();
    if term.is_empty() {
        return Err("a synonym needs a term".to_string());
    }
    if canonical.is_empty() {
        return Err("a synonym needs a canonical name".to_string());
    }
    let _guard = store_lock();
    let mut store = list();
    if store.synonyms.iter().any(|s| s.term.eq_ignore_ascii_case(&term)) {
        return Err(format!("a synonym for \"{term}\" already exists"));
    }
    let synonym = Synonym { term, canonical };
    store.synonyms.push(synonym.clone());
    save(&store);
    Ok(synonym)
}

/// Create an entity: a friendly `name` bound to a `table`, its key columns, and
/// a description. The name sanitizes with the metric rules and is unique
/// case-insensitively among entities; `table` may not be empty. KEEP IN SYNC
/// with semantic.ts::createEntity.
pub fn create_entity(
    name: &str,
    table: &str,
    key_columns: &[String],
    description: &str,
) -> Result<Entity, String> {
    let name = normalize_name(name);
    if name.is_empty() {
        return Err("an entity needs a name".to_string());
    }
    if RESERVED_NAMES.contains(&name.as_str()) {
        return Err(format!("\"{name}\" is a reserved word"));
    }
    let table = table.trim().to_string();
    if table.is_empty() {
        return Err("an entity needs a table".to_string());
    }
    let _guard = store_lock();
    let mut store = list();
    if store.entities.iter().any(|e| e.name.eq_ignore_ascii_case(&name)) {
        return Err(format!("an entity named \"{name}\" already exists"));
    }
    let entity = Entity {
        name,
        table,
        key_columns: key_columns.to_vec(),
        description: description.to_string(),
    };
    store.entities.push(entity.clone());
    save(&store);
    Ok(entity)
}

/// Rename a metric — REFUSED with a message naming the dependent synonyms while
/// any synonym maps to it (silently rewriting a user-approved synonym risks
/// orphaning it — the `views::rename` dependent rule). Otherwise a pure store
/// update: the id and every stored `reads` are untouched. The new name passes
/// the SAME rules as create. KEEP IN SYNC with semantic.ts::renameMetric.
pub fn rename_metric(id: &str, new_name: &str) -> Result<Metric, String> {
    let name = normalize_name(new_name);
    if name.is_empty() {
        return Err("a metric needs a name".to_string());
    }
    if RESERVED_NAMES.contains(&name.as_str()) {
        return Err(format!("\"{name}\" is a reserved word"));
    }
    let _guard = store_lock();
    let mut store = list();
    let Some(idx) = store.metrics.iter().position(|m| m.id == id) else {
        return Err("metric not found".to_string());
    };
    let current = store.metrics[idx].name.clone();
    let deps = dependent_synonyms(&store.synonyms, &current);
    if !deps.is_empty() {
        let terms: Vec<String> = deps.iter().map(|s| s.term.clone()).collect();
        return Err(format!(
            "\"{current}\" can't be renamed while synonyms map to it: {}",
            terms.join(", ")
        ));
    }
    if store
        .metrics
        .iter()
        .any(|m| m.id != id && m.name.eq_ignore_ascii_case(&name))
    {
        return Err(format!("a metric named \"{name}\" already exists"));
    }
    store.metrics[idx].name = name;
    save(&store);
    Ok(store.metrics[idx].clone())
}

/// Delete a metric. While dependent synonyms exist the delete is refused with
/// that list unless `cascade` (sent only after the UI's explicit confirmation
/// showing it); cascade removes the metric plus every synonym that maps to it
/// in ONE write (the `views::delete` cascade rule). Returns the deleted metric
/// id. Sources are never touched by any path. KEEP IN SYNC with
/// semantic.ts::deleteMetric.
pub fn delete_metric(id: &str, cascade: bool) -> Result<String, String> {
    let _guard = store_lock();
    let mut store = list();
    let Some(metric) = store.metrics.iter().find(|m| m.id == id).cloned() else {
        return Err("metric not found".to_string());
    };
    let dep_terms: Vec<String> = dependent_synonyms(&store.synonyms, &metric.name)
        .iter()
        .map(|s| s.term.clone())
        .collect();
    if !dep_terms.is_empty() && !cascade {
        return Err(format!(
            "\"{}\" can't be deleted while synonyms map to it: {}",
            metric.name,
            dep_terms.join(", ")
        ));
    }
    store.metrics.retain(|m| m.id != id);
    store
        .synonyms
        .retain(|s| !s.canonical.eq_ignore_ascii_case(&metric.name));
    save(&store); // the ONE write — metric and its synonyms go together
    Ok(metric.id)
}

/// Delete a synonym by its term (case-insensitive). KEEP IN SYNC with
/// semantic.ts::deleteSynonym.
pub fn delete_synonym(term: &str) -> Result<(), String> {
    let _guard = store_lock();
    let mut store = list();
    let before = store.synonyms.len();
    store.synonyms.retain(|s| !s.term.eq_ignore_ascii_case(term));
    if store.synonyms.len() == before {
        return Err("synonym not found".to_string());
    }
    save(&store);
    Ok(())
}

/// Delete an entity by its name (case-insensitive). KEEP IN SYNC with
/// semantic.ts::deleteEntity.
pub fn delete_entity(name: &str) -> Result<(), String> {
    let _guard = store_lock();
    let mut store = list();
    let before = store.entities.len();
    store.entities.retain(|e| !e.name.eq_ignore_ascii_case(name));
    if store.entities.len() == before {
        return Err("entity not found".to_string());
    }
    save(&store);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::views::SummarySource;

    // Pure-function tests only (the views.rs posture): the store scenarios
    // (round trip, bak-on-write, lifecycle, sources-untouched, local-only over
    // real vault marks) live in tests/semantic_test.rs where VAULT_DIR mutation
    // is serialized by the shared env lock.

    fn summary(text: &str) -> ViewSummary {
        ViewSummary {
            text: text.to_string(),
            source: SummarySource::Question,
        }
    }

    fn file_reads(file_id: &str) -> Reads {
        Reads {
            files: vec![FileRead {
                file_id: file_id.to_string(),
                table_name: "sales".to_string(),
            }],
            views: Vec::new(),
        }
    }

    #[test]
    fn only_v1_envelopes_parse_with_the_camelcase_byte_contract() {
        let set = SemanticSet {
            metrics: vec![Metric {
                id: "metric-abc".into(),
                name: "revenue".into(),
                expression: "SUM(amount) FILTER (WHERE status='paid')".into(),
                description: "paid revenue".into(),
                entity: "sales".into(),
                reads: file_reads("sales.csv"),
                summary: summary("revenue by region"),
                created_ms: 7,
            }],
            synonyms: vec![Synonym {
                term: "GMV".into(),
                canonical: "revenue".into(),
            }],
            entities: vec![Entity {
                name: "sales".into(),
                table: "sales".into(),
                key_columns: vec!["region".into()],
                description: "the sales ledger".into(),
            }],
            join_hints: vec![JoinHint {
                left_entity: "orders".into(),
                left_column: "rep".into(),
                right_entity: "reps".into(),
                right_column: "rep".into(),
                description: "orders to reps".into(),
            }],
        };
        let text = serde_json::to_string_pretty(&Store::from_set(STORE_VERSION, &set)).unwrap();
        // The byte contract with the TS twin: envelope key `joinHints`,
        // camelCase record keys, the summary source as a bare lowercase string,
        // and the view types' `fileId`/`tableName` reused verbatim.
        for needle in [
            "\"v\": 1",
            "\"joinHints\": [",
            "\"createdMs\": 7",
            "\"fileId\": \"sales.csv\"",
            "\"tableName\": \"sales\"",
            "\"source\": \"question\"",
            "\"keyColumns\": [",
            "\"leftEntity\": \"orders\"",
            "\"rightColumn\": \"rep\"",
        ] {
            assert!(text.contains(needle), "missing {needle} in:\n{text}");
        }
        let parsed = parse_store(&text).expect("v1 loads");
        assert_eq!(parsed, set, "round trip preserves every record");

        // Anything else reads as unreadable (None): unknown/missing version,
        // corrupt JSON, and a record with an out-of-whitelist summary source
        // (the SummarySource whitelist — malformed, not coerced).
        assert!(parse_store(r#"{"v":99,"metrics":[],"synonyms":[],"entities":[],"joinHints":[]}"#).is_none());
        assert!(parse_store(r#"{"metrics":[]}"#).is_none());
        assert!(parse_store("{ not json").is_none());
        assert!(parse_store("null").is_none());
        assert!(parse_store(
            r#"{"v":1,"metrics":[{"id":"a","name":"n","expression":"SUM(x)","description":"","entity":"t","reads":{"files":[],"views":[]},"summary":{"text":"t","source":"guess"},"createdMs":1}],"synonyms":[],"entities":[],"joinHints":[]}"#
        )
        .is_none());
    }

    #[test]
    fn metric_ids_are_stable_and_input_sensitive() {
        assert_eq!(mint_id("metric", "a", "SUM(x)", 42), mint_id("metric", "a", "SUM(x)", 42));
        assert_ne!(mint_id("metric", "a", "SUM(x)", 42), mint_id("metric", "a", "SUM(x)", 43));
        assert_ne!(mint_id("metric", "a", "SUM(x)", 42), mint_id("metric", "b", "SUM(x)", 42));
        assert_ne!(mint_id("metric", "a", "SUM(x)", 42), mint_id("metric", "a", "SUM(y)", 42));
        // The prefix distinguishes id namespaces (metric- vs a future entity-).
        assert_ne!(mint_id("metric", "a", "SUM(x)", 42), mint_id("entity", "a", "SUM(x)", 42));
        let id = mint_id("metric", "a", "SUM(x)", 42);
        assert!(id.starts_with("metric-"));
        assert_eq!(id.len(), "metric-".len() + 12);
    }

    // PARITY: test/semantic.test.mjs mirrors this table — the SAME rules as
    // views' `normalize_view_name` (reused, not re-implemented).
    #[test]
    fn names_normalize_with_the_shared_view_rules() {
        assert_eq!(normalize_name("Net Revenue"), "net_revenue");
        assert_eq!(normalize_name("Q3 GMV (paid)"), "q3_gmv_paid");
        assert_eq!(normalize_name("2024 revenue"), "t_2024_revenue");
        assert_eq!(normalize_name("!!!"), "");
        assert_eq!(normalize_name(&"a".repeat(80)).len(), 64);
    }

    #[test]
    fn guard_accepts_a_read_only_aggregation_and_refuses_the_rest() {
        // A valid definition passes the SAME guard as an executed query and its
        // reads name the entity source (the spec's `revenue` scenario).
        let reads = crate::analytics::guard_metric_expression(
            "SUM(amount) FILTER (WHERE status='paid')",
            "sales",
        )
        .expect("accepts a read-only aggregation");
        assert_eq!(reads, vec!["sales"]);
        // An entity that is itself a join carries both sources into reads (the
        // FROM/JOIN factors — consistent across the twin's textual scan).
        let reads = crate::analytics::guard_metric_expression(
            "SUM(s.amount)",
            "sales s JOIN costs c ON s.id = c.id",
        )
        .expect("accepts");
        assert_eq!(reads, vec!["sales", "costs"]);

        // Unparseable expressions and an empty entity are refused at the guard
        // (an empty EXPRESSION parses leniently, so `create_metric` refuses it —
        // see the integration test).
        assert!(crate::analytics::guard_metric_expression("SUM(", "sales").is_err());
        assert!(
            crate::analytics::guard_metric_expression("amount", "").is_err(),
            "an empty entity leaves FROM danging and is unparseable"
        );
        // A smuggled second statement fails the single-statement guard.
        assert_eq!(
            crate::analytics::guard_metric_expression("1 FROM sales; DROP TABLE sales; SELECT 1", "sales")
                .unwrap_err(),
            "expected exactly one SQL statement"
        );
    }

    #[test]
    fn reads_local_only_propagates_over_synthetic_graphs() {
        // The file branch is pure-testable with a synthetic predicate: a
        // definition reading a marked file is local-only; reading only unmarked
        // files is not.
        let reads = file_reads("private.csv");
        assert!(reads_local_only(&reads, &[], &|id| id == "private.csv"));
        assert!(!reads_local_only(&reads, &[], &|_| false));
        // No file dependency and no resolvable read view ⇒ never local-only.
        let empty = Reads::default();
        assert!(!reads_local_only(&empty, &[], &|_| true));
    }

    #[test]
    fn dependent_synonyms_match_the_canonical_case_insensitively() {
        let synonyms = vec![
            Synonym { term: "GMV".into(), canonical: "revenue".into() },
            Synonym { term: "turnover".into(), canonical: "Revenue".into() },
            Synonym { term: "headcount".into(), canonical: "employees".into() },
        ];
        let deps: Vec<&str> = dependent_synonyms(&synonyms, "revenue")
            .iter()
            .map(|s| s.term.as_str())
            .collect();
        assert_eq!(deps, vec!["GMV", "turnover"], "case-insensitive, order kept");
        assert!(dependent_synonyms(&synonyms, "revenue_other").is_empty());
    }

    // --- §2 prompt block ------------------------------------------------------

    fn metric(name: &str, expression: &str, description: &str, created_ms: i64) -> Metric {
        Metric {
            id: format!("metric-{name}"),
            name: name.to_string(),
            expression: expression.to_string(),
            description: description.to_string(),
            entity: "sales".to_string(),
            reads: file_reads("sales.csv"),
            summary: summary("q"),
            created_ms,
        }
    }

    #[test]
    fn newest_first_keeps_the_newest_and_caps() {
        assert_eq!(newest_first(&[1, 2, 3, 4], 2), vec![4, 3], "newest, newest-first");
        assert_eq!(newest_first(&[1, 2], 5), vec![2, 1], "under the cap: all, still newest-first");
        assert!(newest_first::<i32>(&[], 3).is_empty());
    }

    #[test]
    fn render_block_is_none_for_an_empty_set() {
        // The byte-identical-prompt invariant's foundation: nothing eligible ⇒
        // no block ⇒ synth.rs pushes nothing.
        assert!(render_block(&SemanticSet::default()).is_none());
    }

    #[test]
    fn render_block_pins_the_business_definitions_string() {
        // A full set exercises every section + the metric-expansion examples;
        // the exact string is the byte contract with semantic.ts::renderBlock.
        let set = SemanticSet {
            metrics: vec![metric(
                "revenue",
                "SUM(amount) FILTER (WHERE status='paid')",
                "paid revenue",
                1,
            )],
            synonyms: vec![Synonym { term: "GMV".into(), canonical: "revenue".into() }],
            entities: vec![Entity {
                name: "sales".into(),
                table: "sales".into(),
                key_columns: vec!["region".into(), "product".into()],
                description: "the sales ledger".into(),
            }],
            join_hints: vec![JoinHint {
                left_entity: "orders".into(),
                left_column: "rep".into(),
                right_entity: "reps".into(),
                right_column: "rep".into(),
                description: "each order's owner".into(),
            }],
        };
        let block = render_block(&set).expect("a non-empty set renders a block");
        assert_eq!(block.name, "business definitions");
        assert_eq!(block.score, 0.0);
        let expected = [
            "Business definitions for this vault (curated meanings — prefer these over guessing; write SQL that uses each metric's exact definition):",
            "",
            "Metrics (name = definition):",
            "- revenue = SUM(amount) FILTER (WHERE status='paid') — paid revenue",
            "",
            "Synonyms (term → canonical column or metric):",
            "- GMV → revenue",
            "",
            "Entities (name: table (key columns) — description):",
            "- sales: sales (region, product) — the sales ledger",
            "",
            "Curated join hints (authoritative — prefer over inferred joins):",
            "- orders.rep = reps.rep — each order's owner",
            "",
            "Examples (a defined term expands to its metric definition):",
            "Q: revenue by region",
            "SQL: SELECT region, SUM(amount) FILTER (WHERE status = 'paid') AS revenue FROM sales GROUP BY region ORDER BY revenue DESC",
            "Q: gmv by month (gmv is the revenue metric)",
            "SQL: SELECT substr(order_date, 1, 7) AS month, SUM(amount) FILTER (WHERE status = 'paid') AS revenue FROM sales GROUP BY month ORDER BY month",
        ]
        .join("\n");
        assert_eq!(block.text, expected);
    }

    #[test]
    fn render_block_renders_metrics_newest_first_and_omits_examples_without_metrics() {
        // Newest metric first (the slot-cap idiom), empty descriptions add no
        // dangling `— `.
        let set = SemanticSet {
            metrics: vec![
                metric("older", "COUNT(*)", "", 1),
                metric("newer", "SUM(x)", "", 2),
            ],
            ..Default::default()
        };
        let text = render_block(&set).unwrap().text;
        // A metric with no description renders as a bare `- name = expr` (no
        // dangling `— `); newest metric renders first (the slot-cap idiom).
        assert!(text.contains("- newer = SUM(x)\n- older = COUNT(*)"), "newest first, no suffix:\n{text}");

        // A synonym-only set renders a block but NO examples (they demonstrate
        // metric expansion, so ride only when a metric exists).
        let syn_only = SemanticSet {
            synonyms: vec![Synonym { term: "GMV".into(), canonical: "revenue".into() }],
            ..Default::default()
        };
        let text = render_block(&syn_only).unwrap().text;
        assert!(text.contains("- GMV → revenue"));
        assert!(!text.contains(EXAMPLES_HEADER), "no examples without a metric:\n{text}");
    }

    #[test]
    fn every_semantic_fewshot_passes_the_guard() {
        // The block's blessed examples are re-runnable read-only SELECTs — the
        // SAME guard every executed query and every saved metric passes.
        for (q, sql) in SEMANTIC_FEWSHOTS {
            crate::analytics::guard_sql(sql)
                .unwrap_or_else(|e| panic!("semantic few-shot for {q:?} rejected: {e}"));
        }
    }
}
