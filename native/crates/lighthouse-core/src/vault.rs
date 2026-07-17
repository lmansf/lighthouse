//! Local vault engine (port of `src/server/vault.ts`).
//!
//! Turns a real directory of files into the contract's FileNode tree, persists
//! per-node inclusion flags, and runs real content retrieval (TF-IDF cosine
//! over the text of the *included* files only). No cloud, no database server —
//! just the filesystem, byte-compatible with the TS engine's `state.json`.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf, MAIN_SEPARATOR};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::config::{
    read_json, state_dir, state_path, utc_day, vault_dir, write_json, VAULT_SOURCE_ID,
};
use crate::contracts::{DataSource, FileNode, NodeKind, RagReference};
use crate::extract::{extract_rich_text, is_rich_file};

/// An item referenced in place (not copied) — its real absolute path on disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Reference {
    pub path: String,
    pub name: String,
    pub kind: String, // "file" | "folder"
}

/// A bulk curation rule (openspec: add-curation-rules): `{scope folder, ONE
/// predicate, action}`, evaluated LIVE inside the effective-state resolvers as
/// a layer between explicit per-node flags and the global default. A rule
/// never writes `included`/`local_only` — future arrivals are covered by
/// construction, and deleting a rule reverts exactly the nodes it was
/// deciding. Every field is `serde(default)`-tolerant: a hand-edited rule
/// with a missing/unknown predicate or action simply matches nothing (the
/// layer falls through) rather than breaking the walk. KEEP IN SYNC with
/// vault.ts::CurationRule — state.json is shared byte-compatibly.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurationRule {
    #[serde(default)]
    pub id: String,
    /// Scope folder node id. `""` is the vault root — it covers vault-resident
    /// files only; a linked root (`extN`) is its own folder scope (its content
    /// lives outside the vault directory).
    #[serde(default)]
    pub scope: String,
    /// Predicate (exactly one of `kind`/`ext`/`glob`, add-time validated):
    /// file kind from the extraction/catalog classification.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>, // "tabular" | "document" | "image"
    /// Lowercase extension list, stored dot-less (e.g. ["xlsx","csv"]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ext: Option<Vec<String>>,
    /// Glob over the path RELATIVE to the scope — `*`, `**`, `?` only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub glob: Option<String>,
    #[serde(default)]
    pub action: String, // "include" | "exclude" | "local-only" | "clear"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultState {
    #[serde(default = "default_true")]
    pub source_available: bool,
    /// Explicit inclusion overrides keyed by node id; absent ⇒ default.
    #[serde(default)]
    pub included: HashMap<String, bool>,
    /// Explicit "Private — this device only" marks keyed by node id; absent ⇒
    /// not local-only. Ancestor-wins (see `is_effectively_local_only`). Like
    /// `included`, `#[serde(default)]` makes this additively migration-safe: an
    /// old `state.json` with no `localOnly` key loads as an empty map (nothing
    /// marked). state.json is intentionally UN-versioned — the serde-default
    /// tolerance IS the migration story. KEEP IN SYNC with vault.ts.
    #[serde(default)]
    pub local_only: HashMap<String, bool>,
    /// External references keyed by a synthetic node-id prefix (e.g. "ext0").
    #[serde(default)]
    pub references: HashMap<String, Reference>,
    /// Bulk curation rules (openspec: add-curation-rules) — a RESOLUTION
    /// layer, never per-node writes. Definition order matters (within one
    /// scope the last-defined rule wins). `#[serde(default)]`: an old
    /// state.json with no `rules` key loads rule-less — the established
    /// un-versioned migration story. KEEP IN SYNC with vault.ts.
    #[serde(default)]
    pub rules: Vec<CurationRule>,
}

fn default_true() -> bool {
    true
}

impl Default for VaultState {
    fn default() -> Self {
        VaultState {
            source_available: true,
            included: HashMap::new(),
            local_only: HashMap::new(),
            references: HashMap::new(),
            rules: Vec::new(),
        }
    }
}

// The vault state (inclusion flags + references) was re-read and JSON-parsed
// from disk on every call — ≥2× per query, plus once per walk. save_state is
// the sole writer, so an in-memory copy keyed on state_path() stays coherent
// in-process; a vault switch changes the path and misses cleanly (mirrors how
// WALK_CACHE is keyed on root).
static STATE_CACHE: Mutex<Option<(PathBuf, VaultState)>> = Mutex::new(None);

fn load_state() -> VaultState {
    let path = state_path();
    {
        let cache = STATE_CACHE.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((p, s)) = cache.as_ref() {
            if *p == path {
                return s.clone();
            }
        }
    }
    let s = read_json(&path, VaultState::default());
    *STATE_CACHE.lock().unwrap_or_else(|p| p.into_inner()) = Some((path, s.clone()));
    s
}

fn save_state(s: &VaultState) {
    let path = state_path();
    write_json(&path, s);
    // Keep the cache warm with what we just wrote (sole writer ⇒ coherent).
    *STATE_CACHE.lock().unwrap_or_else(|p| p.into_inner()) = Some((path, s.clone()));
    invalidate_walk_cache(); // inclusion flags and references feed the walked tree
}

/// True when `child` is `parent` or lives beneath it on disk (string paths).
fn is_within(parent: &str, child: &str) -> bool {
    child == parent || child.starts_with(&format!("{parent}{MAIN_SEPARATOR}"))
}

fn paths_overlap(a: &str, b: &str) -> bool {
    is_within(a, b) || is_within(b, a)
}

/// Which reference, if any, owns a node id (`extN` itself or `extN/...`).
fn ref_id_of<'a>(id: &str, refs: &'a HashMap<String, Reference>) -> Option<&'a str> {
    refs.keys()
        .find(|r| id == r.as_str() || id.starts_with(&format!("{r}/")))
        .map(|s| s.as_str())
}

/// Lexically absolutize + normalize (like Node's `path.resolve`: no symlink
/// resolution, `..`/`.` collapsed).
fn lexical_resolve(base: &Path, sub: &str) -> PathBuf {
    let joined = if Path::new(sub).is_absolute() {
        PathBuf::from(sub)
    } else {
        base.join(sub)
    };
    let mut out = PathBuf::new();
    for c in joined.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Node-style `path.resolve(p)` for a single (possibly relative) path.
fn resolve_path(p: &str) -> PathBuf {
    lexical_resolve(&std::env::current_dir().unwrap_or_default(), p)
}

/// Resolve a vault-relative id to an absolute path, refusing to escape the vault.
/// True when `abs` is `base` or lives beneath it, compared COMPONENT-WISE.
/// A string prefix formatted with MAIN_SEPARATOR FALSE-REJECTS on Windows:
/// `abs` is separator-normalized (backslashes, via lexical_resolve's component
/// rebuild) while `base` keeps whatever slashes VAULT_DIR carried — a shell-
/// provided `--vault` is forward/mixed — so an in-vault file fails the prefix
/// test and its content read returns empty though the walk (tolerant of mixed
/// separators) still lists and includes it. `Path::starts_with` is separator-
/// agnostic AND stricter (never matches sibling "vault-x" against "vault").
/// PARITY: vault.ts::isWithinBase.
fn is_within_base(base: &Path, abs: &Path) -> bool {
    abs == base || abs.starts_with(base)
}

fn safe_abs(rel_id: &str) -> anyhow::Result<PathBuf> {
    let base = vault_dir();
    let abs = lexical_resolve(&base, rel_id);
    if !is_within_base(&base, &abs) {
        anyhow::bail!("path escapes the vault");
    }
    Ok(abs)
}

/// Resolve a node id to an absolute path on disk. Vault-relative ids map under
/// the vault directory; referenced ids (`extN/...`) map under their registered
/// real path. Both reject paths that escape their base.
fn resolve_abs(id: &str, state: &VaultState) -> anyhow::Result<PathBuf> {
    let Some(ref_id) = ref_id_of(id, &state.references) else {
        return safe_abs(id);
    };
    let base = resolve_path(&state.references[ref_id].path);
    let sub = id[ref_id.len()..].trim_start_matches('/');
    let abs = lexical_resolve(&base, sub);
    if !is_within_base(&base, &abs) {
        anyhow::bail!("path escapes the reference");
    }
    Ok(abs)
}

/// Resolve a node id to its real absolute path (vault file or referenced item).
/// Used to open a file in its native application from a chat citation.
pub fn resolve_node_path(node_id: &str) -> anyhow::Result<PathBuf> {
    resolve_abs(node_id, &load_state())
}

#[cfg(test)]
mod path_containment_tests {
    use super::is_within_base;
    use std::path::Path;

    // The vault-escape guard must stay component-wise: accept in-vault paths,
    // reject anything outside, and — critically — never match a sibling that
    // merely shares a name prefix. (The Windows separator regression that the
    // old string-prefix check caused is exercised end-to-end by the
    // release-smoke headless CLI leg on windows-latest.)
    #[test]
    fn containment_is_component_wise() {
        let base = Path::new("/vault");
        assert!(is_within_base(base, Path::new("/vault")));
        assert!(is_within_base(base, Path::new("/vault/docs/report.md")));
        assert!(!is_within_base(base, Path::new("/vault-secrets/report.md")));
        assert!(!is_within_base(base, Path::new("/elsewhere/report.md")));
        assert!(!is_within_base(base, Path::new("/")));
    }
}

/// The real roots of every linked reference (for the FS watcher).
pub fn reference_roots() -> Vec<PathBuf> {
    load_state()
        .references
        .values()
        .map(|r| resolve_path(&r.path))
        .collect()
}

/// Reference roots paired with their `extN` ids (for path→id mapping).
pub fn reference_roots_with_ids() -> Vec<(String, PathBuf)> {
    load_state()
        .references
        .iter()
        .map(|(id, r)| (id.clone(), resolve_path(&r.path)))
        .collect()
}

// --- walk cache ---------------------------------------------------------------

/// Snapshot TTL for the walked tree. With the Phase 5 watcher active, external
/// changes invalidate the snapshot by event, so the TTL is only a deep
/// fallback (60 s); without a watcher it keeps the legacy 3 s bound on how
/// long an outside change can go unnoticed. Every in-app mutation invalidates
/// immediately either way.
fn walk_ttl_ms() -> u128 {
    if crate::watch::is_active() {
        60_000
    } else {
        3_000
    }
}

struct WalkCache {
    root: PathBuf,
    // Arc so cached_walk hands out a cheap refcount bump instead of deep-cloning
    // the whole node vector on every walk() call (retrieve alone calls it 2-3×).
    nodes: Arc<Vec<FileNode>>,
    at: Instant,
}

static WALK_CACHE: Mutex<Option<WalkCache>> = Mutex::new(None);

pub fn invalidate_walk_cache() {
    *WALK_CACHE.lock().unwrap() = None;
}

/// Whether absent inclusion flags default to INCLUDED. Honors the user's
/// explicit onboarding choice (`include`/`exclude`), falling back to the fixed
/// privacy-preserving default (exclude) when they haven't chosen.
fn default_included() -> bool {
    crate::profile::effective_default_inclusion() == "include"
}

// --- curation rules: evaluation (openspec: add-curation-rules) -----------------
//
// Rules are a resolution layer for FILES: explicit flags (own, then the
// existing ancestor semantics) always win; rules decide only where today's
// code fell through to the default. Folders never take the rule layer — a
// rule "applies to every matching file under its scope", and folder eyes in
// the explorer derive from their descendants anyway.

/// Rule actions / kinds the engine accepts (add-time whitelist).
const RULE_ACTIONS: &[&str] = &["include", "exclude", "local-only", "clear"];
const RULE_KINDS: &[&str] = &["tabular", "document", "image"];

/// `kind:"image"` — the OCR raster set. KEEP IN SYNC with
/// extract.rs::OCR_IMAGE_EXT (their text is an extraction capability, which is
/// what the kind classification reports). PARITY: the TS twin has no OCR, so
/// images are name-match-only there and `kind:"image"` matches nothing.
const RULE_IMAGE_EXT: &[&str] = &["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff"];

/// `kind:"document"` — prose document formats this engine extracts or reads
/// (extract.rs RICH_EXT minus tabular/image, plus the prose documents of
/// TEXT_EXT). `kind:"tabular"` is `analytics::is_tabular` — the catalog gate —
/// so a kind rule and the catalog never disagree about what a spreadsheet is.
/// PARITY: the TS twin's document set is the subset IT can extract (.doc,
/// .pptx, .odt, .odp, .rtf are Rust-only extraction — name-match-only there,
/// so kind rules deliberately don't match them; ext/glob rules are
/// full-fidelity both sides).
const RULE_DOCUMENT_EXT: &[&str] = &[
    "pdf", "doc", "docx", "pptx", "odt", "odp", "rtf", "md", "markdown", "txt", "text", "rst",
    "html", "htm",
];

/// Validate a rule glob: `/`-separated, wildcards `*`/`**`/`?` only, no empty
/// segments, `**` only as a whole segment, no backslashes. Returns the
/// segments. KEEP IN SYNC with vault.ts::parseRuleGlob.
fn parse_rule_glob(glob: &str) -> Result<Vec<String>, String> {
    if glob.trim().is_empty() {
        return Err("glob must not be empty".to_string());
    }
    if glob.contains('\\') {
        return Err("glob uses / as its separator".to_string());
    }
    if glob.starts_with('/') || glob.ends_with('/') || glob.contains("//") {
        return Err("glob must not have empty segments".to_string());
    }
    let segs: Vec<String> = glob.split('/').map(String::from).collect();
    for s in &segs {
        if s.contains("**") && s != "**" {
            return Err("** must stand alone between slashes".to_string());
        }
    }
    Ok(segs)
}

/// `*` / `?` within ONE path segment (never crosses `/`). Linear two-pointer
/// backtracking, so a pathological pattern can't go exponential. KEEP
/// BYTE-IDENTICAL in behavior with vault.ts::globSegmentMatches.
fn glob_segment_matches(pat: &[char], seg: &[char]) -> bool {
    let (mut p, mut s) = (0usize, 0usize);
    let (mut star, mut mark) = (usize::MAX, 0usize);
    while s < seg.len() {
        if p < pat.len() && (pat[p] == '?' || pat[p] == seg[s]) {
            p += 1;
            s += 1;
        } else if p < pat.len() && pat[p] == '*' {
            star = p;
            mark = s;
            p += 1;
        } else if star != usize::MAX {
            p = star + 1;
            mark += 1;
            s = mark;
        } else {
            return false;
        }
    }
    while p < pat.len() && pat[p] == '*' {
        p += 1;
    }
    p == pat.len()
}

/// Segment-wise glob match; `**` spans zero or more whole segments. KEEP IN
/// SYNC with vault.ts::globSegmentsMatch.
fn glob_segments_match(pat: &[String], path: &[&str]) -> bool {
    if pat.is_empty() {
        return path.is_empty();
    }
    if pat[0] == "**" {
        if glob_segments_match(&pat[1..], path) {
            return true; // ** matches zero segments
        }
        return !path.is_empty() && glob_segments_match(pat, &path[1..]);
    }
    if path.is_empty() {
        return false;
    }
    let p: Vec<char> = pat[0].chars().collect();
    let s: Vec<char> = path[0].chars().collect();
    glob_segment_matches(&p, &s) && glob_segments_match(&pat[1..], &path[1..])
}

/// The path of `id` RELATIVE to `scope` when the scope contains it, else None.
/// Scope `""` (the vault root) contains every vault-resident id but NOT linked
/// (`extN…`) subtrees — a linked root is its own folder scope. The scope
/// folder itself is never "under" its own scope (rules decide files under the
/// folder). KEEP IN SYNC with vault.ts::scopeRel.
fn scope_rel<'a>(scope: &str, id: &'a str, state: &VaultState) -> Option<&'a str> {
    if scope.is_empty() {
        return if ref_id_of(id, &state.references).is_none() {
            Some(id)
        } else {
            None
        };
    }
    id.strip_prefix(scope)?.strip_prefix('/')
}

/// Scope depth for deepest-scope-wins ordering (`""` = 0).
fn scope_depth(scope: &str) -> usize {
    if scope.is_empty() {
        0
    } else {
        scope.split('/').count()
    }
}

/// Does the rule's predicate match a FILE at `rel` (path relative to the
/// rule's scope)? A stored rule that fails to evaluate — missing/unknown
/// predicate, unparseable glob — matches nothing (the layer falls through)
/// rather than breaking the walk. KEEP IN SYNC with vault.ts::rulePredicateMatches.
fn rule_predicate_matches(rule: &CurationRule, rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    if let Some(kind) = &rule.kind {
        let e = ext_of(name); // ".xlsx" | "", lowercased
        let bare = e.strip_prefix('.').unwrap_or("");
        return match kind.as_str() {
            "tabular" => crate::analytics::is_tabular(name),
            "document" => RULE_DOCUMENT_EXT.contains(&bare),
            "image" => RULE_IMAGE_EXT.contains(&bare),
            _ => false,
        };
    }
    if let Some(exts) = &rule.ext {
        let e = ext_of(name);
        let bare = e.strip_prefix('.').unwrap_or("");
        return !bare.is_empty() && exts.iter().any(|x| x == bare);
    }
    if let Some(glob) = &rule.glob {
        let Ok(pat) = parse_rule_glob(glob) else {
            return false;
        };
        let segs: Vec<&str> = rel.split('/').collect();
        return glob_segments_match(&pat, &segs);
    }
    false
}

/// The two independent axes a rule can decide.
#[derive(Clone, Copy, PartialEq)]
enum RuleAxis {
    Inclusion,
    LocalOnly,
}

/// Whether an action participates in an axis. `clear` is first-class on BOTH:
/// a scoped return-to-default that masks broader rules (inclusion → the global
/// default; local-only → unmarked).
fn axis_action(axis: RuleAxis, action: &str) -> bool {
    match axis {
        RuleAxis::Inclusion => matches!(action, "include" | "exclude" | "clear"),
        RuleAxis::LocalOnly => matches!(action, "local-only" | "clear"),
    }
}

/// The matching rule that DECIDES a file on one axis: deepest scope wins;
/// within one scope the last-defined (highest index) wins. None ⇒ the rule
/// layer falls through to the default. KEEP IN SYNC with vault.ts::winningRule.
fn winning_rule<'a>(id: &str, state: &'a VaultState, axis: RuleAxis) -> Option<&'a CurationRule> {
    let mut best: Option<(usize, usize, &CurationRule)> = None;
    for (idx, rule) in state.rules.iter().enumerate() {
        if !axis_action(axis, &rule.action) {
            continue;
        }
        let Some(rel) = scope_rel(&rule.scope, id, state) else {
            continue;
        };
        if !rule_predicate_matches(rule, rel) {
            continue;
        }
        let key = (scope_depth(&rule.scope), idx);
        if best.map_or(true, |(d, i, _)| key > (d, i)) {
            best = Some((key.0, key.1, rule));
        }
    }
    best.map(|(_, _, r)| r)
}

/// Which layer decided a flag. The boolean resolvers AND the inspector's
/// attribution both read this one decision, so "what resolved" and "why" can
/// never disagree. KEEP IN SYNC with vault.ts (inclusionDecision /
/// localOnlyDecision).
enum FlagDecision<'a> {
    /// An ancestor's explicit flag decided (exclusion / local-only mark) —
    /// the existing ancestor-wins semantics, never overridden by any rule.
    Ancestor,
    /// The node's own explicit flag — always beats rules.
    Explicit(bool),
    /// A curation rule decided (deepest scope, then last-defined).
    Rule(&'a CurationRule),
    /// No layer claimed it — the global default / unmarked.
    Default,
}

fn inclusion_decision<'a>(id: &str, state: &'a VaultState, is_file: bool) -> FlagDecision<'a> {
    let parts: Vec<&str> = id.split('/').collect();
    let mut prefix = String::new();
    for part in &parts[..parts.len().saturating_sub(1)] {
        if prefix.is_empty() {
            prefix = (*part).to_string();
        } else {
            prefix = format!("{prefix}/{part}");
        }
        if state.included.get(&prefix) == Some(&false) {
            return FlagDecision::Ancestor; // an ancestor folder is excluded
        }
    }
    if let Some(v) = state.included.get(id) {
        return FlagDecision::Explicit(*v);
    }
    if is_file {
        if let Some(rule) = winning_rule(id, state, RuleAxis::Inclusion) {
            return FlagDecision::Rule(rule);
        }
    }
    FlagDecision::Default
}

fn local_only_decision<'a>(id: &str, state: &'a VaultState, is_file: bool) -> FlagDecision<'a> {
    let parts: Vec<&str> = id.split('/').collect();
    let mut prefix = String::new();
    for part in &parts[..parts.len().saturating_sub(1)] {
        if prefix.is_empty() {
            prefix = (*part).to_string();
        } else {
            prefix = format!("{prefix}/{part}");
        }
        if state.local_only.get(&prefix) == Some(&true) {
            return FlagDecision::Ancestor; // an ancestor folder is marked
        }
    }
    if let Some(v) = state.local_only.get(id) {
        return FlagDecision::Explicit(*v);
    }
    if is_file {
        if let Some(rule) = winning_rule(id, state, RuleAxis::LocalOnly) {
            return FlagDecision::Rule(rule);
        }
    }
    FlagDecision::Default
}

/// Effective inclusion. Precedence (spec-pinned, openspec add-curation-rules):
/// explicit ancestor exclusion (the existing ancestor-wins semantics — a rule
/// can never resurrect an excluded subtree) → explicit own flag → matching
/// rules (FILES only: deepest scope, then last-defined; `clear` yields the
/// default and masks shallower rules) → the global default `default_in`.
/// KEEP IN SYNC with vault.ts::isEffectivelyIncluded.
pub fn is_effectively_included(id: &str, state: &VaultState, default_in: bool, is_file: bool) -> bool {
    match inclusion_decision(id, state, is_file) {
        FlagDecision::Ancestor => false,
        FlagDecision::Explicit(v) => v,
        FlagDecision::Rule(rule) => match rule.action.as_str() {
            "include" => true,
            "exclude" => false,
            _ => default_in, // "clear": a scoped return-to-default
        },
        FlagDecision::Default => default_in,
    }
}

/// Effective "Private — this device only" state. ANCESTOR-WINS: a node is
/// local-only when it OR any ancestor carries an explicit `true`; a child's
/// own `false` cannot override a marked ancestor (the safe direction). An
/// explicit OWN flag — either way — beats rules ("explicit user state always
/// beats rules": a rule can only ADD privacy where the user hasn't spoken,
/// and never removes an explicit mark). With no explicit state, matching
/// `local-only` rules mark the file (`clear` masks them back to unmarked);
/// absence means not local-only. KEEP IN SYNC with vault.ts::isEffectivelyLocalOnly.
pub fn is_effectively_local_only(id: &str, state: &VaultState, is_file: bool) -> bool {
    match local_only_decision(id, state, is_file) {
        FlagDecision::Ancestor => true,
        FlagDecision::Explicit(v) => v,
        FlagDecision::Rule(rule) => rule.action == "local-only", // "clear" → unmarked
        FlagDecision::Default => false,
    }
}

/// Wire attribution for the inspector ("why is this flag what it is"):
/// which layer decided. `rule_name` is the generated display name so the
/// panel can say `included by rule "spreadsheets in /reports"`. KEEP IN SYNC
/// with the FileInspection shape in src/contracts/types.ts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlagAttribution {
    pub source: String, // "explicit" | "ancestor" | "rule" | "default"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule_name: Option<String>,
}

fn attribution_of(decision: FlagDecision) -> FlagAttribution {
    match decision {
        FlagDecision::Ancestor => FlagAttribution {
            source: "ancestor".to_string(),
            rule_id: None,
            rule_name: None,
        },
        FlagDecision::Explicit(_) => FlagAttribution {
            source: "explicit".to_string(),
            rule_id: None,
            rule_name: None,
        },
        FlagDecision::Rule(rule) => FlagAttribution {
            source: "rule".to_string(),
            rule_id: Some(rule.id.clone()),
            rule_name: Some(rule_display_name(rule)),
        },
        FlagDecision::Default => FlagAttribution {
            source: "default".to_string(),
            rule_id: None,
            rule_name: None,
        },
    }
}

/// Attribution sibling of `is_effectively_included` for ONE file — computed on
/// demand (the inspector's single file), never stored.
pub fn inclusion_attribution(file_id: &str) -> FlagAttribution {
    attribution_of(inclusion_decision(file_id, &load_state(), true))
}

/// Attribution sibling of `is_effectively_local_only` for ONE file.
pub fn local_only_attribution(file_id: &str) -> FlagAttribution {
    attribution_of(local_only_decision(file_id, &load_state(), true))
}

/// Extensions read directly as UTF-8 text (rich binary formats go via extract).
const TEXT_EXT: &[&str] = &[
    ".md",
    ".markdown",
    ".txt",
    ".text",
    ".rst",
    ".csv",
    ".tsv",
    ".json",
    ".yaml",
    ".yml",
    ".log",
    ".html",
    ".htm",
    // .xml deliberately absent: app-generated sidecar/config XML in linked
    // folders kept surfacing as AI sources (0.6.x field report). The files
    // stay visible in the explorer — they just never become chunks.
    ".js",
    ".ts",
    ".tsx",
    ".jsx",
    ".py",
    ".java",
    ".go",
    ".rb",
    ".rs",
    ".c",
    ".h",
    ".cpp",
    ".sh",
    ".sql",
    ".toml",
    ".ini",
    ".env",
    ".css",
];

fn ext_of(name: &str) -> String {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => format!(".{}", ext.to_lowercase()),
        _ => String::new(),
    }
}

fn is_text_file(name: &str) -> bool {
    TEXT_EXT.contains(&ext_of(name).as_str())
}

fn mime_of(name: &str) -> Option<String> {
    let m = match ext_of(name).as_str() {
        ".md" | ".markdown" => "text/markdown",
        ".txt" => "text/plain",
        ".csv" => "text/csv",
        ".json" => "application/json",
        ".pdf" => "application/pdf",
        ".html" | ".htm" => "text/html",
        ".docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".xlsm" => "application/vnd.ms-excel.sheet.macroEnabled.12",
        ".xls" => "application/vnd.ms-excel",
        _ => return None,
    };
    Some(m.to_string())
}

/// Serializes cache rebuilds: the tree poll, a window-focus refresh, and a
/// watcher push routinely land TOGETHER on a just-invalidated cache, and each
/// caller used to re-walk the whole tree in parallel — a stat storm exactly
/// when the vault is busiest. Losers of this lock re-check the cache and
/// ride the winner's snapshot.
static WALK_BUILD: Mutex<()> = Mutex::new(());

fn cached_walk(root: &Path) -> Option<Arc<Vec<FileNode>>> {
    let cache = WALK_CACHE.lock().unwrap();
    cache.as_ref().and_then(|c| {
        (c.root == root && c.at.elapsed().as_millis() < walk_ttl_ms()).then(|| c.nodes.clone())
    })
}

/// A node id is its POSIX-relative path from the vault root (stable + unique).
fn walk(root: &Path) -> Arc<Vec<FileNode>> {
    if let Some(nodes) = cached_walk(root) {
        return nodes;
    }
    let _build = WALK_BUILD.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(nodes) = cached_walk(root) {
        return nodes; // someone rebuilt while we waited for the lock
    }
    let nodes = Arc::new(walk_uncached(root));
    *WALK_CACHE.lock().unwrap() = Some(WalkCache {
        root: root.to_path_buf(),
        nodes: Arc::clone(&nodes),
        at: Instant::now(),
    });
    nodes
}

fn rel_id(root: &Path, abs: &Path) -> String {
    abs.strip_prefix(root)
        .map(|p| {
            p.components()
                .map(|c| c.as_os_str().to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join("/")
        })
        .unwrap_or_default()
}

fn walk_uncached(root: &Path) -> Vec<FileNode> {
    let mut out: Vec<FileNode> = Vec::new();
    let state = load_state();
    let default_in = default_included(); // resolve the variant once for this walk

    fn recurse(
        out: &mut Vec<FileNode>,
        state: &VaultState,
        default_in: bool,
        root: &Path,
        abs_dir: &Path,
        parent_id: Option<&str>,
    ) {
        let Ok(entries) = fs::read_dir(abs_dir) else {
            return;
        };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue; // skip .rag-vault and dotfiles
            }
            let abs = abs_dir.join(&name);
            let id = rel_id(root, &abs);
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                out.push(FileNode {
                    id: id.clone(),
                    parent_id: parent_id.map(String::from),
                    source_id: VAULT_SOURCE_ID.to_string(),
                    name,
                    kind: NodeKind::Folder,
                    mime_type: None,
                    size: None,
                    rag_included: is_effectively_included(&id, state, default_in, false),
                    local_only: is_effectively_local_only(&id, state, false),
                    external: None,
                });
                recurse(out, state, default_in, root, &abs, Some(&id));
            } else if ft.is_file() {
                let size = fs::metadata(&abs).ok().map(|m| m.len());
                out.push(FileNode {
                    id: id.clone(),
                    parent_id: parent_id.map(String::from),
                    source_id: VAULT_SOURCE_ID.to_string(),
                    name: name.clone(),
                    kind: NodeKind::File,
                    mime_type: mime_of(&name),
                    size,
                    rag_included: is_effectively_included(&id, state, default_in, true),
                    local_only: is_effectively_local_only(&id, state, true),
                    external: None,
                });
            }
        }
    }
    recurse(&mut out, &state, default_in, root, root, None);

    // Referenced items (added via "Link…"): read in place under an `extN` prefix.
    let mut ref_ids: Vec<&String> = state.references.keys().collect();
    ref_ids.sort(); // deterministic order (JS object order is insertion; sort is stable enough here)
    for ref_id in ref_ids {
        let reference = &state.references[ref_id];
        let ref_path = PathBuf::from(&reference.path);
        let exists = fs::metadata(&ref_path).is_ok();
        if reference.kind == "file" {
            let size = fs::metadata(&ref_path).ok().map(|m| m.len());
            out.push(FileNode {
                id: ref_id.clone(),
                parent_id: None,
                source_id: VAULT_SOURCE_ID.to_string(),
                name: reference.name.clone(),
                kind: NodeKind::File,
                mime_type: mime_of(&reference.name),
                size,
                rag_included: is_effectively_included(ref_id, &state, default_in, true),
                local_only: is_effectively_local_only(ref_id, &state, true),
                external: Some(true),
            });
            continue;
        }
        out.push(FileNode {
            id: ref_id.clone(),
            parent_id: None,
            source_id: VAULT_SOURCE_ID.to_string(),
            name: reference.name.clone(),
            kind: NodeKind::Folder,
            mime_type: None,
            size: None,
            rag_included: is_effectively_included(ref_id, &state, default_in, false),
            local_only: is_effectively_local_only(ref_id, &state, false),
            external: Some(true),
        });
        if !exists {
            continue;
        }

        fn recurse_ext(
            out: &mut Vec<FileNode>,
            state: &VaultState,
            default_in: bool,
            ref_root: &Path,
            ref_id: &str,
            abs_dir: &Path,
            parent_id: &str,
        ) {
            let Ok(entries) = fs::read_dir(abs_dir) else {
                return;
            };
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with('.') {
                    continue;
                }
                let abs = abs_dir.join(&name);
                let rel = rel_id(ref_root, &abs);
                let id = format!("{ref_id}/{rel}");
                let Ok(ft) = e.file_type() else { continue };
                if ft.is_dir() {
                    out.push(FileNode {
                        id: id.clone(),
                        parent_id: Some(parent_id.to_string()),
                        source_id: VAULT_SOURCE_ID.to_string(),
                        name,
                        kind: NodeKind::Folder,
                        mime_type: None,
                        size: None,
                        rag_included: is_effectively_included(&id, state, default_in, false),
                        local_only: is_effectively_local_only(&id, state, false),
                        external: Some(true),
                    });
                    recurse_ext(out, state, default_in, ref_root, ref_id, &abs, &id);
                } else if ft.is_file() {
                    let size = fs::metadata(&abs).ok().map(|m| m.len());
                    out.push(FileNode {
                        id: id.clone(),
                        parent_id: Some(parent_id.to_string()),
                        source_id: VAULT_SOURCE_ID.to_string(),
                        name: name.clone(),
                        kind: NodeKind::File,
                        mime_type: mime_of(&name),
                        size,
                        rag_included: is_effectively_included(&id, state, default_in, true),
                        local_only: is_effectively_local_only(&id, state, true),
                        external: Some(true),
                    });
                }
            }
        }
        recurse_ext(
            &mut out, &state, default_in, &ref_path, ref_id, &ref_path, ref_id,
        );
    }
    out
}

pub fn list_sources() -> Vec<DataSource> {
    let state = load_state();
    vec![DataSource {
        id: VAULT_SOURCE_ID.to_string(),
        name: "Local Vault".to_string(),
        kind: "folder".to_string(),
        available: state.source_available,
    }]
}

/// Full-tree listing — the app's regular vault scan (also the hook that catches
/// files copied in / deleted OUTSIDE the app).
pub fn list_nodes() -> Vec<FileNode> {
    let all = walk(&vault_dir());
    (*all).clone()
}

/// Toggle a node and (for folders) all of its descendants.
pub fn set_included(node_id: &str, value: bool) {
    let all = walk(&vault_dir());
    let mut target: HashSet<String> = HashSet::from([node_id.to_string()]);
    let mut grew = true;
    while grew {
        grew = false;
        for n in all.iter() {
            if let Some(pid) = &n.parent_id {
                if target.contains(pid) && !target.contains(&n.id) {
                    target.insert(n.id.clone());
                    grew = true;
                }
            }
        }
    }
    let mut state = load_state();
    for id in target {
        state.included.insert(id, value);
    }
    save_state(&state);
}

/// Mark/unmark a node "Private — this device only". Writes ONLY the target's
/// own flag — NO descendant cascade (contrast `set_included` above, which does
/// cascade): `is_effectively_local_only`'s ancestor-walk already privatizes the
/// whole subtree by resolution, so cascading writes would be redundant and would
/// wrongly stamp children that should stay independently unmarked. Setting a
/// child `false` beneath a marked ancestor is inert (ancestor wins).
/// KEEP IN SYNC with vault.ts::setLocalOnly.
pub fn set_local_only(node_id: &str, value: bool) {
    let mut state = load_state();
    state.local_only.insert(node_id.to_string(), value);
    save_state(&state);
}

pub fn set_source_available(available: bool) {
    let mut state = load_state();
    state.source_available = available;
    save_state(&state);
}

// --- curation rules: CRUD + display (openspec: add-curation-rules) --------------

/// Generated display name from predicate + scope — e.g. "spreadsheets in
/// /reports". Derived on demand (never stored, so it can't go stale). KEEP
/// BYTE-IDENTICAL with vault.ts::ruleDisplayName — the inspector's
/// attribution line renders it on both engines.
pub fn rule_display_name(rule: &CurationRule) -> String {
    let predicate = if let Some(kind) = &rule.kind {
        match kind.as_str() {
            "tabular" => "spreadsheets".to_string(),
            "document" => "documents".to_string(),
            "image" => "images".to_string(),
            other => format!("{other} files"),
        }
    } else if let Some(exts) = &rule.ext {
        let dotted: Vec<String> = exts.iter().map(|e| format!(".{e}")).collect();
        format!("{} files", dotted.join("/"))
    } else if let Some(glob) = &rule.glob {
        format!("files matching {glob}")
    } else {
        "files".to_string() // degenerate stored rule — matches nothing anyway
    };
    let place = if rule.scope.is_empty() {
        "the vault".to_string()
    } else {
        format!("/{}", rule.scope)
    };
    format!("{predicate} in {place}")
}

/// Mint a short random rule id ("r" + 8 hex chars), re-rolled on the unlikely
/// collision. Dependency-free: SHA-1 over wall-clock nanos + a salt.
fn mint_rule_id(existing: &[CurationRule]) -> String {
    use sha1::{Digest, Sha1};
    let mut salt = 0u64;
    loop {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let digest = Sha1::digest(format!("{nanos}:{salt}:{}", existing.len()).as_bytes());
        let id = format!(
            "r{}",
            digest.iter().take(4).map(|b| format!("{b:02x}")).collect::<String>()
        );
        if !existing.iter().any(|r| r.id == id) {
            return id;
        }
        salt += 1;
    }
}

/// All stored rules, definition order.
pub fn list_rules() -> Vec<CurationRule> {
    load_state().rules
}

/// Validate + add a rule; the id is minted engine-side. Exactly ONE predicate
/// (kind | ext | glob) must be given; kinds/actions are whitelisted; the glob
/// must parse; extensions normalize to lowercase dot-less. Rejection is an
/// Err with the human-readable reason (the routes surface it as a 400).
/// Saving goes through `save_state`, so a rule write invalidates the walk
/// cache exactly like a flag write. KEEP IN SYNC with vault.ts::addRule.
pub fn add_rule(
    scope: &str,
    kind: Option<&str>,
    ext: Option<&[String]>,
    glob: Option<&str>,
    action: &str,
) -> anyhow::Result<CurationRule> {
    if !RULE_ACTIONS.contains(&action) {
        anyhow::bail!("action must be include, exclude, local-only, or clear");
    }
    if scope.contains('\\') || scope.starts_with('/') || scope.ends_with('/') || scope.contains("//") {
        anyhow::bail!("invalid scope");
    }
    let picked = usize::from(kind.is_some()) + usize::from(ext.is_some()) + usize::from(glob.is_some());
    if picked != 1 {
        anyhow::bail!("exactly one of kind, ext, or glob is required");
    }
    if let Some(k) = kind {
        if !RULE_KINDS.contains(&k) {
            anyhow::bail!("kind must be tabular, document, or image");
        }
    }
    let ext_norm: Option<Vec<String>> = match ext {
        None => None,
        Some(list) => {
            let norm: Vec<String> = list
                .iter()
                .map(|e| e.trim().trim_start_matches('.').to_lowercase())
                .filter(|e| !e.is_empty())
                .collect();
            if norm.is_empty() {
                anyhow::bail!("ext needs at least one extension");
            }
            if let Some(bad) = norm
                .iter()
                .find(|e| !e.chars().all(|c| c.is_ascii_alphanumeric()))
            {
                anyhow::bail!("invalid extension {bad:?}");
            }
            Some(norm)
        }
    };
    if let Some(g) = glob {
        if let Err(reason) = parse_rule_glob(g) {
            anyhow::bail!("invalid glob: {reason}");
        }
    }
    let mut state = load_state();
    let rule = CurationRule {
        id: mint_rule_id(&state.rules),
        scope: scope.to_string(),
        kind: kind.map(String::from),
        ext: ext_norm,
        glob: glob.map(String::from),
        action: action.to_string(),
    };
    state.rules.push(rule.clone());
    save_state(&state); // invalidates the walk cache like a flag write
    Ok(rule)
}

/// Remove a rule by id (idempotent). Only the rule's own layer disappears:
/// every node it was deciding reverts to the next layer down — explicit flags
/// are untouched by construction (rules never wrote any).
pub fn remove_rule(id: &str) {
    let mut state = load_state();
    let before = state.rules.len();
    state.rules.retain(|r| r.id != id);
    if state.rules.len() != before {
        save_state(&state);
    }
}

/// A rule enriched for the UI: generated display name, a human scope label,
/// and whether the scope folder currently exists (an orphaned rule matches
/// nothing but is kept for cleanup — the folder may return, e.g. an unplugged
/// linked root). KEEP IN SYNC with vault.ts::rulesListing.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleListing {
    #[serde(flatten)]
    pub rule: CurationRule,
    pub name: String,
    pub scope_label: String,
    pub orphaned: bool,
}

/// Human label for a rule scope: "" → "Vault"; a linked subtree renders under
/// its link's display name instead of the synthetic `extN`.
fn scope_label_of(scope: &str, state: &VaultState) -> String {
    if scope.is_empty() {
        return "Vault".to_string();
    }
    if let Some(ref_id) = ref_id_of(scope, &state.references) {
        let name = &state.references[ref_id].name;
        let rest = scope[ref_id.len()..].trim_start_matches('/');
        return if rest.is_empty() {
            name.clone()
        } else {
            format!("{name}/{rest}")
        };
    }
    scope.to_string()
}

/// Enrich one rule for the wire (the `add` response and each `list` row).
pub fn enrich_rule(rule: CurationRule) -> RuleListing {
    let state = load_state();
    let folder_ids: HashSet<String> = list_nodes()
        .into_iter()
        .filter(|n| n.kind == NodeKind::Folder)
        .map(|n| n.id)
        .collect();
    enrich_with(rule, &state, &folder_ids)
}

fn enrich_with(rule: CurationRule, state: &VaultState, folder_ids: &HashSet<String>) -> RuleListing {
    let orphaned = !rule.scope.is_empty() && !folder_ids.contains(&rule.scope);
    RuleListing {
        name: rule_display_name(&rule),
        scope_label: scope_label_of(&rule.scope, state),
        orphaned,
        rule,
    }
}

/// Every rule enriched for the UI (Preferences list + folder dialogs).
pub fn rules_listing() -> Vec<RuleListing> {
    let state = load_state();
    let folder_ids: HashSet<String> = list_nodes()
        .into_iter()
        .filter(|n| n.kind == NodeKind::Folder)
        .map(|n| n.id)
        .collect();
    state
        .rules
        .clone()
        .into_iter()
        .map(|r| enrich_with(r, &state, &folder_ids))
        .collect()
}

/// Move a file/folder within the vault (an *internal* move), preserving its
/// inclusion setting and that of its subtree.
pub fn move_node(from_id: &str, to_parent_id: Option<&str>) -> anyhow::Result<String> {
    if from_id.is_empty() {
        anyhow::bail!("fromId required");
    }
    let from_abs = safe_abs(from_id)?;
    let name = from_id.rsplit('/').next().unwrap_or(from_id).to_string();
    let new_id = match to_parent_id {
        Some(p) => format!("{p}/{name}"),
        None => name,
    };
    let to_abs = safe_abs(&new_id)?;
    if fs::metadata(&from_abs).is_err() {
        anyhow::bail!("source not found");
    }
    if fs::metadata(&to_abs).is_ok() {
        anyhow::bail!("destination already exists");
    }
    if let Some(parent) = to_abs.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(&from_abs, &to_abs)?;

    // Remap the node and every descendant's inclusion + local-only flags onto
    // the new prefix (both maps move together — see rename_node). Rule SCOPES
    // remap too: a rule follows its folder like the flags do, instead of
    // silently orphaning on an in-app move (orphaning is for deletion).
    let mut state = load_state();
    state.included = remap_prefix(&state.included, from_id, &new_id);
    state.local_only = remap_prefix(&state.local_only, from_id, &new_id);
    remap_rule_scopes(&mut state.rules, from_id, &new_id);
    save_state(&state);
    Ok(new_id)
}

/// Remap rule scopes onto a moved/renamed folder's new id (the scope itself
/// and any scope beneath it) — the rules analog of `remap_prefix`, so a rule
/// travels with its folder exactly like the per-node flags do. Scope-relative
/// globs survive untouched by construction. KEEP IN SYNC with
/// vault.ts::remapRuleScopes.
fn remap_rule_scopes(rules: &mut [CurationRule], old_id: &str, new_id: &str) {
    for r in rules.iter_mut() {
        if r.scope == old_id {
            r.scope = new_id.to_string();
        } else if let Some(rest) = r.scope.strip_prefix(&format!("{old_id}/")) {
            r.scope = format!("{new_id}/{rest}");
        }
    }
}

/// Remap a per-node flag map onto a new id prefix (the node itself and every
/// `{old}/…` descendant), leaving unrelated keys untouched. Shared by move and
/// rename so the `included` and `local_only` maps stay migrated in lockstep.
fn remap_prefix(map: &HashMap<String, bool>, old_id: &str, new_id: &str) -> HashMap<String, bool> {
    let mut next: HashMap<String, bool> = HashMap::new();
    for (k, v) in map {
        if k == old_id {
            next.insert(new_id.to_string(), *v);
        } else if k.starts_with(&format!("{old_id}/")) {
            next.insert(format!("{new_id}{}", &k[old_id.len()..]), *v);
        } else {
            next.insert(k.clone(), *v);
        }
    }
    next
}

/// Rename a node in place (same parent, new basename), carrying its inclusion
/// flags and its subtree's. Refuses empty / dotfile / separator names and a
/// destination that already exists. Vault-resident nodes only.
pub fn rename_node(id: &str, new_name: &str) -> anyhow::Result<String> {
    if id.is_empty() {
        anyhow::bail!("id required");
    }
    let clean = new_name.trim();
    if clean.is_empty() || clean.starts_with('.') || clean.contains('/') || clean.contains('\\') {
        anyhow::bail!("invalid name");
    }
    let from_abs = safe_abs(id)?;
    if fs::metadata(&from_abs).is_err() {
        anyhow::bail!("source not found");
    }
    let new_id = match id.rsplit_once('/') {
        Some((parent, _)) => format!("{parent}/{clean}"),
        None => clean.to_string(),
    };
    if new_id == id {
        return Ok(new_id); // no-op rename
    }
    let to_abs = safe_abs(&new_id)?;
    if fs::metadata(&to_abs).is_ok() {
        anyhow::bail!("destination already exists");
    }
    fs::rename(&from_abs, &to_abs)?;
    // Remap the node and every descendant's inclusion + local-only flags (same
    // as move_node), plus any rule scopes anchored at or beneath it.
    let mut state = load_state();
    state.included = remap_prefix(&state.included, id, &new_id);
    state.local_only = remap_prefix(&state.local_only, id, &new_id);
    remap_rule_scopes(&mut state.rules, id, &new_id);
    save_state(&state);
    Ok(new_id)
}

/// Create an empty folder under a parent (or the vault root when None). Returns
/// its id. Refuses empty / dotfile / separator names and existing paths.
pub fn create_folder(parent_id: Option<&str>, name: &str) -> anyhow::Result<String> {
    let clean = name.trim();
    if clean.is_empty() || clean.starts_with('.') || clean.contains('/') || clean.contains('\\') {
        anyhow::bail!("invalid folder name");
    }
    let new_id = match parent_id {
        Some(p) if !p.is_empty() => format!("{p}/{clean}"),
        _ => clean.to_string(),
    };
    let abs = safe_abs(&new_id)?;
    if fs::metadata(&abs).is_ok() {
        anyhow::bail!("a file or folder with that name already exists");
    }
    fs::create_dir_all(&abs)?;
    invalidate_walk_cache(); // a new (empty, excluded) folder — no state entry
    Ok(new_id)
}

/// Write an uploaded file into the vault (optionally under a folder). Collisions
/// get a " (n)" suffix. No state entry is created, so an uploaded file follows
/// the user's default-inclusion setting like any external add.
pub fn add_file(name: &str, bytes: &[u8], dest_parent_id: Option<&str>) -> anyhow::Result<String> {
    let safe_name = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(name)
        .trim()
        .to_string();
    if safe_name.is_empty() || safe_name.starts_with('.') {
        anyhow::bail!("invalid filename");
    }
    let ext = ext_of_preserving_case(&safe_name);
    let base = &safe_name[..safe_name.len() - ext.len()];

    let mut final_id = match dest_parent_id {
        Some(d) => format!("{d}/{safe_name}"),
        None => safe_name.clone(),
    };
    let mut abs = safe_abs(&final_id)?;
    if let Some(parent) = abs.parent() {
        fs::create_dir_all(parent)?;
    }
    // create_new makes the exists-check and the create one atomic step, so
    // two concurrent adds with the same name can never clobber each other —
    // the loser just moves to the next " (N)" suffix.
    let mut i = 1u32;
    loop {
        match fs::OpenOptions::new().write(true).create_new(true).open(&abs) {
            Ok(mut f) => {
                use std::io::Write as _;
                f.write_all(bytes)?;
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let alt = format!("{base} ({i}){ext}");
                final_id = match dest_parent_id {
                    Some(d) => format!("{d}/{alt}"),
                    None => alt,
                };
                abs = safe_abs(&final_id)?;
                i += 1;
            }
            Err(e) => return Err(e.into()),
        }
    }
    invalidate_walk_cache(); // a new file exists that no state write announced
    Ok(final_id)
}

/// G6: auto-exported past-chat notes live here (under "Lighthouse Notes").
/// A node id is its POSIX vault-relative path, so a path-prefix test is an
/// exact, deterministic source-kind classifier. KEEP IN SYNC with
/// src/server/vault.ts (CHATS_SUBDIR / sourceKindOf).
pub const CHATS_SUBDIR: &str = "Lighthouse Notes/Chats";

/// Classify a retrieved node id as a past-conversation note or an ordinary
/// file — purely by its vault-relative path. The trailing slash matters:
/// `Lighthouse Notes/Chats/x.md` is a conversation, `Lighthouse Notes/Chatsz`
/// is not. KEEP IN SYNC with src/server/vault.ts::sourceKindOf.
pub fn source_kind_of(file_id: &str) -> crate::contracts::SourceKind {
    if file_id.starts_with("Lighthouse Notes/Chats/") {
        crate::contracts::SourceKind::Conversation
    } else {
        crate::contracts::SourceKind::File
    }
}

/// Write an artifact into a named vault folder ("Lighthouse Results",
/// "Lighthouse Notes") — openspec: add-answer-artifacts. The name hint is
/// REPAIRED, never rejected (separators and control chars become dashes,
/// leading dots shed, length capped), then `add_file` supplies the collision
/// suffix — an existing file is never overwritten. The artifact is an
/// ordinary vault file: walked, watched, inclusion-ruled. Returns
/// (node_id, file_name). KEEP IN SYNC with src/server/vault.ts::writeArtifact.
pub fn write_artifact(
    subdir: &str,
    name_hint: &str,
    ext: &str,
    bytes: &[u8],
) -> anyhow::Result<(String, String)> {
    let mut clean: String = name_hint
        .chars()
        .map(|c| if c == '/' || c == '\\' || c.is_control() { '-' } else { c })
        .take(80)
        .collect();
    // Trim whitespace AND U+FEFF (BOM/ZWNBSP): JS String.trim() in the TS twin
    // (writeArtifact) strips it, but Rust's is_whitespace() does not, so a
    // name hint echoed from a BOM-prefixed file would otherwise yield a
    // different filename on each engine.
    let is_trim = |c: char| c.is_whitespace() || c == '\u{FEFF}';
    clean = clean.trim_matches(is_trim).trim_start_matches('.').trim_matches(is_trim).to_string();
    if clean.is_empty() {
        clean = "result".to_string();
    }
    let id = add_file(&format!("{clean}.{ext}"), bytes, Some(subdir))?;
    let name = id.rsplit('/').next().unwrap_or(&id).to_string();
    Ok((id, name))
}

/// Write/OVERWRITE a fixed-name artifact in a named vault folder (the G5
/// briefing-note refresh). Same hint sanitization as `write_artifact`, but NO
/// collision suffix — the file is replaced in place, so "Lighthouse Briefing.md"
/// stays a single, refreshed file instead of accreting " (1)", " (2)", … . The
/// target is `safe_abs`-guarded against vault escape and the walk cache is
/// invalidated (a file changed that no state write announced). Returns
/// (node_id, file_name). KEEP IN SYNC with src/server/vault.ts::refreshArtifact.
pub fn refresh_artifact(
    subdir: &str,
    name_hint: &str,
    ext: &str,
    bytes: &[u8],
) -> anyhow::Result<(String, String)> {
    let mut clean: String = name_hint
        .chars()
        .map(|c| if c == '/' || c == '\\' || c.is_control() { '-' } else { c })
        .take(80)
        .collect();
    let is_trim = |c: char| c.is_whitespace() || c == '\u{FEFF}';
    clean = clean.trim_matches(is_trim).trim_start_matches('.').trim_matches(is_trim).to_string();
    if clean.is_empty() {
        clean = "result".to_string();
    }
    // The node id is the vault-relative path; safe_abs rejects any escape.
    let id = format!("{subdir}/{clean}.{ext}");
    let abs = safe_abs(&id)?;
    if let Some(parent) = abs.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&abs, bytes)?; // truncating overwrite — replaces in place
    invalidate_walk_cache();
    let name = id.rsplit('/').next().unwrap_or(&id).to_string();
    Ok((id, name))
}

/// G6: 8 hex chars of SHA-1(conversation_id) — collision-resistant, stable,
/// and independent of the (mutable) title. THE one derivation of the
/// `[cid8]` key: `write_conversation_note` brackets it into the note's
/// filename, and `retrieve`'s investigation preference (openspec:
/// add-investigations) recomputes it from preferred conversation ids to
/// recognize those same filenames — extracted here so the two can never
/// drift. KEEP IN SYNC with src/server/vault.ts::conversationCid8.
fn conversation_cid8(conversation_id: &str) -> String {
    use sha1::{Digest, Sha1};
    let digest = Sha1::digest(conversation_id.as_bytes());
    digest.iter().take(4).map(|b| format!("{b:02x}")).collect()
}

/// The `[cid8]` key a conversation-note FILENAME carries (the
/// `"<title> [<cid8>].md"` format `write_conversation_note` produces), or
/// `None` for any other id. The LAST ` [` wins, so a title that itself
/// contains brackets still yields the engine-appended key. KEEP IN SYNC with
/// src/server/vault.ts::noteCid8Of.
fn note_cid8_of(file_id: &str) -> Option<&str> {
    let stem = file_id.strip_suffix("].md")?;
    stem.rsplit_once(" [").map(|(_, cid)| cid)
}

/// G6: write (overwrite) the auto-exported note for ONE conversation under
/// `CHATS_SUBDIR`. The filename is the sanitized title plus a short, stable id
/// derived from the conversation id — `"<title> [<cid8>].md"` — so the note is
/// human-scannable in the explorer yet keyed by conversation, not title. Any
/// earlier note for the SAME conversation whose title (hence filename) has since
/// changed is removed first, so one chat never leaves two notes behind.
/// `safe_abs`-guarded; walk cache invalidated. Returns (node_id, file_name).
/// KEEP IN SYNC with src/server/vault.ts::writeConversationNote.
pub fn write_conversation_note(
    conversation_id: &str,
    title: &str,
    bytes: &[u8],
) -> anyhow::Result<(String, String)> {
    // The dedup key in brackets (shared derivation — see conversation_cid8).
    let cid8 = conversation_cid8(conversation_id);
    let mut clean: String = title
        .chars()
        .map(|c| if c == '/' || c == '\\' || c.is_control() { '-' } else { c })
        .take(80)
        .collect();
    let is_trim = |c: char| c.is_whitespace() || c == '\u{FEFF}';
    clean = clean.trim_matches(is_trim).trim_start_matches('.').trim_matches(is_trim).to_string();
    if clean.is_empty() {
        clean = "Conversation".to_string();
    }
    let filename = format!("{clean} [{cid8}].md");
    let id = format!("{CHATS_SUBDIR}/{filename}");
    let abs = safe_abs(&id)?;
    if let Some(parent) = abs.parent() {
        fs::create_dir_all(parent)?;
        // Remove a prior note for this same conversation under a different title.
        let suffix = format!(" [{cid8}].md");
        if let Ok(rd) = fs::read_dir(parent) {
            for e in rd.flatten() {
                let fname = e.file_name().to_string_lossy().to_string();
                if fname.ends_with(&suffix) && fname != filename {
                    let _ = fs::remove_file(e.path());
                }
            }
        }
    }
    fs::write(&abs, bytes)?; // truncating overwrite — one current note per chat
    invalidate_walk_cache();
    Ok((id, filename))
}

/// G6 fail-closed opt-out: remove the entire auto-exported `Chats/` folder, so
/// turning "Save chats on this device" off leaves none of the user's
/// conversations on disk. Idempotent — a missing folder is success. `safe_abs`-
/// guarded. KEEP IN SYNC with src/server/vault.ts::purgeConversationNotes.
pub fn purge_conversation_notes() -> anyhow::Result<()> {
    let abs = safe_abs(CHATS_SUBDIR)?;
    if abs.exists() {
        fs::remove_dir_all(&abs)?;
        invalidate_walk_cache();
    }
    Ok(())
}

/// Like Node's `path.extname`: extension including the dot, original case.
fn ext_of_preserving_case(name: &str) -> String {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.contains('/') => format!(".{ext}"),
        _ => String::new(),
    }
}

/// Register a file or folder *in place* (a reference / link) instead of copying.
/// The path must exist. Re-linking the same path is idempotent; overlapping an
/// existing reference (or the vault) is rejected so content is never indexed twice.
pub fn add_reference(input_path: &str) -> anyhow::Result<(String, String)> {
    let abs = resolve_path(input_path);
    // Managed policy: linking is how arbitrary disk paths enter the corpus —
    // the vaultRoots allowlist is enforced here, at the single funnel every
    // caller (route op, desktop drop, native picker) goes through.
    if !crate::policy::vault_path_allowed(&abs) {
        anyhow::bail!("outside a location your organization allows");
    }
    let meta = fs::metadata(&abs).map_err(|_| anyhow::anyhow!("path not found"))?;
    let kind = if meta.is_dir() { "folder" } else { "file" };
    let mut state = load_state();

    let abs_s = abs.to_string_lossy().to_string();
    let vault_s = vault_dir().to_string_lossy().to_string();
    if paths_overlap(&abs_s, &vault_s) {
        anyhow::bail!("overlaps the vault");
    }
    let mut ids: Vec<String> = state.references.keys().cloned().collect();
    ids.sort();
    for id in &ids {
        let r = &state.references[id];
        let rp = resolve_path(&r.path).to_string_lossy().to_string();
        if rp == abs_s {
            return Ok((id.clone(), r.kind.clone()));
        }
        // A path INSIDE an already-linked folder resolves to that existing
        // descendant node id instead of re-linking.
        if r.kind == "folder" && is_within(&rp, &abs_s) {
            let rel = abs
                .strip_prefix(&rp)
                .map(|p| {
                    p.components()
                        .map(|c| c.as_os_str().to_string_lossy().to_string())
                        .collect::<Vec<_>>()
                        .join("/")
                })
                .unwrap_or_default();
            return Ok((format!("{id}/{rel}"), kind.to_string()));
        }
        if paths_overlap(&abs_s, &rp) {
            anyhow::bail!("overlaps an existing reference");
        }
    }

    let mut i = 0u32;
    let mut id = format!("ext{i}");
    while state.references.contains_key(&id) {
        i += 1;
        id = format!("ext{i}");
    }
    let name = abs
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| abs_s.clone());
    state.references.insert(
        id.clone(),
        Reference {
            path: abs_s,
            name,
            kind: kind.to_string(),
        },
    );
    save_state(&state);
    // Index the newly-linked content in the background now, so the first
    // question afterwards doesn't stall on building it interactively.
    warm_index_async();
    Ok((id, kind.to_string()))
}

/// Collect + drop a per-node flag map's entries for a node and its subtree,
/// returning the removed (id → bool) pairs so a later restore can put them back
/// exactly. Used for BOTH `included` and `local_only` so a removal round-trips
/// every per-node flag, not just inclusion.
fn take_flag_subtree(
    map: &mut HashMap<String, bool>,
    node_id: &str,
) -> serde_json::Map<String, serde_json::Value> {
    let prefix = format!("{node_id}/");
    let mut taken = serde_json::Map::new();
    map.retain(|k, v| {
        if k.as_str() == node_id || k.starts_with(prefix.as_str()) {
            taken.insert(k.clone(), serde_json::Value::Bool(*v));
            false
        } else {
            true
        }
    });
    taken
}

/// Re-apply an (id → bool) map captured by `take_flag_subtree`.
fn restore_flags(map: &mut HashMap<String, bool>, flags: &serde_json::Map<String, serde_json::Value>) {
    for (k, v) in flags {
        if let Some(b) = v.as_bool() {
            map.insert(k.clone(), b);
        }
    }
}

/// Remove a node from the vault — non-destructively. A linked item unlinks; a
/// vault-resident file/folder MOVES to a recoverable trash
/// (`.rag-vault/trash/<date>/…`) and its inclusion flags are dropped. Returns a
/// restore descriptor (fed to `restore_from_vault`) so the removal can be undone
/// without the user hand-digging the trash folder.
pub fn remove_from_vault(node_id: &str) -> anyhow::Result<serde_json::Value> {
    let mut state = load_state();
    let ref_id = ref_id_of(node_id, &state.references).map(String::from);
    // Reference root: unlink; restore re-links the same real path.
    if ref_id.as_deref() == Some(node_id) {
        let path = state
            .references
            .get(node_id)
            .map(|r| r.path.clone())
            .unwrap_or_default();
        let included = take_flag_subtree(&mut state.included, node_id);
        let local_only = take_flag_subtree(&mut state.local_only, node_id);
        state.references.remove(node_id);
        save_state(&state);
        return Ok(
            serde_json::json!({ "kind": "unlink", "root": node_id, "path": path, "included": included, "localOnly": local_only }),
        );
    }
    // A node *inside* a linked folder: scope the removal to just this node's
    // subtree by dropping its inclusion + local-only flags; the link itself
    // stays intact.
    if ref_id.is_some() {
        let included = take_flag_subtree(&mut state.included, node_id);
        let local_only = take_flag_subtree(&mut state.local_only, node_id);
        save_state(&state);
        return Ok(serde_json::json!({ "kind": "flags", "included": included, "localOnly": local_only }));
    }
    let abs = safe_abs(node_id)?; // refuses to escape the vault
    if abs == vault_dir() {
        anyhow::bail!("cannot remove the vault root");
    }
    let included = take_flag_subtree(&mut state.included, node_id);
    let local_only = take_flag_subtree(&mut state.local_only, node_id);
    if fs::metadata(&abs).is_ok() {
        let trash_dir = state_dir().join("trash").join(utc_day());
        fs::create_dir_all(&trash_dir)?;
        let base_name = node_id.rsplit('/').next().unwrap_or(node_id);
        let mut dest = trash_dir.join(base_name);
        let dest_name = dest.file_name().unwrap().to_string_lossy().to_string();
        let ext = ext_of_preserving_case(&dest_name);
        let stem = &dest_name[..dest_name.len() - ext.len()];
        let mut i = 1u32;
        while fs::metadata(&dest).is_ok() {
            dest = trash_dir.join(format!("{stem} ({i}){ext}"));
            i += 1;
        }
        fs::rename(&abs, &dest)?;
        save_state(&state);
        return Ok(serde_json::json!({
            "kind": "trash",
            "id": node_id,
            "trashPath": dest.to_string_lossy(),
            "included": included,
            "localOnly": local_only,
        }));
    }
    // Nothing on disk to move (already gone) — only flags were dropped.
    save_state(&state);
    Ok(serde_json::json!({ "kind": "flags", "included": included, "localOnly": local_only }))
}

/// Reverse a `remove_from_vault` using the descriptor it returned. Non-
/// destructive and refuses to overwrite: if something now occupies the original
/// location, it fails rather than clobbering. Returns the node's (possibly new)
/// id so the caller can refresh.
pub fn restore_from_vault(desc: &serde_json::Value) -> anyhow::Result<serde_json::Value> {
    let included = desc
        .get("included")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    // Older descriptors (removed before this change) carry no localOnly key —
    // absent ⇒ nothing to restore, the same serde-default tolerance state.json
    // itself relies on.
    let local_only = desc
        .get("localOnly")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    match desc.get("kind").and_then(|v| v.as_str()) {
        Some("unlink") => {
            let path = desc.get("path").and_then(|v| v.as_str()).unwrap_or_default();
            if path.is_empty() {
                anyhow::bail!("nothing to restore");
            }
            // Re-link the same real path; it may receive a fresh extN id, so
            // remap the saved flags (both maps) from the old root prefix onto
            // the new one.
            let old_root = desc.get("root").and_then(|v| v.as_str()).unwrap_or_default();
            let (new_root, _kind) = add_reference(path)?;
            let mut state = load_state();
            let remap = |k: &str| -> String {
                if k == old_root {
                    new_root.clone()
                } else if let Some(rest) = k.strip_prefix(&format!("{old_root}/")) {
                    format!("{new_root}/{rest}")
                } else {
                    k.to_string()
                }
            };
            for (k, v) in &included {
                if let Some(b) = v.as_bool() {
                    state.included.insert(remap(k), b);
                }
            }
            for (k, v) in &local_only {
                if let Some(b) = v.as_bool() {
                    state.local_only.insert(remap(k), b);
                }
            }
            save_state(&state);
            Ok(serde_json::json!({ "id": new_root }))
        }
        Some("flags") => {
            let mut state = load_state();
            restore_flags(&mut state.included, &included);
            restore_flags(&mut state.local_only, &local_only);
            save_state(&state);
            Ok(serde_json::json!({ "ok": true }))
        }
        Some("trash") => {
            let id = desc.get("id").and_then(|v| v.as_str()).unwrap_or_default();
            let trash_path = desc
                .get("trashPath")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if id.is_empty() || trash_path.is_empty() {
                anyhow::bail!("incomplete restore token");
            }
            let abs = safe_abs(id)?;
            if fs::metadata(&abs).is_ok() {
                anyhow::bail!("something already exists at the original location");
            }
            if let Some(parent) = abs.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::rename(trash_path, &abs)?;
            let mut state = load_state();
            restore_flags(&mut state.included, &included);
            restore_flags(&mut state.local_only, &local_only);
            save_state(&state);
            Ok(serde_json::json!({ "id": id }))
        }
        _ => anyhow::bail!("unknown restore token"),
    }
}

/// Drop a reference (unlink). Leaves the real files on disk untouched.
pub fn remove_reference(ref_id: &str) {
    let mut state = load_state();
    if state.references.remove(ref_id).is_none() {
        return;
    }
    let prefix = format!("{ref_id}/");
    state
        .included
        .retain(|k, _| k != ref_id && !k.starts_with(&prefix));
    state
        .local_only
        .retain(|k, _| k != ref_id && !k.starts_with(&prefix));
    save_state(&state);
}

/// File ids currently included on disk — the single source of truth for what
/// chat may see. Empty if the vault source is toggled unavailable.
pub fn active_included_file_ids() -> Vec<String> {
    let state = load_state();
    if !state.source_available {
        return Vec::new();
    }
    let default_in = default_included();
    walk(&vault_dir())
        .iter()
        .filter(|n| {
            n.kind == NodeKind::File && is_effectively_included(&n.id, &state, default_in, true)
        })
        .map(|n| n.id.clone())
        .collect()
}

/// The SHAREABLE set — the master gate for anything a provider could receive.
/// On the local/extractive path (`is_cloud == false`) it equals
/// `active_included_file_ids()`: local-only marks are INERT, so on-device
/// answers are byte-identical to today. When a CLOUD provider is active it is
/// the active-included set MINUS every effectively-local-only id. Retrieval,
/// the analytics candidate gather, doc-focus, cross-doc, and meta/catalog
/// answers all start here, so routing them through this one function keeps a
/// marked file's content off the cloud path in a single move.
/// KEEP IN SYNC with vault.ts::shareableFileIds.
pub fn shareable_file_ids(is_cloud: bool) -> Vec<String> {
    let ids = active_included_file_ids();
    if !is_cloud {
        return ids;
    }
    let state = load_state();
    ids.into_iter()
        .filter(|id| !is_effectively_local_only(id, &state, true))
        .collect()
}

/// The shareable candidate set with each file's CURRENT freshness key
/// (`mtimeMs:size` — the index's own key shape, index::key_of), in one walk +
/// one state load: the answer cache's candidate-digest input (openspec:
/// add-answer-cache). Inherits every gate the answer respects via
/// `shareable_file_ids`; an unreadable file participates with an empty key
/// (readable⇄unreadable is itself an answer-changing event). KEEP IN SYNC with
/// vault.ts::shareableFreshnessKeys (whose keys are its own stat values —
/// same shape, twin-local values; the twins never share a cache file).
pub fn shareable_freshness_keys(is_cloud: bool) -> Vec<(String, String)> {
    let state = load_state();
    shareable_file_ids(is_cloud)
        .into_iter()
        .map(|id| {
            let key = resolve_abs(&id, &state)
                .ok()
                .and_then(|abs| crate::index::key_of(&abs))
                .unwrap_or_default();
            (id, key)
        })
        .collect()
}

/// Drop effectively-local-only ids from `ids` when a cloud provider is active;
/// pass `ids` through unchanged on the device path. The reusable filter the two
/// gate-BYPASSERS (attachments, doc-focus) apply at their own choke points, and
/// the belt-and-suspenders analytics filter reuses. KEEP IN SYNC with
/// vault.ts::shareableSubset.
pub fn shareable_subset(ids: &[String], is_cloud: bool) -> Vec<String> {
    if !is_cloud {
        return ids.to_vec();
    }
    let state = load_state();
    ids.iter()
        .filter(|id| !is_effectively_local_only(id, &state, true))
        .cloned()
        .collect()
}

/// The effectively-local-only ids among `ids` — i.e. the files a cloud answer
/// must DROP solely for being marked private. Empty on the device path (the
/// mark is inert). Drives the honest skip note. KEEP IN SYNC with
/// vault.ts::localOnlySubset.
pub fn local_only_subset(ids: &[String], is_cloud: bool) -> Vec<String> {
    if !is_cloud {
        return Vec::new();
    }
    let state = load_state();
    ids.iter()
        .filter(|id| is_effectively_local_only(id, &state, true))
        .cloned()
        .collect()
}

/// Single-id `is_effectively_local_only` that loads state itself — for callers
/// outside vault.rs that don't hold a `VaultState` (the sharepoint connector's
/// node list, the analytics belt-and-suspenders). Local-only marks live in the
/// vault state keyed by node id regardless of the owning source. Callers pass
/// FILE ids (retrieval candidates), so the rule layer applies.
pub fn node_is_local_only(id: &str) -> bool {
    is_effectively_local_only(id, &load_state(), true)
}

// --- text reading ---------------------------------------------------------------

/// Read text from an absolute path — rich formats (pdf/docx/xlsx) go through
/// the extractor with its own size handling and cache; plain text is read
/// directly, capped at `cap` bytes so one pathological file can't dominate
/// memory. The index (Phase 5) passes a generous, env-tunable cap; the legacy
/// 1 MB bound existed only to protect the per-query read path that no longer
/// exists.
pub fn read_text_abs_capped(abs: &Path, cap: u64) -> String {
    let name = abs.to_string_lossy();
    if is_rich_file(&name) {
        return extract_rich_text(abs, &ext_of(&name));
    }
    if !is_text_file(&name) {
        return String::new();
    }
    let size = fs::metadata(abs).map(|m| m.len()).unwrap_or(0);
    if size <= cap {
        return fs::read(abs)
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .unwrap_or_default();
    }
    // Large file: read only the first `cap` bytes.
    use std::io::Read;
    let Ok(f) = fs::File::open(abs) else {
        return String::new();
    };
    let mut buf = vec![0u8; cap as usize];
    let mut taken = f.take(cap);
    let mut read = 0usize;
    loop {
        match taken.read(&mut buf[read..]) {
            Ok(0) => break,
            Ok(n) => read += n,
            Err(_) => return String::new(),
        }
    }
    String::from_utf8_lossy(&buf[..read]).into_owned()
}

// --- tokenization & scoring ------------------------------------------------------

const STOP_WORDS: &[&str] = &[
    "the", "a", "an", "and", "or", "of", "to", "in", "is", "are", "for", "on", "with", "as", "at",
    "by", "from", "this", "that", "it", "be", "do", "does", "have", "any", "there", "my", "our",
    "your", "you", "me", "i",
];

/// Lowercased runs of `[a-z0-9]{2,}` minus stop words (port of `tokenize`).
pub fn tokenize(s: &str) -> Vec<String> {
    word_runs(&s.to_lowercase())
        .into_iter()
        .filter(|t| t.len() >= 2 && !STOP_WORDS.contains(&t.as_str()))
        .collect()
}

/// All maximal runs of ascii `[a-z0-9]` in an (already lowercased) string.
fn word_runs(lower: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for c in lower.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            cur.push(c);
        } else if !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Crude singularizer so "cards" matches "card".
fn singular(t: &str) -> &str {
    if t.len() > 3 && t.ends_with('s') {
        &t[..t.len() - 1]
    } else {
        t
    }
}

/// Searchable tokens from a file's name and path.
pub fn name_tokens_of(id: &str, name: &str) -> Vec<String> {
    tokenize(&format!("{} {}", id.replace('/', " "), name))
}

/// How strongly the query matches a file's name/path tokens.
fn name_match(q_tokens: &[String], name_toks: &[String]) -> (usize, bool) {
    let mut hits = 0usize;
    let mut strong = false;
    for raw in q_tokens {
        let q = singular(raw);
        if q.len() < 3 {
            continue;
        }
        let hit = name_toks.iter().any(|nt0| {
            let nt = singular(nt0);
            nt == q || nt.contains(q) || (nt.len() >= 3 && q.contains(nt))
        });
        if hit {
            hits += 1;
            if raw.len() >= 4 {
                strong = true;
            }
        }
    }
    (hits, strong)
}

/// The named-file pin's target, if any: the single file whose meaningful
/// name/path tokens the question covers substantially enough to read as
/// "the user named this file". Deliberately conservative — the pin FORCES a
/// file into the top-k, so a weak or ambiguous match must select nothing
/// (0.6.2 field report: a lone generic token shared with a filename pinned
/// irrelevant files — "quoting the right documents but recommending the
/// wrong ones"). KEEP IN SYNC with vault.ts::pinnedNamedFile. Rules:
///   - coverage: the question must mention at least half of the file's
///     unique meaningful name tokens (len ≥ 3, extension tokens dropped);
///   - specificity: ≥ 2 covered tokens, or a single-token name whose token
///     is ≥ 5 chars ("resume" can pin, "plan" never does);
///   - uniqueness: two files with the same coverage signature mean the
///     phrase is generic (meeting-notes-1/2/3…) — pin nothing.
fn pinned_named_file<'a>(
    qtokens: &[String],
    files: impl Iterator<Item = (&'a str, &'a [String])>,
) -> Option<&'a str> {
    let mut best: Option<(&str, usize, usize)> = None; // (id, covered, total)
    let mut ambiguous = false;
    for (id, name_toks) in files {
        let mut uniq: Vec<&str> = name_toks
            .iter()
            .map(|t| singular(t))
            .filter(|t| t.len() >= 3 && !EXT_TOKENS.contains(t))
            .collect();
        uniq.sort_unstable();
        uniq.dedup();
        if uniq.is_empty() {
            continue;
        }
        let covered: Vec<&str> = uniq
            .iter()
            .copied()
            .filter(|&nt| {
                qtokens.iter().any(|q0| {
                    let q = singular(q0);
                    q.len() >= 3 && (q == nt || nt.contains(q) || q.contains(nt))
                })
            })
            .collect();
        let (c, m) = (covered.len(), uniq.len());
        let specific = c >= 2 || (m == 1 && covered.first().is_some_and(|t| t.len() >= 5));
        if c * 2 < m || !specific {
            continue;
        }
        match best {
            None => best = Some((id, c, m)),
            Some((_, bc, bm)) => {
                // Compare coverage fractions via cross-multiplication (c/m
                // vs bc/bm), then absolute covered count. An exact tie on
                // both is the generic-siblings case.
                let (lhs, rhs) = (c * bm, bc * m);
                if lhs > rhs || (lhs == rhs && c > bc) {
                    best = Some((id, c, m));
                    ambiguous = false;
                } else if lhs == rhs && c == bc {
                    ambiguous = true;
                }
            }
        }
    }
    if ambiguous {
        return None;
    }
    best.map(|(id, _, _)| id)
}

// --- catalog / listing queries ----------------------------------------------------

struct Listing {
    label: String,
    exts: Option<HashSet<String>>, // None ⇒ match every file
}

fn listing_exts(kind: &str) -> Vec<&'static str> {
    match kind {
        "dataset" => vec![
            ".csv", ".tsv", ".xlsx", ".xlsm", ".xls", ".parquet", ".json", ".arrow", ".feather",
        ],
        "spreadsheet" => vec![".csv", ".tsv", ".xlsx", ".xlsm", ".xls"],
        "document" => vec![
            ".md",
            ".markdown",
            ".txt",
            ".text",
            ".rst",
            ".doc",
            ".docx",
            ".pdf",
            ".rtf",
            ".odt",
        ],
        "pdf" => vec![".pdf"],
        _ => vec![],
    }
}

const LISTING_FILLER: &[&str] = &[
    "show",
    "me",
    "list",
    "give",
    "please",
    "can",
    "could",
    "would",
    "you",
    "display",
    "name",
    "names",
    "enumerate",
    "tell",
    "what",
    "which",
    "how",
    "many",
    "much",
    "are",
    "there",
    "is",
    "do",
    "does",
    "did",
    "i",
    "we",
    "my",
    "our",
    "the",
    "a",
    "an",
    "all",
    "every",
    "each",
    "of",
    "in",
    "on",
    "to",
    "get",
    "see",
    "view",
    "find",
    "catalog",
    "catalogue",
    "count",
    "number",
    "total",
    "available",
    "included",
    "uploaded",
    "stored",
    "have",
    "has",
    "any",
];

const LISTING_NOUN: &[&str] = &[
    "file",
    "files",
    "dataset",
    "datasets",
    "document",
    "documents",
    "doc",
    "docs",
    "pdf",
    "pdfs",
    "spreadsheet",
    "spreadsheets",
    "csv",
    "csvs",
    "table",
    "tables",
    "source",
    "sources",
];

fn listing_qualifier(t: &str) -> Option<Vec<&'static str>> {
    let exts: Vec<&'static str> = match t {
        "csv" => vec![".csv"],
        "tsv" => vec![".tsv"],
        "xlsx" => vec![".xlsx"],
        "xlsm" => vec![".xlsm"],
        "xls" => vec![".xls"],
        "parquet" => vec![".parquet"],
        "json" => vec![".json"],
        "arrow" => vec![".arrow"],
        "feather" => vec![".feather"],
        "md" | "markdown" => vec![".md", ".markdown"],
        "txt" | "text" => vec![".txt", ".text"],
        "rst" => vec![".rst"],
        "rtf" => vec![".rtf"],
        "odt" => vec![".odt"],
        "docx" => vec![".docx"],
        "xml" => vec![".xml"],
        "html" => vec![".html"],
        _ => return None,
    };
    Some(exts)
}

/// Whether `q` contains `phrase` bounded by non-word chars (JS `\b…\b` on a
/// literal, supporting the two-word "how many").
fn contains_phrase(q: &str, phrase: &str) -> bool {
    let bytes = q.as_bytes();
    let is_word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let mut start = 0;
    while let Some(pos) = q[start..].find(phrase) {
        let at = start + pos;
        let before_ok = at == 0 || !is_word(bytes[at - 1]);
        let after = at + phrase.len();
        let after_ok = after >= bytes.len() || !is_word(bytes[after]);
        if before_ok && after_ok {
            return true;
        }
        start = at + 1;
    }
    false
}

/// Detect a catalog-style query ("show me all files", "list my datasets", "how
/// many documents") and which file kind it refers to. None for an ordinary
/// content question.
fn listing_intent(query: &str) -> Option<Listing> {
    let q = query.to_lowercase();
    // First noun token matching \b(file|dataset|document|doc|pdf|spreadsheet|csv|table|source)(s)?\b.
    const NOUNS: &[&str] = &[
        "file",
        "dataset",
        "document",
        "doc",
        "pdf",
        "spreadsheet",
        "csv",
        "table",
        "source",
    ];
    let tokens = word_runs(&q);
    let mut matched: Option<(&str, bool)> = None; // (noun, plural)
    'outer: for t in &tokens {
        for n in NOUNS {
            if t == n {
                matched = Some((n, false));
                break 'outer;
            }
            if t.len() == n.len() + 1 && t.starts_with(n) && t.ends_with('s') {
                matched = Some((n, true));
                break 'outer;
            }
        }
    }
    let (noun, plural) = matched?;

    let verb = [
        "show",
        "list",
        "give",
        "display",
        "name",
        "what",
        "which",
        "enumerate",
        "tell",
    ]
    .iter()
    .any(|v| contains_phrase(&q, v))
        || contains_phrase(&q, "how many");
    if !verb {
        return None;
    }
    let strong = [
        "all",
        "every",
        "each",
        "list",
        "enumerate",
        "catalog",
        "catalogue",
    ]
    .iter()
    .any(|v| contains_phrase(&q, v))
        || contains_phrase(&q, "how many");
    if !plural && !strong {
        return None;
    }

    // Only a pure catalog request should enumerate: if any meaningful content
    // token survives the scaffolding strip, fall through to relevance ranking.
    let residual = tokens.iter().any(|t| {
        !LISTING_FILLER.contains(&t.as_str())
            && !LISTING_NOUN.contains(&t.as_str())
            && listing_qualifier(t).is_none()
    });
    if residual {
        return None;
    }

    // A named file-type qualifier narrows the listing to exactly its extensions.
    let mut qual_words: Vec<String> = Vec::new();
    let mut qual_exts: HashSet<String> = HashSet::new();
    for t in &tokens {
        let base = if listing_qualifier(t).is_some() {
            Some(t.clone())
        } else if t.ends_with('s') && listing_qualifier(&t[..t.len() - 1]).is_some() {
            Some(t[..t.len() - 1].to_string())
        } else {
            None
        };
        if let Some(b) = base {
            if !qual_words.contains(&b) {
                for e in listing_qualifier(&b).unwrap() {
                    qual_exts.insert(e.to_string());
                }
                qual_words.push(b);
            }
        }
    }
    if !qual_exts.is_empty() {
        return Some(Listing {
            label: format!(
                "{} files",
                qual_words
                    .iter()
                    .map(|w| w.to_uppercase())
                    .collect::<Vec<_>>()
                    .join("/")
            ),
            exts: Some(qual_exts),
        });
    }

    let kind = match noun {
        "dataset" | "csv" | "table" => "dataset",
        "spreadsheet" => "spreadsheet",
        "document" | "doc" => "document",
        "pdf" => "pdf",
        _ => "all",
    };
    if kind == "all" {
        return Some(Listing {
            label: "files".to_string(),
            exts: None,
        });
    }
    let exts: HashSet<String> = listing_exts(kind).into_iter().map(String::from).collect();
    let label = if kind == "pdf" {
        "PDFs".to_string()
    } else {
        format!("{kind}s")
    };
    Some(Listing {
        label,
        exts: Some(exts),
    })
}

fn listing_matches(intent: &Listing, name: &str) -> bool {
    match &intent.exts {
        None => true,
        Some(exts) => exts.contains(&ext_of(name)),
    }
}

/// Enumerate the included files matching a listing intent (capped for huge vaults).
fn build_listing(nodes: &[FileNode], intent: &Listing) -> Retrieved {
    let files: Vec<&FileNode> = nodes
        .iter()
        .filter(|n| listing_matches(intent, &n.name))
        .collect();
    if files.is_empty() {
        return Retrieved {
            references: vec![],
            contexts: vec![Context {
                name: format!("Included {}", intent.label),
                text: format!("No included {} found.", intent.label),
                score: 1.0,
                kind: crate::contracts::SourceKind::File,
            }],
        };
    }
    const CAP: usize = 50;
    let names: Vec<&str> = files.iter().map(|f| f.name.as_str()).collect();
    let mut list = format!("{} included {}:\n", files.len(), intent.label);
    list.push_str(
        &names
            .iter()
            .take(CAP)
            .map(|n| format!("- {n}"))
            .collect::<Vec<_>>()
            .join("\n"),
    );
    if names.len() > CAP {
        list.push_str(&format!("\n…and {} more", names.len() - CAP));
    }
    let references: Vec<RagReference> = files
        .iter()
        .take(CAP)
        .map(|f| RagReference {
            file_id: f.id.clone(),
            name: f.name.clone(),
            snippet: String::new(),
            score: 1.0,
            kind: source_kind_of(&f.id),
        })
        .collect();
    Retrieved {
        references,
        contexts: vec![Context {
            name: format!("Included {}", intent.label),
            text: list,
            score: 1.0,
            kind: crate::contracts::SourceKind::File,
        }],
    }
}

// --- chunking & retrieval -----------------------------------------------------------

/// Split like JS `text.split(/\s+/)` (leading/trailing empties preserved so
/// window alignment matches the TS chunker exactly).
fn js_split_ws(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = text;
    if rest.is_empty() {
        return vec![""];
    }
    let starts_ws = rest
        .chars()
        .next()
        .map(|c| c.is_whitespace())
        .unwrap_or(false);
    if starts_ws {
        out.push(&text[0..0]); // JS yields a leading ""
    }
    while !rest.is_empty() {
        let ws_at = rest.find(char::is_whitespace);
        match ws_at {
            Some(0) => {
                let next = rest
                    .char_indices()
                    .find(|(_, c)| !c.is_whitespace())
                    .map(|(i, _)| i)
                    .unwrap_or(rest.len());
                rest = &rest[next..];
                if rest.is_empty() {
                    out.push(&text[0..0]); // trailing ""
                }
            }
            Some(i) => {
                out.push(&rest[..i]);
                rest = &rest[i..];
            }
            None => {
                out.push(rest);
                rest = &rest[rest.len()..];
            }
        }
    }
    out
}

/// Structure-aware chunking (docs/analytics-beam.md, B1): tabular extracts
/// chunk by ROWS with the header line(s) prepended to every chunk, so a chunk
/// holding row 400 still carries its column names; prose keeps the word
/// windows below. KEEP BYTE-IDENTICAL with the TS chunker (vault.ts chunksOf).
pub fn chunk_texts_named(name: &str, text: &str) -> Vec<String> {
    if crate::analytics::is_tabular(name) {
        return chunk_tabular(name, text);
    }
    chunk_texts_of(text)
}

fn chunk_tabular(name: &str, text: &str) -> Vec<String> {
    const ROWS: usize = 30;
    const ROW_OVERLAP: usize = 5;
    let lower = name.to_lowercase();
    // Workbook extracts prepend the sheet name above each sheet's CSV; carry
    // BOTH the sheet line and the header row into every chunk.
    let header_lines =
        if lower.ends_with(".xlsx") || lower.ends_with(".xlsm") || lower.ends_with(".xls") { 2 } else { 1 };
    let mut chunks: Vec<String> = Vec::new();
    // Blank-line-separated blocks (one per sheet for workbooks).
    for block in text.split("\n\n") {
        // Trim trailing whitespace INCLUDING U+FEFF (BOM/ZWNBSP): JS `\s` and
        // `String.trim` strip it but Rust's `char::is_whitespace` does not, so a
        // tabular line ending in a mid-file BOM would chunk differently across
        // the twins. Match JS so the chunkers stay byte-identical (parity).
        let ws = |c: char| c.is_whitespace() || c == '\u{feff}';
        let lines: Vec<&str> = block
            .split('\n')
            .map(|l| l.trim_end_matches(ws))
            .filter(|l| !l.trim_matches(ws).is_empty())
            .collect();
        if lines.is_empty() {
            continue;
        }
        let h = header_lines.min(lines.len().saturating_sub(1));
        if lines.len() <= h + 1 {
            chunks.push(lines.join("\n"));
            continue;
        }
        let header = lines[..h].join("\n");
        let data = &lines[h..];
        let mut i = 0usize;
        while i < data.len() {
            let end = (i + ROWS).min(data.len());
            let body = data[i..end].join("\n");
            chunks.push(if header.is_empty() { body } else { format!("{header}\n{body}") });
            if i + ROWS >= data.len() {
                break;
            }
            i += ROWS - ROW_OVERLAP;
        }
    }
    chunks
}

/// 120-word chunks with 25-word overlap — identical windows to the TS engine.
/// Term frequencies are attached by the index at build time.
pub fn chunk_texts_of(text: &str) -> Vec<String> {
    let words = js_split_ws(text);
    const SIZE: usize = 120;
    const OVERLAP: usize = 25;
    let mut chunks = Vec::new();
    let mut i = 0usize;
    while i < words.len() {
        let end = (i + SIZE).min(words.len());
        let slice = words[i..end].join(" ").trim().to_string();
        if !slice.is_empty() {
            chunks.push(slice);
        }
        if i + SIZE >= words.len() {
            break;
        }
        i += SIZE - OVERLAP;
    }
    chunks
}

#[derive(Debug, Clone, Serialize)]
pub struct Context {
    pub name: String,
    pub text: String,
    pub score: f64,
    /// G6: `Conversation` for a past-chat note, else `File`. Internal to synth
    /// (drives the prompt label); not serialized to the client. Defaults to File.
    #[serde(default)]
    pub kind: crate::contracts::SourceKind,
}

#[derive(Debug, Clone, Serialize)]
pub struct Retrieved {
    pub references: Vec<RagReference>,
    pub contexts: Vec<Context>,
}

/// An externally-mirrored item (cloud connector) ranked alongside vault files.
#[derive(Clone)]
pub struct ExternalItem {
    pub id: String,
    pub name: String,
    pub abs: PathBuf,
}

/// Build the retrieval index for everything currently included, on a
/// background thread (bounded parallelism inside `entries_for`). Called after
/// linking a folder and at desktop boot so the FIRST question never pays the
/// whole corpus build interactively — that wait was the "load times are very
/// slow after linking a large number of files" complaint. Single-flight: a
/// request that lands while one is running is dropped (the per-query key
/// check self-heals any gap).
pub fn warm_index_async() {
    use std::sync::atomic::{AtomicBool, Ordering};
    static WARMING: AtomicBool = AtomicBool::new(false);
    if WARMING.swap(true, Ordering::SeqCst) {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("lh-index-warm".into())
        .spawn(|| {
            let ids: HashSet<String> = active_included_file_ids().into_iter().collect();
            let state = load_state();
            let items: Vec<crate::index::IndexItem> = walk(&vault_dir())
                .iter()
                .filter(|n| n.kind == NodeKind::File && ids.contains(&n.id))
                .map(|n| crate::index::IndexItem {
                    abs: resolve_abs(&n.id, &state).ok(),
                    path_for: n.id.clone(),
                    id: n.id.clone(),
                    name: n.name.clone(),
                })
                .collect();
            let _ = crate::index::entries_for(&items);
            // Vectors may be cold even when every index entry was a hit (first
            // boot after enabling B2, sidecar deleted, embed server was down).
            crate::embed::nudge_warm();
            WARMING.store(false, Ordering::SeqCst);
        });
    if spawned.is_err() {
        WARMING.store(false, Ordering::SeqCst);
    }
}

/// Retrieval over the included files: TF-IDF cosine over content chunks combined
/// with a filename/path match, plus catalog/listing enumeration.
/// `preferred_conversation_ids` (openspec: add-investigations) names the
/// current investigation's conversations so a recall cue can prefer THEIR
/// notes over global ones — empty means no preference (byte-identical to
/// the pre-investigations ranking).
pub fn retrieve(
    query: &str,
    included_file_ids: &[String],
    k: usize,
    external: &[ExternalItem],
    attachment_ids: &[String],
    is_cloud: bool,
    preferred_conversation_ids: &[String],
) -> Retrieved {
    let state = load_state();
    // The candidate id set. When a cloud provider is active, both branches are
    // narrowed to the SHAREABLE set so an effectively-local-only file's content
    // never reaches the vendor:
    //  - attachments are their own consent scope, but a marked attachment still
    //    can't ride to the cloud — filter it at this bypasser's own choke point;
    //  - otherwise, intersect the caller's ids with the shareable gate (the
    //    active-included set minus local-only), which also blocks a stale client
    //    from resurrecting an excluded OR a local-only file.
    let idset: HashSet<String> = if !attachment_ids.is_empty() {
        shareable_subset(attachment_ids, is_cloud).into_iter().collect()
    } else {
        let auth: HashSet<String> = shareable_file_ids(is_cloud).into_iter().collect();
        included_file_ids
            .iter()
            .filter(|id| auth.contains(*id))
            .cloned()
            .collect()
    };

    // Mirrored cloud-connector items bypass the vault gate — drop any that are
    // effectively-local-only when cloud is active, at this choke point.
    let external_owned: Vec<ExternalItem>;
    let external: &[ExternalItem] = if is_cloud {
        external_owned = external
            .iter()
            .filter(|e| !is_effectively_local_only(&e.id, &state, true))
            .cloned()
            .collect();
        &external_owned
    } else {
        external
    };

    let nodes: Vec<FileNode> = walk(&vault_dir())
        .iter()
        .filter(|n| n.kind == NodeKind::File && idset.contains(&n.id))
        .cloned()
        .collect();
    if nodes.is_empty() && external.is_empty() {
        return Retrieved {
            references: vec![],
            contexts: vec![],
        };
    }

    // Catalog/listing intent enumerates vault files.
    if !nodes.is_empty() {
        if let Some(listing) = listing_intent(query) {
            return build_listing(&nodes, &listing);
        }
    }

    let qtokens = tokenize(query);
    if qtokens.is_empty() {
        return Retrieved {
            references: vec![],
            contexts: vec![],
        };
    }

    // Unified retrieval items served by the persistent index (Phase 5): vault
    // files by node id, mirrored cloud files by absolute mirror path. Stale or
    // missing entries are rebuilt in parallel inside `entries_for`.
    let items: Vec<crate::index::IndexItem> = nodes
        .iter()
        .map(|n| crate::index::IndexItem {
            id: n.id.clone(),
            name: n.name.clone(),
            path_for: n.id.clone(),
            abs: resolve_abs(&n.id, &state).ok(),
        })
        .chain(external.iter().map(|e| crate::index::IndexItem {
            id: e.id.clone(),
            name: e.name.clone(),
            path_for: String::new(),
            abs: Some(e.abs.clone()),
        }))
        .collect();
    let entries = crate::index::entries_for(&items);

    // Chunks scored this query. The legacy 4,000-chunk cap protected the
    // per-query read loop; from the index a far larger budget is cheap, and
    // hitting it is logged instead of silent.
    let max_chunks = crate::index::max_query_chunks();
    type ChunkRef<'a> = (
        &'a str,
        &'a crate::index::FileEntry,
        &'a crate::index::IndexedChunk,
    );
    let mut chunk_refs: Vec<ChunkRef> = Vec::new();
    'items: for item in &items {
        let Some(entry) = entries.get(&item.id) else {
            continue;
        };
        for c in &entry.chunks {
            if chunk_refs.len() >= max_chunks {
                eprintln!(
                    "retrieve: chunk budget {max_chunks} reached; some included content was not scored this query"
                );
                break 'items;
            }
            chunk_refs.push((item.id.as_str(), entry, c));
        }
    }

    // --- content scoring (TF-IDF cosine over chunks; identical math to TS) ---
    struct Scored<'a> {
        file_id: &'a str,
        name: &'a str,
        text: &'a str,
        score: f64,
    }
    let mut scored: Vec<Scored> = Vec::new();
    if !chunk_refs.is_empty() {
        let mut df: HashMap<&str, f64> = HashMap::new();
        for (_, _, c) in &chunk_refs {
            for t in c.tf.keys() {
                *df.entry(t.as_str()).or_insert(0.0) += 1.0;
            }
        }
        let n = chunk_refs.len() as f64;
        // idf precomputed ONCE per unique corpus term. The old closure recomputed
        // ((n+1)/(df+1)).ln()+1 for every term-occurrence of every chunk on every
        // query; the fallback here reproduces the old df.get(..).unwrap_or(0.0)
        // path for query terms absent from the corpus. Scores are bit-identical.
        let idf_fallback = (n + 1.0).ln() + 1.0;
        let idf_map: HashMap<&str, f64> = df
            .iter()
            .map(|(&t, &d)| (t, ((n + 1.0) / (d + 1.0)).ln() + 1.0))
            .collect();
        let idf = |t: &str| idf_map.get(t).copied().unwrap_or(idf_fallback);
        // Query vector — small (only the query's own terms), materialized once.
        let mut qtf: HashMap<&str, f64> = HashMap::new();
        for t in &qtokens {
            *qtf.entry(t.as_str()).or_insert(0.0) += 1.0;
        }
        let mut qv: Vec<(&str, f64)> = Vec::with_capacity(qtf.len());
        let mut qnorm_sq = 0.0;
        for (t, f) in &qtf {
            let w = f * idf(t);
            qv.push((*t, w));
            qnorm_sq += w * w;
        }
        let qnorm = if qnorm_sq.sqrt() == 0.0 { 1.0 } else { qnorm_sq.sqrt() };
        let mut lex: Vec<f64> = Vec::with_capacity(chunk_refs.len());
        for (_, _, c) in &chunk_refs {
            // Document norm: allocation-free fold over the chunk's own terms
            // (was a full HashMap<String,f64> clone-and-insert per chunk).
            let mut dnorm_sq = 0.0;
            for (t, f) in &c.tf {
                let w = f * idf(t);
                dnorm_sq += w * w;
            }
            let dnorm = if dnorm_sq.sqrt() == 0.0 { 1.0 } else { dnorm_sq.sqrt() };
            // Dot product touches only the query's ~few terms, looked up in the
            // chunk — not a full document vector. dv[t] was c.tf[t]*idf(t) or 0.
            let mut dot = 0.0;
            for (t, qw) in &qv {
                if let Some(f) = c.tf.get(*t) {
                    dot += qw * (f * idf(*t));
                }
            }
            lex.push(dot / (qnorm * dnorm));
        }
        // Hybrid search (B2): when the local embedding server is up and the
        // scored chunks have current vectors, replace the raw lexical scores
        // with RRF-fused lexical+vector scores. None ⇒ exactly today's path.
        let chunk_meta: Vec<(String, String, usize)> = {
            let mut ord: HashMap<&str, usize> = HashMap::new();
            chunk_refs
                .iter()
                .map(|(id, entry, _)| {
                    let o = ord.entry(id).or_insert(0);
                    let meta = (id.to_string(), entry.key.clone(), *o);
                    *o += 1;
                    meta
                })
                .collect()
        };
        let base = crate::embed::hybrid_scores(query, &chunk_meta, &lex).unwrap_or(lex);
        for (i, (file_id, entry, c)) in chunk_refs.iter().enumerate() {
            let mut score = base[i];
            // Nudge a chunk up when its file also matches by name.
            let (hits, strong) = name_match(&qtokens, &entry.name_tokens);
            if strong {
                score += 0.2 * (hits as f64 / qtokens.len() as f64);
            }
            scored.push(Scored {
                file_id,
                name: entry.name.as_str(),
                text: c.text.as_str(),
                score,
            });
        }
    }

    // Merged candidates: scored content chunks, plus a synthetic entry for any
    // file that matches by name but isn't already represented by its content.
    struct Cand {
        file_id: String,
        name: String,
        text: String,
        score: f64,
    }
    let mut cands: Vec<Cand> = scored
        .iter()
        .filter(|s| s.score > 0.0)
        .map(|s| Cand {
            file_id: s.file_id.to_string(),
            name: s.name.to_string(),
            text: s.text.to_string(),
            score: s.score,
        })
        .collect();
    let present: HashSet<String> = cands.iter().map(|c| c.file_id.clone()).collect();
    for item in &items {
        if present.contains(&item.id) {
            continue;
        }
        let Some(entry) = entries.get(&item.id) else {
            continue;
        };
        let (hits, strong) = name_match(&qtokens, &entry.name_tokens);
        if hits == 0 || !strong {
            continue;
        }
        let pv = entry.preview.clone();
        cands.push(Cand {
            file_id: item.id.clone(),
            name: item.name.clone(),
            text: if pv.is_empty() {
                "(matched by file name; no readable text could be extracted)".to_string()
            } else {
                pv
            },
            score: 0.5 + 0.4 * (hits as f64 / qtokens.len() as f64), // 0.5..0.9
        });
    }

    // G6 recall cue: a "what did I ask/conclude about X" question biases toward
    // past-conversation notes so synthesis draws on them. Deterministic — it only
    // scales existing conversation-kind candidates before the sort, never invents
    // a cand and never asks the model to rank. Runs on every retrieve pass (both
    // the initial k and the wide pass) since it's inside `retrieve`.
    //
    // Investigation preference (openspec: add-investigations): where the cue
    // boosts conversation notes, a note BELONGING to the ask's investigation
    // — its filename's [cid8] matches a preferred conversation id, the same
    // derivation write_conversation_note bracketed in — is lifted a further
    // INVESTIGATION_BOOST. Preference, not exclusion: global notes keep
    // their CONV_BOOST and still surface, ordered after.
    if crate::synth::recall_cue(query) {
        let preferred_cid8s: HashSet<String> = preferred_conversation_ids
            .iter()
            .map(|id| conversation_cid8(id))
            .collect();
        for c in &mut cands {
            if source_kind_of(&c.file_id) == crate::contracts::SourceKind::Conversation {
                c.score *= crate::synth::CONV_BOOST;
                if !preferred_cid8s.is_empty()
                    && note_cid8_of(&c.file_id)
                        .is_some_and(|cid| preferred_cid8s.contains(cid))
                {
                    c.score *= crate::synth::INVESTIGATION_BOOST;
                }
            }
        }
    }
    cands.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut top: Vec<&Cand> = cands.iter().take(k).collect();
    // Named-file guarantee: a question that strongly names a file MUST surface
    // that file. Before hybrid search this held by accident — name-matched
    // candidates (0.5–0.9) always beat lexical cosines (~0.05–0.3). RRF fused
    // scores fill the 0.9–1.0 band, so topically-similar chunks from OTHER
    // files can crowd the named file out of the top-k (0.6.0 field report:
    // "the file is not present in the provided context" — about a file named
    // verbatim in the question). Pin the best-named file's best candidate
    // into the last slot when ranking dropped it.
    let named = pinned_named_file(
        &qtokens,
        items.iter().filter_map(|item| {
            entries
                .get(&item.id)
                .map(|e| (item.id.as_str(), e.name_tokens.as_slice()))
        }),
    );
    if let Some(named_id) = named {
        if !top.iter().any(|c| c.file_id == named_id) {
            if let Some(best) = cands.iter().find(|c| c.file_id == named_id) {
                if top.len() >= k && !top.is_empty() {
                    top.pop();
                }
                top.push(best);
            }
        }
    }
    if top.is_empty() {
        return Retrieved {
            references: vec![],
            contexts: vec![],
        };
    }

    let max = if top[0].score == 0.0 {
        1.0
    } else {
        top[0].score
    };
    // One reference per file (best chunk), but keep all top chunks as context.
    let mut seen: HashSet<&str> = HashSet::new();
    let mut references: Vec<RagReference> = Vec::new();
    for c in &top {
        if seen.contains(c.file_id.as_str()) {
            continue;
        }
        seen.insert(&c.file_id);
        let snippet: String = c.text.chars().take(240).collect();
        let truncated = c.text.chars().count() > 240;
        references.push(RagReference {
            file_id: c.file_id.clone(),
            name: c.name.clone(),
            snippet: format!("{}{}", snippet.trim(), if truncated { "…" } else { "" }),
            score: (c.score / max).min(1.0),
            kind: source_kind_of(&c.file_id),
        });
    }
    let contexts: Vec<Context> = top
        .iter()
        .map(|c| Context {
            name: c.name.clone(),
            text: c.text.clone(),
            score: (c.score / max).min(1.0),
            kind: source_kind_of(&c.file_id),
        })
        .collect();
    Retrieved {
        references,
        contexts,
    }
}

/// A file's display name + extracted text, for the synthesis pipeline
/// (crate::synth): table profiles need the full content; `preview_chars`
/// bounds the map-step fallback used when a query's tokens miss the file.
/// Mirrors src/server/vault.ts::docText.
pub fn doc_text(file_id: &str, preview_chars: Option<usize>) -> Option<(String, String)> {
    const DOC_TEXT_CAP: u64 = 4 * 1024 * 1024;
    let node = walk(&vault_dir())
        .iter()
        .find(|n| n.kind == NodeKind::File && n.id == file_id)
        .cloned()?;
    let state = load_state();
    let abs = resolve_abs(file_id, &state).ok()?;
    let text = read_text_abs_capped(&abs, DOC_TEXT_CAP);
    if text.trim().is_empty() {
        return None;
    }
    let text = match preview_chars {
        Some(n) => text.chars().take(n).collect(),
        None => text,
    };
    Some((node.name, text))
}

/// The single INCLUDED vault file the question NAMES, if any — the synth
/// pipeline's single-document-focus detector. Same conservative matcher as
/// the in-retrieve named pin (ambiguity ⇒ None), over the same
/// `name_tokens_of` tokens. Mirrors src/server/vault.ts::namedFileTarget.
pub fn named_file_target(
    question: &str,
    included_file_ids: &[String],
) -> Option<(String, String)> {
    let qtokens = tokenize(question);
    if qtokens.is_empty() {
        return None;
    }
    let included: HashSet<&String> = included_file_ids.iter().collect();
    let nodes = walk(&vault_dir());
    let files: Vec<(String, String, Vec<String>)> = nodes
        .iter()
        .filter(|n| n.kind == NodeKind::File && included.contains(&n.id))
        .map(|n| (n.id.clone(), n.name.clone(), name_tokens_of(&n.id, &n.name)))
        .collect();
    let id = pinned_named_file(
        &qtokens,
        files.iter().map(|(id, _, t)| (id.as_str(), t.as_slice())),
    )?;
    files
        .iter()
        .find(|(fid, _, _)| fid == id)
        .map(|(fid, name, _)| (fid.clone(), name.clone()))
}

/// A document's display name + ORDERED chunk texts — the same byte-identical
/// chunker the index uses — for whole-document coverage in the synth
/// pipeline (doc-focus). None when the file is missing or extracts empty.
/// Mirrors src/server/vault.ts::docChunks.
pub fn doc_chunks(file_id: &str) -> Option<(String, Vec<String>)> {
    let (name, text) = doc_text(file_id, None)?;
    let chunks = chunk_texts_named(&name, &text);
    if chunks.is_empty() {
        return None;
    }
    Some((name, chunks))
}

/// Extension-ish tokens that don't count as "naming" a file in a question.
const EXT_TOKENS: &[&str] = &[
    "xlsx", "xlsm", "xls", "csv", "tsv", "pdf", "docx", "doc", "md", "txt", "parquet",
    "pptx", "json", "html", "log",
];

/// Vault files the question NAMES (every meaningful name token appears in the
/// question) that are NOT currently included. Feeds the deterministic
/// "it exists but the AI can't see it" note in the answer pipeline — without
/// it, asking about an excluded file gets a gaslighting "not present in the
/// provided context" (0.6.0 field report, verbatim file name in the question).
/// Returns display names, capped at 2.
pub fn named_but_excluded(question: &str) -> Vec<String> {
    let qtokens: Vec<String> = tokenize(question).iter().map(|t| singular(t).to_string()).collect();
    if qtokens.is_empty() {
        return Vec::new();
    }
    let active: HashSet<String> = active_included_file_ids().into_iter().collect();
    let mut out = Vec::new();
    for node in walk(&vault_dir()).iter() {
        if node.kind != NodeKind::File || active.contains(&node.id) {
            continue;
        }
        let meaningful: Vec<String> = tokenize(&node.name)
            .into_iter()
            .filter(|t| t.len() >= 3 && !EXT_TOKENS.contains(&t.as_str()))
            .collect();
        if meaningful.is_empty() || !meaningful.iter().any(|t| t.len() >= 4) {
            continue; // too generic to claim the question "named" it
        }
        let all_present = meaningful.iter().all(|nt0| {
            let nt = singular(nt0);
            qtokens.iter().any(|q| q == nt || q.contains(nt) || (q.len() >= 3 && nt.contains(q.as_str())))
        });
        if all_present {
            out.push(node.name.clone());
            if out.len() == 2 {
                break;
            }
        }
    }
    out
}

/// A file's display name + resolved absolute path, for the analytics engine
/// (crate::analytics) — csv/tsv/parquet register with DataFusion by real path.
pub fn doc_path(file_id: &str) -> Option<(String, PathBuf)> {
    let node = walk(&vault_dir())
        .iter()
        .find(|n| n.kind == NodeKind::File && n.id == file_id)
        .cloned()?;
    let state = load_state();
    let abs = resolve_abs(file_id, &state).ok()?;
    Some((node.name, abs))
}

#[cfg(test)]
mod named_pin_tests {
    use super::{name_tokens_of, pinned_named_file, tokenize};

    fn files(ids: &[&str]) -> Vec<(String, Vec<String>)> {
        ids.iter().map(|id| (id.to_string(), name_tokens_of(id, id))).collect()
    }

    fn pick<'a>(question: &str, fs: &'a [(String, Vec<String>)]) -> Option<&'a str> {
        let q = tokenize(question);
        pinned_named_file(&q, fs.iter().map(|(id, t)| (id.as_str(), t.as_slice())))
    }

    #[test]
    fn a_verbatim_name_pins() {
        let fs = files(&["1 Galaxy Servers.md", "meeting-notes-1.md", "recipes.md"]);
        assert_eq!(pick("what is inside 1 Galaxy Servers", &fs), Some("1 Galaxy Servers.md"));
    }

    /// 0.6.2 field report: right quotes, wrong recommended files — a lone
    /// generic token ("plan") shared with a filename must never force it in.
    #[test]
    fn a_lone_generic_token_never_pins() {
        let fs = files(&["plan.md", "roadmap.md"]);
        assert_eq!(pick("what is the plan for the rollout", &fs), None);
    }

    #[test]
    fn a_distinctive_single_token_name_still_pins() {
        let fs = files(&["resume.pdf", "recipes.md"]);
        assert_eq!(pick("can you summarize my resume", &fs), Some("resume.pdf"));
    }

    /// Same coverage signature across sibling files = a generic phrase, not
    /// a named file — nothing may be pinned arbitrarily.
    #[test]
    fn generic_siblings_tie_and_nothing_pins() {
        let fs = files(&["meeting-notes-1.md", "meeting-notes-2.md"]);
        assert_eq!(pick("what did the meeting notes say", &fs), None);
    }

    #[test]
    fn fuller_name_coverage_wins_over_partial() {
        let fs = files(&["galaxy servers rollout plan.md", "1 Galaxy Servers.md"]);
        assert_eq!(pick("what is inside 1 galaxy servers", &fs), Some("1 Galaxy Servers.md"));
    }
}

#[cfg(test)]
mod chunk_tests {
    use super::chunk_texts_named;

    /// PARITY FIXTURE — mirrored in test/chunker.test.mjs. 70 data rows chunk
    /// as 1-30 / 26-55 / 51-70, every chunk led by the header line.
    #[test]
    fn csv_rows_chunk_with_header_prepended() {
        let mut text = String::from("region,amount\n");
        for i in 1..=70 {
            text.push_str(&format!("r{i},{i}\n"));
        }
        let chunks = chunk_texts_named("sales.csv", &text);
        assert_eq!(chunks.len(), 3);
        for c in &chunks {
            assert!(c.starts_with("region,amount\n"), "{c}");
        }
        assert!(chunks[0].ends_with("r30,30"));
        assert!(chunks[1].contains("r26,26") && chunks[1].ends_with("r55,55"));
        assert!(chunks[2].contains("r51,51") && chunks[2].ends_with("r70,70"));
    }

    #[test]
    fn workbook_blocks_carry_sheet_and_header_lines() {
        let mut text = String::from("Sheet1\nh1,h2\na,1\nb,2\nc,3\n\nSheet2\nh1,h2\n");
        for i in 1..=40 {
            text.push_str(&format!("x{i},{i}\n"));
        }
        let chunks = chunk_texts_named("book.xlsx", &text);
        assert_eq!(chunks.len(), 3); // sheet1: 1 chunk · sheet2: rows 1-30, 26-40
        assert!(chunks[0].starts_with("Sheet1\nh1,h2\n"));
        assert!(chunks[1].starts_with("Sheet2\nh1,h2\n") && chunks[1].ends_with("x30,30"));
        assert!(chunks[2].starts_with("Sheet2\nh1,h2\n") && chunks[2].ends_with("x40,40"));
    }

    #[test]
    fn prose_keeps_word_windows() {
        let text = (1..=300).map(|i| format!("w{i}")).collect::<Vec<_>>().join(" ");
        let chunks = chunk_texts_named("notes.md", &text);
        assert_eq!(chunks.len(), 3); // 120-word windows, 95-word step
        assert!(chunks[0].starts_with("w1 ") && chunks[0].ends_with("w120"));
    }

    #[test]
    fn tabular_line_trailing_bom_is_trimmed_for_parity() {
        // A mid-file U+FEFF (BOM/ZWNBSP) at a line end: Rust's char::is_whitespace
        // doesn't strip it but JS `\s`/trim do, which would drift the twins. Both
        // now trim it, so the chunk equals the BOM-free version byte-for-byte.
        let with_bom = "region,amount\nNE,1\u{feff}\nNW,2\n";
        let plain = "region,amount\nNE,1\nNW,2\n";
        assert_eq!(chunk_texts_named("t.csv", with_bom), chunk_texts_named("t.csv", plain));
        assert!(!chunk_texts_named("t.csv", with_bom)[0].contains('\u{feff}'));
    }
}

#[cfg(test)]
mod rule_glob_tests {
    use super::{parse_rule_glob, rule_display_name, CurationRule};

    /// PARITY FIXTURE — mirrored in test/curationRules.test.mjs
    /// ("glob matcher parity table"): identical verdicts in both engines.
    fn matches(glob: &str, rel: &str) -> bool {
        let pat = parse_rule_glob(glob).expect("valid glob");
        let segs: Vec<&str> = rel.split('/').collect();
        super::glob_segments_match(&pat, &segs)
    }

    #[test]
    fn glob_matcher_table() {
        // Single-segment wildcards never cross `/`.
        assert!(matches("*.xlsx", "q1.xlsx"));
        assert!(!matches("*.xlsx", "2024/q1.xlsx"));
        assert!(matches("q?.csv", "q1.csv"));
        assert!(!matches("q?.csv", "q10.csv"));
        // `**` spans zero or more whole segments.
        assert!(matches("**/*.xlsx", "q1.xlsx"));
        assert!(matches("**/*.xlsx", "2024/deep/q1.xlsx"));
        assert!(matches("**", "anything/at/all.txt"));
        assert!(matches("2024/**/final.md", "2024/final.md"));
        assert!(matches("2024/**/final.md", "2024/a/b/final.md"));
        assert!(!matches("2024/**/final.md", "2023/final.md"));
        // Literal segments are exact (case-sensitive).
        assert!(matches("drafts/*", "drafts/x.md"));
        assert!(!matches("drafts/*", "Drafts/x.md"));
        // A backtracking-hostile pattern stays linear and correct.
        assert!(matches("*a*a*a*a", "aaaaaaaa"));
        assert!(!matches("*a*a*a*a", "bbbbbbbb"));
    }

    #[test]
    fn glob_validation_rejects_malformed_patterns() {
        assert!(parse_rule_glob("").is_err(), "empty");
        assert!(parse_rule_glob("  ").is_err(), "blank");
        assert!(parse_rule_glob("a\\b").is_err(), "backslash");
        assert!(parse_rule_glob("/lead").is_err(), "leading slash");
        assert!(parse_rule_glob("trail/").is_err(), "trailing slash");
        assert!(parse_rule_glob("a//b").is_err(), "empty segment");
        assert!(parse_rule_glob("a**b").is_err(), "** inside a segment");
        assert!(parse_rule_glob("**.xlsx").is_err(), "** glued to a suffix");
        assert!(parse_rule_glob("**/*.xlsx").is_ok(), "** alone is fine");
    }

    /// PARITY: byte-identical with vault.ts::ruleDisplayName (the node twin
    /// asserts the same strings).
    #[test]
    fn display_names_derive_from_predicate_and_scope() {
        let base = CurationRule {
            id: "r1".into(),
            scope: "reports".into(),
            kind: Some("tabular".into()),
            ext: None,
            glob: None,
            action: "include".into(),
        };
        assert_eq!(rule_display_name(&base), "spreadsheets in /reports");
        let ext = CurationRule {
            kind: None,
            ext: Some(vec!["xlsx".into(), "csv".into()]),
            scope: String::new(),
            ..base.clone()
        };
        assert_eq!(rule_display_name(&ext), ".xlsx/.csv files in the vault");
        let glob = CurationRule {
            kind: None,
            glob: Some("**/*.png".into()),
            scope: "design/assets".into(),
            ..base.clone()
        };
        assert_eq!(rule_display_name(&glob), "files matching **/*.png in /design/assets");
    }
}
