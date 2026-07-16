//! Investigations store over a real temp vault (openspec: add-investigations):
//! round trip, unknown-version/corrupt bak-on-write, the history-posture gate
//! on conversation refs, duplicate-name rejection, the archive flag, and the
//! §2 ask-context resolution (scope → attachments, local-only → cfg swap)
//! plus its cross-engine retrieval-parity fixture.
//! Mirrored by the TS twin's test/investigations.test.mjs (PARITY).

mod common;

use lighthouse_core::investigations::{self, ProviderPolicy};
use lighthouse_core::llm::ModelCfg;
use lighthouse_core::vault;

/// Point the managed policy at a throwaway file (or an absent path) for the
/// closure, then restore — same seam policy.rs's own tests use.
fn with_policy(content: Option<&str>, f: impl FnOnce()) {
    let dir = tempfile::tempdir().expect("policy tempdir");
    let file = dir.path().join("policy.json");
    if let Some(c) = content {
        std::fs::write(&file, c).expect("write policy");
    }
    std::env::set_var("LIGHTHOUSE_POLICY_FILE", &file);
    lighthouse_core::policy::reset_for_tests();
    f();
    std::env::remove_var("LIGHTHOUSE_POLICY_FILE");
    lighthouse_core::policy::reset_for_tests();
}

/// Paths of `investigations.json.bak-<epochms>` siblings in the state dir.
fn bak_files(state: &std::path::Path) -> Vec<std::path::PathBuf> {
    std::fs::read_dir(state)
        .map(|rd| {
            rd.filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.starts_with("investigations.json.bak-"))
                })
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn round_trips_byte_stable() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());

    let scope = vec!["reports/a.pdf".to_string(), "reports/b.csv".to_string()];
    let created =
        investigations::create("Q3 audit", &scope, ProviderPolicy::LocalOnly).expect("creates");
    assert!(created.id.starts_with("inv-"), "{}", created.id);
    assert_eq!(created.folder_name, "Q3 audit");

    // Re-read from disk: every stored field returns as written.
    let listed = investigations::list();
    assert_eq!(listed.len(), 1);
    let inv = &listed[0];
    assert_eq!(inv.id, created.id);
    assert_eq!(inv.name, "Q3 audit");
    assert_eq!(inv.created_ms, created.created_ms);
    assert!(!inv.archived);
    assert_eq!(inv.scope_file_ids, scope);
    assert_eq!(inv.provider_policy, ProviderPolicy::LocalOnly);
    assert!(inv.conversation_refs.is_empty());

    // The on-disk envelope is the byte contract with the TS twin: v1, then
    // the records, camelCase keys in declaration order, 2-space pretty.
    let raw =
        std::fs::read_to_string(vault.path().join(".rag-vault/investigations.json")).unwrap();
    assert!(
        raw.starts_with("{\n  \"v\": 1,\n  \"investigations\": ["),
        "{raw}"
    );
    for pair in [
        ("\"id\"", "\"name\""),
        ("\"name\"", "\"createdMs\""),
        ("\"createdMs\"", "\"archived\""),
        ("\"archived\"", "\"scopeFileIds\""),
        ("\"scopeFileIds\"", "\"providerPolicy\""),
        ("\"providerPolicy\"", "\"conversationRefs\""),
        ("\"conversationRefs\"", "\"folderName\""),
    ] {
        let (a, b) = (raw.find(pair.0), raw.find(pair.1));
        assert!(a.is_some() && a < b, "{} must precede {}", pair.0, pair.1);
    }
    assert!(raw.contains("\"providerPolicy\": \"local-only\""), "{raw}");

    // The wire view enriches with DERIVED memberships — empty until §3/§4.
    let views = investigations::listing();
    assert_eq!(views.len(), 1);
    assert!(views[0].pin_refs.is_empty() && views[0].note_refs.is_empty());
}

#[test]
fn unknown_version_loads_empty_and_baks_on_write() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    let state = vault.path().join(".rag-vault");
    std::fs::create_dir_all(&state).unwrap();
    let newer = r#"{"v":99,"investigations":[{"id":"inv-from-the-future"}]}"#;
    std::fs::write(state.join("investigations.json"), newer).unwrap();

    // Session reads empty — never a crash, never a partial parse.
    assert!(investigations::list().is_empty(), "v99 loads empty");

    // The first write preserves the unreadable file, then writes fresh v1.
    investigations::create("Fresh", &[], ProviderPolicy::Default).expect("creates");
    let baks = bak_files(&state);
    assert_eq!(baks.len(), 1, "exactly one bak: {baks:?}");
    assert_eq!(
        std::fs::read_to_string(&baks[0]).unwrap(),
        newer,
        "newer data recoverable byte-for-byte"
    );
    let raw = std::fs::read_to_string(state.join("investigations.json")).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(parsed["v"], 1);
    assert_eq!(parsed["investigations"][0]["name"], "Fresh");
    assert_eq!(investigations::list().len(), 1);
}

#[test]
fn corrupt_json_loads_empty_and_baks_on_write() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    let state = vault.path().join(".rag-vault");
    std::fs::create_dir_all(&state).unwrap();
    std::fs::write(state.join("investigations.json"), "{ not json").unwrap();

    assert!(investigations::list().is_empty(), "corrupt loads empty");
    investigations::create("After corruption", &[], ProviderPolicy::Default).expect("creates");
    let baks = bak_files(&state);
    assert_eq!(baks.len(), 1, "corrupt file preserved: {baks:?}");
    assert_eq!(std::fs::read_to_string(&baks[0]).unwrap(), "{ not json");
    assert_eq!(investigations::list().len(), 1);
}

#[test]
fn duplicate_names_rejected_case_insensitively() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());

    investigations::create("Alpha", &[], ProviderPolicy::Default).expect("creates");
    let err = investigations::create("alpha", &[], ProviderPolicy::Default).unwrap_err();
    assert!(err.contains("already exists"), "{err}");
    let err = investigations::create("  Alpha  ", &[], ProviderPolicy::Default).unwrap_err();
    assert!(err.contains("already exists"), "trimmed collision: {err}");
    assert!(investigations::create("", &[], ProviderPolicy::Default).is_err());
    assert!(investigations::create("   ", &[], ProviderPolicy::Default).is_err());

    // Uniqueness spans ARCHIVED records too — unarchive must never collide.
    let alpha_id = investigations::list()[0].id.clone();
    investigations::set_archived(&alpha_id, true).expect("archives");
    let err = investigations::create("ALPHA", &[], ProviderPolicy::Default).unwrap_err();
    assert!(err.contains("already exists"), "archived still holds the name: {err}");
    investigations::set_archived(&alpha_id, false).expect("unarchives");

    // Rename obeys the same rule; its own name (a case change) is allowed and
    // the folder name + id stay fixed.
    let beta = investigations::create("Beta", &[], ProviderPolicy::Default).expect("creates");
    let err = investigations::rename(&beta.id, "ALPHA").unwrap_err();
    assert!(err.contains("already exists"), "{err}");
    let renamed = investigations::rename(&beta.id, "BETA").expect("case change of own name");
    assert_eq!(renamed.name, "BETA");
    assert_eq!(renamed.folder_name, "Beta", "folder name NEVER moves on rename");
    assert_eq!(renamed.id, beta.id, "rename keeps the id");
    assert!(investigations::rename(&beta.id, "").is_err());
    assert!(investigations::rename("inv-nope", "Gamma").is_err());
}

#[test]
fn archive_flag_round_trips_non_destructively() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());

    let scope = vec!["cases/cold.md".to_string()];
    let inv = investigations::create("Cold case", &scope, ProviderPolicy::Default).unwrap();
    with_policy(None, || {
        investigations::add_conversation_ref(&inv.id, "c-77", true).expect("ref lands");
    });

    let archived = investigations::set_archived(&inv.id, true).expect("archives");
    assert!(archived.archived);
    // Nothing cascades: the record stays listed with scope + refs intact.
    let rec = &investigations::list()[0];
    assert!(rec.archived);
    assert_eq!(rec.scope_file_ids, scope);
    assert_eq!(rec.conversation_refs, vec!["c-77"]);

    let restored = investigations::set_archived(&inv.id, false).expect("unarchives");
    assert!(!restored.archived);
    assert_eq!(restored.conversation_refs, vec!["c-77"], "restored fully");
    assert!(investigations::set_archived("inv-nope", true).is_err());
}

#[test]
fn history_posture_gates_conversation_refs() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    let inv = investigations::create("Sensitive", &[], ProviderPolicy::Default).unwrap();

    // Client verdict false ⇒ silent no-op, even with no managed policy.
    with_policy(None, || {
        let rec = investigations::add_conversation_ref(&inv.id, "c-1", false).unwrap();
        assert!(rec.conversation_refs.is_empty(), "persistAllowed=false is a no-op");
    });

    // Managed chatHistory off ⇒ no-op even when the client would persist —
    // while STRUCTURE writes keep landing (posture gates refs, not names).
    with_policy(Some(r#"{"v":1,"chatHistory":"off"}"#), || {
        let rec = investigations::add_conversation_ref(&inv.id, "c-1", true).unwrap();
        assert!(rec.conversation_refs.is_empty(), "policy history off is a no-op");
        let renamed = investigations::rename(&inv.id, "Sensitive, renamed").unwrap();
        assert_eq!(renamed.name, "Sensitive, renamed");
        assert!(renamed.conversation_refs.is_empty());
    });

    // Both allow ⇒ the ref lands exactly once (dedupe), and persists.
    with_policy(None, || {
        investigations::add_conversation_ref(&inv.id, "c-1", true).unwrap();
        let rec = investigations::add_conversation_ref(&inv.id, "c-1", true).unwrap();
        assert_eq!(rec.conversation_refs, vec!["c-1"], "deduped");
        assert!(investigations::add_conversation_ref("inv-nope", "c-2", true).is_err());
        assert!(investigations::add_conversation_ref(&inv.id, "   ", true).is_err());
    });
    assert_eq!(investigations::list()[0].conversation_refs, vec!["c-1"]);
}

// --- §2 ask-context resolution over a real store ----------------------------

/// A mocked CLOUD model config — what `model_config()` yields for a keyed
/// remote profile. The resolution must return it untouched except under a
/// local-only investigation.
fn cloud_cfg() -> ModelCfg {
    ModelCfg {
        provider_id: Some("anthropic".to_string()),
        model_id: Some("claude-haiku-4-5".to_string()),
        api_key: Some("sk-test-cloud".to_string()),
    }
}

fn ids(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

#[test]
fn resolve_ask_context_applies_scope_and_swaps_local_only_cfg() {
    let vault_dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());

    // Scope carries a dangling id on purpose — resolution must NOT filter
    // (downstream ignores unknowns; the skip-note honesty counts drops).
    let scoped = investigations::create(
        "Scoped",
        &ids(&["cases/a.md", "cases/gone.md"]),
        ProviderPolicy::Default,
    )
    .unwrap();
    let sealed = investigations::create("Sealed", &[], ProviderPolicy::LocalOnly).unwrap();

    // Default policy: scope becomes the attachments; the mocked cloud cfg
    // passes through UNTOUCHED (key included).
    let (atts, cfg) =
        investigations::resolve_ask_context(Some(&scoped.id), vec![], cloud_cfg());
    assert_eq!(atts, ids(&["cases/a.md", "cases/gone.md"]), "dangling id kept");
    assert_eq!(cfg.provider_id.as_deref(), Some("anthropic"));
    assert_eq!(cfg.api_key.as_deref(), Some("sk-test-cloud"), "cfg passthrough");

    // Explicit per-ask attachments WIN; scope is not intersected.
    let (atts, _) = investigations::resolve_ask_context(
        Some(&scoped.id),
        ids(&["other/c.md"]),
        cloud_cfg(),
    );
    assert_eq!(atts, ids(&["other/c.md"]), "attachments override scope");

    // local-only: the mocked cloud cfg goes in, the LOCAL config comes out —
    // provider "local", the local model sentinel, no key — at the same
    // resolution point model_config() is consulted, so origin_of() stamps
    // "device" and no cloud transport is ever constructed.
    let (atts, cfg) =
        investigations::resolve_ask_context(Some(&sealed.id), vec![], cloud_cfg());
    assert!(atts.is_empty(), "empty scope = whole vault");
    assert_eq!(cfg.provider_id.as_deref(), Some("local"));
    assert_eq!(cfg.model_id.as_deref(), Some("lighthouse-local"));
    assert_eq!(cfg.api_key, None, "no key rides into the private path");

    // Archived investigations resolve like live ones (never weaker).
    investigations::set_archived(&sealed.id, true).unwrap();
    let (_, cfg) = investigations::resolve_ask_context(Some(&sealed.id), vec![], cloud_cfg());
    assert_eq!(cfg.provider_id.as_deref(), Some("local"), "archived still enforces");

    // Absent/blank/unknown investigation → passthrough, cfg untouched.
    for missing in [None, Some(""), Some("   "), Some("inv-nope")] {
        let (atts, cfg) =
            investigations::resolve_ask_context(missing, ids(&["req.md"]), cloud_cfg());
        assert_eq!(atts, ids(&["req.md"]), "passthrough for {missing:?}");
        assert_eq!(cfg.provider_id.as_deref(), Some("anthropic"));
    }
}

// --- Cross-engine parity -----------------------------------------------------

/// The byte-pinned §2 parity fixture. The node twin (test/investigations.
/// test.mjs) builds the SAME vault + investigation and asserts the SAME
/// candidate ids, so scope resolution can't drift between the engines: an
/// investigation scoped to 2 of 3 fixture files yields a retrieval candidate
/// set of exactly those 2 — the out-of-scope decoy loses even though it
/// matches the query best.
#[test]
fn parity_scoped_ask_retrieval_candidate_ids() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    let write = |rel: &str, text: &str| {
        let p = dir.path().join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    };
    write("cases/alpha.md", "the harbor ledger shows the missing shipment entries");
    write("cases/beta.md", "harbor ledger notes about the missing shipment manifest");
    write(
        "cases/decoy.md",
        "missing shipment missing shipment harbor ledger decoy dossier",
    );
    vault::invalidate_walk_cache();
    let all = ids(&["cases/alpha.md", "cases/beta.md", "cases/decoy.md"]);
    for id in &all {
        vault::set_included(id, true);
    }

    let inv = investigations::create(
        "Harbor case",
        &ids(&["cases/alpha.md", "cases/beta.md"]),
        ProviderPolicy::Default,
    )
    .unwrap();

    // Control (no investigation): the decoy is a candidate — it matches best.
    let open = vault::retrieve("missing shipment harbor ledger", &all, 5, &[], &[], false);
    let open_ids: Vec<String> = open.references.iter().map(|r| r.file_id.clone()).collect();
    assert!(
        open_ids.contains(&"cases/decoy.md".to_string()),
        "unscoped ask sees the decoy: {open_ids:?}"
    );

    // Scoped: resolution turns the scope into attachments; the candidate set
    // is exactly the scope, decoy excluded.
    let (atts, _cfg) = investigations::resolve_ask_context(Some(&inv.id), vec![], ModelCfg::default());
    let scoped = vault::retrieve("missing shipment harbor ledger", &all, 5, &[], &atts, false);
    let mut scoped_ids: Vec<String> =
        scoped.references.iter().map(|r| r.file_id.clone()).collect();
    scoped_ids.sort();
    assert_eq!(
        scoped_ids,
        ids(&["cases/alpha.md", "cases/beta.md"]),
        "candidate ids match the TS twin"
    );
}
