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
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};

use crate::config::{now_ms, state_dir, write_json};

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
    /// CREATION time and never moved by rename — membership = location (§4
    /// derives note refs from it; §1 only records it).
    pub folder_name: String,
}

/// Read-time enriched view the `investigations` op returns: the record plus
/// DERIVED memberships. §1 returns them empty — §3 derives `pinRefs` from
/// pins.json (`Pin.investigationId`), §4 derives `noteRefs` from the
/// investigation's folder under `Lighthouse Notes/`.
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

/// Enrich one record for the wire (empty derived memberships in §1).
pub fn view(record: Investigation) -> InvestigationView {
    InvestigationView {
        record,
        pin_refs: Vec::new(),
        note_refs: Vec::new(),
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
}
