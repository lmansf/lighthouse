//! Boards: pin-backed local dashboards (openspec: add-boards).
//!
//! A board arranges EXISTING pins as ordered card references — {id, name,
//! investigationId | global, cards: [{pinId, size S|M|L}]} — and nothing
//! else. Cards are pure references: removing a card never touches the pin,
//! and pin existence is deliberately NOT enforced at write time — a pin
//! deleted later renders as a tombstone card instead of corrupting the
//! board (design.md). Names are unique case-insensitively WITHIN a scope
//! (the global scope and each investigation validate separately, mirroring
//! how `Pin.investigationId` partitions pins).
//!
//! Versioning posture (user data, not a cache): the store is a versioned
//! envelope `{v: 1, boards: [...]}` in `state_dir()/boards.json` — the
//! investigations idiom verbatim. `v == 1` loads; an unknown or missing
//! version — or unparseable JSON — loads EMPTY for the session, and the
//! first subsequent write renames the unreadable file to
//! `boards.json.bak-<epochms>` before writing a fresh v1 envelope. Nothing
//! is silently clobbered; a downgrade leaves the newer file recoverable.
//!
//! Defaults, lazily (proposal: "one default board per investigation plus a
//! global 'My board'"): a READ-TIME synthesis, never a migration or eager
//! write. Listing a scope with no persisted board returns a VIRTUAL default
//! carrying a DETERMINISTIC id (`default-global`, or `default-<invId>`
//! named after the investigation; `createdMs` 0 = never persisted), and the
//! first mutation naming that id materializes it as a real record under the
//! SAME id — the client mutates exactly what list returned.
//!
//! Refresh: `refresh_cards` re-runs each pin's stored SQL through the SAME
//! guarded, model-free path as watcher rechecks (`pins::refresh_one` wraps
//! `analytics::run_direct`) — a manual board refresh IS a recheck, so the
//! pin's stored digest/summary/lastRun advance identically, while the
//! rows/chart/footer (which rechecks deliberately never persist) ride back
//! to the caller for rendering. Zero model calls, ever.
//!
//! The dev server twin (src/server/boards.ts, KEEP IN SYNC) mirrors this
//! module byte-compatibly: same envelope, same validation and error
//! strings, same virtual defaults. Its refreshCards answers from STORED pin
//! state with `live: false` (PARITY: analytics is Rust-engine-only).

use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};

use crate::config::{now_ms, state_dir, write_json};

/// Envelope version this engine reads and writes.
const STORE_VERSION: u32 = 1;

/// The global default board's deterministic id — never minted for a created
/// board (those get `board-<sha>`), so a virtual id can't collide.
pub const GLOBAL_DEFAULT_ID: &str = "default-global";
/// The global default board's display name.
pub const GLOBAL_DEFAULT_NAME: &str = "My board";

/// Serializes load-modify-save on the store (mirrors investigations').
fn store_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|p| p.into_inner())
}

/// Card footprint on the responsive grid. Unit variant names ARE the wire
/// strings ("S" | "M" | "L") — serde rejects anything else at parse time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CardSize {
    S,
    M,
    L,
}

/// One ordered card: a pin reference plus its size. The pin id is stored as
/// given — dangling-tolerant like scope file ids (an id naming nothing
/// renders as a tombstone; it never corrupts the board).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardRef {
    pub pin_id: String,
    pub size: CardSize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    /// Engine-minted, stable: `board-` + first 12 hex chars of
    /// sha1(name \n scope \n createdMs) for created boards (see `board_id`),
    /// or the deterministic `default-…` id for materialized defaults. NOT
    /// derived from the current name — rename keeps the id.
    pub id: String,
    /// Display name, unique case-insensitively WITHIN its scope (global and
    /// each investigation validate separately).
    pub name: String,
    /// The investigation this board belongs to; `None` = the global scope
    /// (mirrors `Pin.investigationId`). Serde-default + skipped when absent
    /// so global boards round-trip byte-identically.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub investigation_id: Option<String>,
    /// Ordered card references — order IS the layout order.
    pub cards: Vec<CardRef>,
    /// Creation instant; 0 on a VIRTUAL default (never persisted yet).
    pub created_ms: i64,
}

fn boards_path() -> PathBuf {
    state_dir().join("boards.json")
}

#[derive(Serialize, Deserialize)]
struct Store {
    v: u32,
    boards: Vec<Board>,
}

/// A readable v1 envelope's records, or `None` when the text is not one
/// (unknown/missing version, or unparseable JSON — the two read identically,
/// see the module's versioning posture). PARITY: the TS twin trusts the
/// records array wholesale once the envelope checks pass; here serde also
/// rejects records with malformed required fields — engine-written files
/// always carry every field, so the twins agree on every file they write.
fn parse_store(text: &str) -> Option<Vec<Board>> {
    match serde_json::from_str::<Store>(text) {
        Ok(s) if s.v == STORE_VERSION => Some(s.boards),
        _ => None,
    }
}

enum Loaded {
    Records(Vec<Board>),
    Missing,
    /// Present but not a readable v1 envelope — reads empty for the session;
    /// the next write baks the file first (never clobber silently).
    Unreadable,
}

fn load() -> Loaded {
    match std::fs::read_to_string(boards_path()) {
        Ok(text) => match parse_store(&text) {
            Some(records) => Loaded::Records(records),
            None => Loaded::Unreadable,
        },
        Err(_) => Loaded::Missing,
    }
}

/// All PERSISTED boards, creation order. A missing store reads empty; an
/// unreadable one reads empty FOR THE SESSION (see `save`'s bak-on-write).
/// Virtual defaults are a read-time synthesis of `list_for`, never records.
pub fn list() -> Vec<Board> {
    match load() {
        Loaded::Records(records) => records,
        _ => Vec::new(),
    }
}

fn save(records: &[Board]) {
    let path = boards_path();
    // Versioning posture: an unreadable file (unknown/missing version,
    // corrupt JSON) is preserved as a `.bak-<epochms>` sibling before the
    // fresh v1 write — a downgrade or corruption never silently clobbers
    // newer data. Rename, falling back to copy, both best-effort.
    if matches!(load(), Loaded::Unreadable) {
        let bak = path.with_file_name(format!("boards.json.bak-{}", now_ms()));
        if std::fs::rename(&path, &bak).is_err() {
            let _ = std::fs::copy(&path, &bak);
        }
    }
    write_json(
        &path,
        &Store {
            v: STORE_VERSION,
            boards: records.to_vec(),
        },
    );
}

/// The deterministic id a scope's lazy default carries, virtual or
/// materialized: `default-global` for the global scope, `default-<invId>`
/// for an investigation. Deterministic so the client can mutate what a
/// listing returned — the first mutation persists the record under this
/// exact id (see `default_scope`).
pub fn default_board_id(investigation_id: Option<&str>) -> String {
    match investigation_id {
        None => GLOBAL_DEFAULT_ID.to_string(),
        Some(id) => format!("default-{id}"),
    }
}

/// The scope + default display name a never-persisted default id names, or
/// `None` when the id is not a valid virtual default: a scoped default only
/// resolves while its investigation exists (the name comes from it, and the
/// id can only have been obtained from a listing that synthesized it).
fn default_scope(id: &str) -> Option<(Option<String>, String)> {
    if id == GLOBAL_DEFAULT_ID {
        return Some((None, GLOBAL_DEFAULT_NAME.to_string()));
    }
    let inv_id = id.strip_prefix("default-")?;
    let inv = crate::investigations::list()
        .into_iter()
        .find(|r| r.id == inv_id)?;
    Some((Some(inv.id), inv.name))
}

/// A scope's virtual default: deterministic id, empty cards, `createdMs` 0
/// (= never persisted). Synthesized at read time only — nothing writes.
fn virtual_default(scope: Option<&str>, name: &str) -> Board {
    Board {
        id: default_board_id(scope),
        name: name.to_string(),
        investigation_id: scope.map(str::to_string),
        cards: Vec::new(),
        created_ms: 0,
    }
}

/// The `{op:"boards", action:"list"}` read. `Some(id)` filters to the boards
/// scoped to that investigation; `None` — absent or blank at the dispatch
/// layers — is "all", the `listPins`/`pins::list_for` convention exactly.
/// KEEP IN SYNC with src/server/boards.ts::listBoards.
///
/// Lazy defaults ride on top of the persisted records (appended after them,
/// deterministic order): a requested scope with no persisted board yields
/// its virtual default — for `None` that means the global "My board" plus
/// one default per stored investigation that has no board of its own
/// (archived investigations included; the caller filters, exactly as the
/// investigations listing leaves archived records in). An unknown
/// investigation id yields no virtual (there is no record to name it
/// after) — dangling filters simply match nothing, as with pins.
pub fn list_for(investigation_id: Option<&str>) -> Vec<Board> {
    let records = list();
    match investigation_id {
        Some(id) => {
            let mut out: Vec<Board> = records
                .iter()
                .filter(|b| b.investigation_id.as_deref() == Some(id))
                .cloned()
                .collect();
            if out.is_empty() {
                if let Some(inv) = crate::investigations::list().into_iter().find(|r| r.id == id)
                {
                    out.push(virtual_default(Some(&inv.id), &inv.name));
                }
            }
            out
        }
        None => {
            let mut out = records.clone();
            if !records.iter().any(|b| b.investigation_id.is_none()) {
                out.push(virtual_default(None, GLOBAL_DEFAULT_NAME));
            }
            for inv in crate::investigations::list() {
                if !records
                    .iter()
                    .any(|b| b.investigation_id.as_deref() == Some(inv.id.as_str()))
                {
                    out.push(virtual_default(Some(&inv.id), &inv.name));
                }
            }
            out
        }
    }
}

/// Stable engine-minted id for a CREATED board: `board-` + first 12 hex
/// chars of sha1(name \n scope \n createdMs). The scope rides in the hash so
/// same-named boards created in different scopes within the same millisecond
/// (tests do) can't collide; the `board-` prefix keeps minted ids disjoint
/// from the `default-…` namespace. KEEP IN SYNC with boards.ts::boardId.
fn board_id(name: &str, investigation_id: Option<&str>, created_ms: i64) -> String {
    let scope = investigation_id.unwrap_or("");
    let digest = Sha1::digest(format!("{name}\n{scope}\n{created_ms}").as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("board-{}", &hex[..12])
}

/// Case-insensitive name collision test WITHIN one scope, optionally
/// excluding one record (rename may keep — or case-change — its own name).
/// The global scope (`None`) and each investigation validate separately:
/// "Ops" may exist globally AND inside an investigation.
fn name_taken(
    records: &[Board],
    name: &str,
    scope: Option<&str>,
    excluding_id: Option<&str>,
) -> bool {
    let wanted = name.to_lowercase();
    records.iter().any(|r| {
        excluding_id != Some(r.id.as_str())
            && r.investigation_id.as_deref() == scope
            && r.name.to_lowercase() == wanted
    })
}

/// Parse the wire's `cards` value into typed refs — the shared validation
/// front door for `setCards` across routes.rs / commands.rs, so both
/// dispatch layers reject with the SAME human-readable reasons the TS twin
/// uses (KEEP IN SYNC: boards.ts::parseBoardCards, byte-identical errors).
/// Pin ids are only checked non-empty — existence is deliberately not
/// enforced (tombstone-tolerant, design.md).
pub fn parse_cards(value: &serde_json::Value) -> Result<Vec<CardRef>, String> {
    let Some(items) = value.as_array() else {
        return Err("cards must be an array of {pinId, size}".to_string());
    };
    items
        .iter()
        .map(|item| {
            let pin_id = item["pinId"].as_str().unwrap_or("").trim();
            if pin_id.is_empty() {
                return Err("every card needs a pinId".to_string());
            }
            let size = match item["size"].as_str() {
                Some("S") => CardSize::S,
                Some("M") => CardSize::M,
                Some("L") => CardSize::L,
                _ => return Err("card size must be \"S\", \"M\", or \"L\"".to_string()),
            };
            Ok(CardRef {
                pin_id: pin_id.to_string(),
                size,
            })
        })
        .collect()
}

/// Create a board. The name must be non-empty and unique case-insensitively
/// WITHIN its scope; a blank/absent `investigation_id` means the global
/// scope. The id is stored as given, dangling-tolerant like a pin's
/// membership — an investigation deleted later (there is no delete today;
/// archive never cascades) would simply never match a filter. Fails with a
/// human-readable reason. KEEP IN SYNC with boards.ts::createBoard.
pub fn create(name: &str, investigation_id: Option<&str>) -> Result<Board, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("a board needs a name".to_string());
    }
    let scope = investigation_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let _guard = store_lock();
    let mut records = list();
    if name_taken(&records, name, scope.as_deref(), None) {
        return Err(format!("a board named \"{name}\" already exists"));
    }
    let created_ms = now_ms();
    let board = Board {
        id: board_id(name, scope.as_deref(), created_ms),
        name: name.to_string(),
        investigation_id: scope,
        cards: Vec::new(),
        created_ms,
    };
    records.push(board.clone());
    save(&records);
    Ok(board)
}

/// Rename in place — same per-scope uniqueness rule as `create` (a case
/// change of the record's own name is allowed). Renaming a VIRTUAL default
/// materializes it under the new name (first mutation persists, design.md);
/// the deterministic id is kept, so a rename never invalidates what a
/// listing returned. KEEP IN SYNC with boards.ts::renameBoard.
pub fn rename(id: &str, new_name: &str) -> Result<Board, String> {
    let new_name = new_name.trim();
    if new_name.is_empty() {
        return Err("a board needs a name".to_string());
    }
    let _guard = store_lock();
    let mut records = list();
    if let Some(idx) = records.iter().position(|r| r.id == id) {
        let scope = records[idx].investigation_id.clone();
        if name_taken(&records, new_name, scope.as_deref(), Some(id)) {
            return Err(format!("a board named \"{new_name}\" already exists"));
        }
        records[idx].name = new_name.to_string();
        save(&records);
        return Ok(records[idx].clone());
    }
    // First mutation of a virtual default materializes it — under the NEW
    // name (validated like create), empty cards, the same deterministic id.
    let Some((scope, _)) = default_scope(id) else {
        return Err("board not found".to_string());
    };
    if name_taken(&records, new_name, scope.as_deref(), None) {
        return Err(format!("a board named \"{new_name}\" already exists"));
    }
    let board = Board {
        id: id.to_string(),
        name: new_name.to_string(),
        investigation_id: scope,
        cards: Vec::new(),
        created_ms: now_ms(),
    };
    records.push(board.clone());
    save(&records);
    Ok(board)
}

/// Delete a board record. Deleting a scope's default — materialized or
/// still virtual — is always effectively a RESET: the record (if any) goes,
/// and the next listing synthesizes a fresh empty virtual default for the
/// scope again; a never-persisted virtual id is therefore an Ok no-op.
/// Unknown ids fail ("board not found"). Cards are references, so deletion
/// never touches any pin. KEEP IN SYNC with boards.ts::deleteBoard.
pub fn delete(id: &str) -> Result<(), String> {
    let _guard = store_lock();
    let mut records = list();
    let before = records.len();
    records.retain(|r| r.id != id);
    if records.len() != before {
        save(&records);
        return Ok(());
    }
    if default_scope(id).is_some() {
        return Ok(()); // virtual default: nothing persisted, nothing to do
    }
    Err("board not found".to_string())
}

/// Replace a board's card list wholesale — the ONE mutation for reorder,
/// resize, add, and remove alike (atomic full-list replace; no per-card
/// deltas to interleave). Pin ids are NOT validated against pins.json
/// (tombstone-tolerant, design.md), and removing a card never touches the
/// pin. Targeting a VIRTUAL default id materializes it (first mutation
/// persists) under the scope's default name, validated like create. KEEP IN
/// SYNC with boards.ts::setBoardCards.
pub fn set_cards(id: &str, cards: Vec<CardRef>) -> Result<Board, String> {
    if cards.iter().any(|c| c.pin_id.trim().is_empty()) {
        return Err("every card needs a pinId".to_string());
    }
    let _guard = store_lock();
    let mut records = list();
    if let Some(idx) = records.iter().position(|r| r.id == id) {
        records[idx].cards = cards;
        save(&records);
        return Ok(records[idx].clone());
    }
    let Some((scope, default_name)) = default_scope(id) else {
        return Err("board not found".to_string());
    };
    if name_taken(&records, &default_name, scope.as_deref(), None) {
        return Err(format!("a board named \"{default_name}\" already exists"));
    }
    let board = Board {
        id: id.to_string(),
        name: default_name,
        investigation_id: scope,
        cards,
        created_ms: now_ms(),
    };
    records.push(board.clone());
    save(&records);
    Ok(board)
}

/// One card's answer from the `refreshCards` action. `live` is the engine's
/// mode, uniform across every card of a response: `true` here (computed NOW
/// via `run_direct`), `false` on the TS twin (stored pin state — PARITY:
/// analytics is Rust-engine-only). The absent-field posture (skip-if-none)
/// keeps the wire shape identical between the engines; the twin fills the
/// stored-state fields (lastSummary/lastDigest/staleReason) this engine
/// never sets, and vice versa for the computed ones.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardRefresh {
    pub pin_id: String,
    pub live: bool,
    /// The pin no longer exists — render the tombstone card ("pin removed").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tombstone: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
    /// Narration-capped result table, fresh from the guarded re-execution.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub markdown: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chart: Option<String>,
    /// The engine freshness/provenance footer — the card's freshness line.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub footer: Option<String>,
    /// Full-fidelity digest of the computed result (what rechecks compare).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run_ms: Option<i64>,
    /// `run_direct` failure (file gone, schema drift, guard) — the card
    /// shows it with the staleReason posture (same honesty as the pins
    /// dialog); the pin was marked stale in the store by the same pass.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl CardRefresh {
    /// A card with only identity + mode set; the caller fills its outcome.
    fn empty(pin_id: &str) -> Self {
        CardRefresh {
            pin_id: pin_id.to_string(),
            live: true,
            tombstone: None,
            question: None,
            markdown: None,
            chart: None,
            footer: None,
            result_digest: None,
            last_run_ms: None,
            error: None,
        }
    }
}

/// The `{op:"boards", action:"refreshCards"}` answer: re-run each pin's
/// stored SQL through the SAME guarded, model-free path as watcher rechecks.
/// A manual board refresh IS a recheck — `pins::refresh_one` wraps the
/// recheck internals (run_direct + the shared summarize + the merge-by-id
/// write-back), so the pin's stored digest/summary/lastRun/staleReason
/// advance exactly as the watcher loop would advance them, and this module
/// duplicates none of that logic. The rows/chart/footer rechecks
/// deliberately never persist ride back here for rendering only. Unknown
/// pins answer as tombstones — a board is pure references and never blocks
/// on a deleted pin. Sequential like `recheck_all` (a board holds at most
/// the pin cap's worth of local queries).
pub async fn refresh_cards(pin_ids: &[String]) -> Vec<CardRefresh> {
    let mut out = Vec::with_capacity(pin_ids.len());
    for pin_id in pin_ids {
        let mut card = CardRefresh::empty(pin_id);
        match crate::pins::refresh_one(pin_id).await {
            None => card.tombstone = Some(true),
            Some((pin, Ok(res))) => {
                card.question = Some(pin.question);
                card.markdown = Some(res.markdown);
                card.chart = res.chart;
                card.footer = Some(res.footer);
                card.result_digest = Some(res.result_digest);
                card.last_run_ms = pin.last_run_ms;
            }
            Some((pin, Err(e))) => {
                card.question = Some(pin.question);
                card.last_run_ms = pin.last_run_ms;
                card.error = Some(e);
            }
        }
        out.push(card);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // Pure-function tests only, like investigations.rs — the store scenarios
    // (round trip, bak-on-write, per-scope collisions, virtual defaults,
    // refresh) live in tests/boards_test.rs where VAULT_DIR mutation is
    // serialized by the shared env lock.

    fn board(id: &str, name: &str, scope: Option<&str>) -> Board {
        Board {
            id: id.into(),
            name: name.into(),
            investigation_id: scope.map(str::to_string),
            cards: Vec::new(),
            created_ms: 1,
        }
    }

    #[test]
    fn only_v1_envelopes_parse() {
        // A written envelope round-trips: sizes as bare "S"/"M"/"L" strings,
        // camelCase keys, investigationId omitted for global boards.
        let store = Store {
            v: STORE_VERSION,
            boards: vec![Board {
                id: "board-abc".into(),
                name: "Ops".into(),
                investigation_id: None,
                cards: vec![
                    CardRef {
                        pin_id: "pin-1".into(),
                        size: CardSize::S,
                    },
                    CardRef {
                        pin_id: "pin-2".into(),
                        size: CardSize::L,
                    },
                ],
                created_ms: 7,
            }],
        };
        let text = serde_json::to_string_pretty(&store).unwrap();
        assert!(text.contains("\"size\": \"S\""), "{text}");
        assert!(text.contains("\"size\": \"L\""), "{text}");
        assert!(text.contains("\"pinId\": \"pin-1\""), "{text}");
        assert!(!text.contains("investigationId"), "global omits the field: {text}");
        let records = parse_store(&text).expect("v1 loads");
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].cards.len(), 2);
        assert_eq!(records[0].cards[1].size, CardSize::L);

        // Anything else reads as unreadable (None): unknown version, missing
        // version, corrupt JSON — the bak-on-write posture treats them alike.
        assert!(parse_store(r#"{"v":99,"boards":[]}"#).is_none());
        assert!(parse_store(r#"{"boards":[]}"#).is_none());
        assert!(parse_store("{ not json").is_none());
        assert!(parse_store("null").is_none());
        // A record with an out-of-whitelist size is malformed, not coerced.
        assert!(parse_store(
            r#"{"v":1,"boards":[{"id":"b","name":"n","cards":[{"pinId":"p","size":"XL"}],"createdMs":1}]}"#
        )
        .is_none());
    }

    #[test]
    fn board_ids_are_stable_and_scope_sensitive() {
        assert_eq!(board_id("Ops", None, 42), board_id("Ops", None, 42));
        assert_ne!(board_id("Ops", None, 42), board_id("Ops", None, 43));
        assert_ne!(board_id("Ops", None, 42), board_id("Ops2", None, 42));
        // Same name + instant in DIFFERENT scopes must not collide.
        assert_ne!(board_id("Ops", None, 42), board_id("Ops", Some("inv-a"), 42));
        assert_ne!(
            board_id("Ops", Some("inv-a"), 42),
            board_id("Ops", Some("inv-b"), 42)
        );
        assert!(board_id("Ops", None, 42).starts_with("board-"));
        assert_eq!(board_id("Ops", None, 42).len(), "board-".len() + 12);
    }

    #[test]
    fn default_ids_are_deterministic_per_scope() {
        assert_eq!(default_board_id(None), "default-global");
        assert_eq!(default_board_id(Some("inv-abc")), "default-inv-abc");
        // Deterministic: the same scope always names the same virtual id, so
        // the client can mutate exactly what a listing returned.
        assert_eq!(default_board_id(Some("inv-abc")), default_board_id(Some("inv-abc")));
    }

    // PARITY: test/boards.test.mjs mirrors this validation table, errors
    // byte-identical.
    #[test]
    fn parse_cards_validates_shape_size_and_pin_id() {
        let ok = parse_cards(&serde_json::json!([
            { "pinId": "pin-1", "size": "S" },
            { "pinId": "pin-2", "size": "M" },
            { "pinId": "pin-3", "size": "L" },
        ]))
        .expect("whitelisted sizes parse");
        assert_eq!(ok.len(), 3);
        assert_eq!(ok[0].size, CardSize::S);
        assert_eq!(ok[2].size, CardSize::L);
        assert!(parse_cards(&serde_json::json!([])).expect("empty is a valid replace").is_empty());

        assert_eq!(
            parse_cards(&serde_json::json!({"pinId": "p"})).unwrap_err(),
            "cards must be an array of {pinId, size}"
        );
        assert_eq!(
            parse_cards(&serde_json::Value::Null).unwrap_err(),
            "cards must be an array of {pinId, size}"
        );
        assert_eq!(
            parse_cards(&serde_json::json!([{ "size": "S" }])).unwrap_err(),
            "every card needs a pinId"
        );
        assert_eq!(
            parse_cards(&serde_json::json!([{ "pinId": "  ", "size": "S" }])).unwrap_err(),
            "every card needs a pinId"
        );
        for bad in ["XL", "s", "medium", ""] {
            assert_eq!(
                parse_cards(&serde_json::json!([{ "pinId": "p", "size": bad }])).unwrap_err(),
                "card size must be \"S\", \"M\", or \"L\"",
                "{bad:?}"
            );
        }
    }

    #[test]
    fn names_collide_per_scope_only() {
        let records = vec![
            board("b1", "Ops", None),
            board("b2", "Ops", Some("inv-a")),
        ];
        // Within a scope: case-insensitive collision.
        assert!(name_taken(&records, "ops", None, None));
        assert!(name_taken(&records, "OPS", Some("inv-a"), None));
        // Across scopes: the same name is free.
        assert!(!name_taken(&records, "Ops", Some("inv-b"), None));
        // A record may keep (or case-change) its own name.
        assert!(!name_taken(&records, "OPS", None, Some("b1")));
        assert!(name_taken(&records, "OPS", None, Some("b2")), "excluding the OTHER scope's record changes nothing");
    }
}
