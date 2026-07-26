/**
 * §52: the "working…" indicator — subtle, honest, delay-gated liveness feedback.
 * These are contract pins: the shared primitives (src/lib/workingIndicator.ts)
 * carry byte-pinned copy + rotation thresholds + a reduced-motion freeze + a
 * delay-before-show, and InvestigationsNav actually WIRES them (a spinner while
 * the list loads, a placeholder while the capability probe runs, and staged
 * copy on the long report-generate wait).
 *
 * The primitives are a "use client" React module the node runner can't import,
 * so — like choiceDensity.test.mjs — these are source pins; live behavior is the
 * simulator/E2E pass.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const lib = read("src/lib/workingIndicator.ts");
const nav = read("src/features/investigations/InvestigationsNav.tsx");

test("§52 §2: the three report-generate stage labels are byte-pinned + honest", () => {
  // Every string must be TRUE of its phase — no fake progress. The order (run →
  // compose → tail) and the exact copy are the contract; a silent reword drifts
  // the promise, so pin them here.
  assert.match(
    lib,
    /export const REPORT_STAGE_LABELS = \[\s*"Running the analysis…",\s*"Composing the report…",\s*"Almost ready…",?\s*\] as const;/,
    "the three stage labels, in order, byte-identical",
  );
});

test("§52 §2: reportStageLabel maps elapsed time to the honest stage (6s / 14s cuts)", () => {
  // The thresholds are liveness cadence, NOT a progress bar — but they must be
  // the pinned 6s→14s so the copy tracks a real multi-call wait.
  assert.match(lib, /if \(elapsedMs < 6000\) return REPORT_STAGE_LABELS\[0\];/, "under 6s ⇒ first stage");
  assert.match(lib, /if \(elapsedMs < 14000\) return REPORT_STAGE_LABELS\[1\];/, "under 14s ⇒ second stage");
  assert.match(lib, /return REPORT_STAGE_LABELS\[2\];/, "beyond ⇒ the tail stage");
});

test("§52 §3: reduced motion FREEZES the rotation on the first honest stage", () => {
  // Under prefers-reduced-motion the label must NOT rotate — it holds the first
  // (true) stage statically. The JS-side read exists precisely so this freeze is
  // possible (the spinner's own spin is CSS, which Fluent already gates).
  assert.match(lib, /export function usePrefersReducedMotion\(\): boolean/, "the JS-side reduced-motion read exists");
  assert.match(lib, /window\.matchMedia\("\(prefers-reduced-motion: reduce\)"\)/, "it reads the reduce query");
  // The staged-label hook bails to the first stage when idle OR reduced — no interval.
  assert.match(
    lib,
    /if \(!active \|\| reduced\) \{\s*setLabel\(REPORT_STAGE_LABELS\[0\]\);\s*return;\s*\}/,
    "idle or reduced ⇒ first stage, no rotation started",
  );
});

test("§52 §1: the delay-before-show avoids a spinner flash on a fast load", () => {
  // ~200ms default, and it RESETS the moment `active` clears (no lingering
  // spinner). A flash on a 50ms wait is worse than none.
  assert.match(lib, /export function useDelayedFlag\(active: boolean, delayMs = 200\): boolean/, "200ms default delay");
  assert.match(lib, /setTimeout\(\(\) => setShown\(true\), delayMs\)/, "shows only after the delay holds");
  assert.match(lib, /if \(!active\) \{\s*setShown\(false\);\s*return;\s*\}/, "clears immediately when inactive");
});

test("§52: the primitives are pure UI — no engine/service calls in the indicator lib", () => {
  // The indicator must never touch the engine (it only reflects work already in
  // flight). No ragService / invoke / fetch / contracts import.
  assert.doesNotMatch(lib, /ragService|@\/contracts|invoke\(|fetch\(/, "no engine or network calls in the indicator lib");
});

test("§52 §2: InvestigationsNav wires the staged label onto the long generate wait", () => {
  assert.match(nav, /import \{ useDelayedFlag, useReportStageLabel \} from "@\/lib\/workingIndicator";/, "the primitives are imported");
  assert.match(nav, /const generateLabel = useReportStageLabel\(reportBusy\);/, "the generate label tracks reportBusy");
  // The Generate button shows a spinner + the staged label while busy, plain
  // "Generate" at rest — the old flat "Generating…" is gone.
  assert.match(nav, /icon=\{reportBusy \? <Spinner size="tiny" \/> : undefined\}/, "spinner icon while generating");
  assert.match(nav, /\{reportBusy \? generateLabel : "Generate"\}/, "staged label while busy, Generate at rest");
  assert.doesNotMatch(nav, /reportBusy \? "Generating…"/, "the flat single-label busy text is gone");
});

test("§52 §1/§3: InvestigationsNav shows a delay-gated list cue + a cold-probe placeholder", () => {
  // List cue: gated on the store's first load, delay-wrapped so a fast load
  // never flashes it.
  assert.match(nav, /const showListLoading = useDelayedFlag\(!loaded, 200\);/, "list cue waits on !loaded, delay-gated");
  assert.match(nav, /Loading investigations…/, "the list cue copy");
  // Report placeholder: only on a COLD probe (no table known yet) and never
  // stacked under the list cue — at most one quiet spinner.
  assert.match(
    nav,
    /useDelayedFlag\(reportMapLoading && !reportTable, 200\) && !showListLoading/,
    "report placeholder is cold-probe only and yields to the list cue",
  );
  assert.match(nav, /Checking what’s investigable…/, "the report-probe placeholder copy");
  // Both cues share the quiet loadingRow (spinner + foreground3 copy) and mark
  // themselves as polite live regions.
  assert.match(nav, /className=\{styles\.loadingRow\} role="status" aria-live="polite"/, "cues are quiet, polite live regions");
});
