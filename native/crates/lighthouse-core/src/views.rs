//! Shaped views: named, guarded SELECTs over vault tables
//! (openspec: add-shaped-views).
//!
//! A view is a STORED DEFINITION — `{id, name, sql, reads, summary,
//! createdMs}` — never materialized rows. Resolution happens virtually at
//! ask time (a later section registers `ctx.sql(&view.sql)` as a virtual
//! table), so results always reflect the sources' current bytes and no view
//! operation ever writes to a source file.
//!
//! Everything is validated AT SAVE: the definition must pass
//! `analytics::guard_sql` (exactly one read-only SELECT — the same guard
//! every executed query passes), the name must survive the table-name
//! character rules plus a reserved-word list and must collide with neither
//! another view nor a current file table, and `reads` is derived from the
//! parsed AST's table factors (CTE aliases excluded) — every referenced name
//! must resolve to a saved view or to a table derived from the passed file
//! ids, or the save is refused. View-over-view forms a DAG: a definition
//! that would create a cycle or exceed `MAX_VIEW_DEPTH` is refused. Because
//! v1 has no in-place redefinition, edges never change after save — rename
//! keeps ids stable and delete refuses/cascades — so the invariant holds by
//! construction; the cycle check stays anyway as defense (design.md).
//!
//! Versioning posture (user data, not a cache): the store is a versioned
//! envelope `{v: 1, views: [...]}` in `state_dir()/views.json` — the
//! investigations/boards idiom verbatim. `v == 1` loads; an unknown or
//! missing version — or unparseable JSON — loads EMPTY for the session, and
//! the first subsequent write renames the unreadable file to
//! `views.json.bak-<epochms>` before writing a fresh v1 envelope. Nothing is
//! silently clobbered; a downgrade leaves the newer file recoverable.
//!
//! The dev server twin (src/server/views.ts, KEEP IN SYNC) mirrors this
//! module byte-compatibly: same envelope, same validation and error strings,
//! same id minting, same DAG/lifecycle rules. PARITY divergences, both
//! marked there: the twin's definition guard is a conservative textual
//! single-SELECT check (guard_sql's parser is Rust-only; the desktop
//! re-guards before every execution regardless), and its reads derivation is
//! a FROM/JOIN identifier scan rather than an AST walk.

use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};

use crate::config::{now_ms, state_dir, write_json};

/// Envelope version this engine reads and writes.
const STORE_VERSION: u32 = 1;

/// Depth cap for view-over-view stacking: a view over only files has depth
/// 1; referencing a view of depth d makes depth d+1. A definition whose
/// depth would EXCEED this is refused at save (design.md "DAG rules").
pub const MAX_VIEW_DEPTH: usize = 3;

/// Names a view can never take (design.md "Names") — SQL keywords that would
/// make the stored definition ambiguous or unquotable at resolution time.
const RESERVED_NAMES: [&str; 15] = [
    "select", "from", "where", "join", "group", "order", "by", "with", "union", "all", "as", "on",
    "limit", "table", "values",
];

/// Serializes load-modify-save on the store (mirrors boards'/investigations').
fn store_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|p| p.into_inner())
}

/// Where the one-line summary came from. Unit variant names ARE the wire
/// strings ("question" | "model") — serde rejects anything else at parse
/// time, so a record can never carry an unlabeled summary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SummarySource {
    /// Recorded from the asked question ("Save as view" on a Beam answer).
    Question,
    /// Stated by the model during a shaping ask.
    Model,
}

/// The provenance-labeled one-line summary a view card carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ViewSummary {
    pub text: String,
    pub source: SummarySource,
}

/// One source-file dependency with its name binding pinned at save: the
/// table name the definition's SQL uses for this file. Resolution (a later
/// section) re-binds it — aliasing when ambient registration suffixed the
/// name differently — but the stored record never changes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRead {
    pub file_id: String,
    pub table_name: String,
}

/// Dependencies resolved at save, stored: source files (with pinned name
/// bindings) and other views (by id — rename never rewrites these).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Reads {
    pub files: Vec<FileRead>,
    pub views: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    /// Engine-minted, stable: `view-` + first 12 hex chars of
    /// sha1(name \n sql \n createdMs) — see `view_id`. NOT derived from the
    /// current name — rename keeps the id, so dependents' stored `reads`
    /// stay valid forever.
    pub id: String,
    /// Sanitized identifier (lowercase `[a-z0-9_]`, no leading digit, ≤64
    /// chars), unique case-insensitively among views and never shadowing a
    /// current file table.
    pub name: String,
    /// Exactly ONE read-only SELECT — `guard_sql` passed at save, and the
    /// desktop re-guards before every execution.
    pub sql: String,
    /// Dependencies resolved at save (see `Reads`).
    pub reads: Reads,
    /// Provenance-labeled one-liner (question-derived or model-stated).
    pub summary: ViewSummary,
    /// Creation instant (epoch ms).
    pub created_ms: i64,
}

fn views_path() -> PathBuf {
    state_dir().join("views.json")
}

#[derive(Serialize, Deserialize)]
struct Store {
    v: u32,
    views: Vec<View>,
}

/// A readable v1 envelope's records, or `None` when the text is not one
/// (unknown/missing version, or unparseable JSON — the two read identically,
/// see the module's versioning posture). PARITY: the TS twin trusts the
/// records array wholesale once the envelope checks pass; here serde also
/// rejects records with malformed required fields (an out-of-whitelist
/// summary source included) — engine-written files always carry every field,
/// so the twins agree on every file they write.
fn parse_store(text: &str) -> Option<Vec<View>> {
    match serde_json::from_str::<Store>(text) {
        Ok(s) if s.v == STORE_VERSION => Some(s.views),
        _ => None,
    }
}

enum Loaded {
    Records(Vec<View>),
    Missing,
    /// Present but not a readable v1 envelope — reads empty for the session;
    /// the next write baks the file first (never clobber silently).
    Unreadable,
}

fn load() -> Loaded {
    match std::fs::read_to_string(views_path()) {
        Ok(text) => match parse_store(&text) {
            Some(records) => Loaded::Records(records),
            None => Loaded::Unreadable,
        },
        Err(_) => Loaded::Missing,
    }
}

/// All saved views, creation order. A missing store reads empty; an
/// unreadable one reads empty FOR THE SESSION (see `save`'s bak-on-write).
pub fn list() -> Vec<View> {
    match load() {
        Loaded::Records(records) => records,
        _ => Vec::new(),
    }
}

fn save(records: &[View]) {
    let path = views_path();
    // Versioning posture: an unreadable file (unknown/missing version,
    // corrupt JSON) is preserved as a `.bak-<epochms>` sibling before the
    // fresh v1 write — a downgrade or corruption never silently clobbers
    // newer data. Rename, falling back to copy, both best-effort.
    if matches!(load(), Loaded::Unreadable) {
        let bak = path.with_file_name(format!("views.json.bak-{}", now_ms()));
        if std::fs::rename(&path, &bak).is_err() {
            let _ = std::fs::copy(&path, &bak);
        }
    }
    write_json(
        &path,
        &Store {
            v: STORE_VERSION,
            views: records.to_vec(),
        },
    );
}

/// Stable engine-minted id: `view-` + first 12 hex chars of
/// sha1(name \n sql \n createdMs) — the boards `board_id` idiom. The sql
/// rides in the hash so same-named creations in the same millisecond (a
/// deleted name reused by tests) can't collide. KEEP IN SYNC with
/// views.ts::viewId.
fn view_id(name: &str, sql: &str, created_ms: i64) -> String {
    let digest = Sha1::digest(format!("{name}\n{sql}\n{created_ms}").as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("view-{}", &hex[..12])
}

/// Normalize a user-entered view name with the SAME character rules as
/// `analytics::sanitize_table_name` (lowercase, `[a-z0-9_]`, separators
/// collapsed to `_`, trimmed, `t_` prefix on a leading digit) — WITHOUT the
/// file-stem extension strip ("q3.totals" is a dotted name, not a file
/// name) and WITHOUT the "table" fallback: an empty result is returned
/// empty and refused by the caller. Capped at 64 chars (design.md "Names").
/// KEEP IN SYNC with views.ts::normalizeViewName.
fn normalize_view_name(raw: &str) -> String {
    let lower = raw.to_lowercase();
    let mut out = String::with_capacity(lower.len());
    let mut last_us = true; // also trims leading underscores
    for ch in lower.chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            out.push(ch);
            last_us = false;
        } else if !last_us {
            out.push('_');
            last_us = true;
        }
    }
    let mut out = out.trim_end_matches('_').to_string();
    if out.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        out = format!("t_{out}");
    }
    out.truncate(64);
    out.trim_end_matches('_').to_string()
}

// --- Dependency derivation (AST walk) ---------------------------------------------

/// Accumulator for one pass over the parsed query: every CTE alias declared
/// in any WITH clause, and every table-factor name, in appearance order.
#[derive(Default)]
struct TableWalk {
    ctes: Vec<String>,
    names: Vec<String>,
}

fn walk_query(q: &datafusion::sql::sqlparser::ast::Query, w: &mut TableWalk) {
    if let Some(with) = &q.with {
        for cte in &with.cte_tables {
            w.ctes.push(cte.alias.name.value.to_lowercase());
            walk_query(&cte.query, w);
        }
    }
    walk_set_expr(&q.body, w);
}

fn walk_set_expr(body: &datafusion::sql::sqlparser::ast::SetExpr, w: &mut TableWalk) {
    use datafusion::sql::sqlparser::ast::SetExpr;
    match body {
        SetExpr::Select(s) => {
            for twj in &s.from {
                walk_table_with_joins(twj, w);
            }
        }
        SetExpr::Query(inner) => walk_query(inner, w),
        SetExpr::SetOperation { left, right, .. } => {
            walk_set_expr(left, w);
            walk_set_expr(right, w);
        }
        // Values / modifying bodies — guard_sql already rejected anything
        // that could reach here with table references.
        _ => {}
    }
}

fn walk_table_with_joins(twj: &datafusion::sql::sqlparser::ast::TableWithJoins, w: &mut TableWalk) {
    walk_table_factor(&twj.relation, w);
    for j in &twj.joins {
        walk_table_factor(&j.relation, w);
    }
}

fn walk_table_factor(f: &datafusion::sql::sqlparser::ast::TableFactor, w: &mut TableWalk) {
    use datafusion::sql::sqlparser::ast::TableFactor;
    match f {
        // A named relation — table-valued functions land here too (args) and
        // are deliberately COLLECTED: their name resolves to no saved view or
        // file table, so a definition using one is refused rather than saved
        // with an invisible dependency.
        TableFactor::Table { name, .. } => {
            let dotted: Vec<String> = name
                .0
                .iter()
                .map(|p| match p.as_ident() {
                    Some(ident) => ident.value.clone(),
                    None => p.to_string(),
                })
                .collect();
            w.names.push(dotted.join("."));
        }
        TableFactor::Derived { subquery, .. } => walk_query(subquery, w),
        TableFactor::NestedJoin {
            table_with_joins, ..
        } => walk_table_with_joins(table_with_joins, w),
        TableFactor::Pivot { table, .. }
        | TableFactor::Unpivot { table, .. }
        | TableFactor::MatchRecognize { table, .. } => walk_table_factor(table, w),
        // UNNEST / JSON_TABLE / function factors name no stored table.
        _ => {}
    }
}

/// The table names a definition references: the sqlparser AST's table
/// factors (the SAME parse `guard_sql` does — DFParser, so the two can
/// never disagree about what the SQL says), EXCLUDING names declared as CTE
/// aliases in WITH clauses anywhere in the statement. Deduped
/// case-insensitively, first-appearance order and casing kept for the
/// refusal message. PARITY: views.ts::collectTableNames approximates this
/// with a FROM/JOIN identifier scan.
fn collect_table_names(sql: &str) -> Result<Vec<String>, String> {
    use datafusion::sql::parser::{DFParser, Statement as DFStatement};
    use datafusion::sql::sqlparser::ast::Statement as SqlStatement;
    let stmts = DFParser::parse_sql(sql).map_err(|e| format!("SQL parse error: {e}"))?;
    let mut w = TableWalk::default();
    for s in &stmts {
        if let DFStatement::Statement(s) = s {
            if let SqlStatement::Query(q) = &**s {
                walk_query(q, &mut w);
            }
        }
    }
    let mut out: Vec<String> = Vec::new();
    for name in w.names {
        let lower = name.to_lowercase();
        if w.ctes.contains(&lower) {
            continue;
        }
        if !out.iter().any(|n| n.to_lowercase() == lower) {
            out.push(name);
        }
    }
    Ok(out)
}

// --- DAG checks (pure, testable on synthetic graphs) -------------------------------

/// Whether a NEW definition (`new_id`, reading `read_view_ids`) would create
/// a cycle. DFS from each dependency with an explicit path stack: reaching
/// the new view's own id, or revisiting a node already ON THE CURRENT PATH
/// (a back edge in the existing graph — only possible in a hand-crafted
/// store; create keeps the store acyclic by construction), is a cycle. A
/// node reached twice via DIFFERENT paths (a diamond) is legal DAG shape,
/// not a cycle. Unknown ids end their branch — unknown-reference refusal is
/// the derivation step's job. KEEP IN SYNC with views.ts::wouldCycle.
pub fn would_cycle(records: &[View], new_id: &str, read_view_ids: &[String]) -> bool {
    fn visit(
        records: &[View],
        id: &str,
        new_id: &str,
        path: &mut Vec<String>,
        done: &mut Vec<String>,
    ) -> bool {
        if id == new_id {
            return true;
        }
        if path.iter().any(|p| p == id) {
            return true; // back edge: the existing graph itself is cyclic
        }
        if done.iter().any(|d| d == id) {
            return false; // finished elsewhere (diamond) — no cycle through it
        }
        let Some(v) = records.iter().find(|r| r.id == id) else {
            done.push(id.to_string());
            return false;
        };
        path.push(id.to_string());
        for dep in &v.reads.views {
            if visit(records, dep, new_id, path, done) {
                return true;
            }
        }
        path.pop();
        done.push(id.to_string());
        false
    }
    let mut path = Vec::new();
    let mut done = Vec::new();
    read_view_ids
        .iter()
        .any(|dep| visit(records, dep, new_id, &mut path, &mut done))
}

/// The depth a NEW definition reading `read_view_ids` would have: 1 when it
/// reads only files, else 1 + the deepest referenced view (design.md "DAG
/// rules"). Cycle-safe on synthetic graphs: a node revisited on the current
/// path answers past the cap rather than recursing forever (`would_cycle`
/// is the check that actually names the offense). Unknown ids count as
/// depth 1. KEEP IN SYNC with views.ts::viewDepth.
pub fn view_depth(records: &[View], read_view_ids: &[String]) -> usize {
    fn depth_of(records: &[View], id: &str, path: &mut Vec<String>) -> usize {
        if path.iter().any(|p| p == id) {
            return MAX_VIEW_DEPTH + 1; // cyclic (synthetic) — poison past the cap
        }
        let Some(v) = records.iter().find(|r| r.id == id) else {
            return 1;
        };
        if v.reads.views.is_empty() {
            return 1;
        }
        path.push(id.to_string());
        let d = 1 + v
            .reads
            .views
            .iter()
            .map(|dep| depth_of(records, dep, path))
            .max()
            .unwrap_or(0);
        path.pop();
        d
    }
    if read_view_ids.is_empty() {
        return 1;
    }
    let mut path = Vec::new();
    1 + read_view_ids
        .iter()
        .map(|dep| depth_of(records, dep, &mut path))
        .max()
        .unwrap_or(0)
}

/// DIRECT dependents within a record set: every view whose `reads.views`
/// names `id`, store (creation) order. Pure so lifecycle rules are testable
/// on synthetic graphs.
pub fn dependents_in(records: &[View], id: &str) -> Vec<View> {
    records
        .iter()
        .filter(|r| r.reads.views.iter().any(|v| v == id))
        .cloned()
        .collect()
}

/// TRANSITIVE dependents within a record set (dependents, their dependents,
/// …), store (creation) order, excluding `id` itself. Grow-until-fixed like
/// the vault's descendant walks — no recursion, cycle-tolerant on synthetic
/// graphs.
pub fn transitive_dependents_in(records: &[View], id: &str) -> Vec<View> {
    let mut in_set: Vec<String> = vec![id.to_string()];
    let mut grew = true;
    while grew {
        grew = false;
        for r in records {
            if !in_set.contains(&r.id) && r.reads.views.iter().any(|v| in_set.contains(v)) {
                in_set.push(r.id.clone());
                grew = true;
            }
        }
    }
    records
        .iter()
        .filter(|r| r.id != id && in_set.contains(&r.id))
        .cloned()
        .collect()
}

/// The saved views that DIRECTLY read `id` — what the rename refusal names
/// and the inspector lists. KEEP IN SYNC with views.ts::dependentsOf.
pub fn dependents_of(id: &str) -> Vec<View> {
    dependents_in(&list(), id)
}

/// The saved views that TRANSITIVELY read `id` — what the delete refusal and
/// the cascade confirmation show. KEEP IN SYNC with
/// views.ts::transitiveDependents.
pub fn transitive_dependents(id: &str) -> Vec<View> {
    transitive_dependents_in(&list(), id)
}

// --- Posture (ask-time eligibility, openspec: add-shaped-views §2) ------------------

/// TRANSITIVE local-only propagation (design.md "Local-only propagation"):
/// a view is effectively local-only when ANY transitive source file carries
/// an effective local-only mark (the vault's ancestor-wins resolver via its
/// stateless single-file accessor, `vault::node_is_local_only`), or any view
/// it reads is. Cycle-tolerant on synthetic graphs; unknown parent ids
/// contribute nothing. KEEP IN SYNC with views.ts::viewEffectivelyLocalOnly.
pub fn view_effectively_local_only(v: &View, records: &[View]) -> bool {
    fn walk(cur: &View, records: &[View], seen: &mut Vec<String>) -> bool {
        if cur
            .reads
            .files
            .iter()
            .any(|f| crate::vault::node_is_local_only(&f.file_id))
        {
            return true;
        }
        for pid in &cur.reads.views {
            if seen.iter().any(|s| s == pid) {
                continue;
            }
            seen.push(pid.clone());
            if let Some(parent) = records.iter().find(|r| r.id == *pid) {
                if walk(parent, records, seen) {
                    return true;
                }
            }
        }
        false
    }
    walk(v, records, &mut vec![v.id.clone()])
}

/// The saved views eligible under an ask's posture, store (creation) order:
/// every view when the ask stays on device (marks are inert locally); a
/// cloud ask excludes the effectively-local-only ones so a private table's
/// shape can never ride a view into a vendor prompt — or into its cache key
/// (answer_cache::cache_key digests exactly this list). KEEP IN SYNC with
/// views.ts::eligibleForPosture.
pub fn eligible_for_posture(is_cloud: bool) -> Vec<View> {
    let records = list();
    if !is_cloud {
        return records;
    }
    records
        .iter()
        .filter(|v| !view_effectively_local_only(v, &records))
        .cloned()
        .collect()
}

// --- Vault lookups (create's public entry fetches these) ---------------------------

/// Table names the CURRENT catalog would give the vault's tabular files —
/// what a view name must not shadow (design.md: files always win a name
/// collision). Same enumeration as the direct-execution path
/// (`analytics::direct_tables`): active included ids → `vault::doc_path` →
/// the tabular/PDF registration gate → `sanitize_table_name`.
fn current_file_table_names() -> Vec<String> {
    crate::vault::active_included_file_ids()
        .iter()
        .filter_map(|id| crate::vault::doc_path(id))
        .filter(|(name, _)| {
            crate::analytics::is_tabular(name) || crate::analytics::is_pdf(name)
        })
        .map(|(name, _)| crate::analytics::sanitize_table_name(&name))
        .collect()
}

/// Resolve the passed file ids to display names, keeping order — the same
/// per-id lookup `run_direct` uses. Ids that no longer resolve (or aren't
/// registrable as tables) simply contribute no table name; a definition
/// that references them is then refused as an unknown table.
fn resolve_files(file_ids: &[String]) -> Vec<(String, String)> {
    file_ids
        .iter()
        .filter_map(|id| {
            let (name, _) = crate::vault::doc_path(id)?;
            (crate::analytics::is_tabular(&name) || crate::analytics::is_pdf(&name))
                .then_some((id.clone(), name))
        })
        .collect()
}

// --- CRUD --------------------------------------------------------------------------

/// Create a view: validate the name, guard the definition, derive `reads`,
/// enforce the DAG rules, persist — refusing with a human-readable reason at
/// the first offense and persisting NOTHING on refusal. The vault lookups
/// (current file table names, file display names) are fetched here;
/// `create_with_tables` is the deterministic core. KEEP IN SYNC with
/// views.ts::createView.
pub fn create(
    name: &str,
    sql: &str,
    summary: ViewSummary,
    file_ids: &[String],
) -> Result<View, String> {
    create_with_tables(
        name,
        sql,
        summary,
        &resolve_files(file_ids),
        &current_file_table_names(),
    )
}

/// `create` with the vault lookups supplied by the caller: `files` is the
/// resolved `(file_id, display_name)` list in file_ids order, and
/// `taken_table_names` is the current catalog's file table names (the
/// name-shadowing check). KEEP IN SYNC with views.ts::createViewWithTables.
pub fn create_with_tables(
    name: &str,
    sql: &str,
    summary: ViewSummary,
    files: &[(String, String)],
    taken_table_names: &[String],
) -> Result<View, String> {
    // 1. Name: sanitize, then refuse empty / reserved / any collision.
    let name = normalize_view_name(name);
    if name.is_empty() {
        return Err("a view needs a name".to_string());
    }
    if RESERVED_NAMES.contains(&name.as_str()) {
        return Err(format!("\"{name}\" is a reserved word"));
    }
    let _guard = store_lock();
    let records = list();
    if records.iter().any(|r| r.name.eq_ignore_ascii_case(&name)) {
        return Err(format!("a view named \"{name}\" already exists"));
    }
    if taken_table_names
        .iter()
        .any(|t| t.eq_ignore_ascii_case(&name))
    {
        return Err(format!(
            "a table named \"{name}\" already exists in your files"
        ));
    }

    // 2. Guard: the SAME check every executed query passes, at save time.
    crate::analytics::guard_sql(sql)?;

    // 3. Reads: walk the parsed AST's table factors; every referenced name
    //    must resolve to a saved view (case-insensitive name match) or to a
    //    table derived from the passed files by replaying register_tables'
    //    naming pipeline — sanitize_table_name over each display name, in
    //    file_ids order, with unique_table_name suffix-on-collision.
    let referenced = collect_table_names(sql)?;
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
        if let Some(v) = records.iter().find(|r| r.name.to_lowercase() == lower) {
            reads.views.push(v.id.clone());
        } else if let Some((table_name, file_id)) =
            file_tables.iter().find(|(t, _)| *t == lower)
        {
            reads.files.push(FileRead {
                file_id: file_id.clone(),
                table_name: table_name.clone(),
            });
        } else {
            return Err(format!("unknown table in definition: {table}"));
        }
    }

    // 4. DAG: cycle (impossible by construction, checked anyway as defense)
    //    and the depth cap.
    let created_ms = now_ms();
    let id = view_id(&name, sql, created_ms);
    if would_cycle(&records, &id, &reads.views) {
        return Err("that definition would create a cycle".to_string());
    }
    if view_depth(&records, &reads.views) > MAX_VIEW_DEPTH {
        return Err(format!("view depth is capped at {MAX_VIEW_DEPTH}"));
    }

    let view = View {
        id,
        name,
        sql: sql.to_string(),
        reads,
        summary,
        created_ms,
    };
    let mut records = records;
    records.push(view.clone());
    save(&records);
    Ok(view)
}

/// Rename a view — REFUSED with a message naming the dependent views while
/// any other view reads this one (dependent SQL is user-approved text;
/// silently rewriting it risks corrupting a definition where the old name
/// also appears as a column — design.md "Lifecycle"). Otherwise a pure
/// store update: the id and every stored `reads` are untouched everywhere.
/// The new name passes the SAME rules as create. KEEP IN SYNC with
/// views.ts::renameView.
pub fn rename(id: &str, new_name: &str) -> Result<View, String> {
    let name = normalize_view_name(new_name);
    if name.is_empty() {
        return Err("a view needs a name".to_string());
    }
    if RESERVED_NAMES.contains(&name.as_str()) {
        return Err(format!("\"{name}\" is a reserved word"));
    }
    let taken_table_names = current_file_table_names();
    let _guard = store_lock();
    let mut records = list();
    let Some(idx) = records.iter().position(|r| r.id == id) else {
        return Err("view not found".to_string());
    };
    let deps = dependents_in(&records, id);
    if !deps.is_empty() {
        let names: Vec<String> = deps.iter().map(|d| d.name.clone()).collect();
        return Err(format!(
            "\"{}\" can't be renamed while other views read it: {}",
            records[idx].name,
            names.join(", ")
        ));
    }
    if records
        .iter()
        .any(|r| r.id != id && r.name.eq_ignore_ascii_case(&name))
    {
        return Err(format!("a view named \"{name}\" already exists"));
    }
    if taken_table_names
        .iter()
        .any(|t| t.eq_ignore_ascii_case(&name))
    {
        return Err(format!(
            "a table named \"{name}\" already exists in your files"
        ));
    }
    records[idx].name = name;
    save(&records);
    Ok(records[idx].clone())
}

/// Delete a view. While TRANSITIVE dependents exist the delete is refused
/// with that list unless `cascade` (sent only after the UI's explicit
/// confirmation showing it); cascade removes the view plus its transitive
/// dependents in ONE write. Returns the deleted ids, store (creation)
/// order. Sources are never touched by any path. KEEP IN SYNC with
/// views.ts::deleteView.
pub fn delete(id: &str, cascade: bool) -> Result<Vec<String>, String> {
    let _guard = store_lock();
    let mut records = list();
    let Some(target) = records.iter().find(|r| r.id == id).cloned() else {
        return Err("view not found".to_string());
    };
    let dependents = transitive_dependents_in(&records, id);
    if !dependents.is_empty() && !cascade {
        let names: Vec<String> = dependents.iter().map(|d| d.name.clone()).collect();
        return Err(format!(
            "\"{}\" can't be deleted while other views read it: {}",
            target.name,
            names.join(", ")
        ));
    }
    let mut doomed: Vec<String> = vec![id.to_string()];
    doomed.extend(dependents.iter().map(|d| d.id.clone()));
    let deleted: Vec<String> = records
        .iter()
        .filter(|r| doomed.contains(&r.id))
        .map(|r| r.id.clone())
        .collect();
    records.retain(|r| !doomed.contains(&r.id));
    save(&records); // the ONE write — target and dependents go together
    Ok(deleted)
}

// --- Shaping ask (openspec: add-shaped-views §3) ------------------------------------
//
// `shape_view` is the ONE model-consulting path in this module (and the only
// one this feature adds anywhere): a single `llm::stream_answer` completion
// proposes a transform SELECT over one registered source; the engine
// validates it with the SAME guard as every executed query and renders
// before/after sample evidence. NOTHING persists in this flow, ever — `create`
// runs only when the user clicks Save, via the separate `op:"views"` arm.
// Desktop/server engines only; the TS twin always answers `{available:false}`
// (PARITY — analytics/DataFusion is Rust-engine-only).

/// A shaping proposal: the validated SELECT, engine-rendered before/after
/// sample tables (markdown), and the model's one-line summary ("" when the
/// reply carried none — `create` then stores an empty model-labeled summary
/// and the card simply shows nothing). Held by the UI until Save or Cancel;
/// never stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShapeProposal {
    pub sql: String,
    pub before: String,
    pub after: String,
    pub summary: String,
}

/// The honest refusal when the effective provider can't complete (no provider
/// configured, or a keyless remote — the extractive fallback answers without
/// a model). The dispatch arms match this EXACT string to answer
/// `{available:false}` (the TS twin's constant posture), so keep it stable.
pub const SHAPE_NEEDS_MODEL: &str =
    "shaping needs a model; the current provider answers extractively";

/// First rows rendered as before/after evidence. KEEP IN SYNC with
/// analytics.rs::SAMPLE_ROWS — the table cards sample the same three.
const SHAPE_SAMPLE_ROWS: usize = 3;

/// Longest slice of a no-SELECT model reply surfaced as the refusal reason —
/// enough to read the model's own words, bounded so the dialog stays sane.
const SHAPE_REFUSAL_MAX_CHARS: usize = 400;

/// Few-shot examples for the shaping prompt — messy→clean transforms in the
/// two shapes the dialog exists for: casting a '$1,234'-style text column to
/// numeric, and filtering junk header rows with a WHERE. Deliberately GENERIC
/// table/column names (the prompt says to adapt them); every SELECT must pass
/// `guard_sql`, pinned by a test (the SQL_FEWSHOTS/chart-directive precedent
/// of validating few-shots with the engine's own validator).
pub const SHAPE_FEWSHOTS: &[(&str, &str, &str)] = &[
    (
        "the amount column is text like '$1,234' — make it a real number",
        "SELECT region, CAST(REPLACE(REPLACE(amount, '$', ''), ',', '') AS DOUBLE) AS amount FROM raw_sales",
        "raw_sales with amount cast from '$1,234'-style text to a number",
    ),
    (
        "drop the junk rows that repeat the header inside the data",
        "SELECT * FROM raw_export WHERE region <> 'region' AND amount IS NOT NULL",
        "raw_export without the repeated-header junk rows",
    ),
];

/// The few-shot context block the completion sees beside the source's table
/// card. Pure — pinned with `shape_question` by the snapshot test.
pub fn shape_fewshot_block() -> String {
    SHAPE_FEWSHOTS
        .iter()
        .map(|(instruction, sql, summary)| {
            format!("Instruction: {instruction}\nSQL: {sql}\nSummary: {summary}")
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// The shaping ask handed to the model (the source's table card and the
/// few-shot examples ride as context blocks, not in this string). Fixed
/// template — the reply contract is EXACTLY one SELECT in a ```sql fence,
/// then one "Summary:" line; the reply is post-processed by `extract_sql` +
/// `guard_sql`, so stray prose is tolerated. Pure; snapshot-tested.
pub fn shape_question(source: &str, instruction: &str) -> String {
    format!(
        "You are shaping the table \"{source}\" into a clean, reusable view with \
         ONE SQL query (DataFusion, PostgreSQL-style syntax). The first context \
         block describes {source}: its exact table name, columns with types, row \
         count, and a few sample rows; the second holds examples with a GENERIC \
         schema — adapt their idea to {source}'s real columns.\n\
         Write a single SELECT statement over {source} that applies the \
         instruction below. Reply with ONLY:\n\
         1. the SQL in a ```sql code block\n\
         2. one line starting with \"Summary:\" — a plain-words description of \
         the shaped result\n\
         Use the exact table and column names as given. Read only — never write, \
         and never invent tables.\n\n\
         Instruction: {instruction}"
    )
}

/// Parse a shaping reply: the fenced (or bare) SELECT via the SAME
/// `extract_sql` + `guard_sql` pair as the ask path, plus the reply's
/// "Summary:" line ("" when absent). No usable SELECT ⇒ Err carrying the
/// model's own words (bounded) — the dialog shows the refusal verbatim and
/// retry is free (design.md "Failure & degradation").
pub fn parse_shape_reply(reply: &str) -> Result<(String, String), String> {
    let Some(sql) = crate::analytics::extract_sql(reply) else {
        let reason: String = reply.trim().chars().take(SHAPE_REFUSAL_MAX_CHARS).collect();
        return Err(if reason.is_empty() {
            "the model returned no SQL".to_string()
        } else {
            reason
        });
    };
    crate::analytics::guard_sql(&sql)?;
    let summary = reply
        .lines()
        .filter_map(|l| l.trim().strip_prefix("Summary:"))
        .map(|s| s.trim().to_string())
        .find(|s| !s.is_empty())
        .unwrap_or_default();
    Ok((sql, summary))
}

/// Engine-rendered before/after evidence: the first `SHAPE_SAMPLE_ROWS` of
/// the source and of the proposed SELECT (wrapped as a guarded subquery),
/// both through `run_query` — the guard, the timeout, and the markdown caps
/// every executed query gets. Any execution failure is the caller's Err (the
/// proposal dialog shows the reason; nothing was persisted).
pub async fn shape_samples(
    ctx: &datafusion::prelude::SessionContext,
    source: &str,
    sql: &str,
) -> Result<(String, String), String> {
    let before = crate::analytics::run_query(
        ctx,
        &format!("SELECT * FROM {source} LIMIT {SHAPE_SAMPLE_ROWS}"),
    )
    .await?
    .markdown;
    let after = crate::analytics::run_query(
        ctx,
        &format!("SELECT * FROM ({sql}) AS shaped LIMIT {SHAPE_SAMPLE_ROWS}"),
    )
    .await?
    .markdown;
    Ok((before, after))
}

/// Whether the shaping completion must take the local path: any of the file
/// ids is effectively local-only (the vault's ancestor-wins resolver via its
/// stateless single-file accessor), or the source names a saved view that is
/// transitively local-only. This is the H1 `local_model_config()` seam — the
/// same swap a local-only investigation applies at the model-config
/// chokepoint (`investigations::resolve_ask_context`), applied here BEFORE
/// any transport exists.
pub fn shape_is_local_only(source: &str, file_ids: &[String]) -> bool {
    if file_ids
        .iter()
        .any(|id| crate::vault::node_is_local_only(id))
    {
        return true;
    }
    let records = list();
    records
        .iter()
        .find(|v| v.name.eq_ignore_ascii_case(source.trim()))
        .is_some_and(|v| view_effectively_local_only(v, &records))
}

/// Whether a config can actually complete. Mirrors synth::has_real_model
/// (private there): the on-device model always can; a remote provider only
/// with a key; anything else is the extractive fallback — no model to shape
/// with.
fn cfg_has_real_model(cfg: &crate::llm::ModelCfg) -> bool {
    match cfg.provider_id.as_deref() {
        Some("local") => true,
        Some(id) if id == "anthropic" || crate::llm::remote_provider(id).is_some() => {
            cfg.api_key.as_deref().is_some_and(|k| !k.is_empty())
        }
        _ => false,
    }
}

/// Drain one completion stream to a string — synth's private `collect`,
/// replicated (the multi-step idiom at its `collect(llm::stream_answer(…))`
/// call sites).
async fn collect(mut s: crate::llm::AnswerStream) -> String {
    use futures::StreamExt;
    let mut out = String::new();
    while let Some(d) = s.next().await {
        out.push_str(&d);
    }
    out
}

/// The shaping ask (design.md "Shaping ask"): register the files (and
/// eligible saved views) the direct-execution way, resolve `source` to a
/// registered table or view, make ONE completion proposing a transform
/// SELECT, validate it with `guard_sql`, and render before/after sample
/// evidence. Returns a PROPOSAL — nothing persists here, ever. A local-only
/// source forces the local model path before any transport exists (the H1
/// seam), and an extractive/keyless provider refuses with
/// `SHAPE_NEEDS_MODEL` (the dispatch arms answer `{available:false}`). Files
/// are never opened for write anywhere in this flow.
pub async fn shape_view(
    source: &str,
    instruction: &str,
    file_ids: &[String],
    cfg: crate::llm::ModelCfg,
) -> Result<ShapeProposal, String> {
    let source = source.trim();
    let instruction = instruction.trim();
    if source.is_empty() {
        return Err("a source table or view is required".to_string());
    }
    if instruction.is_empty() {
        return Err("an instruction is required".to_string());
    }

    // Local-only forcing FIRST — the cfg swap must precede the posture and
    // the model check so a private source can never select a cloud path.
    let cfg = if shape_is_local_only(source, file_ids) {
        crate::profile::local_model_config()
    } else {
        cfg
    };
    if !cfg_has_real_model(&cfg) {
        return Err(SHAPE_NEEDS_MODEL.to_string());
    }
    // Registration posture follows the EFFECTIVE provider: on a cloud path
    // the belt-and-suspenders registration filters drop local-only files and
    // views (none should remain — the forcing above already swapped when any
    // was in play); the forced/local path registers everything.
    let is_cloud = crate::synth::is_cloud_provider(&cfg);

    // Resolve + register exactly like the direct-execution path
    // (analytics::direct_tables): active + included ids only, the tabular/PDF
    // registration gate, then files and eligible views into one fresh ctx.
    let active: std::collections::HashSet<String> = crate::vault::active_included_file_ids()
        .into_iter()
        .collect();
    let mut files: Vec<(String, String, std::path::PathBuf)> = Vec::new();
    for id in file_ids {
        if !active.contains(id) {
            continue;
        }
        if let Some((name, abs)) = crate::vault::doc_path(id) {
            if crate::analytics::is_tabular(&name) || crate::analytics::is_pdf(&name) {
                files.push((id.clone(), name, abs));
            }
        }
    }
    let ctx = datafusion::prelude::SessionContext::new();
    let regs = crate::analytics::register_tables(&ctx, &files, is_cloud).await;
    let view_regs = crate::analytics::register_views(&ctx, &regs, is_cloud).await;

    // The source must name a registered table or view — its card is the ONE
    // schema block the completion sees (bounded like the analytics prompt).
    let resolved = regs
        .iter()
        .find(|r| r.table.eq_ignore_ascii_case(source))
        .map(|r| (r.table.clone(), r.card.clone()))
        .or_else(|| {
            view_regs
                .iter()
                .find(|v| v.name.eq_ignore_ascii_case(source))
                .map(|v| (v.name.clone(), v.card.clone()))
        });
    let Some((source, card)) = resolved else {
        return Err(format!(
            "\"{source}\" is not available to shape — pick a table or saved view from the current files"
        ));
    };

    // ONE completion (the multi-step idiom): the card + the few-shots as
    // context blocks, the fixed template as the question, empty history.
    let ctxs = vec![
        crate::llm::Ctx {
            name: source.clone(),
            text: card,
            score: 1.0,
        },
        crate::llm::Ctx {
            name: "shaping examples".to_string(),
            text: shape_fewshot_block(),
            score: 0.0,
        },
    ];
    let raw = collect(crate::llm::stream_answer(
        shape_question(&source, instruction),
        ctxs,
        cfg,
        Vec::new(),
        None,
    ))
    .await;
    let (sql, summary) = parse_shape_reply(&crate::synth::strip_markers(&raw))?;
    let (before, after) = shape_samples(&ctx, &source, &sql).await?;
    Ok(ShapeProposal {
        sql,
        before,
        after,
        summary,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Pure-function tests only, like boards.rs — the store scenarios (round
    // trip, bak-on-write, lifecycle, sources-untouched) live in
    // tests/views_test.rs where VAULT_DIR mutation is serialized by the
    // shared env lock.

    fn v(id: &str, name: &str, read_views: &[&str]) -> View {
        View {
            id: id.into(),
            name: name.into(),
            sql: "SELECT 1".into(),
            reads: Reads {
                files: Vec::new(),
                views: read_views.iter().map(|s| s.to_string()).collect(),
            },
            summary: ViewSummary {
                text: String::new(),
                source: SummarySource::Question,
            },
            created_ms: 1,
        }
    }

    #[test]
    fn only_v1_envelopes_parse() {
        let store = Store {
            v: STORE_VERSION,
            views: vec![View {
                id: "view-abc".into(),
                name: "top_sales".into(),
                sql: "SELECT * FROM sales".into(),
                reads: Reads {
                    files: vec![FileRead {
                        file_id: "sales.csv".into(),
                        table_name: "sales".into(),
                    }],
                    views: vec!["view-base0000".into()],
                },
                summary: ViewSummary {
                    text: "which regions sell most".into(),
                    source: SummarySource::Question,
                },
                created_ms: 7,
            }],
        };
        let text = serde_json::to_string_pretty(&store).unwrap();
        // The byte contract with the TS twin: camelCase keys in declaration
        // order, summary source as a bare lowercase string.
        assert!(text.contains("\"fileId\": \"sales.csv\""), "{text}");
        assert!(text.contains("\"tableName\": \"sales\""), "{text}");
        assert!(text.contains("\"source\": \"question\""), "{text}");
        assert!(text.contains("\"createdMs\": 7"), "{text}");
        let records = parse_store(&text).expect("v1 loads");
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].reads.files[0].table_name, "sales");
        assert_eq!(records[0].summary.source, SummarySource::Question);

        // Anything else reads as unreadable (None): unknown version, missing
        // version, corrupt JSON — the bak-on-write posture treats them alike.
        assert!(parse_store(r#"{"v":99,"views":[]}"#).is_none());
        assert!(parse_store(r#"{"views":[]}"#).is_none());
        assert!(parse_store("{ not json").is_none());
        assert!(parse_store("null").is_none());
        // A record with an out-of-whitelist summary source is malformed, not
        // coerced (the boards CardSize posture).
        assert!(parse_store(
            r#"{"v":1,"views":[{"id":"a","name":"n","sql":"SELECT 1","reads":{"files":[],"views":[]},"summary":{"text":"t","source":"guess"},"createdMs":1}]}"#
        )
        .is_none());
    }

    #[test]
    fn view_ids_are_stable_and_input_sensitive() {
        assert_eq!(view_id("a", "SELECT 1", 42), view_id("a", "SELECT 1", 42));
        assert_ne!(view_id("a", "SELECT 1", 42), view_id("a", "SELECT 1", 43));
        assert_ne!(view_id("a", "SELECT 1", 42), view_id("b", "SELECT 1", 42));
        assert_ne!(view_id("a", "SELECT 1", 42), view_id("a", "SELECT 2", 42));
        assert!(view_id("a", "SELECT 1", 42).starts_with("view-"));
        assert_eq!(view_id("a", "SELECT 1", 42).len(), "view-".len() + 12);
    }

    // PARITY: test/views.test.mjs mirrors this normalization table.
    #[test]
    fn names_normalize_with_the_table_rules_minus_the_stem_strip() {
        assert_eq!(normalize_view_name("Top Sales"), "top_sales");
        assert_eq!(normalize_view_name("Q3 Sales (final)"), "q3_sales_final");
        // No extension strip: a dotted name is separators, not a file stem.
        assert_eq!(normalize_view_name("q3.totals"), "q3_totals");
        // Leading digit gets the same t_ prefix as file table names.
        assert_eq!(normalize_view_name("2024 totals"), "t_2024_totals");
        // Leading/trailing separators trim; runs collapse.
        assert_eq!(normalize_view_name("  __weird -- name__  "), "weird_name");
        // Unusable names come back empty (the caller refuses).
        assert_eq!(normalize_view_name("!!!"), "");
        assert_eq!(normalize_view_name(""), "");
        // 64-char cap, applied after the t_ prefix, trailing _ re-trimmed.
        let long = "a".repeat(80);
        assert_eq!(normalize_view_name(&long).len(), 64);
        let capped = format!("{}_x", "a".repeat(63));
        assert_eq!(normalize_view_name(&capped), "a".repeat(63));
    }

    #[test]
    fn table_names_collect_from_factors_excluding_ctes() {
        let names = |sql: &str| collect_table_names(sql).expect(sql);
        assert_eq!(names("SELECT * FROM sales"), vec!["sales"]);
        assert_eq!(
            names("SELECT * FROM sales s JOIN costs c ON s.id = c.id"),
            vec!["sales", "costs"]
        );
        // Comma-separated FROM list.
        assert_eq!(names("SELECT * FROM sales, costs"), vec!["sales", "costs"]);
        // CTE aliases are declarations, not dependencies.
        assert_eq!(
            names("WITH t AS (SELECT * FROM sales) SELECT * FROM t JOIN costs ON true"),
            vec!["sales", "costs"]
        );
        // Derived subqueries and UNION arms are walked.
        assert_eq!(names("SELECT * FROM (SELECT * FROM inner_t) x"), vec!["inner_t"]);
        assert_eq!(
            names("SELECT a FROM north UNION ALL SELECT a FROM south"),
            vec!["north", "south"]
        );
        // A WITH inside a derived subquery still declares (not references).
        assert_eq!(
            names("SELECT * FROM (WITH q AS (SELECT * FROM base) SELECT * FROM q) z"),
            vec!["base"]
        );
        // Dotted names ride whole (they resolve to nothing and get refused).
        assert_eq!(names("SELECT * FROM db.t"), vec!["db.t"]);
        // Case-insensitive dedupe keeps the first spelling.
        assert_eq!(
            names("SELECT a FROM sales UNION ALL SELECT a FROM SALES"),
            vec!["sales"]
        );
        assert!(collect_table_names("not sql at all").is_err());
    }

    #[test]
    fn cycle_checker_walks_synthetic_graphs() {
        // b → a, and a carries a manual edge to the id the NEW view would
        // get: new → b → a → new is a cycle (the spec's B-reads-A scenario).
        let records = vec![v("a", "a", &["view-new"]), v("b", "b", &["a"])];
        assert!(would_cycle(&records, "view-new", &["b".to_string()]));
        // Reading the new view's own id directly is a self-cycle.
        assert!(would_cycle(&[], "view-new", &["view-new".to_string()]));
        // A hand-crafted store that is ALREADY cyclic trips the back-edge
        // check even when the walk never reaches the new id.
        let cyclic = vec![v("a", "a", &["b"]), v("b", "b", &["a"])];
        assert!(would_cycle(&cyclic, "view-new", &["a".to_string()]));
        // A diamond (b and c both read d) is legal DAG shape, NOT a cycle.
        let diamond = vec![
            v("d", "d", &[]),
            v("b", "b", &["d"]),
            v("c", "c", &["d"]),
        ];
        assert!(!would_cycle(
            &diamond,
            "view-new",
            &["b".to_string(), "c".to_string()]
        ));
        // No view references at all: nothing to cycle through.
        assert!(!would_cycle(&diamond, "view-new", &[]));
    }

    #[test]
    fn depth_counts_the_deepest_chain() {
        let chain = vec![v("v1", "v1", &[]), v("v2", "v2", &["v1"]), v("v3", "v3", &["v2"])];
        assert_eq!(view_depth(&chain, &[]), 1, "files only");
        assert_eq!(view_depth(&chain, &["v1".to_string()]), 2);
        assert_eq!(view_depth(&chain, &["v3".to_string()]), 4, "one past the cap");
        // The MAX of the referenced depths decides, not the sum.
        let diamond = vec![v("d", "d", &[]), v("b", "b", &["d"]), v("c", "c", &["d"])];
        assert_eq!(
            view_depth(&diamond, &["b".to_string(), "c".to_string()]),
            3
        );
        // Cycle-safe on synthetic graphs: poisoned past the cap, no hang.
        let cyclic = vec![v("a", "a", &["b"]), v("b", "b", &["a"])];
        assert!(view_depth(&cyclic, &["a".to_string()]) > MAX_VIEW_DEPTH);
    }

    #[test]
    fn dependents_direct_and_transitive_on_synthetic_graphs() {
        let records = vec![
            v("v1", "base", &[]),
            v("v2", "mid", &["v1"]),
            v("v3", "top", &["v2"]),
            v("v4", "other", &[]),
        ];
        let direct: Vec<String> = dependents_in(&records, "v1").iter().map(|d| d.id.clone()).collect();
        assert_eq!(direct, vec!["v2"]);
        let transitive: Vec<String> = transitive_dependents_in(&records, "v1")
            .iter()
            .map(|d| d.id.clone())
            .collect();
        assert_eq!(transitive, vec!["v2", "v3"], "creation order");
        assert!(dependents_in(&records, "v3").is_empty());
        assert!(transitive_dependents_in(&records, "v4").is_empty());
    }
}
