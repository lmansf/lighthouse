/**
 * §48 §3: a visible Report door in two always-relevant places.
 *  a. Hero: the report chip is NAMED "Report on <table>" (not hidden behind
 *     "Investigate"), with a report icon, keeping its Standard/Scientific/
 *     Business menu.
 *  b. Per-answer: a "Report…" action on a tabular analytics answer whose source
 *     table resolves — the §46 hypothesis prompt + reused investigate() + a
 *     Saved—Open confirmation; absent when no source table resolves (no dead
 *     door).
 * Source-pinned (JSX the node runner can't import); live behavior is the
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

test("§3a: the hero chip reads \"Report on <table>\" with a report icon, menu intact", () => {
  const chip = read("src/features/chat/ReportChip.tsx");
  assert.match(chip, /`Report on \$\{table\}`/, "the trigger names the report");
  assert.match(chip, /icon=\{<IconReport \/>\}/, "a report icon, not a search glass");
  // The Standard/Scientific/Business menu + engine op stay byte-identical.
  assert.match(chip, /label: "Standard report",/);
  assert.match(chip, /label: "Scientific method",/);
  assert.match(chip, /label: "Business report",/);
  assert.match(chip, /ragService\.investigate\(table, undefined, template\)/, "reused investigate op");
});

test("§3b: the per-answer Report action is gated on a resolvable source table", () => {
  const action = read("src/features/chat/AnswerReportAction.tsx");
  // Resolves THIS answer's source table from its own files via the investigable
  // gate, and is ABSENT when none resolves (no dead door).
  assert.match(action, /ragService\s*\n?\s*\.capabilityMap\(/, "resolves from the answer's files");
  assert.match(action, /\.find\(\(t\) => t\.investigable\)\?\.name \?\? null/, "investigable source table");
  assert.match(action, /if \(!table\) return null;/, "absent when no source table resolves");
  // The §46 hypothesis prompt + reused investigate with the hypothesis + the
  // Saved—Open confirmation.
  assert.match(action, /aria-label="Working hypothesis"/, "the §46 hypothesis prompt");
  assert.match(
    action,
    /ragService\.investigate\(\s*table!,\s*currentInvestigationId,\s*template,\s*hypoText\.trim\(\) \|\| undefined,\s*\)/,
    "investigate reused with the current investigation + hypothesis",
  );
  assert.match(action, /Saved \{saved\.name\}/, "Saved <name> confirmation");
  assert.match(action, />\s*Open\s*</, "with an Open affordance");
  // Standard maps to NO template (the deterministic report), like the hero door.
  assert.match(action, /picked === "standard" \? undefined : picked/, "Standard = no template");
});

test("§3b: the Report action rides the per-answer action row", () => {
  const chat = read("src/features/chat/ChatPanel.tsx");
  assert.match(chat, /<AnswerReportAction fileIds=\{meta\.fileIds\} \/>/, "mounted in the RefineChips row");
});

// --- §49: reports become a main feature --------------------------------------

test("§49 §2: the open-report event helper is typo-proof and window-safe", () => {
  const lib = read("src/lib/openReport.ts");
  assert.match(lib, /export const OPEN_REPORT_EVENT = "lighthouse:open-report";/, "the pinned event name");
  // Named openSavedReport (not openReport) so it never collides with the
  // launcher surfaces' local openReport(template) template picker.
  assert.match(lib, /export function openSavedReport\(id: string\): void/, "the reader-open helper");
  assert.match(
    lib,
    /window\.dispatchEvent\(new CustomEvent\(OPEN_REPORT_EVENT, \{ detail: \{ id \} \}\)\)/,
    "dispatches the {id} open event",
  );
});

test("§49 §3: every report door OPENS the reader (openSavedReport), never a silent save", () => {
  for (const [p, why] of [
    ["src/features/chat/ReportChip.tsx", "the hero chip"],
    ["src/features/chat/AnswerReportAction.tsx", "the per-answer action"],
    ["src/features/investigations/InvestigationsNav.tsx", "the investigation launcher"],
  ]) {
    const src = read(p);
    assert.match(src, /import \{ openSavedReport \} from "@\/lib\/openReport";/, `${why} imports the reader-open helper`);
    assert.match(src, /openSavedReport\(savedId\);/, `${why} opens the reader on the fresh report`);
    // The tree reveal survives alongside it (open AND highlight, not either/or).
    assert.match(src, /"lighthouse:reveal-node"/, `${why} still reveals the saved node`);
  }
  // The per-answer "Open" affordance opens the reader on the saved report too.
  assert.match(
    read("src/features/chat/AnswerReportAction.tsx"),
    /onClick=\{\(\) => openSavedReport\(saved\.id\)\}/,
    "the Saved—Open button opens the reader",
  );
});

test("§49 §2: the reader host reads the note, DRAWS its key chart, and exports", () => {
  const host = read("src/features/chat/ReportReaderHost.tsx");
  assert.match(host, /window\.addEventListener\(OPEN_REPORT_EVENT, onOpen\)/, "opens on the event");
  assert.match(host, /ragService\s*\n?\s*\.readNote\(id\)/, "reads the saved note (local vault read)");
  assert.match(host, /const CHART_LANG = "language-lighthouse-chart"/, "recognizes the persisted chart fence");
  assert.match(host, /<AnalyticsChart spec=\{spec\} \/>/, "draws the key chart (the chat answer's chart path)");
  // Export (Markdown / HTML / Print) + Reveal + Close — the reader's actions.
  assert.match(host, /label: "Markdown \(\.md\)"/, "Export → Markdown");
  assert.match(host, /label: "Web page \(\.html\)"/, "Export → HTML");
  assert.match(host, /label: "Print \/ Save as PDF"/, "Export → Print");
  assert.match(host, /Reveal in Files/, "Reveal-in-Files");
  assert.match(host, /aria-label="Close report"/, "Close");
});

test("§49 §4: the Reports home lists saved reports and opens rows in the reader", () => {
  const home = read("src/features/chat/ReportsHome.tsx");
  assert.match(home, /ragService\s*\n?\s*\.listReports\(\)/, "lists the saved reports (newest-first)");
  assert.match(home, /openSavedReport\(id\)/, "a row opens the reader");
  // "New report" is capability-gated on an investigable table (no dead door),
  // and reuses the same investigate op + hypothesis framing.
  assert.match(home, /\.filter\(\(t\) => t\.investigable\)/, "gated on an investigable table");
  assert.match(home, /ragService\.investigate\(table, undefined, wire, hypoText\.trim\(\) \|\| undefined\)/, "reused investigate op");
  assert.match(home, /disabled=\{tables\.length === 0\}/, "New report is disabled with no investigable table");
  // The desktop dialog host opens on its own event.
  assert.match(home, /export const OPEN_REPORTS_EVENT = "lighthouse:open-reports";/, "the pinned home event");
  assert.match(home, /window\.addEventListener\(OPEN_REPORTS_EVENT, onOpen\)/, "ReportsHomeHost listens for it");
});

test("§49 §4: Reports is a first-class destination — mobile tab, desktop entry, one host", () => {
  // MOBILE: a full-screen page peer of Files/Settings, with its own tab icon.
  assert.match(read("src/shell/CompactTabBar.tsx"), /reports: \{ rest: <IconReport \/>, active: <IconReport \/> \}/, "the Reports tab icon");
  const shell = read("src/shell/AppShell.tsx");
  assert.match(shell, /import \{ ReportsHome \} from "@\/features\/chat\/ReportsHome";/, "AppShell renders the home");
  assert.match(shell, /const reportsLayer = pageLayers\.find\(\(l\) => l\.tab === "reports"\);/, "the Reports page layer");
  assert.match(shell, /aria-label="Reports"/, "the Reports page");
  // DESKTOP: a Sidebar-footer entry dispatching the home event.
  assert.match(read("src/shell/Sidebar.tsx"), /window\.dispatchEvent\(new CustomEvent\(OPEN_REPORTS_EVENT\)\)/, "the Sidebar footer entry");
  // ONE host mounted in the composition root (desktop dialog face of the home).
  assert.match(read("app/page.tsx"), /<ReportsHomeHost \/>/, "the desktop host is mounted once");
});

test("§49 §4: listReports is wired Rust-only across the engine layers", () => {
  const core = read("native/crates/lighthouse-core/src/reports.rs");
  assert.match(core, /pub fn list_reports\(\) -> Vec<ReportEntry>/, "the engine op");
  // Precise report identification: the report-header signature, EXCLUDING the
  // conversation-notes folder that shares the Notes tree.
  assert.match(core, /const REPORT_SIGNATURE: &str = "every figure computed by Lighthouse";/, "the report signature");
  assert.match(core, /"Lighthouse Notes\/Chats\/"/, "excludes conversation notes");
  // mtime descending — the honest newest-first (FileNode carries no timestamp).
  assert.match(core, /b\.generated_ms\.cmp\(&a\.generated_ms\)/, "newest-first by file mtime");
  // The op is reachable on both wire surfaces (desktop command + server route).
  assert.match(read("native/crates/lighthouse-shell/src/commands.rs"), /Some\("listReports"\)/, "shell command arm");
  assert.match(read("native/crates/lighthouse-server/src/routes.rs"), /Some\("listReports"\)/, "server route arm");
});
