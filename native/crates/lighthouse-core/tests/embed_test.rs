//! B2 hybrid search, end to end against a stub /v1/embeddings server:
//! a semantic-only query (zero token overlap with any file) finds the right
//! file once the warm pass has embedded the corpus, and the Preferences kill
//! switch drops retrieval back to pure lexical instantly.

mod common;

use std::io::{Read, Write};
use std::net::TcpListener;

use lighthouse_core::vault;

fn write_file(path: &std::path::Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

/// Minimal HTTP stub: /health → ok; /v1/embeddings → deterministic vectors
/// whose geometry encodes topic similarity (finance-ish vs food-ish), so the
/// test controls "meaning" without a model. One request per connection.
fn spawn_stub() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut s) = stream else { continue };
            let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(5)));
            let mut buf = Vec::new();
            let mut tmp = [0u8; 4096];
            let (mut head_end, mut body_need) = (0usize, None::<usize>);
            loop {
                if body_need.is_none() {
                    if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        head_end = pos + 4;
                        let head = String::from_utf8_lossy(&buf[..pos]).to_lowercase();
                        let len = head
                            .lines()
                            .find_map(|l| l.strip_prefix("content-length:"))
                            .and_then(|v| v.trim().parse::<usize>().ok())
                            .unwrap_or(0);
                        body_need = Some(len);
                    }
                }
                if let Some(need) = body_need {
                    if buf.len() >= head_end + need {
                        break;
                    }
                }
                match s.read(&mut tmp) {
                    Ok(0) => break,
                    Ok(n) => buf.extend_from_slice(&tmp[..n]),
                    Err(_) => break,
                }
            }
            let head = String::from_utf8_lossy(&buf[..head_end.max(buf.len().min(head_end))]);
            let body = if head.contains("/v1/embeddings") {
                let req: serde_json::Value =
                    serde_json::from_slice(&buf[head_end..]).unwrap_or_default();
                let data: Vec<serde_json::Value> = req["input"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .iter()
                    .map(|t| {
                        let text = t.as_str().unwrap_or("").to_lowercase();
                        let hit = |words: &[&str]| words.iter().any(|w| text.contains(w));
                        let fin = if hit(&["revenue", "sales", "quarter", "q3"]) { 1.0 } else { 0.01 };
                        let food =
                            if hit(&["cake", "chocolate", "butter", "cocoa", "recipe"]) { 1.0 } else { 0.01 };
                        serde_json::json!({ "embedding": [fin, food, 0.2, 0.1] })
                    })
                    .collect();
                serde_json::json!({ "data": data }).to_string()
            } else {
                r#"{"status":"ok"}"#.to_string()
            };
            let _ = write!(
                s,
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
        }
    });
    port
}

#[test]
fn hybrid_retrieval_finds_by_meaning_and_honors_the_kill_switch() {
    let vault_dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap(); // settings live OUTSIDE the vault walk
    let _guard = common::lock_env(vault_dir.path());
    let port = spawn_stub();
    std::env::set_var("LIGHTHOUSE_EMBED_URL", format!("http://127.0.0.1:{port}"));
    let settings = outside.path().join("settings.json");
    std::fs::write(&settings, "{}").unwrap();
    std::env::set_var("LIGHTHOUSE_SETTINGS_FILE", &settings);

    write_file(
        &vault_dir.path().join("roadmap.md"),
        "Third-quarter sales figures grew strongly across all regions.",
    );
    write_file(
        &vault_dir.path().join("recipe.md"),
        "Grandma's chocolate cake needs butter, cocoa, and patience.",
    );
    let ids: Vec<String> = vault::list_nodes()
        .into_iter()
        .filter(|n| n.kind == lighthouse_core::contracts::NodeKind::File)
        .map(|n| n.id)
        .collect();
    assert_eq!(ids.len(), 2);
    for id in &ids {
        vault::set_included(id, true);
    }

    // Zero token overlap with either file: "q3"/"revenue" appear nowhere.
    let query = "Q3 revenue";

    // Pass 1 — vectors are cold, so retrieval is lexical and finds nothing
    // (this also kicks the index build + the async vector warm pass).
    let cold = vault::retrieve(query, &ids, 5, &[], &[]);
    assert!(
        cold.references.is_empty(),
        "lexical-only retrieval must find nothing for a semantic query, got {:?}",
        cold.references.iter().map(|r| &r.name).collect::<Vec<_>>()
    );

    // Pass 2 — poll until the warm pass lands (embeds both files, ~ms).
    let mut hybrid = None;
    for _ in 0..100 {
        std::thread::sleep(std::time::Duration::from_millis(150));
        let r = vault::retrieve(query, &ids, 5, &[], &[]);
        if !r.references.is_empty() {
            hybrid = Some(r);
            break;
        }
    }
    let hybrid = hybrid.expect("vector warm pass never activated hybrid retrieval");
    assert_eq!(
        hybrid.references[0].name, "roadmap.md",
        "the semantically-related file must rank first"
    );
    if let Some(recipe) = hybrid.references.iter().find(|r| r.name == "recipe.md") {
        assert!(
            recipe.score <= hybrid.references[0].score,
            "unrelated file must not outrank the related one"
        );
    }
    // Vectors persisted beside the index.
    assert!(
        vault_dir
            .path()
            .join(".rag-vault/cache/vectors-v1.bin")
            .exists(),
        "vector sidecar must be written"
    );

    // Kill switch: Preferences off ⇒ instantly lexical again (no restart).
    std::fs::write(&settings, r#"{ "semanticSearch": false }"#).unwrap();
    let off = vault::retrieve(query, &ids, 5, &[], &[]);
    assert!(
        off.references.is_empty(),
        "semanticSearch=false must drop retrieval back to pure lexical"
    );

    std::env::remove_var("LIGHTHOUSE_EMBED_URL");
    std::env::remove_var("LIGHTHOUSE_SETTINGS_FILE");
}
