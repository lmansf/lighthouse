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
    // passes through UNTOUCHED (key included). No conversation refs yet, so
    // the recall preference (§3) is empty.
    let (atts, cfg, preferred) =
        investigations::resolve_ask_context(Some(&scoped.id), vec![], cloud_cfg());
    assert_eq!(atts, ids(&["cases/a.md", "cases/gone.md"]), "dangling id kept");
    assert_eq!(cfg.provider_id.as_deref(), Some("anthropic"));
    assert_eq!(cfg.api_key.as_deref(), Some("sk-test-cloud"), "cfg passthrough");
    assert!(preferred.is_empty(), "no refs ⇒ no recall preference");

    // Explicit per-ask attachments WIN; scope is not intersected.
    let (atts, _, _) = investigations::resolve_ask_context(
        Some(&scoped.id),
        ids(&["other/c.md"]),
        cloud_cfg(),
    );
    assert_eq!(atts, ids(&["other/c.md"]), "attachments override scope");

    // local-only: the mocked cloud cfg goes in, the LOCAL config comes out —
    // provider "local", the local model sentinel, no key — at the same
    // resolution point model_config() is consulted, so origin_of() stamps
    // "device" and no cloud transport is ever constructed.
    let (atts, cfg, _) =
        investigations::resolve_ask_context(Some(&sealed.id), vec![], cloud_cfg());
    assert!(atts.is_empty(), "empty scope = whole vault");
    assert_eq!(cfg.provider_id.as_deref(), Some("local"));
    assert_eq!(cfg.model_id.as_deref(), Some("lighthouse-local"));
    assert_eq!(cfg.api_key, None, "no key rides into the private path");

    // Archived investigations resolve like live ones (never weaker).
    investigations::set_archived(&sealed.id, true).unwrap();
    let (_, cfg, _) = investigations::resolve_ask_context(Some(&sealed.id), vec![], cloud_cfg());
    assert_eq!(cfg.provider_id.as_deref(), Some("local"), "archived still enforces");

    // The investigation's conversation refs ride out as the recall
    // preference (§3) once recorded (history posture allowing).
    with_policy(None, || {
        investigations::add_conversation_ref(&scoped.id, "c-91", true).unwrap();
    });
    let (_, _, preferred) =
        investigations::resolve_ask_context(Some(&scoped.id), vec![], cloud_cfg());
    assert_eq!(preferred, vec!["c-91"], "conversationRefs become the preference");

    // Absent/blank/unknown investigation → passthrough, cfg untouched,
    // no recall preference.
    for missing in [None, Some(""), Some("   "), Some("inv-nope")] {
        let (atts, cfg, preferred) =
            investigations::resolve_ask_context(missing, ids(&["req.md"]), cloud_cfg());
        assert_eq!(atts, ids(&["req.md"]), "passthrough for {missing:?}");
        assert_eq!(cfg.provider_id.as_deref(), Some("anthropic"));
        assert!(preferred.is_empty(), "no investigation ⇒ empty preference");
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
    let open = vault::retrieve("missing shipment harbor ledger", &all, 5, &[], &[], false, &[]);
    let open_ids: Vec<String> = open.references.iter().map(|r| r.file_id.clone()).collect();
    assert!(
        open_ids.contains(&"cases/decoy.md".to_string()),
        "unscoped ask sees the decoy: {open_ids:?}"
    );

    // Scoped: resolution turns the scope into attachments; the candidate set
    // is exactly the scope, decoy excluded.
    let (atts, _cfg, _) =
        investigations::resolve_ask_context(Some(&inv.id), vec![], ModelCfg::default());
    let scoped = vault::retrieve("missing shipment harbor ledger", &all, 5, &[], &atts, false, &[]);
    let mut scoped_ids: Vec<String> =
        scoped.references.iter().map(|r| r.file_id.clone()).collect();
    scoped_ids.sort();
    assert_eq!(
        scoped_ids,
        ids(&["cases/alpha.md", "cases/beta.md"]),
        "candidate ids match the TS twin"
    );
}

// --- §3 belonging: pins, notes, recall ----------------------------------------

/// Pins belong via `Pin.investigationId` — the single source of truth the
/// view derives `pinRefs` from. Old pins (written before the field existed)
/// load unchanged, stay uncategorized, and keep round-tripping WITHOUT the
/// field; the list op's filter narrows to one investigation without touching
/// the "all" behavior. Mirrored by test/investigations.test.mjs (PARITY).
#[test]
fn pins_belong_and_the_view_derives_pin_refs() {
    let vault_dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());
    let state = vault_dir.path().join(".rag-vault");
    std::fs::create_dir_all(&state).unwrap();

    // A store written BEFORE the field existed (no investigationId anywhere).
    std::fs::write(
        state.join("pins.json"),
        r#"{"pins":[{"id":"pin-legacy000001","question":"legacy pin","sql":"SELECT 1","fileIds":["a.csv"],"createdMs":7}]}"#,
    )
    .unwrap();
    let legacy = lighthouse_core::pins::list();
    assert_eq!(legacy.len(), 1, "old stores still load");
    assert_eq!(legacy[0].investigation_id, None, "…and stay uncategorized");

    let inv = investigations::create("Q3 audit", &[], ProviderPolicy::Default).unwrap();

    // One pin inside the investigation, one global (explicit None), plus a
    // blank id that must normalize to uncategorized.
    let member =
        lighthouse_core::pins::add("member?", "SELECT 2", &ids(&["a.csv"]), Some(&inv.id))
            .expect("adds");
    assert_eq!(member.investigation_id.as_deref(), Some(inv.id.as_str()));
    let global = lighthouse_core::pins::add("global?", "SELECT 3", &[], None).expect("adds");
    assert_eq!(global.investigation_id, None);
    let blank = lighthouse_core::pins::add("blank?", "SELECT 4", &[], Some("  ")).expect("adds");
    assert_eq!(blank.investigation_id, None, "blank id = uncategorized");

    // Round trip: re-read from disk, fields intact; the raw store carries
    // investigationId ONLY on the member pin (absent = omitted, so legacy
    // pins keep round-tripping byte-compatibly).
    let listed = lighthouse_core::pins::list();
    assert_eq!(listed.len(), 4);
    assert_eq!(
        listed.iter().find(|p| p.id == member.id).unwrap().investigation_id.as_deref(),
        Some(inv.id.as_str())
    );
    assert_eq!(listed.iter().find(|p| p.id == "pin-legacy000001").unwrap().investigation_id, None);
    let raw = std::fs::read_to_string(state.join("pins.json")).unwrap();
    assert_eq!(raw.matches("\"investigationId\"").count(), 1, "{raw}");

    // The list filter narrows to the investigation; None keeps "all".
    assert_eq!(lighthouse_core::pins::list_for(None).len(), 4);
    let filtered = lighthouse_core::pins::list_for(Some(&inv.id));
    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0].id, member.id);
    assert!(lighthouse_core::pins::list_for(Some("inv-nope")).is_empty());

    // The view derives pinRefs from the store — the member only.
    let views = investigations::listing();
    assert_eq!(views.len(), 1);
    assert_eq!(views[0].pin_refs, vec![member.id.clone()]);

    // Re-pinning the same SQL from the GLOBAL context replaces the pin and
    // drops its membership (replace semantics, like every other field).
    let repinned = lighthouse_core::pins::add("member?", "SELECT 2", &ids(&["a.csv"]), None)
        .expect("re-pin");
    assert_eq!(repinned.id, member.id, "same SQL ⇒ same pin id");
    assert_eq!(repinned.investigation_id, None);
    assert!(investigations::listing()[0].pin_refs.is_empty(), "membership followed the re-pin");
}

/// Notes belong by location: `notes_subdir` resolves `Lighthouse
/// Notes/<stored folderName>` for a KNOWN investigation only (unknown id and
/// tampered stores reject — the traversal attempt never becomes a write
/// path), exports land under it via the same sanitized write_artifact, and
/// the view derives `noteRefs` from exactly that folder. Mirrored by
/// test/investigations.test.mjs (PARITY, identical error strings).
#[test]
fn notes_land_under_the_investigation_folder_and_derive_note_refs() {
    let vault_dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());
    let state = vault_dir.path().join(".rag-vault");

    let inv = investigations::create("Harbor case", &[], ProviderPolicy::Default).unwrap();
    let subdir = investigations::notes_subdir(&inv.id).expect("resolves");
    assert_eq!(subdir, "Lighthouse Notes/Harbor case");

    // Export through the resolved folder (what the exportChat op does) plus
    // one GLOBAL note — membership = location, so only the first derives.
    let (note_id, note_name) =
        vault::write_artifact(&subdir, "Findings so far", "md", b"# findings").unwrap();
    assert_eq!(note_id, format!("Lighthouse Notes/Harbor case/{note_name}"));
    assert!(vault_dir.path().join(&note_id).exists(), "written inside the vault");
    vault::write_artifact("Lighthouse Notes", "Global note", "md", b"# global").unwrap();

    let views = investigations::listing();
    assert_eq!(views[0].note_refs, vec![note_id.clone()], "prefix scan, member only");

    // Unknown ids reject — a silently-global note would lose its membership.
    assert_eq!(
        investigations::notes_subdir("inv-nope").unwrap_err(),
        "investigation not found"
    );

    // Validate-at-use: hand-tamper the store (the API's sanitizer can't be
    // driven to these) — a traversal segment, and the reserved G6 "Chats"
    // folder. Neither resolves; neither derives notes.
    let tampered = r#"{"v":1,"investigations":[
        {"id":"inv-evil","name":"Evil","createdMs":1,"folderName":"../evil"},
        {"id":"inv-chats","name":"Chats twin","createdMs":2,"folderName":"Chats"}
    ]}"#;
    std::fs::write(state.join("investigations.json"), tampered).unwrap();
    assert_eq!(
        investigations::notes_subdir("inv-evil").unwrap_err(),
        "investigation folder name is not usable",
        "traversal attempt rejected"
    );
    assert_eq!(
        investigations::notes_subdir("inv-chats").unwrap_err(),
        "investigation folder name is not usable",
        "the G6 Chats folder can never be aliased"
    );
    let views = investigations::listing();
    assert!(views.iter().all(|v| v.note_refs.is_empty()), "unusable folders derive nothing");
}

/// §3 recall preference — the byte-pinned parity fixture (the node twin in
/// test/investigations.test.mjs builds the SAME two conversation notes and
/// asserts the SAME reference ORDER): two notes with IDENTICAL bodies score
/// equally on a recall-cued ask; naming one conversation as preferred ranks
/// its note FIRST while the other still surfaces (preference, not
/// exclusion). The preferred ids are the RAW conversation ids — matching the
/// filenames' [cid8] proves retrieve reuses write_conversation_note's exact
/// derivation.
#[test]
fn recall_prefers_the_investigations_conversation_notes() {
    let vault_dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());

    let body = b"We concluded the missing shipment was rerouted through the harbor depot.";
    let (alpha_id, _) =
        vault::write_conversation_note("conv-alpha", "Alpha thread", body).unwrap();
    let (beta_id, _) = vault::write_conversation_note("conv-beta", "Beta thread", body).unwrap();
    vault::invalidate_walk_cache();
    vault::set_included(&alpha_id, true);
    vault::set_included(&beta_id, true);
    let all = vec![alpha_id.clone(), beta_id.clone()];

    // The recall-cued probe ("what did i conclude…" fires the cue; the topic
    // tokens hit both bodies equally).
    let query = "what did i conclude about the missing shipment?";
    let ref_ids = |preferred: &[String]| -> Vec<String> {
        vault::retrieve(query, &all, 5, &[], &[], false, preferred)
            .references
            .iter()
            .map(|r| r.file_id.clone())
            .collect()
    };

    // No preference: both conversation notes surface (equal scores).
    let open = ref_ids(&[]);
    assert!(open.contains(&alpha_id) && open.contains(&beta_id), "{open:?}");

    // Preferring one conversation ranks ITS note first — and flipping the
    // preference flips the order, so it is the preference (not name or
    // insertion luck) that decides. The global note is still present.
    let prefer_alpha = ref_ids(&[String::from("conv-alpha")]);
    assert_eq!(prefer_alpha[0], alpha_id, "preferred first: {prefer_alpha:?}");
    assert!(prefer_alpha.contains(&beta_id), "global still surfaces: {prefer_alpha:?}");

    let prefer_beta = ref_ids(&[String::from("conv-beta")]);
    assert_eq!(prefer_beta[0], beta_id, "flipped preference flips order: {prefer_beta:?}");
    assert!(prefer_beta.contains(&alpha_id), "preference never excludes: {prefer_beta:?}");
}
