/**
 * Vault meta-answers: deterministic, model-free answers to questions ABOUT
 * the vault — "what's new this week?", "what spreadsheets do I have?"
 * (openspec: add-vault-meta-answers).
 *
 * KEEP IN SYNC with native/crates/lighthouse-core/src/meta.rs — the cue table
 * and the WhatsNew/ListFiles renderers mirror it. PARITY: FindColumn answers
 * and suggested asks are Rust-engine-only (the column catalog has no TS
 * twin); here the intent is still *recognized* but renders as null, so the
 * pipeline falls through to normal retrieval exactly like a renderer error.
 */

import fs from "node:fs";
import path from "node:path";
import type { RagReference } from "@/contracts";
import { shareableFileIds, resolveNodePath } from "./vault";
// Relative (not @/) so the node test hook resolves it — see tableProfile.ts.
import { chartSpecFromTable } from "../lib/chartFromTable";

/** Most files a WhatsNew answer lists. */
const WHATS_NEW_MAX = 15;
/** Most names a ListFiles answer spells out (counts cover the rest). */
const LIST_FILES_MAX = 10;
const DAY_MS = 86_400_000;

export type KindFilter = "spreadsheets" | "documents" | "pdfs";

/** A recognized vault-meta question, pre-parsed so renderers stay pure. */
export type MetaIntent =
  | { kind: "whatsNew"; windowMs: number | null }
  | { kind: "listFiles"; filter: KindFilter | null }
  | { kind: "findColumn"; name: string };

/** Lowercase, collapse whitespace, trim, shed trailing punctuation. */
function norm(question: string): string {
  return question
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[?!. ]+$/g, "")
    .trim();
}

/** The words a WhatsNew tail may contain — anything else usually names a
 *  document, which means content, not meta. KEEP IN SYNC with meta.rs. */
const WHATS_NEW_TAIL_WORDS = new Set([
  "in", "to", "with", "my", "the", "vault", "files", "file", "documents", "docs",
  "today", "yesterday", "this", "past", "last", "week", "month", "recently", "lately",
]);

const WHATS_NEW_FRAMES = [
  "what's new",
  "whats new",
  "what is new",
  "what's changed",
  "whats changed",
  "what changed",
  "what has changed",
  "what did i add",
  "what have i added",
  "anything new",
];

/** Anchored frame match: `null` unless the frame ends on a word boundary. */
function frameTail(q: string, frame: string): string | null {
  if (!q.startsWith(frame)) return null;
  const rest = q.slice(frame.length);
  if (rest === "") return "";
  return rest.startsWith(" ") ? rest.slice(1) : null;
}

function whatsNewIntent(q: string): MetaIntent | null {
  let tail: string | null = null;
  for (const f of WHATS_NEW_FRAMES) {
    tail = frameTail(q, f);
    if (tail !== null) break;
  }
  if (tail === null) return null;
  // Document-name guard: every tail word must be from the allow-list.
  const words = tail.split(" ").filter(Boolean);
  if (!words.every((w) => WHATS_NEW_TAIL_WORDS.has(w))) return null;
  let windowMs: number | null = null;
  if (tail.includes("today")) windowMs = DAY_MS;
  else if (tail.includes("yesterday")) windowMs = 2 * DAY_MS;
  else if (tail.includes("week")) windowMs = 7 * DAY_MS;
  else if (tail.includes("month")) windowMs = 31 * DAY_MS;
  else if (tail.includes("recently") || tail.includes("lately")) windowMs = 7 * DAY_MS;
  return { kind: "whatsNew", windowMs };
}

/** Kind nouns a ListFiles cue can name. KEEP IN SYNC with meta.rs. */
function kindOfWord(w: string): KindFilter | null | undefined {
  switch (w) {
    case "files":
      return null;
    case "spreadsheets":
    case "tables":
    case "csvs":
      return "spreadsheets";
    case "documents":
    case "docs":
      return "documents";
    case "pdfs":
      return "pdfs";
    default:
      return undefined;
  }
}

/** A ListFiles tail may only point back at the vault ("in my vault"). */
function vaultTailOk(tail: string): boolean {
  return tail
    .split(" ")
    .filter(Boolean)
    .every((w) => ["in", "my", "the", "vault", "here"].includes(w));
}

function listFilesIntent(q: string): MetaIntent | null {
  // "what|which|how many <kind> do i have [in my vault]" — "how many" is the
  // count phrasing §2 answers with a stat tile. KEEP IN SYNC with meta.rs.
  for (const lead of ["what ", "which ", "how many "]) {
    if (!q.startsWith(lead)) continue;
    const rest = q.slice(lead.length);
    const sp = rest.indexOf(" ");
    const kindWord = sp < 0 ? rest : rest.slice(0, sp);
    const after = sp < 0 ? "" : rest.slice(sp + 1);
    const filter = kindOfWord(kindWord);
    if (filter === undefined) continue;
    const tail = frameTail(after, "do i have");
    if (tail !== null && vaultTailOk(tail)) return { kind: "listFiles", filter };
  }
  // "list|show me [all] [of] my <kind>"
  for (const lead of ["list ", "show me ", "show "]) {
    if (!q.startsWith(lead)) continue;
    let rest = q.slice(lead.length);
    if (rest.startsWith("all ")) rest = rest.slice(4);
    if (rest.startsWith("of ")) rest = rest.slice(3);
    if (rest.startsWith("my ")) rest = rest.slice(3);
    const sp = rest.indexOf(" ");
    const kindWord = sp < 0 ? rest : rest.slice(0, sp);
    const after = sp < 0 ? "" : rest.slice(sp + 1);
    const filter = kindOfWord(kindWord);
    if (filter !== undefined && vaultTailOk(after)) return { kind: "listFiles", filter };
  }
  return null;
}

function columnNameIntent(raw: string): MetaIntent | null {
  const name = raw.trim().replace(/^["“”'`]+|["“”'`]+$/g, "").trim();
  // A column name is a short noun phrase; a long tail means content.
  if (!name || name.split(" ").length > 4 || name.length > 48) return null;
  return { kind: "findColumn", name };
}

function findColumnIntent(q: string): MetaIntent | null {
  const LEADS = [
    "which files have",
    "which files contain",
    "what files have",
    "what files contain",
    "which of my files have",
    "which of my files contain",
    "who has",
  ];
  let rest: string | null = null;
  for (const l of LEADS) {
    rest = frameTail(q, l);
    if (rest !== null) break;
  }
  if (!rest) return null;
  for (const lead of ["a column ", "an column ", "the column ", "column "]) {
    if (rest.startsWith(lead)) {
      let name = rest.slice(lead.length);
      if (name.startsWith("called ")) name = name.slice(7);
      else if (name.startsWith("named ")) name = name.slice(6);
      return columnNameIntent(name);
    }
  }
  const suffix = rest.endsWith(" columns") ? " columns" : rest.endsWith(" column") ? " column" : null;
  if (suffix) {
    let middle = rest.slice(0, -suffix.length);
    if (middle.startsWith("a ")) middle = middle.slice(2);
    else if (middle.startsWith("an ")) middle = middle.slice(3);
    else if (middle.startsWith("the ")) middle = middle.slice(4);
    return columnNameIntent(middle);
  }
  return null;
}

/** The anchored cue gate. `null` = not a vault-meta question. Pure, no IO. */
export function metaIntent(question: string): MetaIntent | null {
  const q = norm(question);
  if (!q) return null;
  return whatsNewIntent(q) ?? listFilesIntent(q) ?? findColumnIntent(q);
}

// --- Renderers -------------------------------------------------------------------

export interface MetaAnswer {
  markdown: string;
  references: RagReference[];
}

/** Human age of a file's last save — mirrors analytics.rs::saved_age_label. */
export function savedAgeLabel(modifiedMs: number, nowMs: number): string {
  const delta = nowMs - modifiedMs;
  if (delta < 60_000) return "just now"; // future mtimes read as fresh
  const ladder: [number, string][] = [
    [60_000, "minute"],
    [3_600_000, "hour"],
    [86_400_000, "day"],
    [604_800_000, "week"],
    [2_592_000_000, "month"],
    [31_536_000_000, "year"],
  ];
  const [unitMs, unit] = [...ladder].reverse().find(([ms]) => delta >= ms)!;
  const n = Math.floor(delta / unitMs);
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

interface WalkedFile {
  id: string;
  name: string;
  ms: number;
}

/** Included **and available** files with mtimes, newest first — the inclusion
 *  set intersected with the engine's active walk, like the analytics branch. */
function includedFilesWithMtime(included: string[], isCloud: boolean): WalkedFile[] {
  // On the cloud path this is the SHAREABLE set (active-included minus
  // effectively-local-only), so a marked file never surfaces in a catalog/
  // metadata answer; on the device path it is unchanged.
  const active = new Set(shareableFileIds(isCloud));
  const out: WalkedFile[] = [];
  for (const id of included) {
    if (!active.has(id)) continue;
    try {
      const abs = resolveNodePath(id);
      const st = fs.statSync(abs);
      if (!st.isFile()) continue;
      out.push({ id, name: path.basename(abs), ms: st.mtimeMs });
    } catch {
      // unresolvable/removed since the walk — skip
    }
  }
  out.sort((a, b) => b.ms - a.ms || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/** Coarse kind label from the extension — display taxonomy, not MIME truth. */
function kindLabel(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["csv", "tsv", "xlsx", "xlsm", "xls", "parquet"].includes(ext)) return "spreadsheet";
  if (ext === "pdf") return "PDF";
  if (["doc", "docx", "rtf", "odt", "md", "txt", "html", "htm"].includes(ext)) return "document";
  return "file";
}

function matchesFilter(name: string, filter: KindFilter): boolean {
  const label = kindLabel(name);
  return (
    (filter === "spreadsheets" && label === "spreadsheet") ||
    (filter === "documents" && label === "document") ||
    (filter === "pdfs" && label === "PDF")
  );
}

function reference(f: WalkedFile, snippet: string, rank: number): RagReference {
  // Descending with list order so any score-sorted rendering preserves it.
  return { fileId: f.id, name: f.name, snippet, score: Math.max(0.5, 1.0 - rank * 0.02) };
}

function whatsNew(included: string[], windowMs: number | null, nowMs: number, isCloud: boolean): MetaAnswer | null {
  const files = includedFilesWithMtime(included, isCloud);
  if (files.length === 0) return null; // fall through — no included files
  const scoped = windowMs === null ? files : files.filter((f) => f.ms >= nowMs - windowMs);
  const windowLabel =
    windowMs === null
      ? ""
      : windowMs <= DAY_MS
        ? "in the last day"
        : windowMs <= 2 * DAY_MS
          ? "in the last two days"
          : windowMs <= 7 * DAY_MS
            ? "in the last week"
            : "in the last month";
  if (scoped.length === 0) {
    // Honest empty window — still deterministic, still cite the newest file.
    const f = files[0];
    const age = savedAgeLabel(f.ms, nowMs);
    return {
      markdown: `Nothing visible to AI changed ${windowLabel}. The most recent file is **${f.name}** (saved ${age}).`,
      references: [reference(f, `${kindLabel(f.name)} · saved ${age}`, 0)],
    };
  }
  const heading = windowLabel
    ? `${scoped.length} file${scoped.length === 1 ? "" : "s"} visible to AI changed ${windowLabel}:`
    : "Your most recently updated files visible to AI:";
  const lines = [heading, ""];
  const references: RagReference[] = [];
  scoped.slice(0, WHATS_NEW_MAX).forEach((f, i) => {
    const age = savedAgeLabel(f.ms, nowMs);
    lines.push(`- **${f.name}** — ${kindLabel(f.name)}, saved ${age}`);
    references.push(reference(f, `${kindLabel(f.name)} · saved ${age}`, i));
  });
  if (scoped.length > WHATS_NEW_MAX) lines.push(`- …and ${scoped.length - WHATS_NEW_MAX} more.`);
  return { markdown: lines.join("\n"), references };
}

/** Kind counts (spreadsheet / document / PDF / file) over the inventory, biggest
 *  first — the structured form both `countLine` and the §2 count visual read.
 *  KEEP IN SYNC with meta.rs::kind_counts. */
function kindCounts(files: WalkedFile[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const f of files) {
    const label = kindLabel(f.name);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/** "5 spreadsheets, 3 documents" — only non-zero buckets, biggest first. */
function countLine(files: WalkedFile[]): string {
  return kindCounts(files)
    .map(([label, n]) => plural(label, n))
    .join(", ");
}

/** "1 PDF" / "3 PDFs" — the count line's own pluralization, reused for the
 *  visual labels. KEEP IN SYNC with meta.rs::plural. */
function plural(label: string, n: number): string {
  return `${n} ${label}${n === 1 ? "" : "s"}`;
}

/** The bare plural noun ("PDFs", "spreadsheets") for a bar x-label / a stat
 *  caption. KEEP IN SYNC with meta.rs::plural_noun. */
function pluralNoun(label: string, n: number): string {
  return n === 1 ? label : `${label}s`;
}

/** A `lighthouse-stat` fence: an inline stat tile carrying ONE engine number and
 *  its caption (StatValue shape). Fixed key order for byte-parity with the Rust
 *  twin; the caption is an engine noun, so no escaping is needed. KEEP IN SYNC
 *  with meta.rs::stat_fence. */
function statFence(value: number, label: string): string {
  return `\`\`\`lighthouse-stat\n{"raw":"${value}","value":${value},"label":"${label}"}\n\`\`\``;
}

/** The by-kind counts as a bar chart spec (fence body), or null with fewer than
 *  two kinds (a single number is a tile, not a bar). Built from the SAME client
 *  heuristic the "Chart it" chip uses, over the structured counts — never the
 *  prose count line. PARITY: meta.rs::counts_bar_spec (JSON differs only in
 *  float formatting). */
export function countsBarSpec(counts: [string, number][]): string | null {
  if (counts.length < 2) return null;
  const spec = chartSpecFromTable({
    header: ["kind", "files"],
    rows: counts.map(([label, n]) => [pluralNoun(label, n), String(n)]),
  });
  return spec ? JSON.stringify(spec) : null;
}

/** The visual a ListFiles answer carries by default: a single kind's count as a
 *  stat tile, the whole-vault composition as a compact bar (falling back to a
 *  total tile when there is only one kind). KEEP IN SYNC with
 *  meta.rs::list_files_visual. */
function listFilesVisual(
  filter: KindFilter | null,
  scopedLen: number,
  files: WalkedFile[],
  noun: string,
): string | null {
  if (filter !== null) {
    // A single asked-for kind → one number → a stat tile.
    return statFence(scopedLen, pluralNoun(noun, scopedLen));
  }
  // The whole vault → the by-kind breakdown as a bar, else a total tile.
  const bar = countsBarSpec(kindCounts(files));
  if (bar) return `\`\`\`lighthouse-chart\n${bar}\n\`\`\``;
  return statFence(files.length, pluralNoun("file", files.length));
}

function listFiles(included: string[], filter: KindFilter | null, nowMs: number, isCloud: boolean): MetaAnswer | null {
  const files = includedFilesWithMtime(included, isCloud);
  if (files.length === 0) return null; // fall through — no included files
  const scoped = filter === null ? files : files.filter((f) => matchesFilter(f.name, filter));
  const noun =
    filter === "spreadsheets" ? "spreadsheet" : filter === "documents" ? "document" : filter === "pdfs" ? "PDF" : "file";
  if (scoped.length === 0) {
    return {
      markdown: `No ${noun}s are visible to AI right now (${files.length} file${files.length === 1 ? "" : "s"} total: ${countLine(files)}).`,
      references: [],
    };
  }
  const heading = filter
    ? `**${scoped.length} ${noun}${scoped.length === 1 ? "" : "s"}** visible to AI:`
    : `**${scoped.length} file${scoped.length === 1 ? "" : "s"}** visible to AI — ${countLine(files)}:`;
  const lines = [heading, ""];
  const references: RagReference[] = [];
  scoped.slice(0, LIST_FILES_MAX).forEach((f, i) => {
    const age = savedAgeLabel(f.ms, nowMs);
    lines.push(`- **${f.name}** — ${kindLabel(f.name)}, saved ${age}`);
    references.push(reference(f, `${kindLabel(f.name)} · saved ${age}`, i));
  });
  if (scoped.length > LIST_FILES_MAX) lines.push(`- …and ${scoped.length - LIST_FILES_MAX} more.`);
  // §2 visual-first: the count IS engine-verified quantitative data, so it
  // renders a visual by default — a single kind's count as a stat tile, the
  // whole-vault breakdown as a compact bar. Built from the structured inventory,
  // never from the prose count line.
  let markdown = lines.join("\n");
  const visual = listFilesVisual(filter, scoped.length, files, noun);
  if (visual) markdown += `\n\n${visual}`;
  return { markdown, references };
}

/**
 * Dispatch an intent to its renderer. `null` = fall through to the normal
 * pipeline (the caller MUST emit nothing on null — no partial meta output).
 * PARITY: findColumn always falls through here — the column catalog is
 * Rust-engine-only, and a wrong "no such column" would be worse than retrieval.
 */
export function renderMeta(intent: MetaIntent, included: string[], nowMs: number, isCloud: boolean): MetaAnswer | null {
  try {
    switch (intent.kind) {
      case "whatsNew":
        return whatsNew(included, intent.windowMs, nowMs, isCloud);
      case "listFiles":
        return listFiles(included, intent.filter, nowMs, isCloud);
      case "findColumn":
        // PARITY: the column catalog (find-column, suggested-asks) is Rust-
        // engine-only, so this always falls through to retrieval here. The
        // Rust twin routes find_column through the SHAREABLE set to keep a
        // marked table's column names off a cloud prompt; there is no TS
        // catalog to gate, so nothing local-only leaks on this side.
        return null;
    }
  } catch {
    return null; // any renderer error falls through silently
  }
}
