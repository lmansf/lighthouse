//! Retrieval quality harness: a golden-question benchmark comparing lexical
//! retrieval against hybrid (lexical + embeddings, B2) on a synthetic vault.
//!
//! Two question classes:
//!   - `semantic`: the query shares NO content words with its target file
//!     (pure paraphrase — "Q3 revenue" vs "third-quarter sales"). Lexical
//!     retrieval is expected to fail these; hybrid is expected to catch them.
//!   - `keyword`: the query's words appear verbatim in the target. Lexical
//!     already wins these — they guard against hybrid regressing the basics.
//!
//! Modes:
//!   - No LIGHTHOUSE_EMBED_URL: lexical-only report (harness smoke).
//!   - LIGHTHOUSE_EMBED_URL set (llama-server --embedding, e.g. the
//!     asset-digests workflow): runs BOTH modes, prints the comparison, and
//!     enforces floors — the process exits non-zero when hybrid loses ground.
//!
//! Run: cargo run -p lighthouse-core --example retrieval_eval

use std::fs;

use lighthouse_core::contracts::NodeKind;
use lighthouse_core::vault;

struct Golden {
    query: &'static str,
    expect: &'static str, // target file name
    class: &'static str,  // "semantic" | "keyword"
}

/// (file name, contents). Semantic targets deliberately avoid their query's
/// words; keyword targets contain them verbatim; fillers add ranking noise.
const CORPUS: &[(&str, &str)] = &[
    // --- semantic targets -------------------------------------------------
    (
        "quarterly-results.md",
        "Third-quarter sales came in strong. Income from customers grew 12% over the summer period, led by the enterprise tier.",
    ),
    (
        "new-hire-guide.md",
        "A step-by-step welcome plan for people joining the team: accounts on day one, badge photo, a buddy for the first week, and goals for the first month.",
    ),
    (
        "time-off-rules.md",
        "How paid leave works here: request days in the portal, manager approval within two days, carryover capped at five days, public holidays excluded.",
    ),
    (
        "network-troubleshooting.md",
        "When the wireless connection keeps dropping: restart the router, forget and rejoin the SSID, and update the adapter driver before blaming the ISP.",
    ),
    (
        "retention-report.md",
        "Why subscribers cancel: pricing surprises and unused seats. Roughly 3% of accounts leave each month; save offers recover a third of them.",
    ),
    (
        "breach-playbook.md",
        "What to do when systems are compromised: contain the affected hosts, assess what data was touched, notify the on-call lead, and write the timeline.",
    ),
    // --- keyword targets --------------------------------------------------
    (
        "kubernetes-notes.md",
        "Kubernetes deployment yaml gotchas: resource limits, liveness probes, and rolling update surge settings we standardized on.",
    ),
    (
        "espresso-maintenance.md",
        "Espresso machine descaling: run the citric solution monthly, flush twice, and backflush the group head weekly.",
    ),
    (
        "playwright-debugging.md",
        "Playwright test flakiness usually traces to unawaited navigation or animations; prefer locators with auto-wait and disable transitions in CI.",
    ),
    (
        "mortgage-calc.md",
        "Mortgage amortization table notes: early payments are mostly interest; extra principal in year one shortens the loan the most.",
    ),
    // --- cross-file span targets (§3): the answer to "staff and payroll
    //     across the offices" lives HALF in each file, so both must surface. ---
    (
        "office-london.md",
        "The London office has 40 people on staff. Monthly payroll for the London site is 320,000 pounds, up slightly this year.",
    ),
    (
        "office-berlin.md",
        "The Berlin office has 25 people on staff. Monthly payroll for the Berlin site is 180,000 euros, flat versus last year.",
    ),
    // --- fillers (ranking noise) ------------------------------------------
    ("meeting-notes-jan.md", "Discussed roadmap priorities and the hiring plan; action items assigned to owners with dates."),
    ("design-principles.md", "Prefer clarity over cleverness. Small reversible steps. Make the default path the safe path."),
    ("recipe-collection.md", "Grandma's chocolate cake needs butter, cocoa, and patience. The bread wants a cold overnight proof."),
    ("travel-log.md", "Kyoto in autumn: temples at dawn, maple leaves, and the best bowl of ramen of the trip."),
    ("garden-journal.md", "Tomatoes went in late this year; the basil bolted early. Try shade cloth for the lettuce in July."),
    ("book-notes.md", "Notes on systems thinking: stocks, flows, feedback loops, and why delays cause oscillation."),
];

const GOLDEN: &[Golden] = &[
    Golden { query: "Q3 revenue figures", expect: "quarterly-results.md", class: "semantic" },
    Golden { query: "employee onboarding checklist", expect: "new-hire-guide.md", class: "semantic" },
    Golden { query: "vacation policy", expect: "time-off-rules.md", class: "semantic" },
    Golden { query: "fix wifi problems", expect: "network-troubleshooting.md", class: "semantic" },
    Golden { query: "customer churn analysis", expect: "retention-report.md", class: "semantic" },
    Golden { query: "security incident response", expect: "breach-playbook.md", class: "semantic" },
    Golden { query: "kubernetes deployment yaml", expect: "kubernetes-notes.md", class: "keyword" },
    Golden { query: "espresso machine descaling", expect: "espresso-maintenance.md", class: "keyword" },
    Golden { query: "playwright test flakiness", expect: "playwright-debugging.md", class: "keyword" },
    Golden { query: "mortgage amortization table", expect: "mortgage-calc.md", class: "keyword" },
];

/// §3 cross-file span floor: a question whose answer requires BOTH files. Both
/// must surface in the top-K references, or the answer can only single-source.
struct Span {
    query: &'static str,
    expect: [&'static str; 2],
}

const SPAN: &[Span] = &[Span {
    query: "total staff and payroll across the offices",
    expect: ["office-london.md", "office-berlin.md"],
}];

const K: usize = 5;

#[derive(Default, Clone, Copy)]
struct Agg {
    n: usize,
    hit1: usize,
    hit3: usize,
    mrr: f64,
}

impl Agg {
    fn add(&mut self, rank: Option<usize>) {
        self.n += 1;
        if let Some(r) = rank {
            if r == 1 {
                self.hit1 += 1;
            }
            if r <= 3 {
                self.hit3 += 1;
            }
            self.mrr += 1.0 / r as f64;
        }
    }
    fn line(&self, label: &str) -> String {
        format!(
            "{label:<22} hit@1 {:>4.0}%   hit@3 {:>4.0}%   MRR {:.3}   (n={})",
            100.0 * self.hit1 as f64 / self.n.max(1) as f64,
            100.0 * self.hit3 as f64 / self.n.max(1) as f64,
            self.mrr / self.n.max(1) as f64,
            self.n
        )
    }
}

/// 1-based rank of the expected file among the returned references.
fn rank_of(query: &str, ids: &[String], expect: &str) -> Option<usize> {
    let r = vault::retrieve(query, ids, K, &[], &[], false, &[]);
    r.references
        .iter()
        .position(|reference| reference.name == expect)
        .map(|p| p + 1)
}

/// §3: do BOTH expected files surface in the top-K references? A single-sourcing
/// retriever fails this — only one half of the answer is available.
fn both_cited(query: &str, ids: &[String], expect: &[&str; 2]) -> bool {
    let r = vault::retrieve(query, ids, K, &[], &[], false, &[]);
    let names: Vec<&str> = r.references.iter().map(|x| x.name.as_str()).collect();
    expect.iter().all(|e| names.contains(e))
}

fn run_mode(label: &str, ids: &[String], detail: bool) -> (Agg, Agg, Agg) {
    let (mut all, mut sem, mut kw) = (Agg::default(), Agg::default(), Agg::default());
    for g in GOLDEN {
        let rank = rank_of(g.query, ids, g.expect);
        all.add(rank);
        if g.class == "semantic" {
            sem.add(rank);
        } else {
            kw.add(rank);
        }
        if detail {
            println!(
                "  [{label}] {:<34} → {:<28} rank {}",
                g.query,
                g.expect,
                rank.map(|r| r.to_string()).unwrap_or_else(|| "—".into())
            );
        }
    }
    (all, sem, kw)
}

fn main() {
    // The engine reads its vault from env, same as the servers do.
    let dir = std::env::temp_dir().join(format!("lh-retrieval-eval-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("create eval vault");
    std::env::set_var("VAULT_DIR", &dir);
    std::env::remove_var("LIGHTHOUSE_SETTINGS_FILE");
    for (name, text) in CORPUS {
        fs::write(dir.join(name), text).expect("write corpus file");
    }

    let ids: Vec<String> = vault::list_nodes()
        .into_iter()
        .filter(|n| n.kind == NodeKind::File)
        .map(|n| n.id)
        .collect();
    assert_eq!(ids.len(), CORPUS.len(), "corpus mis-listed");
    for id in &ids {
        vault::set_included(id, true);
    }

    let embed_url = std::env::var("LIGHTHOUSE_EMBED_URL").ok().filter(|v| !v.is_empty());

    // --- lexical baseline (embeddings forced off via the toggle-free path:
    //     without LIGHTHOUSE_EMBED_URL the web build never embeds; with it,
    //     measure BEFORE the warm pass by disabling semantic search). ---
    let settings = dir.join("eval-settings.json");
    if embed_url.is_some() {
        fs::write(&settings, r#"{ "semanticSearch": false }"#).unwrap();
        std::env::set_var("LIGHTHOUSE_SETTINGS_FILE", &settings);
    }
    println!("== lexical ==");
    let (lex_all, lex_sem, lex_kw) = run_mode("lex", &ids, true);
    println!("{}", lex_all.line("lexical / all"));
    println!("{}", lex_sem.line("lexical / semantic"));
    println!("{}", lex_kw.line("lexical / keyword"));

    let Some(_) = embed_url else {
        println!("\nLIGHTHOUSE_EMBED_URL not set — lexical-only run (no floors enforced).");
        let _ = fs::remove_dir_all(&dir);
        return;
    };

    // --- hybrid: enable, warm, wait for coverage ---
    fs::write(&settings, r#"{ "semanticSearch": true }"#).unwrap();
    lighthouse_core::embed::nudge_warm();
    let canary = GOLDEN.iter().find(|g| g.class == "semantic").unwrap();
    let mut warmed = false;
    for _ in 0..240 {
        std::thread::sleep(std::time::Duration::from_millis(250));
        if rank_of(canary.query, &ids, canary.expect).is_some() {
            warmed = true;
            break;
        }
        lighthouse_core::embed::nudge_warm();
    }
    if !warmed {
        eprintln!("vector warm pass never activated hybrid retrieval — is the embedding server up?");
        std::process::exit(1);
    }

    println!("\n== hybrid ==");
    let (hy_all, hy_sem, hy_kw) = run_mode("hyb", &ids, true);
    println!("{}", hy_all.line("hybrid / all"));
    println!("{}", hy_sem.line("hybrid / semantic"));
    println!("{}", hy_kw.line("hybrid / keyword"));

    // --- floors ---
    let mut failures: Vec<String> = Vec::new();
    if hy_all.hit3 < lex_all.hit3 {
        failures.push(format!(
            "hybrid overall hit@3 ({}) below lexical ({})",
            hy_all.hit3, lex_all.hit3
        ));
    }
    if (hy_sem.hit3 as f64) < 0.6 * hy_sem.n as f64 {
        failures.push(format!(
            "hybrid semantic hit@3 {}/{} below the 60% floor",
            hy_sem.hit3, hy_sem.n
        ));
    }
    if hy_kw.hit3 + 1 < lex_kw.hit3 {
        failures.push(format!(
            "hybrid keyword hit@3 ({}) regressed more than one question vs lexical ({})",
            hy_kw.hit3, lex_kw.hit3
        ));
    }
    // §3 cross-file span: a two-file question must surface BOTH halves, or the
    // answer can only single-source. This is what makes cross-file synthesis
    // possible at all — the router (synth::multi_file_span) needs two files in
    // the references to fire.
    println!("\n== cross-file span (§3) ==");
    for s in SPAN {
        let ok = both_cited(s.query, &ids, &s.expect);
        println!(
            "  {:<44} → both cited: {}",
            s.query,
            if ok { "yes" } else { "NO" }
        );
        if !ok {
            failures.push(format!(
                "cross-file span '{}' did not surface both {:?} in top-{K}",
                s.query, s.expect
            ));
        }
    }

    let _ = fs::remove_dir_all(&dir);
    if failures.is_empty() {
        println!("\nretrieval eval OK — hybrid holds the floors.");
    } else {
        for f in &failures {
            eprintln!("FLOOR VIOLATION: {f}");
        }
        std::process::exit(1);
    }
}
