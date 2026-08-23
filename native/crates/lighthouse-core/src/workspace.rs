//! The session workspace (openspec: refocus-chat-attachments): the only
//! corpus the app has. Each conversation owns a manifest of up to
//! [`MAX_ATTACHMENTS`] files; bytes live once in a content-addressed blob
//! store shared by every conversation. Ids resolve through the manifest — a
//! map lookup — never a directory walk, and blobs are write-once, so every
//! downstream cache keyed by the blob path is effectively keyed by content
//! hash.
//!
//! PARITY: the byte-parallel twin of src/server/workspace.ts — id minting,
//! manifest layout, cap messages, and sweep rules are identical.

use std::path::PathBuf;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

use crate::config::{app_state_dir, now_ms, read_json, write_json_compact};

/// The corpus cap — the product IS "a small group of files, done
/// exceptionally well". Attach #11 is refused, never silently dropped.
/// KEEP IN SYNC with workspace.ts::MAX_ATTACHMENTS.
pub const MAX_ATTACHMENTS: usize = 10;
/// Per-file byte cap, unchanged from the vault-era upload routes.
/// KEEP IN SYNC with workspace.ts::MAX_ATTACHMENT_BYTES.
pub const MAX_ATTACHMENT_BYTES: usize = 25 * 1024 * 1024;
/// Unreferenced blobs younger than this survive a sweep — a conversation
/// deleted moments ago shouldn't strand a re-attach mid-thought.
const SWEEP_AGE_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// Manifest envelope version. A mismatch reads as empty (attach rewrites).
const MANIFEST_V: u32 = 1;

/// One attached file as the manifest records it. `hash` is the sha256 hex of
/// the bytes; `id` is minted from hash + name (see [`attachment_id`]).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub name: String,
    pub hash: String,
    pub size: u64,
    pub added_ms: i64,
}

#[derive(Debug, Serialize, Deserialize)]
struct Manifest {
    v: u32,
    files: Vec<Attachment>,
}

impl Default for Manifest {
    fn default() -> Self {
        Manifest { v: MANIFEST_V, files: Vec::new() }
    }
}

fn workspace_dir() -> PathBuf {
    let dir = app_state_dir().join("workspace");
    let _ = std::fs::create_dir_all(dir.join("blobs"));
    dir
}

/// Blob path for a content hash. Blobs are written once under their own
/// hash and never renamed, so `(path, mtime, size)`-keyed caches downstream
/// (extract, catalog, index) are content-hash-keyed by construction.
pub fn blob_path(hash: &str) -> PathBuf {
    workspace_dir().join("blobs").join(hash)
}

/// Manifest filename for a conversation id. Ids come from the client, so the
/// filename keeps only [A-Za-z0-9_-]; when sanitization changed anything, a
/// short hash of the original id is appended so distinct ids can never
/// collide on their sanitized forms.
fn manifest_path(conversation_id: &str) -> PathBuf {
    let safe: String = conversation_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .take(64)
        .collect();
    let name = if safe == conversation_id && !safe.is_empty() {
        safe
    } else {
        let tag = sha256_hex(conversation_id.as_bytes());
        format!("{}-{}", if safe.is_empty() { "conv" } else { &safe }, &tag[..8])
    };
    workspace_dir().join(format!("{name}.json"))
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(bytes))
}

/// Engine-minted attachment id: `att-` + first 12 hex of sha256(hash + name)
/// (the pins/investigation-id precedent). The hash component is fixed-width
/// hex, so the concatenation is unambiguous. Same bytes under the same name
/// mint the same id in every conversation — that is what makes re-attach
/// idempotent and the answer cache portable.
/// KEEP IN SYNC with workspace.ts::attachmentId.
pub fn attachment_id(hash: &str, name: &str) -> String {
    format!("att-{}", &sha256_hex(format!("{hash}{name}").as_bytes())[..12])
}

fn load(conversation_id: &str) -> Manifest {
    let m: Manifest = read_json(&manifest_path(conversation_id), Manifest::default());
    if m.v != MANIFEST_V {
        return Manifest::default();
    }
    m
}

fn store(conversation_id: &str, m: &Manifest) {
    write_json_compact(&manifest_path(conversation_id), m);
}

/// Attach bytes to a conversation. Enforces both caps (the transports narrow,
/// the engine decides), writes the blob once, and records the manifest entry.
/// Re-attaching identical bytes under the same name is idempotent — the
/// existing entry is returned untouched, and no bytes are rewritten.
pub fn attach(conversation_id: &str, name: &str, bytes: &[u8]) -> Result<Attachment> {
    if bytes.is_empty() {
        return Err(anyhow!("this file is empty"));
    }
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(anyhow!("files are capped at 25 MB"));
    }
    let hash = sha256_hex(bytes);
    let id = attachment_id(&hash, name);
    let mut m = load(conversation_id);
    if let Some(existing) = m.files.iter().find(|f| f.id == id) {
        return Ok(existing.clone());
    }
    if m.files.len() >= MAX_ATTACHMENTS {
        return Err(anyhow!(
            "a conversation holds at most {MAX_ATTACHMENTS} files — remove one first"
        ));
    }
    let blob = blob_path(&hash);
    if !blob.exists() {
        // Write-once via a temp neighbor + rename so a crashed write can
        // never leave a half blob under a valid hash name.
        let tmp = blob.with_extension("part");
        std::fs::write(&tmp, bytes)?;
        std::fs::rename(&tmp, &blob)?;
    }
    let att = Attachment {
        id,
        name: name.to_string(),
        hash,
        size: bytes.len() as u64,
        added_ms: now_ms(),
    };
    m.files.push(att.clone());
    store(conversation_id, &m);
    Ok(att)
}

/// Remove one attachment from a conversation. The blob stays for the sweep —
/// another conversation may reference it.
pub fn detach(conversation_id: &str, id: &str) {
    let mut m = load(conversation_id);
    let before = m.files.len();
    m.files.retain(|f| f.id != id);
    if m.files.len() != before {
        store(conversation_id, &m);
    }
}

/// The conversation's attachments, in attach order.
pub fn list(conversation_id: &str) -> Vec<Attachment> {
    load(conversation_id).files
}

/// Resolve an attachment id to its display name and blob path — the whole
/// replacement for the vault walk. `None` when the id isn't in the manifest
/// or its blob is gone (a swept or damaged store): callers answer honestly
/// about the gap instead of crashing.
pub fn resolve(conversation_id: &str, id: &str) -> Option<(String, PathBuf)> {
    let m = load(conversation_id);
    let f = m.files.iter().find(|f| f.id == id)?;
    let path = blob_path(&f.hash);
    if !path.exists() {
        return None;
    }
    Some((f.name.clone(), path))
}

/// Drop blobs no manifest references any more, once they are older than the
/// grace window. Mark-and-sweep over the workspace dir; errors are ignored —
/// a failed sweep just retries next startup.
pub fn sweep() {
    let dir = workspace_dir();
    let mut referenced = std::collections::HashSet::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) == Some("json") {
                let m: Manifest = read_json(&p, Manifest::default());
                for f in m.files {
                    referenced.insert(f.hash);
                }
            }
        }
    }
    let cutoff = now_ms() - SWEEP_AGE_MS;
    if let Ok(entries) = std::fs::read_dir(dir.join("blobs")) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if referenced.contains(&name) {
                continue;
            }
            let old_enough = e
                .metadata()
                .and_then(|md| md.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| (d.as_millis() as i64) < cutoff)
                .unwrap_or(false);
            if old_enough {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_temp_state(f: impl FnOnce()) {
        let _env = crate::test_env_lock();
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("LIGHTHOUSE_APP_STATE_DIR", dir.path());
        f();
        std::env::remove_var("LIGHTHOUSE_APP_STATE_DIR");
    }

    // PARITY: test/workspace.test.mjs pins the same literal.
    #[test]
    fn attachment_ids_are_pinned_across_engines() {
        let hash = sha256_hex(b"hello,world\n");
        assert_eq!(attachment_id(&hash, "a.csv"), "att-69f7e4ec78ca");
    }

    #[test]
    fn attach_round_trips_and_reattach_is_idempotent() {
        with_temp_state(|| {
            let a = attach("conv-1", "a.csv", b"x,y\n1,2\n").unwrap();
            assert!(a.id.starts_with("att-"));
            assert_eq!(a.size, 8);
            let again = attach("conv-1", "a.csv", b"x,y\n1,2\n").unwrap();
            assert_eq!(again, a, "same bytes + name = same entry, no growth");
            assert_eq!(list("conv-1").len(), 1);
            let (name, path) = resolve("conv-1", &a.id).unwrap();
            assert_eq!(name, "a.csv");
            assert_eq!(std::fs::read(path).unwrap(), b"x,y\n1,2\n");
            // Same bytes in another conversation share the blob and the id.
            let b = attach("conv-2", "a.csv", b"x,y\n1,2\n").unwrap();
            assert_eq!(b.id, a.id);
        });
    }

    #[test]
    fn caps_refuse_at_the_boundary() {
        with_temp_state(|| {
            for i in 0..MAX_ATTACHMENTS {
                attach("conv-cap", &format!("f{i}.txt"), format!("body {i}").as_bytes())
                    .unwrap();
            }
            let err = attach("conv-cap", "one-more.txt", b"z").unwrap_err();
            assert_eq!(
                err.to_string(),
                "a conversation holds at most 10 files — remove one first"
            );
            assert_eq!(list("conv-cap").len(), MAX_ATTACHMENTS, "refusal added nothing");
            // Re-attaching an EXISTING file still works at the cap (idempotent
            // path runs before the cap check).
            attach("conv-cap", "f0.txt", b"body 0").unwrap();
            let big = vec![b'a'; MAX_ATTACHMENT_BYTES + 1];
            assert_eq!(
                attach("conv-cap2", "big.bin", &big).unwrap_err().to_string(),
                "files are capped at 25 MB"
            );
            assert_eq!(
                attach("conv-cap2", "empty.bin", b"").unwrap_err().to_string(),
                "this file is empty"
            );
        });
    }

    #[test]
    fn detach_leaves_the_blob_and_resolve_reports_gaps_honestly() {
        with_temp_state(|| {
            let a = attach("conv-d", "a.txt", b"abc").unwrap();
            let b = attach("conv-e", "a.txt", b"abc").unwrap();
            detach("conv-d", &a.id);
            assert!(list("conv-d").is_empty());
            assert!(resolve("conv-d", &a.id).is_none(), "detached = gone from HERE");
            let (_, p) = resolve("conv-e", &b.id).expect("other conversation unaffected");
            assert!(p.exists(), "blob survives while referenced anywhere");
            // A vanished blob resolves to None, never a panic.
            std::fs::remove_file(&p).unwrap();
            assert!(resolve("conv-e", &b.id).is_none());
        });
    }

    #[test]
    fn traversal_shaped_conversation_ids_stay_inside_the_workspace() {
        with_temp_state(|| {
            let a = attach("../../etc/passwd", "a.txt", b"abc").unwrap();
            let ws = workspace_dir();
            let entries: Vec<_> = std::fs::read_dir(&ws)
                .unwrap()
                .flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect();
            assert!(
                entries.iter().any(|n| n.starts_with("etcpasswd-")),
                "sanitized + hash-suffixed manifest, in place: {entries:?}"
            );
            assert!(resolve("../../etc/passwd", &a.id).is_some());
            // Distinct raw ids that sanitize identically stay distinct files.
            attach("etc/passwd", "b.txt", b"xyz").unwrap();
            assert_eq!(list("../../etc/passwd").len(), 1);
            assert_eq!(list("etc/passwd").len(), 1);
        });
    }

    #[test]
    fn sweep_drops_only_old_unreferenced_blobs() {
        with_temp_state(|| {
            let kept = attach("conv-s", "kept.txt", b"keep me").unwrap();
            let gone = attach("conv-s", "gone.txt", b"drop me").unwrap();
            detach("conv-s", &gone.id);
            // Fresh unreferenced blob survives (inside the grace window).
            sweep();
            assert!(blob_path(&gone.hash).exists(), "young blob survives the sweep");
            // Age it past the window and it goes; the referenced one stays.
            let old = filetime::FileTime::from_unix_time(1_000_000, 0);
            filetime::set_file_mtime(blob_path(&gone.hash), old).unwrap();
            filetime::set_file_mtime(blob_path(&kept.hash), old).unwrap();
            sweep();
            assert!(!blob_path(&gone.hash).exists(), "old unreferenced blob swept");
            assert!(blob_path(&kept.hash).exists(), "referenced blob immortal");
        });
    }
}
