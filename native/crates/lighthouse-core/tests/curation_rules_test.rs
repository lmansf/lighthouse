//! Bulk curation rules (openspec: add-curation-rules). Covers the precedence
//! contract (explicit own flag and ancestor exclusion beat rules; deepest
//! scope then last-defined among rules; `clear` masks and yields the default),
//! the three predicates (kind / ext / glob), add-time validation, the
//! non-surprising removal property, the cross-engine parity fixture (the node
//! twin is test/curationRules.test.mjs over the SAME tree + rules), and the
//! end-to-end spec scenario: create a rule, drop a NEW matching file into the
//! vault, and watch it arrive with the rule's flags — with NO per-node write
//! in state.json — while the inspector names the rule.

mod common;

use lighthouse_core::vault::{self, CurationRule, VaultState};

fn write(path: &std::path::Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn kind_rule(id: &str, scope: &str, kind: &str, action: &str) -> CurationRule {
    CurationRule {
        id: id.to_string(),
        scope: scope.to_string(),
        kind: Some(kind.to_string()),
        ext: None,
        glob: None,
        action: action.to_string(),
    }
}

fn ext_rule(id: &str, scope: &str, exts: &[&str], action: &str) -> CurationRule {
    CurationRule {
        id: id.to_string(),
        scope: scope.to_string(),
        kind: None,
        ext: Some(exts.iter().map(|e| e.to_string()).collect()),
        glob: None,
        action: action.to_string(),
    }
}

fn glob_rule(id: &str, scope: &str, glob: &str, action: &str) -> CurationRule {
    CurationRule {
        id: id.to_string(),
        scope: scope.to_string(),
        kind: None,
        ext: None,
        glob: Some(glob.to_string()),
        action: action.to_string(),
    }
}

// --- Precedence (unit, via the public resolvers on synthetic state) --------------

#[test]
fn explicit_own_flag_beats_any_rule() {
    let mut st = VaultState::default();
    st.rules.push(ext_rule("r1", "reports", &["xlsx"], "include"));
    // The rule decides while the user hasn't spoken…
    assert!(vault::is_effectively_included("reports/q.xlsx", &st, false, true));
    // …but a hand-excluded file stays excluded (spec scenario).
    st.included.insert("reports/q.xlsx".to_string(), false);
    assert!(!vault::is_effectively_included("reports/q.xlsx", &st, false, true));
    // And a hand-included file survives an exclude rule.
    let mut st2 = VaultState::default();
    st2.rules.push(ext_rule("r1", "", &["md"], "exclude"));
    st2.included.insert("notes.md".to_string(), true);
    assert!(vault::is_effectively_included("notes.md", &st2, false, true));
}

#[test]
fn ancestor_exclusion_is_inviolable_by_rules() {
    // Spec scenario: a folder is explicitly excluded and a rule scoped INSIDE
    // it says include — every descendant remains excluded, under either
    // global default.
    let mut st = VaultState::default();
    st.included.insert("archive".to_string(), false);
    st.rules.push(glob_rule("r1", "archive", "**", "include"));
    for default_in in [false, true] {
        assert!(
            !vault::is_effectively_included("archive/deep/file.md", &st, default_in, true),
            "rules cannot resurrect an excluded subtree (default_in={default_in})"
        );
    }
}

#[test]
fn deepest_scope_wins_then_last_defined_and_clear_masks() {
    // Spec scenario: a vault-root rule excludes images, a /design rule
    // includes them — images under /design are in, elsewhere out.
    let mut st = VaultState::default();
    st.rules.push(kind_rule("root", "", "image", "exclude"));
    st.rules.push(kind_rule("design", "design", "image", "include"));
    assert!(vault::is_effectively_included("design/logo.png", &st, true, true));
    assert!(!vault::is_effectively_included("misc/photo.png", &st, true, true));

    // Within ONE scope the last-defined wins, regardless of predicate shape.
    let mut st2 = VaultState::default();
    st2.rules.push(ext_rule("a", "", &["txt"], "include"));
    st2.rules.push(ext_rule("b", "", &["txt"], "exclude"));
    assert!(!vault::is_effectively_included("a.txt", &st2, false, true));

    // `clear` is first-class: it masks a shallower rule and yields the global
    // default — whichever that is.
    let mut st3 = VaultState::default();
    st3.rules.push(kind_rule("inc", "reports", "tabular", "include"));
    st3.rules.push(kind_rule("clr", "reports/private", "tabular", "clear"));
    assert!(vault::is_effectively_included("reports/q.xlsx", &st3, false, true));
    assert!(
        !vault::is_effectively_included("reports/private/salary.xlsx", &st3, false, true),
        "clear masks the include and falls to the exclude default"
    );
    assert!(
        vault::is_effectively_included("reports/private/salary.xlsx", &st3, true, true),
        "clear yields the include default when that is the global setting"
    );
}

#[test]
fn folders_never_take_the_rule_layer() {
    // A glob that would match the folder path must not repaint the folder —
    // rules apply to every matching FILE under their scope, nothing else.
    let mut st = VaultState::default();
    st.rules.push(glob_rule("r1", "", "**", "include"));
    assert!(vault::is_effectively_included("reports/q.md", &st, false, true));
    assert!(!vault::is_effectively_included("reports", &st, false, false));
    assert!(!vault::is_effectively_local_only("reports", &st, false));
}

#[test]
fn local_only_axis_explicit_beats_rules_and_clear_unmarks() {
    // A local-only rule marks matching files where the user hasn't spoken.
    let mut st = VaultState::default();
    st.rules.push(glob_rule("lo", "hr", "**", "local-only"));
    assert!(vault::is_effectively_local_only("hr/salaries.xlsx", &st, true));
    assert!(!vault::is_effectively_local_only("public/notes.md", &st, true));

    // A rule NEVER removes an explicit mark: a deeper `clear` cannot unmark a
    // file the user marked by hand…
    st.local_only.insert("hr/salaries.xlsx".to_string(), true);
    st.rules.push(glob_rule("clr", "hr", "salaries.xlsx", "clear"));
    assert!(vault::is_effectively_local_only("hr/salaries.xlsx", &st, true));
    // …and an explicit own `false` ("allow cloud") shields the file from
    // local-only rules — explicit user state always beats rules.
    st.local_only.insert("hr/handbook.md".to_string(), false);
    assert!(!vault::is_effectively_local_only("hr/handbook.md", &st, true));
    // An ancestor's explicit mark still wins over everything (as shipped).
    let mut st2 = VaultState::default();
    st2.local_only.insert("hr".to_string(), true);
    st2.rules.push(glob_rule("clr", "hr", "**", "clear"));
    assert!(vault::is_effectively_local_only("hr/anything.md", &st2, true));

    // `clear` DOES mask a broader local-only rule where nothing is explicit.
    let mut st3 = VaultState::default();
    st3.rules.push(glob_rule("lo", "hr", "**", "local-only"));
    st3.rules.push(glob_rule("clr", "hr/public", "**", "clear"));
    assert!(vault::is_effectively_local_only("hr/salaries.xlsx", &st3, true));
    assert!(!vault::is_effectively_local_only("hr/public/faq.md", &st3, true));
}

// --- Predicates -------------------------------------------------------------------

#[test]
fn predicates_kind_ext_glob() {
    // kind:"tabular" is the catalog gate; ext matching is lowercase.
    let mut st = VaultState::default();
    st.rules.push(kind_rule("t", "", "tabular", "include"));
    for f in ["a.csv", "b.tsv", "c.parquet", "d.xlsx", "e.xlsm", "f.xls", "G.XLSX"] {
        assert!(vault::is_effectively_included(f, &st, false, true), "{f} is tabular");
    }
    assert!(!vault::is_effectively_included("notes.md", &st, false, true));

    let mut st2 = VaultState::default();
    st2.rules.push(kind_rule("d", "", "document", "include"));
    for f in ["a.pdf", "b.docx", "c.md", "d.txt", "e.rtf", "f.odt", "g.pptx"] {
        assert!(vault::is_effectively_included(f, &st2, false, true), "{f} is a document");
    }
    assert!(!vault::is_effectively_included("sheet.xlsx", &st2, false, true));

    let mut st3 = VaultState::default();
    st3.rules.push(kind_rule("i", "", "image", "include"));
    for f in ["a.png", "b.jpg", "c.jpeg", "d.webp", "e.bmp", "f.tif", "g.tiff"] {
        assert!(vault::is_effectively_included(f, &st3, false, true), "{f} is an image");
    }
    assert!(!vault::is_effectively_included("a.pdf", &st3, false, true));

    // ext list: dot-less lowercase entries; extension-less files never match.
    let mut st4 = VaultState::default();
    st4.rules.push(ext_rule("e", "", &["xlsx", "csv"], "include"));
    assert!(vault::is_effectively_included("Q3 Sales.XLSX", &st4, false, true));
    assert!(vault::is_effectively_included("data.csv", &st4, false, true));
    assert!(!vault::is_effectively_included("notes.md", &st4, false, true));
    assert!(!vault::is_effectively_included("README", &st4, false, true));

    // glob is relative to the SCOPE, not the vault root.
    let mut st5 = VaultState::default();
    st5.rules.push(glob_rule("g", "reports", "2024/*.xlsx", "include"));
    assert!(vault::is_effectively_included("reports/2024/q1.xlsx", &st5, false, true));
    assert!(
        !vault::is_effectively_included("reports/2023/q1.xlsx", &st5, false, true),
        "different subfolder"
    );
    assert!(
        !vault::is_effectively_included("2024/q1.xlsx", &st5, false, true),
        "outside the scope entirely"
    );
    // The vault-root scope covers vault-resident ids only — a linked (extN)
    // subtree is its own folder scope.
    let mut st6 = VaultState::default();
    st6.references.insert(
        "ext0".to_string(),
        // Reference paths are irrelevant to scope math; any value works here.
        serde_json::from_value(serde_json::json!({"path": "/x", "name": "x", "kind": "folder"}))
            .unwrap(),
    );
    st6.rules.push(glob_rule("g", "", "**", "include"));
    assert!(vault::is_effectively_included("loose.md", &st6, false, true));
    assert!(
        !vault::is_effectively_included("ext0/inside.md", &st6, false, true),
        "a vault-root rule does not reach into linked roots"
    );
    st6.rules.push(glob_rule("g2", "ext0", "**", "include"));
    assert!(vault::is_effectively_included("ext0/inside.md", &st6, false, true));
}

// --- Add-time validation ----------------------------------------------------------

#[test]
fn add_rule_validates_and_mints_ids() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());

    // Whitelists: action, kind; exactly one predicate; glob parse; ext shape.
    assert!(vault::add_rule("x", None, None, None, "banish").is_err(), "unknown action");
    assert!(vault::add_rule("x", None, None, None, "include").is_err(), "no predicate");
    assert!(
        vault::add_rule("x", Some("tabular"), None, Some("**"), "include").is_err(),
        "two predicates"
    );
    assert!(
        vault::add_rule("x", Some("spreadsheety"), None, None, "include").is_err(),
        "unknown kind"
    );
    assert!(
        vault::add_rule("x", None, None, Some("a**b"), "include").is_err(),
        "** inside a segment"
    );
    assert!(
        vault::add_rule("x", None, None, Some("/lead"), "include").is_err(),
        "empty glob segment"
    );
    let blank = vec![" ".to_string()];
    assert!(
        vault::add_rule("x", None, Some(&blank), None, "include").is_err(),
        "blank ext list"
    );
    let separator = vec!["x/y".to_string()];
    assert!(
        vault::add_rule("x", None, Some(&separator), None, "include").is_err(),
        "separator inside an extension"
    );
    assert!(vault::add_rule("/x", Some("tabular"), None, None, "include").is_err(), "bad scope");

    // A valid add mints a short id and normalizes extensions.
    let exts = vec![".XLSX".to_string(), "csv".to_string()];
    let rule = vault::add_rule("reports", None, Some(&exts), None, "include").unwrap();
    assert!(rule.id.starts_with('r') && rule.id.len() == 9, "short random id: {}", rule.id);
    assert_eq!(rule.ext.as_deref(), Some(&["xlsx".to_string(), "csv".to_string()][..]));
    assert_eq!(vault::list_rules().len(), 1);
    assert_eq!(
        vault::rule_display_name(&rule),
        ".xlsx/.csv files in /reports",
        "generated display name derives from predicate + scope"
    );
}

// --- Removal reverts only what the rule decided ------------------------------------

#[test]
fn removing_a_rule_reverts_only_rule_decided_files() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    write(&dir.path().join("reports/auto.xlsx"), "a,b\n1,2\n");
    write(&dir.path().join("reports/hand.xlsx"), "a,b\n3,4\n");
    vault::invalidate_walk_cache();

    // One file was hand-included; the other is decided by the rule alone.
    vault::set_included("reports/hand.xlsx", true);
    let rule = vault::add_rule("reports", Some("tabular"), None, None, "include").unwrap();
    let mut active = vault::active_included_file_ids();
    active.sort();
    assert_eq!(active, vec!["reports/auto.xlsx".to_string(), "reports/hand.xlsx".to_string()]);

    // Deleting the rule restores exactly the rule-decided file to the default;
    // the hand-toggled file keeps its state (spec scenario: non-surprising).
    vault::remove_rule(&rule.id);
    assert_eq!(vault::active_included_file_ids(), vec!["reports/hand.xlsx".to_string()]);
}

// --- Rules follow their folder (move/rename remap, like the flag maps) -------------

#[test]
fn rule_scopes_remap_on_rename_and_move() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    write(&dir.path().join("reports/q1.xlsx"), "a,b\n1,2\n");
    vault::invalidate_walk_cache();
    vault::add_rule("reports", Some("tabular"), None, None, "include").unwrap();
    assert_eq!(vault::active_included_file_ids(), vec!["reports/q1.xlsx".to_string()]);

    let renamed = vault::rename_node("reports", "ledgers").unwrap();
    assert_eq!(renamed, "ledgers");
    vault::invalidate_walk_cache();
    assert_eq!(
        vault::list_rules()[0].scope,
        "ledgers",
        "the rule followed its folder instead of orphaning"
    );
    assert_eq!(vault::active_included_file_ids(), vec!["ledgers/q1.xlsx".to_string()]);
}

// --- Cross-engine parity ------------------------------------------------------------

/// The byte-pinned parity fixture. The node twin (test/curationRules.test.mjs)
/// builds the SAME vault tree and adds the SAME rules in the SAME order, then
/// asserts these exact effective sets — so rule evaluation can't drift between
/// the engines. (Shared-fidelity predicates only: kind:"tabular", ext, glob.)
#[test]
fn parity_effective_sets_from_shared_fixture() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    for (path, text) in [
        ("loose.md", "loose notes"),
        ("q2.md", "quarterly two"),
        ("a.txt", "alpha"),
        ("reports/q1.xlsx", "a,b\n1,2\n"),
        ("reports/q2.csv", "a,b\n3,4\n"),
        ("reports/notes.md", "notes"),
        ("reports/private/salary.xlsx", "a,b\n5,6\n"),
    ] {
        write(&dir.path().join(path), text);
    }
    vault::invalidate_walk_cache();

    // The SAME seven rules, in the SAME order, as the node twin.
    vault::add_rule("", None, Some(&["md".to_string()]), None, "include").unwrap();
    vault::add_rule("reports", Some("tabular"), None, None, "include").unwrap();
    vault::add_rule("reports/private", Some("tabular"), None, None, "clear").unwrap();
    vault::add_rule("", None, None, Some("**/q2.*"), "exclude").unwrap();
    vault::add_rule("", None, Some(&["txt".to_string()]), None, "include").unwrap();
    vault::add_rule("", None, Some(&["txt".to_string()]), None, "exclude").unwrap();
    vault::add_rule("reports", None, None, Some("**"), "local-only").unwrap();

    let mut active = vault::active_included_file_ids();
    active.sort();
    assert_eq!(
        active,
        vec![
            "loose.md".to_string(),
            "reports/notes.md".to_string(),
            "reports/q1.xlsx".to_string(),
            "reports/q2.csv".to_string(),
        ],
        "effective included set (deepest-scope, last-defined, clear, ext/kind/glob)"
    );
    // Device path: local-only rules are inert — the full set is shareable.
    let mut device = vault::shareable_file_ids(false);
    device.sort();
    assert_eq!(device, active);
    // Cloud path: the reports/** local-only rule withholds the whole subtree.
    assert_eq!(vault::shareable_file_ids(true), vec!["loose.md".to_string()]);
}

// --- End-to-end: the future arrival (spec scenario) --------------------------------

#[test]
fn a_future_arrival_resolves_by_rule_with_no_per_node_write_and_named_attribution() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    std::fs::create_dir_all(dir.path().join("reports")).unwrap();
    vault::invalidate_walk_cache();

    // Create the spec's rule: "spreadsheets in /reports → include" (plus a
    // local-only rule so both axes are exercised by the same arrival).
    let rule = vault::add_rule("reports", Some("tabular"), None, None, "include").unwrap();
    let lo_rule = vault::add_rule("reports", Some("tabular"), None, None, "local-only").unwrap();
    assert_eq!(vault::rule_display_name(&rule), "spreadsheets in /reports");

    // A NEW matching file lands AFTER the rule exists (simulating the watcher/
    // scan pickup with an explicit invalidate, as the vault tests do).
    write(&dir.path().join("reports/late.xlsx"), "region,amount\nNE,1\n");
    vault::invalidate_walk_cache();

    // The next walk resolves it with the rule's flags — no user action.
    let nodes = vault::list_nodes();
    let late = nodes.iter().find(|n| n.id == "reports/late.xlsx").expect("walked");
    assert!(late.rag_included, "included on first appearance");
    assert!(late.local_only, "local-only on first appearance");
    assert_eq!(vault::active_included_file_ids(), vec!["reports/late.xlsx".to_string()]);
    assert!(vault::shareable_file_ids(true).is_empty(), "cloud path withholds it");

    // NO per-node write happened: state.json's flag maps never mention the
    // file — the rule is a resolution layer, not a stamp.
    let raw = std::fs::read_to_string(dir.path().join(".rag-vault/state.json")).unwrap();
    let state: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(
        state["included"].as_object().map(|m| m.len()),
        Some(0),
        "no inclusion flag written: {raw}"
    );
    assert_eq!(
        state["localOnly"].as_object().map(|m| m.len()),
        Some(0),
        "no local-only flag written: {raw}"
    );
    assert_eq!(state["rules"].as_array().map(|a| a.len()), Some(2), "both rules persisted");

    // The inspector attributes both flags to the rules BY NAME.
    let inspection = lighthouse_core::inspect::inspect("reports/late.xlsx", None);
    assert_eq!(inspection.included, Some(true));
    let inc_by = inspection.included_by.expect("attribution present");
    assert_eq!(inc_by.source, "rule");
    assert_eq!(inc_by.rule_id.as_deref(), Some(rule.id.as_str()));
    assert_eq!(inc_by.rule_name.as_deref(), Some("spreadsheets in /reports"));
    let lo_by = inspection.local_only_by.expect("local-only attribution present");
    assert_eq!(lo_by.source, "rule");
    assert_eq!(lo_by.rule_id.as_deref(), Some(lo_rule.id.as_str()));

    // An explicit toggle flips the attribution to "explicit" (and wins).
    vault::set_included("reports/late.xlsx", false);
    let after = lighthouse_core::inspect::inspect("reports/late.xlsx", None);
    assert_eq!(after.included, Some(false));
    assert_eq!(after.included_by.map(|a| a.source), Some("explicit".to_string()));
}

// --- Listing enrichment (orphans + labels) ------------------------------------------

#[test]
fn listing_marks_orphaned_scopes_and_labels() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    std::fs::create_dir_all(dir.path().join("reports")).unwrap();
    vault::invalidate_walk_cache();
    vault::add_rule("reports", Some("tabular"), None, None, "include").unwrap();
    vault::add_rule("gone", Some("tabular"), None, None, "include").unwrap();
    vault::add_rule("", None, Some(&["md".to_string()]), None, "include").unwrap();

    let listing = vault::rules_listing();
    assert_eq!(listing.len(), 3);
    assert!(!listing[0].orphaned, "existing folder is not orphaned");
    assert_eq!(listing[0].scope_label, "reports");
    assert_eq!(listing[0].name, "spreadsheets in /reports");
    assert!(listing[1].orphaned, "missing folder IS orphaned (kept for cleanup)");
    assert!(!listing[2].orphaned, "the vault root always exists");
    assert_eq!(listing[2].scope_label, "Vault");
}
