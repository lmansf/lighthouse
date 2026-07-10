//! Answer artifacts over a real temp vault: write_artifact name repair +
//! collision safety, and the Save-as-CSV path end to end
//! (openspec: add-answer-artifacts).

mod common;

use lighthouse_core::analytics::run_direct_save;
use lighthouse_core::vault::{self, write_artifact};

fn write(path: &std::path::Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

#[test]
fn write_artifact_repairs_names_and_never_overwrites() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());

    // A hostile hint is repaired, not rejected — and stays inside the vault.
    let (id, name) = write_artifact("Lighthouse Notes", "../../evil name", "md", b"x").unwrap();
    assert_eq!(id, format!("Lighthouse Notes/{name}"));
    assert!(name.starts_with("..-..-evil name") || name.contains("evil name"), "{name}");
    let abs = dir.path().join(&id);
    assert!(abs.exists(), "written inside the vault: {abs:?}");

    // An empty / dotfile hint falls back instead of failing.
    let (_, fallback) = write_artifact("Lighthouse Notes", "...", "md", b"y").unwrap();
    assert_eq!(fallback, "result.md");

    // Same hint again ⇒ collision suffix, both files intact.
    let (_, first) = write_artifact("Lighthouse Results", "totals", "csv", b"a").unwrap();
    let (_, second) = write_artifact("Lighthouse Results", "totals", "csv", b"b").unwrap();
    assert_eq!(first, "totals.csv");
    assert_eq!(second, "totals (1).csv");
    assert_eq!(
        std::fs::read(dir.path().join("Lighthouse Results/totals.csv")).unwrap(),
        b"a"
    );
}

#[tokio::test]
async fn save_as_csv_writes_a_queryable_vault_file() {
    let vault_dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());
    write(
        &vault_dir.path().join("sales.csv"),
        "region,amount\nNE,100\nNW,50\nNE,25\n",
    );
    vault::invalidate_walk_cache();
    // Direct execution honors AI visibility — only included files register.
    vault::set_included("sales.csv", true);

    let ids = vec!["sales.csv".to_string()];
    let (preview, saved) = run_direct_save(
        "SELECT region, SUM(amount) AS total FROM sales GROUP BY region ORDER BY total DESC",
        &ids,
        "Totals by region",
    )
    .await
    .expect("save runs");

    // The preview carries the normal narration + provenance.
    assert!(preview.markdown.contains("NE"), "{}", preview.markdown);
    assert!(preview.footer.contains("*Query used:*"), "{}", preview.footer);

    // The artifact is a real, full-fidelity CSV in Lighthouse Results/.
    assert_eq!(saved.name, "Totals by region.csv");
    assert_eq!(saved.rows, 2);
    let csv = std::fs::read_to_string(
        vault_dir.path().join("Lighthouse Results").join(&saved.name),
    )
    .unwrap();
    assert_eq!(csv, "region,total\r\nNE,125\r\nNW,50\r\n");

    // And the walk sees it immediately — it's ordinary vault input now.
    let nodes = vault::list_nodes();
    assert!(
        nodes.iter().any(|n| n.id == saved.id),
        "saved artifact appears in the tree"
    );

    // A write statement is still rejected on the save path.
    let err = run_direct_save("DROP TABLE sales", &ids, "nope").await.unwrap_err();
    assert!(err.contains("SELECT"), "{err}");
    assert!(!vault_dir.path().join("Lighthouse Results/nope.csv").exists());
}
