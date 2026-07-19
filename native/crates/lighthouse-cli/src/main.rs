//! `lighthouse` — the headless CLI (openspec: add-automation §2).
//!
//! The first true headless ask: no webview, no loopback HTTP. `ask` drives
//! `lighthouse_core::ask::run_headless_ask` — the shared audited chokepoint (§1)
//! — so a scripted ask is recorded in the audit + egress ledger EXACTLY like an
//! app ask, by construction. `fork`/`export` drive the §4 investigation engine
//! functions; `export` composes the render with `notes_subdir` +
//! `write_artifact` in-process, mirroring the `routes.rs` `action:"export"` arm.
//!
//! The provenance a caller sees is READ from the final chunk's `ChunkMeta`
//! stamp (origin, cost meter, source-file count) — the engine's own account of
//! where the answer was computed and what it cost — never recomputed or
//! model-authored (constitution §14).
//!
//! Arg parsing is hand-rolled over `std::env::args` (no `clap`): the surface is
//! three subcommands and a handful of flags, and a dependency-free parser keeps
//! the crate's tree to `lighthouse-core` + serde + tokio + futures.
//!
//! PARITY: this binary is Rust ENTRY PLUMBING (the same category as
//! `lighthouse-server` / `lighthouse-desktop`), NOT shared engine behavior, so
//! it has NO `src/server` twin — only the engine functions it calls
//! (`run_headless_ask`, `investigations::{fork, export_markdown}`) carry the
//! parity contract.

use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::ExitCode;

use futures::{Stream, StreamExt};
use serde::Serialize;

use lighthouse_core::ask::{run_headless_ask, AskOpts};
use lighthouse_core::contracts::{AnalyticsMeta, ChatChunk, ChunkMeta, CostMeta, NodeKind, RagReference};
use lighthouse_core::{investigations, vault};

const USAGE: &str = "\
lighthouse — headless vault CLI (openspec: add-automation)

USAGE:
    lighthouse ask \"<question>\" [--local] [--vault <path>] [--json]
                               [--investigation <id>] [--include <file-id>]...
    lighthouse fork <investigation-id> --name \"<new name>\" [--vault <path>] [--json]
    lighthouse export <investigation-id> [--vault <path>] [--json]

FLAGS:
    --local               Force the on-device model — zero network egress.
    --vault <path>        Point the engine at this vault directory before its first read.
    --json                Emit one JSON object instead of human-readable output.
    --investigation <id>  Run the ask inside this investigation (its scope + policy apply).
    --include <file-id>   Attach a file to the ask (repeatable).

Every `ask` is answered through the shared audited chokepoint, so it is recorded
in the audit + egress ledger exactly like an app ask. `--local` (or a local-only
investigation, no flag needed) forces the device path and egresses nothing.";

// --- Parsed command surface --------------------------------------------------
//
// `parse_args` is a PURE function (args in, `Command` out) so the flag → intent
// mapping is unit-testable without spawning a process or touching the engine.

#[derive(Debug, PartialEq)]
enum Command {
    Ask(AskArgs),
    Fork {
        id: String,
        name: String,
        vault: Option<PathBuf>,
        json: bool,
    },
    Export {
        id: String,
        vault: Option<PathBuf>,
        json: bool,
    },
    Help,
}

/// The `ask` flag surface — a 1:1 pre-image of the `AskOpts` the engine takes,
/// plus the output mode (`json`). Kept as its own struct so a test can assert
/// the whole flag → opts mapping in one comparison.
#[derive(Debug, PartialEq)]
struct AskArgs {
    question: String,
    json: bool,
    local: bool,
    vault: Option<PathBuf>,
    investigation: Option<String>,
    includes: Vec<String>,
}

fn parse_args(args: Vec<String>) -> Result<Command, String> {
    let mut it = args.into_iter();
    match it.next().as_deref() {
        None | Some("-h") | Some("--help") | Some("help") => Ok(Command::Help),
        Some("ask") => parse_ask(it.collect()),
        Some("fork") => parse_fork(it.collect()),
        Some("export") => parse_export(it.collect()),
        Some(other) => Err(format!("unknown subcommand: {other}")),
    }
}

/// Pull the value that must follow a value-taking flag, or a human-readable
/// error naming the flag (the `create`/`rename` error idiom — a message a
/// script's stderr can surface verbatim).
fn take_value(it: &mut impl Iterator<Item = String>, flag: &str) -> Result<String, String> {
    it.next().ok_or_else(|| format!("{flag} requires a value"))
}

fn parse_ask(args: Vec<String>) -> Result<Command, String> {
    let mut question: Option<String> = None;
    let mut json = false;
    let mut local = false;
    let mut vault: Option<PathBuf> = None;
    let mut investigation: Option<String> = None;
    let mut includes: Vec<String> = Vec::new();

    let mut it = args.into_iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--local" => local = true,
            "--json" => json = true,
            "--vault" => vault = Some(PathBuf::from(take_value(&mut it, "--vault")?)),
            "--investigation" => investigation = Some(take_value(&mut it, "--investigation")?),
            "--include" => includes.push(take_value(&mut it, "--include")?),
            "-h" | "--help" => return Ok(Command::Help),
            other if other.starts_with("--") => {
                return Err(format!("unknown flag for ask: {other}"))
            }
            other => {
                if question.is_some() {
                    return Err("ask takes a single question — quote it".to_string());
                }
                question = Some(other.to_string());
            }
        }
    }

    let question = question
        .ok_or_else(|| "ask requires a question: lighthouse ask \"<question>\"".to_string())?;
    Ok(Command::Ask(AskArgs {
        question,
        json,
        local,
        vault,
        investigation,
        includes,
    }))
}

fn parse_fork(args: Vec<String>) -> Result<Command, String> {
    let mut id: Option<String> = None;
    let mut name: Option<String> = None;
    let mut vault: Option<PathBuf> = None;
    let mut json = false;

    let mut it = args.into_iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--name" => name = Some(take_value(&mut it, "--name")?),
            "--vault" => vault = Some(PathBuf::from(take_value(&mut it, "--vault")?)),
            "--json" => json = true,
            "-h" | "--help" => return Ok(Command::Help),
            other if other.starts_with("--") => {
                return Err(format!("unknown flag for fork: {other}"))
            }
            other => {
                if id.is_some() {
                    return Err("fork takes a single investigation id".to_string());
                }
                id = Some(other.to_string());
            }
        }
    }

    let id = id.ok_or_else(|| "fork requires an investigation id".to_string())?;
    let name = name.ok_or_else(|| "fork requires --name \"<new name>\"".to_string())?;
    Ok(Command::Fork {
        id,
        name,
        vault,
        json,
    })
}

fn parse_export(args: Vec<String>) -> Result<Command, String> {
    let mut id: Option<String> = None;
    let mut vault: Option<PathBuf> = None;
    let mut json = false;

    let mut it = args.into_iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--vault" => vault = Some(PathBuf::from(take_value(&mut it, "--vault")?)),
            "--json" => json = true,
            "-h" | "--help" => return Ok(Command::Help),
            other if other.starts_with("--") => {
                return Err(format!("unknown flag for export: {other}"))
            }
            other => {
                if id.is_some() {
                    return Err("export takes a single investigation id".to_string());
                }
                id = Some(other.to_string());
            }
        }
    }

    let id = id.ok_or_else(|| "export requires an investigation id".to_string())?;
    Ok(Command::Export { id, vault, json })
}

// --- Vault override ----------------------------------------------------------

/// Point the engine at `--vault <path>` BEFORE its first read — the SAME mapping
/// `run_headless_ask` applies for `opts.vault`: `VAULT_DIR` redirects the vault
/// and its DERIVED state root (where investigations live), and
/// `LIGHTHOUSE_APP_STATE_DIR` is pinned to that in-vault `.rag-vault` so the
/// audit log and answer cache follow the vault too, even if an ambient app-state
/// dir (a desktop install's private data dir) would otherwise win. `ask` needs
/// this applied before it derives the included set below; `fork`/`export` need it
/// before they read the investigations store. Idempotent with the helper's own
/// set, which re-applies it inside the ask stream.
fn apply_vault_override(vault: Option<&Path>) {
    if let Some(v) = vault {
        std::env::set_var("VAULT_DIR", v);
        std::env::set_var("LIGHTHOUSE_APP_STATE_DIR", lighthouse_core::config::state_dir());
    }
}

/// The vault's currently RAG-included files — the headless equivalent of the
/// included set the UI transports send as `includedFileIds` (the files the user
/// toggled on). An on-device read; must run AFTER `apply_vault_override`.
fn included_file_ids() -> Vec<String> {
    vault::list_nodes()
        .into_iter()
        .filter(|n| n.kind == NodeKind::File && n.rag_included)
        .map(|n| n.id)
        .collect()
}

// --- Ask: stream the answer, read provenance from the ChunkMeta stamp --------

/// What one drained ask yields the caller: the accumulated answer text, the
/// engine's final provenance stamp, and the final chunk's references / analytics.
/// Everything here is READ from the stream — nothing is fabricated.
struct AskOutcome {
    answer: String,
    meta: Option<ChunkMeta>,
    references: Vec<RagReference>,
    analytics: Option<AnalyticsMeta>,
}

impl AskOutcome {
    /// A SETTLED answer: the engine stamped its provenance AND produced text.
    /// Without the stamp there is no honest provenance to report; without text
    /// there is no answer. Either shortfall exits non-zero, so a calling script
    /// detects the failure instead of treating empty output as success (spec:
    /// "A failed ask exits non-zero").
    fn settled(&self) -> bool {
        self.meta.is_some() && !self.answer.trim().is_empty()
    }
}

/// Drain the answer stream: when `stream_deltas`, write each authoritative delta
/// to `sink` AS IT ARRIVES (the human path streams to stdout); always accumulate
/// the answer and capture the final chunk's provenance stamp / references /
/// analytics. Provisional extractive DRAFT chunks (`draft:true`) are replaced in
/// place by the authoritative delta, so a headless consumer takes only the
/// authoritative text — never both, which would duplicate output.
async fn drive_ask(
    mut stream: Pin<Box<dyn Stream<Item = ChatChunk> + Send>>,
    sink: &mut dyn Write,
    stream_deltas: bool,
) -> io::Result<AskOutcome> {
    let mut answer = String::new();
    let mut meta: Option<ChunkMeta> = None;
    let mut references: Vec<RagReference> = Vec::new();
    let mut analytics: Option<AnalyticsMeta> = None;

    while let Some(c) = stream.next().await {
        if c.draft != Some(true) && !c.delta.is_empty() {
            if stream_deltas {
                sink.write_all(c.delta.as_bytes())?;
                sink.flush()?;
            }
            answer.push_str(&c.delta);
        }
        if c.done {
            references = c.references.unwrap_or_default();
            analytics = c.analytics;
            meta = c.meta;
        }
    }

    Ok(AskOutcome {
        answer,
        meta,
        references,
        analytics,
    })
}

// --- Provenance rendering (human line + JSON object) -------------------------

/// The provider-reported token meter, or an honest "not reported" (never a
/// `chars/4` guess — CostMeta §14): reported ⇒ the input/output/total split;
/// unreported (or absent) ⇒ "tokens not reported", the counts being a real 0.
fn cost_tokens_label(cost: Option<&CostMeta>) -> String {
    match cost {
        Some(c) if c.reported => format!(
            "{} in + {} out = {} tokens",
            c.input_tokens, c.output_tokens, c.total_tokens
        ),
        _ => "tokens not reported".to_string(),
    }
}

/// The LABELED dollar estimate, read from the stamp — never a charge. A priced
/// estimate renders "est. $X.XX" (device local-model ⇒ Some(0.0) ⇒ "est.
/// $0.00"); an on-device answer with no estimate is genuinely "$0.00" (device
/// egresses nothing and is never charged — a definitional truth, not a fabricated
/// figure); a cloud answer whose provider priced nothing is "cost estimate
/// unavailable" (honest, never invented).
fn cost_dollars_label(meta: &ChunkMeta) -> String {
    if let Some(v) = meta.cost.as_ref().and_then(|c| c.cost_estimate_usd) {
        return format!("est. ${v:.2}");
    }
    if meta.origin == "device" {
        return "$0.00".to_string();
    }
    "cost estimate unavailable".to_string()
}

/// The single human provenance line (spec: origin; the token/dollar meter;
/// the egress verdict) — ALWAYS emitted after a human-mode answer, read from
/// the engine's `ChunkMeta` stamp. `None` means no answer settled (no stamp to
/// report), which the exit code already signals.
fn provenance_line(meta: Option<&ChunkMeta>) -> String {
    let Some(m) = meta else {
        return "provenance: unavailable — no answer settled".to_string();
    };
    let origin = if m.origin == "device" {
        "answered on this device".to_string()
    } else {
        format!("answered via {}", m.origin)
    };
    let egress = if m.origin == "device" {
        "no network egress".to_string()
    } else {
        format!("egress \u{2192} {}", m.origin)
    };
    format!(
        "provenance: {origin} \u{00b7} {} \u{00b7} {} \u{00b7} {egress}",
        cost_tokens_label(m.cost.as_ref()),
        cost_dollars_label(m),
    )
}

/// The `provenance` object embedded in `--json` output — the raw `ChunkMeta`
/// fields (no interpretation), so a script reads the same figures the human line
/// summarizes. `costEstimateUsd` is present as `null` when unavailable (the field
/// always appears; the value is never fabricated).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProvenanceJson {
    origin: String,
    input_tokens: u64,
    output_tokens: u64,
    total_tokens: u64,
    reported: bool,
    cost_estimate_usd: Option<f64>,
    source_file_count: usize,
}

fn provenance_json(meta: &ChunkMeta) -> ProvenanceJson {
    let (input, output, total, reported, usd) = match &meta.cost {
        Some(c) => (
            c.input_tokens,
            c.output_tokens,
            c.total_tokens,
            c.reported,
            c.cost_estimate_usd,
        ),
        None => (0, 0, 0, false, None),
    };
    ProvenanceJson {
        origin: meta.origin.clone(),
        input_tokens: input,
        output_tokens: output,
        total_tokens: total,
        reported,
        cost_estimate_usd: usd,
        source_file_count: meta.source_file_count,
    }
}

/// The single `--json` object: the answer, its provenance (always present — the
/// "ALWAYS emit provenance" rule holds in JSON mode too), the references, and
/// `analytics` only when the answer is analytical. `Err` when no stamp settled,
/// so the caller emits a script-detectable error object instead of a
/// provenance-less shape.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AskJson<'a> {
    answer: &'a str,
    provenance: ProvenanceJson,
    references: &'a [RagReference],
    #[serde(skip_serializing_if = "Option::is_none")]
    analytics: Option<&'a AnalyticsMeta>,
}

fn outcome_json(outcome: &AskOutcome) -> Result<String, String> {
    let meta = outcome
        .meta
        .as_ref()
        .ok_or_else(|| "no answer settled".to_string())?;
    let obj = AskJson {
        answer: &outcome.answer,
        provenance: provenance_json(meta),
        references: &outcome.references,
        analytics: outcome.analytics.as_ref(),
    };
    serde_json::to_string(&obj).map_err(|e| e.to_string())
}

// --- Subcommand execution ----------------------------------------------------

async fn run_ask(a: AskArgs) -> ExitCode {
    // Set the vault BEFORE deriving the included set (an on-device read).
    apply_vault_override(a.vault.as_deref());
    let included = included_file_ids();

    let opts = AskOpts {
        local: a.local,
        vault: a.vault,
        investigation_id: a.investigation,
        attachment_ids: a.includes,
    };
    // Every ask goes through the shared chokepoint — audited + egress-attributed,
    // never `answer_pipeline` directly. A local-only scope/investigation forces
    // device inside the helper with no flag (the engine decides; we pass through).
    let stream = run_headless_ask(a.question, included, Vec::new(), opts);

    let mut stdout = io::stdout();
    let outcome = match drive_ask(stream, &mut stdout, !a.json).await {
        Ok(o) => o,
        Err(e) => {
            eprintln!("lighthouse: failed writing answer: {e}");
            return ExitCode::FAILURE;
        }
    };

    if a.json {
        match outcome_json(&outcome) {
            Ok(s) => println!("{s}"),
            Err(_) => {
                // No stamp to report — a well-formed, script-detectable error.
                println!("{}", serde_json::json!({ "error": "no answer settled" }));
                return ExitCode::FAILURE;
            }
        }
    } else {
        // The answer already streamed to stdout; close it with a newline, then
        // ALWAYS print the provenance line to stderr (read from the stamp).
        println!();
        eprintln!("{}", provenance_line(outcome.meta.as_ref()));
        if !outcome.settled() {
            eprintln!("lighthouse: no answer settled");
        }
    }

    if outcome.settled() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

fn run_fork(id: String, name: String, vault: Option<PathBuf>, json: bool) -> ExitCode {
    apply_vault_override(vault.as_deref());
    match investigations::fork(&id, &name) {
        Ok(inv) => {
            if json {
                println!(
                    "{}",
                    serde_json::json!({ "savedId": inv.id, "savedName": inv.name })
                );
            } else {
                println!("forked investigation: {} ({})", inv.name, inv.id);
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("lighthouse: fork failed: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run_export(id: String, vault: Option<PathBuf>, json: bool) -> ExitCode {
    apply_vault_override(vault.as_deref());
    // Mirror the `routes.rs` `action:"export"` arm IN-PROCESS: render the
    // investigation (references, never transcripts), resolve its OWN notes folder
    // (the write-artifact allowlist, re-validated at use), then write the markdown
    // as a sanitized, non-egress in-vault note. A validation failure (unknown id,
    // unusable folder) is a human-readable error and writes nothing.
    let markdown = match investigations::export_markdown(&id, None) {
        Ok(md) => md,
        Err(e) => {
            eprintln!("lighthouse: export failed: {e}");
            return ExitCode::FAILURE;
        }
    };
    let subdir = match investigations::notes_subdir(&id) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("lighthouse: export failed: {e}");
            return ExitCode::FAILURE;
        }
    };
    // Title matches the op's default ("Investigation"); write_artifact sanitizes
    // it and appends a collision suffix, returning (savedId, savedName).
    match vault::write_artifact(&subdir, "Investigation", "md", markdown.as_bytes()) {
        Ok((saved_id, saved_name)) => {
            if json {
                println!(
                    "{}",
                    serde_json::json!({ "savedId": saved_id, "savedName": saved_name })
                );
            } else {
                println!("exported investigation to: {saved_id}");
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("lighthouse: export failed: {e}");
            ExitCode::FAILURE
        }
    }
}

async fn run(cmd: Command) -> ExitCode {
    match cmd {
        Command::Help => {
            println!("{USAGE}");
            ExitCode::SUCCESS
        }
        Command::Ask(a) => run_ask(a).await,
        Command::Fork {
            id,
            name,
            vault,
            json,
        } => run_fork(id, name, vault, json),
        Command::Export { id, vault, json } => run_export(id, vault, json),
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    // Drop argv[0]; hand the rest to the pure parser.
    let args: Vec<String> = std::env::args().skip(1).collect();
    match parse_args(args) {
        Ok(cmd) => run(cmd).await,
        Err(e) => {
            eprintln!("lighthouse: {e}\n\n{USAGE}");
            // 2 = usage error (distinct from 1 = a run that failed to answer).
            ExitCode::from(2)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, MutexGuard, OnceLock};

    // --- Env lock for the store-touching tests (ONE guard per test) ----------
    //
    // The engine reads its roots from env vars, so the tests that seed a vault
    // serialize on this lock and point VAULT_DIR at their own temp dir — the
    // `ask_test`/`answer_cache_test` idiom, local to this crate's test binary.

    static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    fn lock_env(vault_dir: &Path) -> MutexGuard<'static, ()> {
        let guard = ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        std::env::set_var("VAULT_DIR", vault_dir);
        std::env::remove_var("LIGHTHOUSE_API_TOKEN");
        std::env::remove_var("LIGHTHOUSE_DESKTOP");
        std::env::remove_var("LIGHTHOUSE_APP_STATE_DIR");
        std::env::remove_var("LIGHTHOUSE_PROFILE_FILE");
        vault::invalidate_walk_cache();
        guard
    }

    const META_QUESTION: &str = "What's new this week?";

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    fn sorted(mut v: Vec<String>) -> Vec<String> {
        v.sort();
        v
    }

    /// The two-file provenance fixture (mirrors ask_test::seed_meta_vault),
    /// included and searchable. Returns the ids.
    fn seed_meta_vault(vault_dir: &Path) -> Vec<String> {
        let write = |rel: &str, text: &str| {
            let p = vault_dir.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        };
        write("sales.csv", "date,region,amount\n2026-01-05,NE,100\n2026-01-06,NW,50\n");
        write("notes.md", "# planning\nsome prose\n");
        vault::invalidate_walk_cache();
        vault::set_included("sales.csv", true);
        vault::set_included("notes.md", true);
        vec!["sales.csv".to_string(), "notes.md".to_string()]
    }

    fn bare_chunk() -> ChatChunk {
        ChatChunk {
            delta: String::new(),
            references: None,
            progress: None,
            analytics: None,
            draft: None,
            plan: None,
            meta: None,
            done: false,
        }
    }

    fn device_meta() -> ChunkMeta {
        ChunkMeta {
            origin: "device".to_string(),
            excerpt_count: 0,
            source_file_count: 2,
            cached_at: None,
            cost: None,
            manifest: None,
            chart: None,
        }
    }

    // --- §2.5: arg parsing (flags → intent) ----------------------------------

    #[test]
    fn parse_ask_maps_every_flag() {
        let cmd = parse_args(args(&[
            "ask",
            "what changed?",
            "--local",
            "--json",
            "--vault",
            "/v",
            "--investigation",
            "inv-1",
            "--include",
            "a.csv",
            "--include",
            "b.md",
        ]))
        .unwrap();
        assert_eq!(
            cmd,
            Command::Ask(AskArgs {
                question: "what changed?".to_string(),
                json: true,
                local: true,
                vault: Some(PathBuf::from("/v")),
                investigation: Some("inv-1".to_string()),
                includes: vec!["a.csv".to_string(), "b.md".to_string()],
            })
        );
    }

    #[test]
    fn parse_ask_defaults_are_inert() {
        match parse_args(args(&["ask", "q"])).unwrap() {
            Command::Ask(a) => {
                assert!(!a.local && !a.json);
                assert!(a.vault.is_none() && a.investigation.is_none());
                assert!(a.includes.is_empty());
                assert_eq!(a.question, "q");
            }
            other => panic!("expected ask, got {other:?}"),
        }
    }

    #[test]
    fn parse_ask_requires_a_question() {
        assert!(parse_args(args(&["ask", "--local"])).is_err());
        assert!(parse_args(args(&["ask", "one", "two"])).is_err(), "one question only");
        assert!(parse_args(args(&["ask", "q", "--nope"])).is_err(), "unknown flag");
    }

    #[test]
    fn parse_fork_needs_id_and_name() {
        assert_eq!(
            parse_args(args(&["fork", "inv-1", "--name", "Q3 deep dive"])).unwrap(),
            Command::Fork {
                id: "inv-1".to_string(),
                name: "Q3 deep dive".to_string(),
                vault: None,
                json: false,
            }
        );
        assert!(parse_args(args(&["fork", "inv-1"])).is_err(), "fork needs --name");
        assert!(parse_args(args(&["fork", "--name", "x"])).is_err(), "fork needs an id");
    }

    #[test]
    fn parse_export_takes_id_and_json() {
        assert_eq!(
            parse_args(args(&["export", "inv-1", "--json"])).unwrap(),
            Command::Export {
                id: "inv-1".to_string(),
                vault: None,
                json: true,
            }
        );
        assert!(parse_args(args(&["export"])).is_err(), "export needs an id");
    }

    #[test]
    fn parse_top_level_help_and_unknown() {
        assert_eq!(parse_args(vec![]).unwrap(), Command::Help);
        assert_eq!(parse_args(args(&["--help"])).unwrap(), Command::Help);
        assert!(parse_args(args(&["frobnicate"])).is_err());
    }

    // --- §2.5: provenance rendering is READ from the stamp, never fabricated -

    #[test]
    fn provenance_line_device_model_free_is_zero_and_no_egress() {
        // A model-free device answer: no cost meter ⇒ "not reported", but a device
        // answer is genuinely "$0.00" and egresses nothing.
        let line = provenance_line(Some(&device_meta()));
        assert!(line.contains("answered on this device"), "{line}");
        assert!(line.contains("tokens not reported"), "{line}");
        assert!(line.contains("$0.00"), "{line}");
        assert!(line.contains("no network egress"), "{line}");
    }

    #[test]
    fn provenance_line_cloud_reports_tokens_dollars_and_egress() {
        let meta = ChunkMeta {
            origin: "anthropic".to_string(),
            excerpt_count: 3,
            source_file_count: 1,
            cached_at: None,
            cost: Some(CostMeta {
                input_tokens: 100,
                output_tokens: 50,
                total_tokens: 150,
                reported: true,
                cost_estimate_usd: Some(0.0123),
            }),
            manifest: None,
            chart: None,
        };
        let line = provenance_line(Some(&meta));
        assert!(line.contains("answered via anthropic"), "{line}");
        assert!(line.contains("100 in + 50 out = 150 tokens"), "{line}");
        assert!(line.contains("est. $0.01"), "{line}");
        assert!(line.contains("egress \u{2192} anthropic"), "{line}");
    }

    #[test]
    fn provenance_line_without_a_stamp_says_so() {
        assert!(provenance_line(None).contains("no answer settled"));
    }

    // --- §2.5: an unsettled ask exits non-zero -------------------------------

    #[tokio::test]
    async fn no_final_stamp_is_not_settled() {
        // A stream that never stamps a final ChunkMeta cannot be reported honestly
        // — not settled, and the JSON path refuses to invent a provenance object.
        let stream: Pin<Box<dyn Stream<Item = ChatChunk> + Send>> =
            Box::pin(futures::stream::iter(vec![bare_chunk()]));
        let mut sink: Vec<u8> = Vec::new();
        let outcome = drive_ask(stream, &mut sink, false).await.unwrap();
        assert!(!outcome.settled(), "no final meta ⇒ not settled");
        assert!(outcome_json(&outcome).is_err(), "no stamp ⇒ no fabricated JSON");
    }

    #[tokio::test]
    async fn empty_answer_is_not_settled_even_with_a_stamp() {
        // A final stamp but no answer text is still a no-answer (exit non-zero).
        let done = ChatChunk {
            references: Some(Vec::new()),
            meta: Some(device_meta()),
            done: true,
            ..bare_chunk()
        };
        let stream: Pin<Box<dyn Stream<Item = ChatChunk> + Send>> =
            Box::pin(futures::stream::iter(vec![done]));
        let mut sink: Vec<u8> = Vec::new();
        let outcome = drive_ask(stream, &mut sink, false).await.unwrap();
        assert!(!outcome.settled(), "empty answer ⇒ not settled");
    }

    #[tokio::test]
    async fn draft_chunks_do_not_double_the_answer() {
        // The provisional draft is replaced by the authoritative delta — a headless
        // consumer accumulates only the authoritative text.
        let draft = ChatChunk {
            delta: "provisional".to_string(),
            draft: Some(true),
            ..bare_chunk()
        };
        let real = ChatChunk {
            delta: "final answer".to_string(),
            ..bare_chunk()
        };
        let done = ChatChunk {
            references: Some(Vec::new()),
            meta: Some(device_meta()),
            done: true,
            ..bare_chunk()
        };
        let stream: Pin<Box<dyn Stream<Item = ChatChunk> + Send>> =
            Box::pin(futures::stream::iter(vec![draft, real, done]));
        let mut sink: Vec<u8> = Vec::new();
        let outcome = drive_ask(stream, &mut sink, true).await.unwrap();
        assert_eq!(outcome.answer, "final answer");
        assert_eq!(String::from_utf8(sink).unwrap(), "final answer");
    }

    // --- §2.5: a --local --json ask over a fixture vault (grounded + device) --

    #[tokio::test]
    async fn local_json_ask_over_fixture_is_grounded_with_device_provenance() {
        let dir = tempfile::tempdir().unwrap();
        let _guard = lock_env(dir.path());
        lighthouse_core::answer_cache::reset_store();

        let ids = seed_meta_vault(dir.path());
        // The CLI derives the included set exactly as `run_ask` does.
        let included = included_file_ids();
        assert_eq!(
            sorted(included.clone()),
            sorted(ids.clone()),
            "the CLI sees the seeded included files"
        );

        // `--local` forces the device (zero-network) config — most-restrictive wins.
        let opts = AskOpts {
            local: true,
            ..AskOpts::default()
        };
        let stream = run_headless_ask(META_QUESTION.to_string(), included, Vec::new(), opts);
        let mut sink: Vec<u8> = Vec::new();
        // json mode ⇒ do not stream deltas; buffer and emit one object.
        let outcome = drive_ask(stream, &mut sink, false).await.unwrap();

        assert!(outcome.settled(), "a --local ask over the fixture settles an answer");
        let meta = outcome.meta.as_ref().unwrap();
        assert_eq!(meta.origin, "device", "--local forces the device origin");
        assert!(
            !outcome.references.is_empty(),
            "the answer cites the fixture files (grounded, not free-floating)"
        );

        // The JSON object carries the answer + a device provenance object together.
        let json = outcome_json(&outcome).unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["provenance"]["origin"], "device");
        assert!(
            !v["answer"].as_str().unwrap().is_empty(),
            "the grounded answer text rides the JSON"
        );
        assert!(
            !v["references"].as_array().unwrap().is_empty(),
            "references ride the JSON"
        );
        // Provenance is present in JSON mode too (the ALWAYS-emit rule).
        assert!(v["provenance"]["sourceFileCount"].as_u64().is_some());
    }
}
