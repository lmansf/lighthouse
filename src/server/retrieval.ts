/**
 * The retrieval RANKER — TF-IDF cosine over content chunks fused with a
 * filename/path match, plus the named-file pin that guarantees a file the
 * question literally names survives the top-k.
 *
 * Extracted from vault.ts when the vault was deleted in 0.15.0 (openspec:
 * refocus-chat-attachments). Nothing here walks a directory, reads inclusion
 * state, or knows what a corpus IS: a caller hands it items and it ranks them.
 * The session workspace (`workspace.ts`) is the one caller today, resolving
 * items from a conversation's attachment manifest.
 *
 * KEEP IN SYNC with native/crates/lighthouse-core/src/retrieval.rs — the
 * scoring, the chunkers, the pin rules and the tokenizer are all parity-pinned
 * so the two engines rank identically.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { RagReference } from "@/contracts";
import { extractRichText, isRichFile } from "./extract";

// --- text reading ------------------------------------------------------------

/**
 * Extensions read directly as UTF-8 text. Rich binary formats (pdf/docx/xlsx)
 * are decoded via parsers in ./extract and are *not* listed here.
 */
// .xml deliberately absent: app-generated sidecar/config XML kept surfacing as
// AI sources (0.6.x field report). KEEP IN SYNC with retrieval.rs.
const TEXT_EXT = new Set([
  ".md", ".markdown", ".txt", ".text", ".rst", ".csv", ".tsv", ".json",
  ".yaml", ".yml", ".log", ".html", ".htm", ".js", ".ts", ".tsx",
  ".jsx", ".py", ".java", ".go", ".rb", ".rs", ".c", ".h", ".cpp", ".sh",
  ".sql", ".toml", ".ini", ".env", ".css",
]);

const isTextFile = (name: string) => TEXT_EXT.has(path.extname(name).toLowerCase());

const MAX_TEXT_BYTES = 1_000_000;

/**
 * Read text from an absolute path. Rich formats (pdf/docx/xlsx) go through the
 * parser with its own size handling and cache; plain text is read directly,
 * capped at MAX_TEXT_BYTES. "" for unsupported/binary types.
 */
export async function readTextAbs(abs: string): Promise<string> {
  if (isRichFile(abs)) return extractRichText(abs, path.extname(abs).toLowerCase());
  if (!isTextFile(abs)) return "";
  try {
    let size = 0;
    try {
      size = fs.statSync(abs).size;
    } catch {
      size = 0;
    }
    if (size <= MAX_TEXT_BYTES) return fs.readFileSync(abs, "utf8");
    // Large file: read only the first MAX_TEXT_BYTES so it can't blow up memory
    // or stall the query. Enough text to match on.
    const fd = fs.openSync(abs, "r");
    try {
      const buf = Buffer.allocUnsafe(MAX_TEXT_BYTES);
      const read = fs.readSync(fd, buf, 0, MAX_TEXT_BYTES, 0);
      return buf.subarray(0, read).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

// --- tokenizing + name matching ----------------------------------------------

const STOP = new Set(
  "the a an and or of to in is are for on with as at by from this that it be do does have any there my our your you me i".split(
    " ",
  ),
);
function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]{2,}/g)?.filter((t) => !STOP.has(t)) ?? [];
}

/** Crude singularizer so "cards" matches "card". */
function singular(t: string): string {
  return t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t;
}

/** Searchable tokens from a file's name and path (so it's findable by what it's
 *  called, not only by its contents). */
function nameTokensOf(id: string, name: string): string[] {
  return tokenize(`${id.replace(/\//g, " ")} ${name}`);
}

/** Extension-ish tokens that don't count as "naming" a file in a question. */
const EXT_TOKENS = new Set([
  "xlsx", "xlsm", "xls", "csv", "tsv", "pdf", "docx", "doc", "md", "txt", "parquet",
  "pptx", "json", "html", "log",
]);

/** How many of the question's meaningful tokens a file's name tokens cover,
 *  and whether any hit was substantial enough to count as "naming" the file.
 *  KEEP IN SYNC with retrieval.rs::name_match. */
function nameMatch(qTokens: string[], nameToks: string[]): { hits: number; strong: boolean } {
  let hits = 0;
  let strong = false;
  for (const raw of qTokens) {
    const q = singular(raw);
    if (q.length < 3) continue;
    const hit = nameToks.some((nt0) => {
      const nt = singular(nt0);
      return nt === q || nt.includes(q) || (nt.length >= 3 && q.includes(nt));
    });
    if (hit) {
      hits++;
      if (raw.length >= 4) strong = true;
    }
  }
  return { hits, strong };
}

/**
 * The named-file pin's target, if any: the single file whose meaningful
 * name/path tokens the question covers substantially enough to read as "the
 * user named this file". Deliberately conservative — the pin FORCES a file
 * into the top-k, so a weak or ambiguous match must select nothing (0.6.2
 * field report: a lone generic token shared with a filename pinned irrelevant
 * files). KEEP IN SYNC with retrieval.rs::pinned_named_file. Rules:
 *   - coverage: the question must mention at least half of the file's unique
 *     meaningful name tokens (len ≥ 3, extension tokens dropped);
 *   - specificity: ≥ 2 covered tokens, or a single-token name whose token is
 *     ≥ 5 chars ("resume" can pin, "plan" never does);
 *   - uniqueness: two files with the same coverage signature mean the phrase
 *     is generic (meeting-notes-1/2/3…) — pin nothing.
 */
export function pinnedNamedFile(
  qtokens: string[],
  files: { id: string; toks: string[] }[],
): string | null {
  let best: { id: string; c: number; m: number } | null = null;
  let ambiguous = false;
  for (const f of files) {
    const uniq = [
      ...new Set(f.toks.map(singular).filter((t) => t.length >= 3 && !EXT_TOKENS.has(t))),
    ];
    if (uniq.length === 0) continue;
    const covered = uniq.filter((nt) =>
      qtokens.some((q0) => {
        const q = singular(q0);
        return q.length >= 3 && (q === nt || nt.includes(q) || q.includes(nt));
      }),
    );
    const c = covered.length;
    const m = uniq.length;
    const specific = c >= 2 || (m === 1 && (covered[0]?.length ?? 0) >= 5);
    if (c * 2 < m || !specific) continue;
    if (!best) {
      best = { id: f.id, c, m };
      continue;
    }
    // Compare coverage fractions via cross-multiplication (c/m vs bc/bm),
    // then absolute covered count. An exact tie on both is the
    // generic-siblings case.
    const lhs = c * best.m;
    const rhs = best.c * m;
    if (lhs > rhs || (lhs === rhs && c > best.c)) {
      best = { id: f.id, c, m };
      ambiguous = false;
    } else if (lhs === rhs && c === best.c) {
      ambiguous = true;
    }
  }
  return best && !ambiguous ? best.id : null;
}

interface Chunk { fileId: string; name: string; text: string; tf: Map<string, number>; }

function chunksOf(text: string, fileId: string, name: string): Chunk[] {
  const texts = chunkTextsNamed(name, text);
  return texts.map((slice) => {
    const tf = new Map<string, number>();
    for (const t of tokenize(slice)) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { fileId, name, text: slice, tf };
  });
}

/**
 * Structure-aware chunking (docs/analytics-beam.md, B1): tabular extracts
 * chunk by ROWS with the header line(s) prepended to every chunk, so a chunk
 * holding row 400 still carries its column names; prose keeps the 120-word
 * windows. KEEP BYTE-IDENTICAL with the Rust twin (retrieval.rs chunk_texts_named).
 */
export function chunkTextsNamed(name: string, text: string): string[] {
  const lower = name.toLowerCase();
  const tabular = [".csv", ".tsv", ".parquet", ".xlsx", ".xlsm", ".xls"].some((e) => lower.endsWith(e));
  if (tabular) return chunkTabular(name, text);
  return chunkTextsProse(text);
}

function chunkTabular(name: string, text: string): string[] {
  const ROWS = 30, ROW_OVERLAP = 5;
  const lower = name.toLowerCase();
  // Workbook extracts prepend the sheet name above each sheet's CSV; carry
  // BOTH the sheet line and the header row into every chunk.
  const headerLines =
    lower.endsWith(".xlsx") || lower.endsWith(".xlsm") || lower.endsWith(".xls") ? 2 : 1;
  const chunks: string[] = [];
  for (const block of text.split("\n\n")) {
    const lines = block
      .split("\n")
      .map((l) => l.replace(/\s+$/, ""))
      .filter((l) => l.trim() !== "");
    if (lines.length === 0) continue;
    const h = Math.min(headerLines, Math.max(0, lines.length - 1));
    if (lines.length <= h + 1) {
      chunks.push(lines.join("\n"));
      continue;
    }
    const header = lines.slice(0, h).join("\n");
    const data = lines.slice(h);
    for (let i = 0; i < data.length; i += ROWS - ROW_OVERLAP) {
      const body = data.slice(i, i + ROWS).join("\n");
      chunks.push(header ? `${header}\n${body}` : body);
      if (i + ROWS >= data.length) break;
    }
  }
  return chunks;
}

function chunkTextsProse(text: string): string[] {
  const words = text.split(/\s+/);
  const SIZE = 120, OVERLAP = 25;
  const out: string[] = [];
  for (let i = 0; i < words.length; i += SIZE - OVERLAP) {
    const slice = words.slice(i, i + SIZE).join(" ").trim();
    if (slice) out.push(slice);
    if (i + SIZE >= words.length) break;
  }
  return out;
}

// --- ranking -----------------------------------------------------------------

export interface Retrieved {
  references: RagReference[];
  contexts: { name: string; text: string; score: number; kind?: "file" | "conversation" }[];
}

/** Bound total chunks scored per query so many/large files can't stall it. */
const MAX_TOTAL_CHUNKS = 4000;

/**
 * A retrieved item's source kind. Conversation notes were vault files written
 * by "save this chat"; the vault took them with it, so every id an attachment
 * corpus produces is a plain file. Kept (and kept parity-pinned with
 * retrieval.rs::source_kind_of) because the recall boost below reads it, and
 * because a future note corpus would re-enter through exactly this seam.
 */
export function sourceKindOf(fileId: string): "file" | "conversation" {
  return fileId.startsWith(`${CHATS_SUBDIR}/`) ? "conversation" : "file";
}

/** Where conversation notes lived. KEEP IN SYNC with retrieval.rs. */
export const CHATS_SUBDIR = "Lighthouse Notes/Chats";

/** How much a recall cue lifts past-conversation candidates before ranking.
 *  KEEP IN SYNC with synth.rs::CONV_BOOST. */
export const CONV_BOOST = 1.5;

/** A further lift for a note belonging to the ask's own conversation set.
 *  KEEP IN SYNC with synth.rs::INVESTIGATION_BOOST. */
export const INVESTIGATION_BOOST = 1.3;

function conversationCid8(conversationId: string): string {
  return createHash("sha256").update(conversationId).digest("hex").slice(0, 8);
}

function noteCid8Of(fileId: string): string | null {
  const m = fileId.match(/\[([0-9a-f]{8})\]/);
  return m ? m[1] : null;
}

const RECALL_FRAMES = [
  "what did i ask", "what did i conclude", "what did we conclude",
  "what did i say", "what did i decide", "did i ask", "have i asked",
  "what did i find", "what have i asked",
];

/**
 * G6 recall meta-cue: does the question ask what the USER previously asked,
 * said, concluded, decided, or found? Anchored frames (not loose keywords) so
 * ordinary questions never trigger. It BIASES retrieval toward conversation
 * notes; it never short-circuits to a model-free answer. Pure; normalization
 * matches `crossDocCue`. KEEP BYTE-IDENTICAL with lighthouse-core::synth::recall_cue.
 */
export function recallCue(question: string): boolean {
  const lower = question.toLowerCase();
  let norm = "";
  let lastSpace = true;
  for (const ch of lower) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) {
      norm += ch;
      lastSpace = false;
    } else if (!lastSpace) {
      norm += " ";
      lastSpace = true;
    }
  }
  const padded = ` ${norm.trim()} `;
  return RECALL_FRAMES.some((f) => padded.includes(` ${f} `));
}

/**
 * G6: write/OVERWRITE the auto-exported note for ONE conversation under
 * `CHATS_SUBDIR`. Filename = sanitized title + a short, stable id derived from
 * the conversation id (`"<title> [<cid8>].md"`), so it is human-scannable yet
 * keyed by conversation. A prior note for the same conversation under a changed
 * title is removed first. `safeAbs`-guarded; walk cache invalidated. KEEP IN SYNC
 * with lighthouse-core::vault::write_conversation_note.
 */
export interface RetrievalItem {
  id: string;
  name: string;
  pathFor: string;
  read: () => Promise<string>;
}

/**
 * Rank `items` against `query` and build the references + contexts — the
 * SOURCE-AGNOSTIC scoring tail of `retrieve`, split out so a workspace corpus
 * (conversation attachments) runs the identical ranking without any vault
 * gating in front of it (openspec: refocus-chat-attachments §1.4). The gate is
 * the caller's business; this is the ranker. KEEP IN SYNC with
 * retrieval.rs::retrieve_items.
 */
export async function retrieveItems(
  query: string,
  items: RetrievalItem[],
  k = 5,
  preferredConversationIds: string[] = [],
): Promise<Retrieved> {
  const qtokens = tokenize(query);
  if (qtokens.length === 0) return { references: [], contexts: [] };
  if (items.length === 0) return { references: [], contexts: [] };
  const nameToks = new Map<string, string[]>();
  for (const it of items) nameToks.set(it.id, nameTokensOf(it.pathFor, it.name));
  const preview = new Map<string, string>(); // first content slice, for name-only hits
  const chunks: Chunk[] = [];
  for (const it of items) {
    const text = await it.read();
    if (text.trim()) {
      const cs = chunksOf(text, it.id, it.name);
      preview.set(it.id, cs[0]?.text.slice(0, 240) ?? "");
      for (const c of cs) {
        chunks.push(c);
        if (chunks.length >= MAX_TOTAL_CHUNKS) break;
      }
    }
    if (chunks.length >= MAX_TOTAL_CHUNKS) break;
  }

  // --- content scoring (TF-IDF cosine over chunks) ---
  let scored: { c: Chunk; score: number }[] = [];
  if (chunks.length > 0) {
    const df = new Map<string, number>();
    for (const c of chunks) for (const t of c.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    const N = chunks.length;
    const idf = (t: string) => Math.log((N + 1) / ((df.get(t) ?? 0) + 1)) + 1;
    const qtf = new Map<string, number>();
    for (const t of qtokens) qtf.set(t, (qtf.get(t) ?? 0) + 1);
    const vec = (tf: Map<string, number>) => {
      const v = new Map<string, number>();
      let norm = 0;
      for (const [t, f] of tf) {
        const w = f * idf(t);
        v.set(t, w);
        norm += w * w;
      }
      return { v, norm: Math.sqrt(norm) || 1 };
    };
    const q = vec(qtf);
    scored = chunks.map((c) => {
      const d = vec(c.tf);
      let dot = 0;
      for (const [t, w] of q.v) dot += w * (d.v.get(t) ?? 0);
      let score = dot / (q.norm * d.norm);
      // Nudge a chunk up when its file also matches by name (name + content).
      const nm = nameMatch(qtokens, nameToks.get(c.fileId) ?? []);
      if (nm.strong) score += 0.2 * (nm.hits / qtokens.length);
      return { c, score };
    });
  }

  // Build merged candidates: scored content chunks, plus a synthetic entry for
  // any file that matches by name but isn't already represented by its content.
  interface Cand { fileId: string; name: string; text: string; score: number }
  const cands: Cand[] = scored
    .filter((s) => s.score > 0)
    .map((s) => ({ fileId: s.c.fileId, name: s.c.name, text: s.c.text, score: s.score }));
  const present = new Set(cands.map((c) => c.fileId));
  for (const it of items) {
    if (present.has(it.id)) continue;
    const nm = nameMatch(qtokens, nameToks.get(it.id) ?? []);
    if (nm.hits === 0 || !nm.strong) continue;
    const pv = preview.get(it.id) ?? "";
    cands.push({
      fileId: it.id,
      name: it.name,
      text: pv || "(matched by file name; no readable text could be extracted)",
      score: 0.5 + 0.4 * (nm.hits / qtokens.length), // 0.5..0.9
    });
  }

  // G6 recall cue: "what did I ask/conclude about X" biases toward past-
  // conversation notes so synthesis draws on them. Deterministic — only scales
  // existing conversation-kind cands before the sort. KEEP IN SYNC with retrieval.rs.
  //
  // Investigation preference (openspec: add-investigations): where the cue
  // boosts conversation notes, a note BELONGING to the ask's investigation —
  // its filename's [cid8] matches a preferred conversation id, the same
  // derivation writeConversationNote bracketed in — is lifted a further
  // INVESTIGATION_BOOST. Preference, not exclusion: global notes keep their
  // CONV_BOOST and still surface, ordered after.
  if (recallCue(query)) {
    const preferredCid8s = new Set(preferredConversationIds.map(conversationCid8));
    for (const c of cands) {
      if (sourceKindOf(c.fileId) === "conversation") {
        c.score *= CONV_BOOST;
        if (preferredCid8s.size > 0) {
          const cid = noteCid8Of(c.fileId);
          if (cid !== null && preferredCid8s.has(cid)) c.score *= INVESTIGATION_BOOST;
        }
      }
    }
  }
  const sorted = cands.sort((a, b) => b.score - a.score);
  const top = sorted.slice(0, k);
  // Named-file guarantee: a question that strongly names a file MUST surface
  // that file — keyword-heavy chunks from other files can otherwise crowd it
  // out of the top-k (and the Rust engine's hybrid scores make that routine;
  // see retrieval.rs::retrieve). KEEP IN SYNC with the Rust twin.
  const named = pinnedNamedFile(
    qtokens,
    items.map((it) => ({ id: it.id, toks: nameToks.get(it.id) ?? [] })),
  );
  if (named && !top.some((c) => c.fileId === named)) {
    const best = sorted.find((c) => c.fileId === named);
    if (best) {
      if (top.length >= k && top.length > 0) top.pop();
      top.push(best);
    }
  }
  if (top.length === 0) return { references: [], contexts: [] };

  const max = top[0].score || 1;
  // one reference per file (best chunk), but keep all top chunks as context
  const seen = new Set<string>();
  const references: RagReference[] = [];
  for (const c of top) {
    if (seen.has(c.fileId)) continue;
    seen.add(c.fileId);
    references.push({
      fileId: c.fileId,
      name: c.name,
      snippet: c.text.slice(0, 240).trim() + (c.text.length > 240 ? "…" : ""),
      score: Math.min(1, c.score / max),
      kind: sourceKindOf(c.fileId),
    });
  }
  const contexts = top.map((c) => ({
    name: c.name,
    text: c.text,
    score: Math.min(1, c.score / max),
    kind: sourceKindOf(c.fileId),
  }));
  return { references, contexts };
}

/**
 * A file's display name + extracted text, for the synthesis pipeline: table
 * profiles need the full content; `previewChars` bounds the map-step fallback
 * used when a generic query's tokens miss the file's content entirely.
/**
 * The file a question NAMES among the given (id, name) pairs, if any — the
 * corpus-agnostic half of the named-file target. KEEP IN SYNC with
 * retrieval.rs::named_file_target_over.
 */
export function namedFileTargetOver(
  question: string,
  files: [string, string][],
): [string, string] | null {
  const qtokens = tokenize(question);
  if (qtokens.length === 0) return null;
  const tokened = files.map(([id, name]) => ({ id, name, toks: nameTokensOf(id, name) }));
  const id = pinnedNamedFile(qtokens, tokened);
  const hit = tokened.find((f) => f.id === id);
  return hit ? [hit.id, hit.name] : null;
}
