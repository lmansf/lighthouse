/**
 * Multi-document synthesis pipeline (Phase 1 — docs/multi-doc-synthesis.md).
 *
 * One entry point for the whole ask path: decides between today's single-shot
 * RAG and a map→reduce plan over 2..6 documents, computes exact table profiles
 * for delimiter files, and streams ChatChunks (including pre-answer `progress`
 * notes) that every surface — web route, axum route, desktop IPC — forwards
 * verbatim. The Rust twin (lighthouse-server/src/synth_pipeline.rs over pure
 * helpers in lighthouse-core) must keep prompts and formats byte-identical.
 */
import type { ChatChunk, ChatTurn, RagReference } from "@/contracts";
import { retrieve as registryRetrieve } from "./sources/registry";
import { retrieve as vaultRetrieve, docText, activeIncludedFileIds, namedButExcluded } from "./vault";
import { remoteProvider, streamAnswer, type Ctx } from "./llm";
import { metaIntent, renderMeta } from "./meta";
import { isProfileable, tableProfile } from "./tableProfile";

/** Budgets — mirrored in lighthouse-core/src/synth.rs. */
const MAX_MAP_DOCS = 6;
const MIN_MAP_DOCS = 2;
const PER_DOC_CHUNKS = 3;
const WIDE_K = 24;
const MAP_EXTRACT_CHARS = 1800;
const PREVIEW_CHARS = 1600;
const SNIPPET_CHARS = 240;
/** Fallback relevance for docs chosen by attachment/inclusion, not retrieval. */
const ASSUMED_DOC_SCORE = 0.75;

export interface ModelCfg {
  providerId: string | null;
  modelId: string | null;
  apiKey: string | null;
}

// --- Trigger -------------------------------------------------------------------

// Single words that signal cross-document intent, matched on word boundaries.
const CUE_WORDS = new Set([
  "across", "compare", "compared", "comparing", "comparison", "versus", "vs",
  "synthesize", "synthesise", "combine", "combined", "overall",
  "differ", "differs", "difference", "differences", "trend", "trends",
]);
// Multi-word cues, matched on the normalized (lowercase, punctuation-free) text.
const CUE_PHRASES = [
  "all my files", "all my documents", "all my docs", "all the files",
  "all the documents", "all of my", "all of the", "each file", "each document",
  "each doc", "each of", "every file", "every document", "both files",
  "both documents", "both reports", "these files", "these documents",
  "my files", "my documents", "between the",
];

/** Whether a question reads as a cross-document ask. Pure; unit-tested. */
export function crossDocCue(question: string): boolean {
  const norm = question
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const padded = ` ${norm} `;
  for (const p of CUE_PHRASES) if (padded.includes(` ${p} `)) return true;
  return norm.split(" ").some((t) => CUE_WORDS.has(t));
}

// --- Document candidates ---------------------------------------------------------

export interface DocCandidate {
  id: string;
  name: string;
  /** Aggregate relevance in [0,1] — reused as the doc-level reference score. */
  score: number;
}

/** Group per-chunk references by file, rank by summed score, normalize to [0,1]. */
export function rankDocsFromHits(refs: RagReference[], max: number): DocCandidate[] {
  const byFile = new Map<string, DocCandidate>();
  for (const r of refs) {
    const cur = byFile.get(r.fileId);
    if (cur) cur.score += r.score;
    else byFile.set(r.fileId, { id: r.fileId, name: r.name, score: r.score });
  }
  const ranked = [...byFile.values()].sort((a, b) => b.score - a.score).slice(0, max);
  const top = ranked[0]?.score || 1;
  return ranked.map((d) => ({ ...d, score: Math.min(1, d.score / top) }));
}

// --- Map step --------------------------------------------------------------------

/** The extraction ask wrapped around the user's question for each map call.
 *  KEEP BYTE-IDENTICAL with lighthouse-core/src/synth.rs::map_question. */
export function mapQuestion(question: string): string {
  return (
    "From this single document, extract every fact, figure, date, and quote " +
    "relevant to answering the question below. Reply as concise bullet points " +
    "and include exact numbers verbatim. If nothing in it is relevant, reply " +
    "with exactly NO_RELEVANT_CONTENT.\n\n" +
    `Question: ${question}`
  );
}

/** Strip [n] citation markers a map call may emit — the reduce step mints its
 *  own numbering over documents, and stray markers would collide with it. */
function stripMarkers(text: string): string {
  return text.replace(/\s*\[\d{1,3}\]/g, "");
}

async function collect(gen: AsyncGenerator<string>): Promise<string> {
  let out = "";
  for await (const d of gen) out += d;
  return out;
}

// --- Pipeline --------------------------------------------------------------------

/** Providers that can actually run map calls (the keyless extractive fallback
 *  answers single-shot only — running it 6 times would just paste passages). */
function hasRealModel(cfg: ModelCfg): boolean {
  if (cfg.providerId === "local") return true;
  const keyed = cfg.providerId === "anthropic" || Boolean(remoteProvider(cfg.providerId));
  return keyed && !!cfg.apiKey;
}

const progress = (label: string, step: number, total: number): ChatChunk => ({
  delta: "",
  progress: { label, step, total },
  done: false,
});

/**
 * The full ask path: single-shot RAG (with table profiles for CSV hits), or —
 * when the question spans documents — per-document extraction then a streamed
 * synthesis with document-level citations.
 */
export async function* answerPipeline(
  question: string,
  includedFileIds: string[],
  attachmentFileIds: string[],
  history: ChatTurn[],
  cfg: ModelCfg,
): AsyncGenerator<ChatChunk> {
  // A bare follow-up retrieves poorly on its own: blend in the previous user
  // turn to anchor retrieval to the topic (moved here from the callers so all
  // three surfaces stay identical).
  const lastUserTurn = [...history].reverse().find((t) => t.role === "user");
  const retrievalQuery = lastUserTurn ? `${lastUserTurn.content}\n${question}` : question;

  const initial = await registryRetrieve(retrievalQuery, includedFileIds, attachmentFileIds, 5);

  // Instant acknowledgment: local models take seconds to a first token, but
  // retrieval lands in milliseconds — naming the sources NOW makes the answer
  // visibly start immediately (0.6.x field feedback: "slow to write… provide
  // something instantly"). The loader shows this label until real tokens
  // replace it. KEEP IN SYNC with synth.rs.
  if (initial.references.length > 0) {
    const names = initial.references.slice(0, 3).map((r) => r.name);
    const extra = initial.references.length - names.length;
    yield progress(
      extra > 0 ? `Reading ${names.join(", ")} +${extra}…` : `Reading ${names.join(", ")}…`,
      0,
      1,
    );
  }

  // Honesty note (deterministic, engine text): the question names a vault
  // file that ISN'T included — say so up front instead of letting the model
  // deny the file exists. Skipped for attachment-scoped asks. KEEP IN SYNC
  // with the Rust pipeline (synth.rs).
  if (attachmentFileIds.length === 0) {
    const missing = namedButExcluded(question);
    if (missing.length > 0) {
      const names = missing.map((n) => `“${n}”`).join(" and ");
      const [isare, itthem] = missing.length === 1 ? ["is", "it"] : ["are", "them"];
      yield {
        delta: `_(${names} ${isare} in your vault but not included, so the AI can't read ${itthem}. Toggle ${itthem} on in the explorer and ask again.)_\n\n`,
        done: false,
      };
    }
  }

  // --- Vault meta-answers (openspec: add-vault-meta-answers): anchored
  //     questions ABOUT the vault (recency, inventory) answer instantly from
  //     walk metadata — no model call, real references. A null render (incl.
  //     the PARITY findColumn case — the catalog is desktop-only) falls
  //     through with NOTHING emitted. KEEP IN SYNC with synth.rs.
  if (attachmentFileIds.length === 0) {
    const intent = metaIntent(question);
    if (intent) {
      const ans = renderMeta(intent, includedFileIds, Date.now());
      if (ans) {
        yield { delta: ans.markdown, done: false };
        yield { delta: "", references: ans.references, done: true };
        return;
      }
    }
  }

  // --- Decide: synthesis or single-shot ---
  let docs: DocCandidate[] = [];
  if (hasRealModel(cfg)) {
    if (attachmentFileIds.length >= MIN_MAP_DOCS) {
      // Explicit multi-attach IS the cross-document gesture.
      docs = attachmentFileIds.slice(0, MAX_MAP_DOCS).map((id) => ({
        id,
        name: "",
        score: ASSUMED_DOC_SCORE,
      }));
    } else if (attachmentFileIds.length === 0 && crossDocCue(question)) {
      // Rank documents by a wide retrieval pass; when few files are included,
      // make sure each of them gets a seat even if the query's tokens miss it.
      const wide = await registryRetrieve(retrievalQuery, includedFileIds, [], WIDE_K);
      docs = rankDocsFromHits(wide.references, MAX_MAP_DOCS);
      const active = new Set(activeIncludedFileIds());
      const inScope = includedFileIds.filter((id) => active.has(id));
      if (inScope.length <= MAX_MAP_DOCS) {
        const seen = new Set(docs.map((d) => d.id));
        for (const id of inScope) {
          if (!seen.has(id) && docs.length < MAX_MAP_DOCS) {
            docs.push({ id, name: "", score: ASSUMED_DOC_SCORE });
          }
        }
      }
    }
  }

  if (docs.length >= MIN_MAP_DOCS) {
    const total = docs.length + 1;
    const extracts: { ref: RagReference; text: string }[] = [];

    for (let i = 0; i < docs.length; i += 1) {
      const doc = docs[i];
      // Resolve the display name early so progress labels are meaningful even
      // for attachment-picked docs (their candidate name starts empty).
      const preview = await docText(doc.id, PREVIEW_CHARS);
      const name = doc.name || preview?.name || doc.id;
      yield progress(`Reading ${name} (${i + 1}/${docs.length})…`, i + 1, total);
      if (!preview) continue; // unreadable/deleted file — skip its seat

      // This document's best chunks, via the attachment-scoping retrieval path
      // (one file id = retrieval constrained to exactly this file).
      const perDoc = await vaultRetrieve(retrievalQuery, [], PER_DOC_CHUNKS, [], [doc.id]);
      const ctxs: Ctx[] =
        perDoc.contexts.length > 0
          ? perDoc.contexts.map((c) => ({ name: c.name, text: c.text, score: c.score }))
          : [{ name, text: preview.text, score: 1 }];

      // Exact numbers for tables: profile the full file, not the preview slice.
      let profile: string | null = null;
      if (isProfileable(name)) {
        const full = await docText(doc.id);
        profile = full ? tableProfile(name, full.text) : null;
        if (profile) ctxs.push({ name: `${name} — table profile`, text: profile, score: 0 });
      }

      let extract = "";
      try {
        extract = await collect(streamAnswer(mapQuestion(question), ctxs, cfg, []));
      } catch {
        continue; // one bad map call must not sink the whole answer
      }
      extract = stripMarkers(extract).trim().slice(0, MAP_EXTRACT_CHARS);
      if (!extract || extract.startsWith("NO_RELEVANT_CONTENT")) continue;
      if (extract.includes("_(Local model unavailable")) continue; // failed mid-map

      const snippet = (perDoc.contexts[0]?.text ?? preview.text).slice(0, SNIPPET_CHARS);
      // Exact stats ride along into the reduce so the final answer can quote them.
      const block = profile ? `${extract}\n\n${profile}` : extract;
      extracts.push({
        ref: { fileId: doc.id, name, snippet, score: doc.score },
        text: block,
      });
    }

    if (extracts.length >= MIN_MAP_DOCS) {
      yield progress(
        `Synthesizing across ${extracts.length} documents…`,
        total,
        total,
      );
      const reduceCtxs: Ctx[] = extracts.map((e) => ({
        name: e.ref.name,
        text: e.text,
        score: e.ref.score,
      }));
      for await (const delta of streamAnswer(question, reduceCtxs, cfg, history)) {
        yield { delta, done: false };
      }
      yield { delta: "", references: extracts.map((e) => e.ref), done: true };
      return;
    }
    // Fewer than two documents had anything to say — fall through to the
    // ordinary single-shot answer over the initial retrieval.
  }

  // --- Single-shot path (today's behavior) + exact table stats for CSV hits ---
  const contexts: Ctx[] = initial.contexts.map((c) => ({
    name: c.name,
    text: c.text,
    score: c.score,
  }));
  let profiled = 0;
  const seen = new Set<string>();
  for (const r of initial.references) {
    if (profiled >= 2) break;
    if (seen.has(r.fileId) || !isProfileable(r.name)) continue;
    seen.add(r.fileId);
    const full = await docText(r.fileId);
    const profile = full ? tableProfile(r.name, full.text) : null;
    if (profile) {
      contexts.push({ name: `${r.name} — table profile`, text: profile, score: 0 });
      profiled += 1;
    }
  }

  for await (const delta of streamAnswer(question, contexts, cfg, history)) {
    yield { delta, done: false };
  }
  yield { delta: "", references: initial.references, done: true };
}
