//! Investigations: named, durable containers for analysis
//! (openspec: add-investigations).
//!
//! An investigation persists STRUCTURE only — id, display name, creation
//! time, archive flag, scope file ids, provider policy, and opaque client
//! conversation ids. Pin and note membership are deliberately DERIVED at
//! read time (pins carry `investigationId`; notes live under the
//! investigation's folder), never duplicated on the record — no two-way
//! bookkeeping to drift. Transcripts never touch the engine; a conversation
//! ref is an id the client minted, nothing more.
//!
//! Versioning posture (user data, not a cache): the store is a versioned
//! envelope `{v: 1, investigations: [...]}` in `state_dir()`. `v == 1`
//! loads; an unknown or missing version — or unparseable JSON — loads EMPTY
//! for the session, and the first subsequent write renames the unreadable
//! file to `investigations.json.bak-<epochms>` before writing a fresh v1
//! envelope. Nothing is silently clobbered; a downgrade leaves the newer
//! file recoverable on disk.
//!
//! The dev server twin (src/server/investigations.ts, KEEP IN SYNC) mirrors
//! this module byte-compatibly: same envelope, same validation, same
//! history-posture gate on conversation refs (PARITY).

use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};

use crate::config::{now_ms, state_dir, write_json};
use crate::llm::ModelCfg;

/// Envelope version this engine reads and writes.
const STORE_VERSION: u32 = 1;

/// Serializes load-modify-save on the store (mirrors pins' STORE_LOCK).
fn store_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|p| p.into_inner())
}

/// Provider posture for every ask inside the investigation: `LocalOnly`
/// forces the private path at the model-config chokepoint (§2 wires it);
/// `Default` follows the profile's active provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderPolicy {
    #[default]
    Default,
    LocalOnly,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Investigation {
    /// Engine-minted, stable (pins-style sha, see `investigation_id`):
    /// `inv-` + first 12 hex chars of sha1(name + createdMs). NOT derived
    /// from the current name — rename keeps the id, and re-creating a
    /// same-named investigation later mints a fresh one.
    pub id: String,
    /// Display name, unique case-insensitively across the store — archived
    /// records included, so unarchiving can never surface a collision.
    pub name: String,
    pub created_ms: i64,
    /// Archive hides, never deletes: a visibility flag with no cascade.
    #[serde(default)]
    pub archived: bool,
    /// Vault node ids; empty = whole vault. Dangling ids (files deleted
    /// since scoping) are harmless — candidate selection ignores unknown
    /// ids (§2).
    #[serde(default)]
    pub scope_file_ids: Vec<String>,
    #[serde(default)]
    pub provider_policy: ProviderPolicy,
    /// Opaque client `Conversation.id` values — refs, never transcripts.
    #[serde(default)]
    pub conversation_refs: Vec<String>,
    /// Folder name for exported notes, sanitized (traversal-safe) at
    /// CREATION time and never moved by rename — membership = location (§3
    /// derives note refs from it and routes `exportChat` under it; §1 only
    /// records it).
    pub folder_name: String,
}

/// Read-time enriched view the `investigations` op returns: the record plus
/// DERIVED memberships (§3) — `pinRefs` from pins.json (the ids of pins
/// carrying `Pin.investigationId == id`), `noteRefs` from the investigation's
/// folder under `Lighthouse Notes/` (a prefix scan of the walk: membership =
/// location). Nothing here is stored on the record — no two-way bookkeeping
/// to drift.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvestigationView {
    #[serde(flatten)]
    pub record: Investigation,
    pub pin_refs: Vec<String>,
    pub note_refs: Vec<String>,
}

fn investigations_path() -> PathBuf {
    state_dir().join("investigations.json")
}

#[derive(Serialize, Deserialize)]
struct Store {
    v: u32,
    investigations: Vec<Investigation>,
}

/// A readable v1 envelope's records, or `None` when the text is not one
/// (unknown/missing version, or unparseable JSON — the two read identically,
/// see design.md's versioning posture). PARITY: the TS twin trusts the
/// records array wholesale once the envelope checks pass; here serde also
/// rejects records with malformed required fields — engine-written files
/// always carry every field, so the twins agree on every file they write.
fn parse_store(text: &str) -> Option<Vec<Investigation>> {
    match serde_json::from_str::<Store>(text) {
        Ok(s) if s.v == STORE_VERSION => Some(s.investigations),
        _ => None,
    }
}

enum Loaded {
    Records(Vec<Investigation>),
    Missing,
    /// Present but not a readable v1 envelope — reads empty for the session;
    /// the next write baks the file first (never clobber silently).
    Unreadable,
}

fn load() -> Loaded {
    match std::fs::read_to_string(investigations_path()) {
        Ok(text) => match parse_store(&text) {
            Some(records) => Loaded::Records(records),
            None => Loaded::Unreadable,
        },
        Err(_) => Loaded::Missing,
    }
}

/// All investigations, creation order. A missing store reads empty; an
/// unreadable one reads empty FOR THE SESSION (see `save`'s bak-on-write).
/// Archived records are included — the caller filters (archive hides in the
/// nav, never in the store).
pub fn list() -> Vec<Investigation> {
    match load() {
        Loaded::Records(records) => records,
        _ => Vec::new(),
    }
}

/// Enrich one record for the wire (§3): memberships are DERIVED at read
/// time, never stored. `pinRefs` = ids of pins whose `investigationId` is
/// this record's id (pins.json is the source of truth, oldest first);
/// `noteRefs` = file ids under `Lighthouse Notes/<folderName>/` (a prefix
/// scan of the cached walk — membership = location, so a note moved out of
/// the folder simply stops being a member). An unusable stored folder name
/// (tampered store) derives NO notes rather than scanning a wrong prefix.
/// PARITY: investigations.ts::investigationView.
pub fn view(record: Investigation) -> InvestigationView {
    let pin_refs = crate::pins::list()
        .into_iter()
        .filter(|p| p.investigation_id.as_deref() == Some(record.id.as_str()))
        .map(|p| p.id)
        .collect();
    let note_refs = match notes_folder_segment(&record) {
        Some(folder) => {
            let prefix = format!("Lighthouse Notes/{folder}/");
            crate::vault::list_nodes()
                .into_iter()
                .filter(|n| {
                    n.kind == crate::contracts::NodeKind::File && n.id.starts_with(&prefix)
                })
                .map(|n| n.id)
                .collect()
        }
        None => Vec::new(),
    };
    InvestigationView {
        record,
        pin_refs,
        note_refs,
    }
}

/// Every record, enriched for the `{op:"investigations", action:"list"}` op.
pub fn listing() -> Vec<InvestigationView> {
    list().into_iter().map(view).collect()
}

fn save(records: &[Investigation]) {
    let path = investigations_path();
    // Versioning posture: an unreadable file (unknown/missing version,
    // corrupt JSON) is preserved as a `.bak-<epochms>` sibling before the
    // fresh v1 write — a downgrade or corruption never silently clobbers
    // newer data. Rename, falling back to copy, both best-effort.
    if matches!(load(), Loaded::Unreadable) {
        let bak = path.with_file_name(format!("investigations.json.bak-{}", now_ms()));
        if std::fs::rename(&path, &bak).is_err() {
            let _ = std::fs::copy(&path, &bak);
        }
    }
    write_json(
        &path,
        &Store {
            v: STORE_VERSION,
            investigations: records.to_vec(),
        },
    );
}

/// Traversal-safe folder name from a display name: path separators (`/`,
/// `\`) stripped, whitespace runs collapsed to single spaces, and a name
/// that is empty or only dots after that (`.`, `..`, `...`) falls back to
/// "Investigation" — the result can never name a parent or nest directories.
fn sanitize_folder_name(name: &str) -> String {
    let stripped: String = name.chars().filter(|c| !matches!(c, '/' | '\\')).collect();
    let collapsed = stripped.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() || collapsed.chars().all(|c| c == '.') {
        "Investigation".to_string()
    } else {
        collapsed
    }
}

/// The record's notes-folder SEGMENT, re-validated AT USE (§3): §1's
/// sanitizer guarantees a safe single segment at creation, but the store is
/// a file on disk — a hand-edited `folderName` must not become a write path.
/// `None` when the stored value is unusable: empty, multi-segment (any `/`
/// or `\`), dots-only (`.`/`..`), or the reserved G6 `Chats` segment
/// (case-insensitive) — `Lighthouse Notes/Chats/` means auto-exported
/// conversation notes (recall classifies by that prefix and the save-chats
/// opt-out purges the whole folder), and an investigation folder must never
/// alias it. PARITY: investigations.ts::notesFolderSegment.
fn notes_folder_segment(record: &Investigation) -> Option<String> {
    let folder = record.folder_name.trim();
    if folder.is_empty()
        || folder.contains('/')
        || folder.contains('\\')
        || folder.chars().all(|c| c == '.')
        || folder.eq_ignore_ascii_case("chats")
    {
        return None;
    }
    Some(folder.to_string())
}

/// Resolve the `exportChat` destination for an investigation (§3):
/// `Lighthouse Notes/<stored folderName>` — the ONLY way a note reaches an
/// investigation subfolder. The folder is resolved ENGINE-SIDE from the
/// store, never taken from the client, and the segment is re-validated at
/// use (see `notes_folder_segment`), so the write-artifact allowlist extends
/// to exactly the folders of known investigations and nothing else. Errors
/// are human-readable and byte-identical to the TS twin
/// (investigations.ts::investigationNotesSubdir).
pub fn notes_subdir(investigation_id: &str) -> Result<String, String> {
    let id = investigation_id.trim();
    let record = list()
        .into_iter()
        .find(|r| r.id == id)
        .ok_or_else(|| "investigation not found".to_string())?;
    let folder = notes_folder_segment(&record)
        .ok_or_else(|| "investigation folder name is not usable".to_string())?;
    Ok(format!("Lighthouse Notes/{folder}"))
}

/// Stable engine-minted id (pins-style sha, like `pin_id`): `inv-` + first
/// 12 hex chars of sha1(name + createdMs). Deterministic for a given
/// (name, creation instant) and independent of later renames.
fn investigation_id(name: &str, created_ms: i64) -> String {
    let digest = Sha1::digest(format!("{name}{created_ms}").as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("inv-{}", &hex[..12])
}

/// Case-insensitive name collision test, optionally excluding one record
/// (rename may keep — or case-change — its own name).
fn name_taken(records: &[Investigation], name: &str, excluding_id: Option<&str>) -> bool {
    let wanted = name.to_lowercase();
    records
        .iter()
        .any(|r| excluding_id != Some(r.id.as_str()) && r.name.to_lowercase() == wanted)
}

/// Create an investigation. The name must be non-empty and unique
/// case-insensitively (archived records count); empty scope means the whole
/// vault. The notes folder name is fixed HERE, at creation — rename never
/// moves notes. Fails with a human-readable reason.
pub fn create(
    name: &str,
    scope_file_ids: &[String],
    provider_policy: ProviderPolicy,
) -> Result<Investigation, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("an investigation needs a name".to_string());
    }
    let _guard = store_lock();
    let mut records = list();
    if name_taken(&records, name, None) {
        return Err(format!("an investigation named \"{name}\" already exists"));
    }
    let created_ms = now_ms();
    let inv = Investigation {
        id: investigation_id(name, created_ms),
        name: name.to_string(),
        created_ms,
        archived: false,
        // Keep scope ids as given (dangling ids are fine downstream), minus
        // empty-string noise.
        scope_file_ids: scope_file_ids
            .iter()
            .filter(|s| !s.trim().is_empty())
            .cloned()
            .collect(),
        provider_policy,
        conversation_refs: Vec::new(),
        folder_name: sanitize_folder_name(name),
    };
    records.push(inv.clone());
    save(&records);
    Ok(inv)
}

/// Rename in place — same uniqueness rule as `create` (a case change of the
/// record's own name is allowed). `folderName` is deliberately UNCHANGED:
/// membership = location, and rename moves nothing (design.md).
pub fn rename(id: &str, new_name: &str) -> Result<Investigation, String> {
    let new_name = new_name.trim();
    if new_name.is_empty() {
        return Err("an investigation needs a name".to_string());
    }
    let _guard = store_lock();
    let mut records = list();
    if name_taken(&records, new_name, Some(id)) {
        return Err(format!(
            "an investigation named \"{new_name}\" already exists"
        ));
    }
    let Some(idx) = records.iter().position(|r| r.id == id) else {
        return Err("investigation not found".to_string());
    };
    records[idx].name = new_name.to_string();
    save(&records);
    Ok(records[idx].clone())
}

/// Set the archive flag — a visibility toggle ONLY. Nothing cascades:
/// pins, notes, scope, and conversation refs stay on disk untouched, and
/// unarchiving restores the investigation fully.
pub fn set_archived(id: &str, archived: bool) -> Result<Investigation, String> {
    let _guard = store_lock();
    let mut records = list();
    let Some(idx) = records.iter().position(|r| r.id == id) else {
        return Err("investigation not found".to_string());
    };
    records[idx].archived = archived;
    save(&records);
    Ok(records[idx].clone())
}

/// Record a conversation ref (an opaque client `Conversation.id`). History
/// posture WINS (design.md): the write happens only when the client's
/// `persistAllowed` verdict is true AND the managed policy allows history —
/// either false ⇒ a silent no-op returning the record unchanged, while
/// structure fields (name, scope, policy, archived) persist regardless.
/// Refs dedupe. `&&` short-circuits, so with `persistAllowed` false the
/// policy layer is never even consulted — the same fail-toward-privacy
/// default as the ask path's cache controls.
pub fn add_conversation_ref(
    id: &str,
    conversation_id: &str,
    persist_allowed: bool,
) -> Result<Investigation, String> {
    let conversation_id = conversation_id.trim();
    if conversation_id.is_empty() {
        return Err("conversationId required".to_string());
    }
    let _guard = store_lock();
    let mut records = list();
    let Some(idx) = records.iter().position(|r| r.id == id) else {
        return Err("investigation not found".to_string());
    };
    if !(persist_allowed && crate::policy::history_allowed()) {
        return Ok(records[idx].clone()); // silent no-op — posture wins
    }
    if !records[idx]
        .conversation_refs
        .iter()
        .any(|c| c == conversation_id)
    {
        records[idx]
            .conversation_refs
            .push(conversation_id.to_string());
        save(&records);
    }
    Ok(records[idx].clone())
}

// --- Fork + export (openspec: add-automation §4) ----------------------------

/// Fork an investigation into a fresh line of inquiry. Under `store_lock`,
/// load the parent and mint a FRESH record — new `created_ms`, new
/// `investigation_id(new_name, created_ms)`, new `sanitize_folder_name`
/// (its own id and its own EMPTY notes folder) — copying ONLY the parent's
/// STRUCTURE: `scope_file_ids`, `provider_policy` (a fork of a `local-only`
/// line stays `local-only`), and `conversation_refs`. Derived membership is
/// DELIBERATELY not duplicated (investigations.rs:4-10): pins carry a single
/// `investigationId` and notes live in ONE folder (membership = location), so
/// a fork is a new line seeded with the parent's scope + conversation context,
/// never a clone of another investigation's members. `new_name` is trimmed,
/// non-empty, and unique case-insensitively (archived records count) — the
/// `create` rule; the fork is NOT archived. Fails with a human-readable
/// reason (blank/duplicate name, missing parent) and persists nothing on
/// failure. PARITY: investigations.ts::forkInvestigation.
pub fn fork(id: &str, new_name: &str) -> Result<Investigation, String> {
    let new_name = new_name.trim();
    if new_name.is_empty() {
        return Err("an investigation needs a name".to_string());
    }
    let _guard = store_lock();
    let mut records = list();
    let Some(parent) = records.iter().find(|r| r.id == id) else {
        return Err("investigation not found".to_string());
    };
    // Snapshot the structure to copy before `records` is mutated below.
    let scope_file_ids = parent.scope_file_ids.clone();
    let provider_policy = parent.provider_policy;
    let conversation_refs = parent.conversation_refs.clone();
    if name_taken(&records, new_name, None) {
        return Err(format!("an investigation named \"{new_name}\" already exists"));
    }
    let created_ms = now_ms();
    let inv = Investigation {
        id: investigation_id(new_name, created_ms),
        name: new_name.to_string(),
        created_ms,
        archived: false,
        // Structure only — the parent's scope, policy, and conversation
        // context seed the branch; derived membership (pins/notes) is NOT
        // duplicated (investigations.rs:4-10).
        scope_file_ids,
        provider_policy,
        conversation_refs,
        folder_name: sanitize_folder_name(new_name),
    };
    records.push(inv.clone());
    save(&records);
    Ok(inv)
}

/// Render an investigation to a standalone markdown document — the exportable
/// artifact, reusing the `briefings::render_markdown` idiom (`# title`, then
/// `## ` sections). The document states the investigation's STRUCTURE and
/// DERIVED membership: name, created time (UTC), archive state, provider
/// policy, scope files (or "whole vault" when empty), conversation refs, the
/// derived pin list, and the derived note list. Conversation refs render by
/// their opaque id — `title (id)` only when the optional `titles` map supplies
/// a non-empty one — and NO transcript text is ever embedded, because the
/// engine deliberately never stores transcripts (investigations.rs:9-10): a
/// ref is a pointer, not content. `Err` when the id is unknown; nothing is
/// written (this is a PURE render — the WRITE composes `notes_subdir` +
/// `vault::write_artifact` at the op). KEEP BYTE-IDENTICAL with
/// investigations.ts::exportMarkdown.
pub fn export_markdown(
    id: &str,
    titles: Option<&HashMap<String, String>>,
) -> Result<String, String> {
    let record = list()
        .into_iter()
        .find(|r| r.id == id.trim())
        .ok_or_else(|| "investigation not found".to_string())?;
    Ok(render_investigation_markdown(&view(record), titles))
}

/// The byte-pinned render literal (twinned in investigations.ts). Kept pure
/// (takes an already-derived `InvestigationView`) so the render is testable
/// without a store and stays byte-identical across the engines.
fn render_investigation_markdown(
    view: &InvestigationView,
    titles: Option<&HashMap<String, String>>,
) -> String {
    let record = &view.record;
    let created = chrono::DateTime::from_timestamp_millis(record.created_ms)
        .map(|d| d.format("%Y-%m-%d %H:%M UTC").to_string())
        .unwrap_or_default();
    let status = if record.archived { "Archived" } else { "Active" };
    let policy = match record.provider_policy {
        ProviderPolicy::Default => "default",
        ProviderPolicy::LocalOnly => "local-only",
    };

    let mut out = format!("# {}\n", record.name);
    out.push_str(&format!(
        "\n- Created: {created}\n- Status: {status}\n- Provider policy: {policy}\n"
    ));

    out.push_str("\n## Scope\n\n");
    if record.scope_file_ids.is_empty() {
        out.push_str("- Whole vault\n");
    } else {
        for f in &record.scope_file_ids {
            out.push_str(&format!("- {f}\n"));
        }
    }

    out.push_str("\n## Conversations\n\n");
    if record.conversation_refs.is_empty() {
        out.push_str("_No conversations._\n");
    } else {
        for c in &record.conversation_refs {
            match titles.and_then(|m| m.get(c)).filter(|t| !t.is_empty()) {
                Some(t) => out.push_str(&format!("- {t} ({c})\n")),
                None => out.push_str(&format!("- {c}\n")),
            }
        }
    }

    out.push_str("\n## Pins\n\n");
    if view.pin_refs.is_empty() {
        out.push_str("_No pins._\n");
    } else {
        for p in &view.pin_refs {
            out.push_str(&format!("- {p}\n"));
        }
    }

    out.push_str("\n## Notes\n\n");
    if view.note_refs.is_empty() {
        out.push_str("_No notes._\n");
    } else {
        for n in &view.note_refs {
            out.push_str(&format!("- {n}\n"));
        }
    }

    out
}

// --- Ask-context resolution (§2) --------------------------------------------

/// The pure scope + policy decision for one ask, over an already-loaded
/// record. PARITY: investigations.ts::resolveScopeAndPolicy — identical
/// precedence, tested identically in both engines.
///
/// - No record (`investigationId` absent, or naming nothing in the store) →
///   passthrough: the request's attachments, no forced-local.
/// - Request attachments non-empty → **they win** (most-specific-wins, the
///   same precedence philosophy as curation rules); scope is NOT intersected.
/// - Scope non-empty and request attachments empty → attachments := scope,
///   passed through UNFILTERED — dangling ids (files deleted since scoping)
///   are harmless because downstream candidate selection ignores unknown ids
///   and the skip-note honesty machinery counts drops.
/// - An empty scope resolves to empty attachments — the whole vault, exactly
///   as an attachment-less ask does today.
/// - Archived records resolve like live ones (asking inside an archived
///   investigation is allowed; archive only hides it from the nav).
/// - `local-only` policy → `force_local` true, regardless of how the
///   attachments resolved.
pub fn resolve_scope_and_policy(
    record: Option<&Investigation>,
    attachment_file_ids: Vec<String>,
) -> (Vec<String>, bool) {
    let Some(record) = record else {
        return (attachment_file_ids, false);
    };
    let attachments = if attachment_file_ids.is_empty() {
        record.scope_file_ids.clone()
    } else {
        attachment_file_ids
    };
    (
        attachments,
        record.provider_policy == ProviderPolicy::LocalOnly,
    )
}

/// Resolve an ask's effective attachments + model config + recall
/// preference. Entry points call this at the SAME chokepoint where
/// `profile::model_config()` is consulted today — the identical depth at
/// which the managed policy layer participates in provider resolution
/// (`model_config()` → llm-time `provider_allowed`). A `local-only`
/// investigation swaps the resolved config to the local provider HERE,
/// before the pipeline ever sees it: no cloud transport is constructed,
/// `origin_of(cfg)` reports "device" and `is_cloud_provider` false (the
/// provenance stamp is accurate with no further code), and
/// local-only-marked files stay readable (the private model may read them).
/// The llm-layer `provider_allowed` belt stays untouched beneath; managed
/// `forceLocalOnly` composes — most-restrictive wins because both act on the
/// same cfg.
///
/// The third element (§3) is the investigation's `conversationRefs`, for the
/// pipeline's recall preference: where a recall cue boosts conversation
/// notes, notes belonging to these conversations get `INVESTIGATION_BOOST`
/// on top — preference, not exclusion. Empty when no (or an unknown)
/// investigation rides the ask. Callers: routes.rs `chat_post`, commands.rs
/// `chat_ask` (PARITY: investigations.ts::resolveAskContext ⇄
/// app/api/chat/route.ts).
pub fn resolve_ask_context(
    investigation_id: Option<&str>,
    attachment_file_ids: Vec<String>,
    cfg: ModelCfg,
) -> (Vec<String>, ModelCfg, Vec<String>) {
    let record = investigation_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .and_then(|id| list().into_iter().find(|r| r.id == id));
    let preferred_conversation_ids = record
        .as_ref()
        .map(|r| r.conversation_refs.clone())
        .unwrap_or_default();
    let (attachments, force_local) = resolve_scope_and_policy(record.as_ref(), attachment_file_ids);
    let cfg = if force_local {
        crate::profile::local_model_config()
    } else {
        cfg
    };
    (attachments, cfg, preferred_conversation_ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Pure-function tests only, like pins.rs — the store scenarios (round
    // trip, bak-on-write, history gate, duplicates, archive) live in
    // tests/investigations_test.rs where VAULT_DIR mutation is serialized by
    // the shared env lock (matching pins' test location).

    #[test]
    fn folder_names_are_traversal_safe() {
        assert_eq!(sanitize_folder_name("Q3 audit"), "Q3 audit");
        assert_eq!(sanitize_folder_name("  a   lot\tof   space  "), "a lot of space");
        // Separators are stripped, not split — no nesting, no parent hops.
        assert_eq!(sanitize_folder_name("up/../and\\down"), "up..anddown");
        assert_eq!(sanitize_folder_name("v1.2 notes"), "v1.2 notes");
        // Dots-only (or empty-after-strip) names can't survive as segments.
        assert_eq!(sanitize_folder_name(".."), "Investigation");
        assert_eq!(sanitize_folder_name("..."), "Investigation");
        assert_eq!(sanitize_folder_name(" . "), "Investigation");
        assert_eq!(sanitize_folder_name("///"), "Investigation");
        assert_eq!(sanitize_folder_name(""), "Investigation");
    }

    // PARITY: test/investigations.test.mjs mirrors this validate-at-use table.
    #[test]
    fn notes_folder_segments_are_revalidated_at_use() {
        let with_folder = |folder: &str| Investigation {
            id: "inv-test".into(),
            name: "T".into(),
            created_ms: 1,
            archived: false,
            scope_file_ids: Vec::new(),
            provider_policy: ProviderPolicy::Default,
            conversation_refs: Vec::new(),
            folder_name: folder.into(),
        };
        // Sanitizer-shaped names pass through.
        assert_eq!(
            notes_folder_segment(&with_folder("Q3 audit")).as_deref(),
            Some("Q3 audit")
        );
        assert_eq!(
            notes_folder_segment(&with_folder("v1.2 notes")).as_deref(),
            Some("v1.2 notes")
        );
        // A tampered store never becomes a write path: multi-segment,
        // dots-only, empty — all unusable.
        for bad in ["../evil", "a/b", "a\\b", "..", ".", "", "   "] {
            assert_eq!(notes_folder_segment(&with_folder(bad)), None, "{bad:?}");
        }
        // The G6 conversation-notes folder is reserved (case-insensitive):
        // recall classifies by that prefix and the save-chats opt-out purges
        // it wholesale — an investigation folder must never alias it.
        for reserved in ["Chats", "chats", "CHATS"] {
            assert_eq!(
                notes_folder_segment(&with_folder(reserved)),
                None,
                "{reserved:?}"
            );
        }
    }

    // PARITY: test/investigations.test.mjs mirrors this render literal
    // byte-for-byte (a hand-written store yields the identical markdown).
    #[test]
    fn export_render_is_byte_stable_and_references_not_transcripts() {
        // A fixed instant so the created line is deterministic (1_784_106_180_000
        // ms = 2026-07-15 09:03 UTC, the briefings-note fixture instant).
        let view = InvestigationView {
            record: Investigation {
                id: "inv-branch".into(),
                name: "Harbor branch".into(),
                created_ms: 1_784_106_180_000,
                archived: false,
                scope_file_ids: vec!["cases/a.md".into(), "cases/b.md".into()],
                provider_policy: ProviderPolicy::LocalOnly,
                conversation_refs: vec!["conv-1".into(), "conv-2".into()],
                folder_name: "Harbor branch".into(),
            },
            pin_refs: Vec::new(),
            note_refs: Vec::new(),
        };
        let expected = "# Harbor branch\n\n- Created: 2026-07-15 09:03 UTC\n- Status: Active\n- Provider policy: local-only\n\n## Scope\n\n- cases/a.md\n- cases/b.md\n\n## Conversations\n\n- conv-1\n- conv-2\n\n## Pins\n\n_No pins._\n\n## Notes\n\n_No notes._\n";
        assert_eq!(render_investigation_markdown(&view, None), expected);

        // A caller-supplied title map only adds legibility (`title (id)`); an
        // absent or empty entry still renders the bare id. No transcript text.
        let mut titles = HashMap::new();
        titles.insert("conv-1".to_string(), "Kickoff".to_string());
        titles.insert("conv-2".to_string(), String::new()); // empty ⇒ bare id
        let md = render_investigation_markdown(&view, Some(&titles));
        assert!(md.contains("\n## Conversations\n\n- Kickoff (conv-1)\n- conv-2\n"), "{md}");
    }

    #[test]
    fn ids_are_stable_per_name_and_instant() {
        assert_eq!(investigation_id("Q3", 42), investigation_id("Q3", 42));
        assert_ne!(investigation_id("Q3", 42), investigation_id("Q3", 43));
        assert_ne!(investigation_id("Q3", 42), investigation_id("Q4", 42));
        assert!(investigation_id("Q3", 42).starts_with("inv-"));
        assert_eq!(investigation_id("Q3", 42).len(), "inv-".len() + 12);
    }

    #[test]
    fn only_v1_envelopes_parse() {
        // A written envelope round-trips.
        let store = Store {
            v: STORE_VERSION,
            investigations: vec![Investigation {
                id: "inv-abc".into(),
                name: "Q3 audit".into(),
                created_ms: 7,
                archived: false,
                scope_file_ids: vec!["a.csv".into()],
                provider_policy: ProviderPolicy::LocalOnly,
                conversation_refs: Vec::new(),
                folder_name: "Q3 audit".into(),
            }],
        };
        let text = serde_json::to_string_pretty(&store).unwrap();
        assert!(text.contains("\"providerPolicy\": \"local-only\""), "{text}");
        let records = parse_store(&text).expect("v1 loads");
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].name, "Q3 audit");

        // Anything else reads as unreadable (None): unknown version, missing
        // version, corrupt JSON — the bak-on-write posture treats them alike.
        assert!(parse_store(r#"{"v":99,"investigations":[]}"#).is_none());
        assert!(parse_store(r#"{"investigations":[]}"#).is_none());
        assert!(parse_store("{ not json").is_none());
        assert!(parse_store("null").is_none());
    }

    /// A record for the pure resolver tests — no store, no disk.
    fn record(scope: &[&str], policy: ProviderPolicy, archived: bool) -> Investigation {
        Investigation {
            id: "inv-test".into(),
            name: "T".into(),
            created_ms: 1,
            archived,
            scope_file_ids: scope.iter().map(|s| s.to_string()).collect(),
            provider_policy: policy,
            conversation_refs: Vec::new(),
            folder_name: "T".into(),
        }
    }

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    // PARITY: test/investigations.test.mjs mirrors this precedence table.
    #[test]
    fn scope_precedence_resolves_most_specific_wins() {
        // Absent/unknown investigation → passthrough, no forced-local.
        let (atts, force) = resolve_scope_and_policy(None, ids(&["req.md"]));
        assert_eq!(atts, ids(&["req.md"]));
        assert!(!force);

        // Scope non-empty, request attachments empty → attachments := scope.
        let rec = record(&["a.md", "b.md"], ProviderPolicy::Default, false);
        let (atts, force) = resolve_scope_and_policy(Some(&rec), vec![]);
        assert_eq!(atts, ids(&["a.md", "b.md"]));
        assert!(!force, "default policy never forces local");

        // Request attachments non-empty → they WIN; scope is not intersected
        // (c.md is outside the scope and still stands alone).
        let (atts, _) = resolve_scope_and_policy(Some(&rec), ids(&["c.md"]));
        assert_eq!(atts, ids(&["c.md"]), "explicit attachments override scope");

        // Empty scope = whole vault: attachments stay empty.
        let whole = record(&[], ProviderPolicy::Default, false);
        let (atts, _) = resolve_scope_and_policy(Some(&whole), vec![]);
        assert!(atts.is_empty());

        // Dangling scope ids pass through UNTOUCHED — resolution never
        // filters; downstream candidate selection ignores unknown ids and
        // the skip-note honesty counts drops.
        let dangling = record(&["gone.md", "a.md"], ProviderPolicy::Default, false);
        let (atts, _) = resolve_scope_and_policy(Some(&dangling), vec![]);
        assert_eq!(atts, ids(&["gone.md", "a.md"]));

        // Archived records resolve exactly like live ones.
        let archived = record(&["a.md"], ProviderPolicy::LocalOnly, true);
        let (atts, force) = resolve_scope_and_policy(Some(&archived), vec![]);
        assert_eq!(atts, ids(&["a.md"]));
        assert!(force, "archive never weakens the policy");

        // local-only forces local regardless of how attachments resolve.
        let local = record(&["a.md"], ProviderPolicy::LocalOnly, false);
        let (_, force) = resolve_scope_and_policy(Some(&local), ids(&["c.md"]));
        assert!(force, "attachment override still respects the policy");
    }
}
