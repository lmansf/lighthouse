//! The 0.15.0 ask (openspec: refocus-chat-attachments): a question answered
//! from a conversation's ATTACHMENTS, with no vault anywhere in the path.
//!
//! This is the end-to-end proof that the corpus swap works: the same
//! `answer_pipeline` that serves the vault serves a workspace corpus, the
//! answer cites the attached file, an unattached file is invisible, and the
//! answer cache replays across conversations that hold byte-identical bytes.
//! Model-free by construction — a device provider with no key answers
//! extractively, so this runs with zero network.

mod common;

use futures::StreamExt;
use lighthouse_core::contracts::ChatChunk;
use lighthouse_core::llm::ModelCfg;
use lighthouse_core::synth::{answer_pipeline, Corpus};
use lighthouse_core::workspace;

/// A device config with no key: the pipeline answers extractively.
fn device_cfg() -> ModelCfg {
    ModelCfg { provider_id: Some("local".into()), ..ModelCfg::default() }
}

async fn ask(question: &str, conversation: &str) -> (String, Vec<ChatChunk>) {
    let mut stream = answer_pipeline(
        question.to_string(),
        vec![],
        vec![],
        vec![],
        device_cfg(),
        Default::default(),
        Default::default(),
        vec![],
        Corpus { conversation_id: Some(conversation.to_string()) },
    );
    let (mut text, mut chunks) = (String::new(), Vec::new());
    while let Some(c) = stream.next().await {
        text.push_str(&c.delta);
        chunks.push(c);
    }
    (text, chunks)
}

fn cited(chunks: &[ChatChunk]) -> Vec<String> {
    let mut names: Vec<String> = chunks
        .iter()
        .filter_map(|c| c.references.as_ref())
        .flatten()
        .map(|r| r.name.clone())
        .collect();
    names.sort();
    names.dedup();
    names
}

#[tokio::test]
async fn an_ask_answers_from_its_conversation_attachments_alone() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());

    workspace::attach(
        "conv-1",
        "quarterly.md",
        b"# Q3 revenue\nNortheast revenue rose sharply this quarter, led by hardware.\n",
    )
    .unwrap();
    // A file attached to a DIFFERENT conversation must stay invisible here.
    workspace::attach("conv-other", "secret.md", b"# Secret\nProject Kestrel ships in May.\n")
        .unwrap();

    let (text, chunks) = ask("What happened to Northeast revenue?", "conv-1").await;
    assert!(
        cited(&chunks).contains(&"quarterly.md".to_string()),
        "the attachment is cited: {:?}",
        cited(&chunks)
    );
    assert!(
        !cited(&chunks).contains(&"secret.md".to_string()),
        "another conversation's attachment never joins the corpus"
    );
    assert!(!text.trim().is_empty(), "an extractive answer still says something");

    // A conversation with nothing attached has nothing to cite.
    let (_, empty) = ask("What happened to Northeast revenue?", "conv-empty").await;
    assert!(cited(&empty).is_empty(), "no attachments ⇒ no sources: {:?}", cited(&empty));
}

#[tokio::test]
async fn identical_attachments_replay_across_conversations() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    let bytes = b"# Q3 revenue\nNortheast revenue rose sharply this quarter.\n";
    workspace::attach("conv-a", "quarterly.md", bytes).unwrap();
    workspace::attach("conv-b", "quarterly.md", bytes).unwrap();

    // The key is over content hashes, so two conversations holding identical
    // bytes key identically — the portability the vault-era global digest
    // could never offer.
    let q = "What happened to Northeast revenue?";
    let key_a =
        lighthouse_core::answer_cache::workspace_cache_key(Some("conv-a"), q, Some("local"), None, &[]);
    let key_b =
        lighthouse_core::answer_cache::workspace_cache_key(Some("conv-b"), q, Some("local"), None, &[]);
    assert_eq!(key_a, key_b, "identical bytes ⇒ identical key");

    // Store an answer under conv-a's key, then ask in conv-b: the pipeline
    // replays it verbatim and stamps it as cached. (A real answer is stored
    // here directly because a model-free container answers "model unavailable",
    // which the engine deliberately refuses to cache.)
    lighthouse_core::answer_cache::reset_store();
    lighthouse_core::answer_cache::insert(
        &key_a,
        lighthouse_core::answer_cache::CachedAnswer {
            key: String::new(),
            created_ms: lighthouse_core::config::now_ms(),
            text: "Northeast revenue rose sharply, led by hardware.".to_string(),
            references: vec![],
            analytics: None,
            meta: lighthouse_core::contracts::ChunkMeta {
                origin: "device".to_string(),
                excerpt_count: 1,
                source_file_count: 1,
                cached_at: None,
                cost: None,
                manifest: None,
                chart: None,
                table: None,
            },
        },
        Default::default(),
    );

    let (text, chunks) = ask(q, "conv-b").await;
    assert_eq!(
        text.trim(),
        "Northeast revenue rose sharply, led by hardware.",
        "the other conversation's stored answer replays verbatim"
    );
    assert!(
        chunks.iter().any(|c| c.meta.as_ref().and_then(|m| m.cached_at).is_some()),
        "and is stamped as a replay, not passed off as fresh"
    );

    // One changed byte in the attachments is a different key — no false replay.
    workspace::attach("conv-c", "quarterly.md", b"# Q3 revenue\nNortheast revenue fell.\n")
        .unwrap();
    let (fresh, _) = ask(q, "conv-c").await;
    assert_ne!(
        fresh.trim(),
        "Northeast revenue rose sharply, led by hardware.",
        "different bytes never replay another conversation's answer"
    );
}
