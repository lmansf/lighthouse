//! Answer cache (openspec: add-answer-cache): verbatim, freshness-stamped
//! replay of an unchanged question over unchanged data.
//!
//! The key is a sha256 over *everything that could change the answer*: the
//! normalized question, a digest of the provider-effective candidate set (the
//! shareable file ids paired with their `mtimeMs:size` freshness keys — which
//! already folds include flags, local-only marks under a cloud provider, and
//! per-file freshness), the provider AND model id, and the sorted attachment
//! id set. Global-digest tradeoff (v1, pinned in the design): ANY vault change
//! invalidates every entry — over-invalidation accepted, correctness beats hit
//! rate.
//!
//! Store: a bounded in-memory LRU (always on, session scope) plus an optional
//! disk mirror (`app_state_dir()/answer-cache.json`, compact JSON, versioned
//! envelope `{v:1, entries:[…]}`) written ONLY when the triggering request
//! carried the client's `persistAllowed` verdict. A request carrying
//! persistence-DISALLOWED deletes any existing disk file (cached answers are
//! chat content — the privacy posture wins over the optimization). Never the
//! vault; never any network. Doubt of any kind (unparseable file, envelope
//! version mismatch) reads as empty — a miss runs live, and the next allowed
//! insert rewrites the store cleanly.
//!
//! PARITY: mirrored byte-parallel in src/server/answerCache.ts. The twins
//! never share a cache file — the TS twin's freshness keys are its own stat
//! values — but normalization, key material shape, LRU bound, envelope, and
//! the persistence gate are identical.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::contracts::{AnalyticsMeta, ChunkMeta, RagReference};

/// LRU bound — small enough that the compact disk envelope stays trivial to
/// rewrite per insert, large enough for a session's worth of re-asks.
/// KEEP IN SYNC with answerCache.ts::CACHE_CAP.
pub const CACHE_CAP: usize = 64;
/// Disk envelope version. A mismatch reads as empty (miss ⇒ live).
const ENVELOPE_V: u32 = 1;
const CACHE_FILE: &str = "answer-cache.json";

/// Per-request cache controls, carried on the wire from the client:
/// `bypass_cache` (the Re-run affordance) skips the lookup but still runs the
/// posture + refreshes the entry on completion; `persist_allowed` is the
/// client's chat-history verdict (`persistEnabled() && !chatHistoryLocked()`),
/// computed per ask so the engines never learn a global flag. Both default
/// false — absent fields fail toward privacy.
#[derive(Debug, Clone, Copy, Default)]
pub struct CacheCtl {
    pub bypass_cache: bool,
    pub persist_allowed: bool,
}

/// One stored answer: the final markdown text verbatim (SQL/chart fences and
/// honesty footers ride inside), the references, the analytics meta, the
/// provenance stamp, and when it was computed. Entries are immutable once
/// written; replay adds `cachedAt` to the stamp, never mutates the entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedAnswer {
    pub key: String,
    pub created_ms: i64,
    pub text: String,
    pub references: Vec<RagReference>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub analytics: Option<AnalyticsMeta>,
    pub meta: ChunkMeta,
}

#[derive(Debug, Serialize, Deserialize)]
struct Envelope {
    v: u32,
    entries: Vec<CachedAnswer>,
}

/// In-memory store: `entries` in recency order (least-recent first), plus the
/// once-per-process lazy disk load flag.
struct Store {
    entries: Vec<CachedAnswer>,
    disk_loaded: bool,
}

static STORE: Mutex<Store> = Mutex::new(Store {
    entries: Vec::new(),
    disk_loaded: false,
});

fn cache_path() -> PathBuf {
    crate::config::app_state_dir().join(CACHE_FILE)
}

// --- Key --------------------------------------------------------------------------

/// Conservative question normalization: trim, lowercase, collapse internal
/// whitespace, strip trailing `?!.` — and nothing else (no stemming, no
/// synonyms): the cache must never conflate questions that could answer
/// differently. KEEP IN SYNC with answerCache.ts::normalizeQuestion.
pub fn normalize_question(question: &str) -> String {
    let lower = question.to_lowercase();
    let collapsed = lower.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed
        .trim_end_matches(['?', '!', '.'])
        .trim_end()
        .to_string()
}

fn sha256_hex(s: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(s.as_bytes()))
}

/// Digest of the provider-effective candidate set: the sorted
/// `(file id, freshness key)` pairs, NUL-joined per pair so ids and keys can
/// never collide across the boundary. Any change — a file added, removed,
/// re-included, marked local-only under a cloud provider, or touched on disk —
/// changes the digest. KEEP IN SYNC with answerCache.ts::candidateDigest.
pub fn candidate_digest(pairs: &[(String, String)]) -> String {
    let mut lines: Vec<String> = pairs
        .iter()
        .map(|(id, key)| format!("{id}\u{0}{key}"))
        .collect();
    lines.sort();
    sha256_hex(&lines.join("\n"))
}

/// The full cache key from pre-computed parts (pure — unit-testable without a
/// vault). Attachments are sorted + deduped: the SET is what was asked.
/// Preferred conversation ids (openspec: add-investigations — the current
/// investigation's recall preference) join the key ONLY when non-empty, so
/// every pre-investigations key — and every ask outside one — is unchanged
/// and existing cache entries stay valid. Without this, a recall-cued answer
/// cached in one investigation could replay inside another whose preferences
/// order the references differently.
/// KEEP IN SYNC with answerCache.ts::keyFromParts.
pub fn key_from_parts(
    question: &str,
    provider_id: Option<&str>,
    model_id: Option<&str>,
    attachment_ids: &[String],
    preferred_conversation_ids: &[String],
    candidate_digest: &str,
) -> String {
    let mut atts: Vec<&str> = attachment_ids.iter().map(|s| s.as_str()).collect();
    atts.sort_unstable();
    atts.dedup();
    let mut material = format!(
        "q:{}\nc:{}\np:{}\nm:{}\na:{}",
        normalize_question(question),
        candidate_digest,
        provider_id.unwrap_or(""),
        model_id.unwrap_or(""),
        atts.join("\u{0}"),
    );
    if !preferred_conversation_ids.is_empty() {
        let mut refs: Vec<&str> = preferred_conversation_ids.iter().map(|s| s.as_str()).collect();
        refs.sort_unstable();
        refs.dedup();
        material.push_str("\nr:");
        material.push_str(&refs.join("\u{0}"));
    }
    sha256_hex(&material)
}

/// The cache key for an ask, computed ONCE at ask entry — BEFORE retrieval —
/// from the same inputs the pipeline will use. Blocking (walks the vault and
/// stats each candidate); call via `spawn_blocking` from async code.
/// KEEP IN SYNC with answerCache.ts::cacheKey.
pub fn cache_key(
    question: &str,
    provider_id: Option<&str>,
    model_id: Option<&str>,
    attachment_ids: &[String],
    preferred_conversation_ids: &[String],
    is_cloud: bool,
) -> String {
    let digest = candidate_digest(&crate::vault::shareable_freshness_keys(is_cloud));
    key_from_parts(
        question,
        provider_id,
        model_id,
        attachment_ids,
        preferred_conversation_ids,
        &digest,
    )
}

// --- Store ------------------------------------------------------------------------

/// Enforce the persistence posture for this request, under the store lock:
/// allowed ⇒ lazily merge the disk mirror into memory (once per process);
/// disallowed ⇒ delete any existing disk file (history-off clears stored chat
/// content) and serve memory only.
fn apply_posture_locked(store: &mut Store, persist_allowed: bool) {
    if !persist_allowed {
        let _ = std::fs::remove_file(cache_path());
        return;
    }
    if store.disk_loaded {
        return;
    }
    store.disk_loaded = true;
    let env: Envelope = crate::config::read_json(
        &cache_path(),
        Envelope {
            v: ENVELOPE_V,
            entries: Vec::new(),
        },
    );
    // Version mismatch (or the unparseable fallback above) reads as empty:
    // doubt is a miss, and the next allowed insert rewrites the file cleanly.
    if env.v != ENVELOPE_V {
        return;
    }
    // Disk entries predate this session's: merge them in FRONT (least recent),
    // skipping keys the session has already re-answered, then re-apply the cap.
    let mut merged: Vec<CachedAnswer> = env
        .entries
        .into_iter()
        .filter(|e| !store.entries.iter().any(|m| m.key == e.key))
        .collect();
    merged.append(&mut store.entries);
    let excess = merged.len().saturating_sub(CACHE_CAP);
    merged.drain(..excess);
    store.entries = merged;
}

/// Look up a stored answer. Always applies the persistence posture (so a
/// disallowed ask deletes the disk file even when it misses or bypasses);
/// `bypass_cache` then skips the lookup itself — Re-run always runs live.
/// A hit is touched to most-recent. Blocking (disk); `spawn_blocking` from async.
pub fn lookup(key: &str, ctl: CacheCtl) -> Option<CachedAnswer> {
    let mut store = STORE.lock().unwrap_or_else(|p| p.into_inner());
    apply_posture_locked(&mut store, ctl.persist_allowed);
    if ctl.bypass_cache {
        return None;
    }
    let idx = store.entries.iter().position(|e| e.key == key)?;
    let entry = store.entries.remove(idx);
    store.entries.push(entry.clone());
    Some(entry)
}

/// Insert (or refresh) the entry for `key` as most-recent, evicting the least
/// recent past the cap. Callers insert only SUCCESSFUL, COMPLETED answers —
/// errored or interrupted streams must never be replayed. Write-through to the
/// disk mirror only when this request allows persistence; the write happens
/// under the store lock so it can never race a disallowed ask's delete back
/// into existence. Blocking (disk); `spawn_blocking` from async.
pub fn insert(key: &str, mut entry: CachedAnswer, ctl: CacheCtl) {
    entry.key = key.to_string();
    let mut store = STORE.lock().unwrap_or_else(|p| p.into_inner());
    apply_posture_locked(&mut store, ctl.persist_allowed);
    store.entries.retain(|e| e.key != key);
    store.entries.push(entry);
    let excess = store.entries.len().saturating_sub(CACHE_CAP);
    store.entries.drain(..excess);
    if ctl.persist_allowed {
        let env = Envelope {
            v: ENVELOPE_V,
            entries: store.entries.clone(),
        };
        crate::config::write_json_compact(&cache_path(), &env);
    }
}

/// Forget the in-process store and the lazy disk-load flag. Never touches the
/// disk file. For tests (which re-point VAULT_DIR / the app-state dir between
/// cases in one process); a production process never re-points its app-state
/// dir, and stale entries from a prior vault can't false-hit anyway — the
/// candidate digest in every key differs.
pub fn reset_store() {
    let mut store = STORE.lock().unwrap_or_else(|p| p.into_inner());
    store.entries.clear();
    store.disk_loaded = false;
}

#[cfg(test)]
mod tests {
    use super::*;

    // Shared normalization fixtures — the TS twin (test/answerCache.test.mjs)
    // asserts the SAME strings fold (or don't) the same way.
    #[test]
    fn normalization_folds_case_whitespace_and_trailing_punctuation_only() {
        assert_eq!(normalize_question("What were Q3 sales?"), "what were q3 sales");
        assert_eq!(normalize_question("  what   WERE q3 sales?! "), "what were q3 sales");
        assert_eq!(normalize_question("what were q3 sales..."), "what were q3 sales");
        // Wording changes are DIFFERENT questions — no stemming, no synonyms.
        assert_ne!(normalize_question("what was q3 sales"), normalize_question("what were q3 sales"));
        // Internal punctuation is meaning, not noise: only the TRAILING run folds.
        assert_eq!(normalize_question("what about v1.2?"), "what about v1.2");
        assert_ne!(normalize_question("50/50"), normalize_question("50 50"));
        assert_eq!(normalize_question("???"), "");
    }

    #[test]
    fn key_from_parts_is_order_insensitive_over_attachments_and_sensitive_to_everything_else() {
        let d = "digest";
        let base = key_from_parts("What were Q3 sales?", Some("openai"), Some("gpt-5-mini"), &[], &[], d);
        // Normalized variants of the same question share the key…
        assert_eq!(
            key_from_parts("  what   WERE q3 sales?! ", Some("openai"), Some("gpt-5-mini"), &[], &[], d),
            base
        );
        // …and every other component is load-bearing.
        assert_ne!(key_from_parts("What were Q4 sales?", Some("openai"), Some("gpt-5-mini"), &[], &[], d), base);
        assert_ne!(key_from_parts("What were Q3 sales?", Some("anthropic"), Some("gpt-5-mini"), &[], &[], d), base);
        assert_ne!(key_from_parts("What were Q3 sales?", Some("openai"), Some("gpt-5"), &[], &[], d), base);
        assert_ne!(key_from_parts("What were Q3 sales?", Some("openai"), Some("gpt-5-mini"), &[], &[], "other"), base);
        assert_ne!(key_from_parts("What were Q3 sales?", None, None, &[], &[], d), base);

        // The attachment SET is the component: order and duplicates fold.
        let a = ["a.md".to_string(), "b.csv".to_string()];
        let b = ["b.csv".to_string(), "a.md".to_string(), "a.md".to_string()];
        let with_a = key_from_parts("q", Some("openai"), None, &a, &[], d);
        assert_eq!(key_from_parts("q", Some("openai"), None, &b, &[], d), with_a);
        assert_ne!(key_from_parts("q", Some("openai"), None, &[], &[], d), with_a);
        assert_ne!(key_from_parts("q", Some("openai"), None, &a[..1].to_vec(), &[], d), with_a);
    }

    #[test]
    fn candidate_digest_orders_pairs_and_separates_id_from_key() {
        let ab = candidate_digest(&[("a.md".into(), "1:2".into()), ("b.md".into(), "3:4".into())]);
        let ba = candidate_digest(&[("b.md".into(), "3:4".into()), ("a.md".into(), "1:2".into())]);
        assert_eq!(ab, ba, "pair order never changes the digest");
        // A freshness change, a membership change, and an id/key boundary shift
        // all change the digest.
        assert_ne!(candidate_digest(&[("a.md".into(), "1:9".into()), ("b.md".into(), "3:4".into())]), ab);
        assert_ne!(candidate_digest(&[("a.md".into(), "1:2".into())]), ab);
        assert_ne!(
            candidate_digest(&[("a.md1".into(), ":2".into()), ("b.md".into(), "3:4".into())]),
            ab,
            "the NUL boundary keeps id/key material apart"
        );
    }
    #[test]
    fn recall_preference_joins_the_key_only_when_non_empty() {
        // openspec: add-investigations — empty preference = the legacy key,
        // byte-for-byte, so pre-investigations cache entries stay valid; a
        // preference re-keys, and the SET is the component (order/dupes fold).
        let d = "digest";
        let atts = ["a.md".to_string()];
        let legacy = key_from_parts("q", Some("openai"), None, &atts, &[], d);
        assert_eq!(key_from_parts("q", Some("openai"), None, &atts, &[], d), legacy);
        let p1 = ["c1".to_string(), "c2".to_string()];
        let p2 = ["c2".to_string(), "c1".to_string(), "c1".to_string()];
        let with_pref = key_from_parts("q", Some("openai"), None, &atts, &p1, d);
        assert_ne!(with_pref, legacy);
        assert_eq!(key_from_parts("q", Some("openai"), None, &atts, &p2, d), with_pref);
        assert_ne!(
            key_from_parts("q", Some("openai"), None, &atts, &p1[..1].to_vec(), d),
            with_pref
        );
    }

}
