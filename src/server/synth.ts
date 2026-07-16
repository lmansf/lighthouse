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
import {
  retrieve as vaultRetrieve,
  docText,
  docChunks,
  activeIncludedFileIds,
  shareableFileIds,
  shareableSubset,
  localOnlySubset,
  namedButExcluded,
  namedFileTarget,
  sourceKindOf,
} from "./vault";
import {
  remoteProvider,
  streamAnswer,
  draftAnswer,
  fullDocCharBudget,
  docSegmentCharBudget,
  maxDocSegments,
  type Ctx,
} from "./llm";
import { readDesktopSettings } from "./settings";
import { metaIntent, renderMeta } from "./meta";
import { isProfileable, tableProfile } from "./tableProfile";
import {
  cacheKey,
  insert as cacheInsert,
  lookup as cacheLookup,
  type CacheCtl,
} from "./answerCache";

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
/**
 * Single-document focus (0.11, field report "partial answers"): a question
 * that clearly targets ONE document is answered from ALL of it — full
 * inclusion when the doc fits the provider budget, else a segment sweep over
 * every chunk — instead of the top-k sample. Dominance = this many of the
 * initial k=5 context blocks from one file.
 */
const DOC_FOCUS_DOMINANCE = 4;

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

/**
 * G6: the synthesis prompt label for a retrieved context. A past-conversation
 * note is announced as such so the model knows the block is the user's OWN
 * earlier chat (not a source document); ordinary files keep their name. This is
 * the text the model reads via `buildPrompt`'s `[n] {name}` header. KEEP
 * BYTE-IDENTICAL with lighthouse-core::synth::ctx_label.
 */
function ctxLabel(c: { name: string; kind?: "file" | "conversation" }): string {
  return c.kind === "conversation" ? "from your past Lighthouse conversation" : c.name;
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

// --- Single-document focus (doc-focus) ---------------------------------------------

/**
 * The one file that dominates the initial hits: at least DOC_FOCUS_DOMINANCE
 * of the context blocks come from a single file. Contexts don't carry file
 * ids, so names are counted and mapped back through the (per-file-deduped)
 * references; a display name shared by two referenced files is ambiguous and
 * returns null. Pure; KEEP IN SYNC with synth.rs::dominant_doc.
 */
export function dominantDoc(ctxNames: string[], refs: RagReference[]): [string, string] | null {
  if (ctxNames.length < DOC_FOCUS_DOMINANCE) return null;
  const counts = new Map<string, number>();
  for (const n of ctxNames) counts.set(n, (counts.get(n) ?? 0) + 1);
  let name = "";
  let c = 0;
  for (const [n, k] of counts) {
    // >= so a tie keeps the LAST name, matching the Rust max_by_key.
    if (k >= c) {
      name = n;
      c = k;
    }
  }
  if (c < DOC_FOCUS_DOMINANCE) return null;
  const matching = refs.filter((r) => r.name === name);
  return matching.length === 1 ? [matching[0].fileId, matching[0].name] : null;
}

/**
 * Partition ORDERED chunks into contiguous `\n\n`-joined segments of at most
 * `segBudget` chars (a single over-budget chunk still gets its own segment;
 * order is preserved). Pure; KEEP IN SYNC with synth.rs::partition_segments.
 */
export function partitionSegments(chunks: string[], segBudget: number): string[] {
  const segs: string[] = [];
  let cur = "";
  for (const ch of chunks) {
    if (cur.length > 0 && cur.length + 2 + ch.length > segBudget) {
      segs.push(cur);
      cur = "";
    }
    cur = cur.length > 0 ? `${cur}\n\n${ch}` : ch;
  }
  if (cur.length > 0) segs.push(cur);
  return segs;
}

/**
 * Evenly-spaced sample of at most `max` segments (all of them when they fit),
 * plus the pre-sample total for the honesty note. First and last segments are
 * always kept. Pure; KEEP IN SYNC with synth.rs::sample_segments.
 */
export function sampleSegments(segs: string[], max: number): [string[], number] {
  const total = segs.length;
  if (total <= max || max === 0) return [segs, total];
  const out: string[] = [];
  for (let i = 0; i < max; i += 1) {
    out.push(segs[max === 1 ? 0 : Math.floor((i * (total - 1)) / (max - 1))]);
  }
  return [out, total];
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
 * The provenance origin for this answer's stamp: `"device"` for the local model
 * or the model-free/extractive fallback (no provider configured), else the cloud
 * provider id. Agrees with the audit record's `provider` (which the choke point
 * derives as `cfg.providerId` or `"none"`) under the device⇔local/none mapping.
 * KEEP IN SYNC with lighthouse-core/src/synth.rs::origin_of.
 */
function originOf(cfg: ModelCfg): string {
  return !cfg.providerId || cfg.providerId === "local" ? "device" : cfg.providerId;
}

/**
 * Whether a CLOUD provider is active — the single predicate that arms local-only
 * enforcement. A keyed remote vendor is cloud; the on-device model and the
 * model-free/extractive fallback are not (`origin === "device"`). Keyed on
 * provider IDENTITY, not on whether a key is present, so a selected-but-keyless
 * cloud provider still counts as cloud (local-only fails CLOSED toward privacy).
 * KEEP IN SYNC with synth.rs::is_cloud_provider.
 */
export function isCloudProvider(cfg: ModelCfg): boolean {
  return originOf(cfg) !== "device";
}

/**
 * The honest skip note appended to a CLOUD answer that dropped `n ≥ 1` files
 * solely because they are marked local-only. Engine-emitted, never model-
 * generated; BYTE-IDENTICAL to synth.rs::local_only_skip_note (docs/ts-twin.md
 * rule 2). Mirrors the shape of the named-but-excluded note.
 */
export function localOnlySkipNote(n: number): string {
  const [files, them] = n === 1 ? ["file", "it"] : ["files", "them"];
  return `_(${n} ${files} skipped — marked private (this device only), so the AI can't send ${them} to a cloud model. Switch to the private model to include ${them}.)_\n\n`;
}

/**
 * The terminating chunk, stamped with the engine-computed provenance
 * (privacy-legibility). `excerptCount` is the number of context blocks the
 * branch that ran actually handed to the model; `sourceFileCount` is derived
 * here from the references so it can never drift from what's cited (nor from the
 * audit record's `fileIds`, which are those same refs' ids). KEEP IN SYNC with
 * lighthouse-core/src/synth.rs::final_chunk.
 */
function finalChunk(
  references: RagReference[],
  excerptCount: number,
  origin: string,
): ChatChunk {
  return {
    delta: "",
    references,
    meta: { origin, excerptCount, sourceFileCount: references.length },
    done: true,
  };
}

/**
 * The full ask path: single-shot RAG (with table profiles for CSV hits), or —
 * when the question spans documents — per-document extraction then a streamed
 * synthesis with document-level citations. This wrapper is the answer cache's
 * ONE choke point (openspec: add-answer-cache): the key is computed ONCE at
 * ask entry — BEFORE retrieval — from the same inputs the live pipeline will
 * use; a hit replays the stored answer verbatim (one text chunk + the final
 * chunk re-stamped with `cachedAt`) with zero retrieval and zero model calls;
 * a miss (or `bypassCache`, the Re-run affordance) runs the live pipeline
 * unchanged and inserts only a SUCCESSFUL, COMPLETED answer under the
 * ask-time key. Any cache failure degrades to a live run — the cache can only
 * add speed, never break an answer. `preferredConversationIds` (openspec:
 * add-investigations) is the ask's investigation's conversationRefs —
 * retrieval's recall preference; empty when no investigation rides the ask.
 * KEEP IN SYNC with lighthouse-core/src/synth.rs::answer_pipeline.
 */
export async function* answerPipeline(
  question: string,
  includedFileIds: string[],
  attachmentFileIds: string[],
  history: ChatTurn[],
  cfg: ModelCfg,
  cache: CacheCtl = {},
  preferredConversationIds: string[] = [],
): AsyncGenerator<ChatChunk> {
  // Key at ask entry. A failing cache degrades to "no cache this ask".
  let key: string | null = null;
  try {
    key = cacheKey(question, cfg.providerId, cfg.modelId, attachmentFileIds, preferredConversationIds, isCloudProvider(cfg));
    // Lookup also enforces the persistence posture (a disallowed ask deletes
    // any disk mirror even when it misses or bypasses).
    const hit = cacheLookup(key, cache);
    if (hit) {
      // Verbatim replay: the full text as ONE chunk (no progress, no draft),
      // then the stored final chunk plus the honesty stamp.
      yield { delta: hit.text, done: false };
      yield {
        delta: "",
        references: hit.references,
        ...(hit.analytics ? { analytics: hit.analytics } : {}),
        meta: { ...hit.meta, cachedAt: hit.createdMs },
        done: true,
      };
      return;
    }
  } catch {
    key = null;
  }

  // Miss or bypass: run live, observing the stream so only a successful,
  // completed answer is stored. The settled text mirrors the UI's rule: a
  // provisional draft is REPLACED by the first authoritative delta.
  let text = "";
  let draftActive = false;
  let finalChunk: ChatChunk | null = null;
  for await (const chunk of answerPipelineLive(
    question,
    includedFileIds,
    attachmentFileIds,
    history,
    cfg,
    preferredConversationIds,
  )) {
    if (chunk.delta) {
      if (chunk.draft) {
        draftActive = true;
      } else if (draftActive) {
        draftActive = false;
        text = "";
      }
      text += chunk.delta;
    }
    if (chunk.done) finalChunk = chunk;
    yield chunk;
  }
  // Insert only on successful completion: a terminating chunk with its
  // provenance stamp arrived, real text settled (never a bare draft), and no
  // engine failure note rode in the answer (llm turns provider errors into
  // "…model unavailable — …" notes, not throws — the same marker the map
  // steps already filter on).
  if (
    key &&
    finalChunk?.meta &&
    !draftActive &&
    text.trim() !== "" &&
    !text.includes("model unavailable —")
  ) {
    try {
      cacheInsert(
        key,
        {
          createdMs: Date.now(),
          text,
          references: finalChunk.references ?? [],
          ...(finalChunk.analytics ? { analytics: finalChunk.analytics } : {}),
          meta: finalChunk.meta,
        },
        cache,
      );
    } catch {
      /* a cache write failure never breaks an already-delivered answer */
    }
  }
}

/** The live ask path (pre-cache behavior, byte-identical): single-shot RAG or
 *  multi-document synthesis, streamed as ChatChunks. */
async function* answerPipelineLive(
  question: string,
  includedFileIds: string[],
  attachmentFileIds: string[],
  history: ChatTurn[],
  cfg: ModelCfg,
  preferredConversationIds: string[] = [],
): AsyncGenerator<ChatChunk> {
  // Provenance origin for this answer's stamp — resolved once from the active
  // provider (agrees with the audit record's `provider`). Every branch's final
  // chunk carries it; it is never derived from model text.
  const origin = originOf(cfg);
  // Local-only enforcement is armed only for a CLOUD provider. On the device
  // path this is false everywhere below, so the shareable gate is a no-op and
  // on-device answers are byte-identical to today.
  const isCloud = isCloudProvider(cfg);

  // A bare follow-up retrieves poorly on its own: blend in the previous user
  // turn to anchor retrieval to the topic (moved here from the callers so all
  // three surfaces stay identical).
  const lastUserTurn = [...history].reverse().find((t) => t.role === "user");
  const retrievalQuery = lastUserTurn ? `${lastUserTurn.content}\n${question}` : question;

  const initial = await registryRetrieve(
    retrievalQuery,
    includedFileIds,
    attachmentFileIds,
    5,
    isCloud,
    preferredConversationIds,
  );

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

  // Honesty note (deterministic, engine text): a CLOUD answer is about to drop
  // one or more files SOLELY because they are marked local-only — say so plainly
  // instead of silently omitting them. Attachment-scoped asks count the dropped
  // attachments; otherwise the effectively-local-only members of the active-
  // included set. Inert on the device path (isCloud false ⇒ 0). KEEP IN SYNC
  // with the Rust pipeline (synth.rs).
  if (isCloud) {
    const scope = attachmentFileIds.length === 0 ? activeIncludedFileIds() : attachmentFileIds;
    const dropped = localOnlySubset(scope, true).length;
    if (dropped > 0) {
      yield { delta: localOnlySkipNote(dropped), done: false };
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
      const ans = renderMeta(intent, includedFileIds, Date.now(), isCloud);
      if (ans) {
        yield { delta: ans.markdown, done: false };
        // Model-free deterministic answer: zero excerpts handed to a model,
        // files behind it are the cited references.
        yield finalChunk(ans.references, 0, origin);
        return;
      }
    }
  }

  // --- Answer-level draft-then-verify (G2): on the PRIVATE path, stream an
  //     instant extractive draft from the retrieval snippets already in hand,
  //     replaced IN PLACE by the local model's grounded answer below. Gated to
  //     the LOCAL provider + the draftAnswers preference (default on) + non-empty
  //     contexts. Meta answered/returned above, so this only ever precedes a real
  //     local-model grounded answer. The draft is a separate chunk that never
  //     enters any prompt — zero tokens against the local window. KEEP IN SYNC
  //     with synth.rs (whose position differs only by the Rust-only analytics
  //     branch, which has no TS twin).
  if (
    cfg.providerId === "local" &&
    readDesktopSettings().draftAnswers !== false &&
    initial.contexts.length > 0
  ) {
    const ctxs: Ctx[] = initial.contexts.map((c) => ({
      name: ctxLabel(c),
      text: c.text,
      score: c.score,
    }));
    const text = draftAnswer(question, ctxs);
    if (text.trim() !== "") {
      yield { delta: text, draft: true, done: false };
    }
  }

  // --- Decide: synthesis or single-shot ---
  let docs: DocCandidate[] = [];
  if (hasRealModel(cfg)) {
    if (attachmentFileIds.length >= MIN_MAP_DOCS) {
      // Explicit multi-attach IS the cross-document gesture — but a marked
      // attachment can't ride to a cloud model. Filter this bypasser at its own
      // choke point before any docText read below.
      docs = shareableSubset(attachmentFileIds, isCloud).slice(0, MAX_MAP_DOCS).map((id) => ({
        id,
        name: "",
        score: ASSUMED_DOC_SCORE,
      }));
    } else if (attachmentFileIds.length === 0 && crossDocCue(question)) {
      // Rank documents by a wide retrieval pass; when few files are included,
      // make sure each of them gets a seat even if the query's tokens miss it.
      const wide = await registryRetrieve(
        retrievalQuery,
        includedFileIds,
        [],
        WIDE_K,
        isCloud,
        preferredConversationIds,
      );
      docs = rankDocsFromHits(wide.references, MAX_MAP_DOCS);
      const active = new Set(shareableFileIds(isCloud));
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
      // (one file id = retrieval constrained to exactly this file). doc.id is
      // already shareable (filtered above), so isCloud only re-affirms it. No
      // recall preference: scoped to ONE document, there is no cross-candidate
      // order to prefer.
      const perDoc = await vaultRetrieve(retrievalQuery, [], PER_DOC_CHUNKS, [], [doc.id], isCloud);
      const ctxs: Ctx[] =
        perDoc.contexts.length > 0
          ? perDoc.contexts.map((c) => ({ name: ctxLabel(c), text: c.text, score: c.score }))
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
      // A model failure mid-map is YIELDED as a "_(… model unavailable — …)_"
      // note (streamAnswer turns provider errors into a note, not a throw), so
      // the try/catch above never fires. Skip both the local- and live-model
      // forms — else a failure note becomes a bogus extract with a fabricated
      // citation in the reduce. KEEP IN SYNC with synth.rs.
      if (extract.includes("model unavailable —")) continue;

      const snippet = (perDoc.contexts[0]?.text ?? preview.text).slice(0, SNIPPET_CHARS);
      // Exact stats ride along into the reduce so the final answer can quote them.
      const block = profile ? `${extract}\n\n${profile}` : extract;
      extracts.push({
        ref: { fileId: doc.id, name, snippet, score: doc.score, kind: sourceKindOf(doc.id) },
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
      yield finalChunk(extracts.map((e) => e.ref), reduceCtxs.length, origin);
      return;
    }
    // Fewer than two documents had anything to say — fall through to the
    // ordinary single-shot answer over the initial retrieval.
  }

  // --- Single-document focus (0.11, field report "partial answers"): a
  //     question that clearly targets ONE document — a single attachment, a
  //     named file, or one file dominating the initial hits — is answered
  //     from ALL of it, not a top-k sample. Full inclusion when the doc fits
  //     the provider budget; otherwise a map sweep over every chunk (the
  //     multi-doc machinery, applied per segment). Multi-doc asks never reach
  //     here (returned above or guarded by the cue); tabular files stay on
  //     the table-profile path (analytics is desktop-only). KEEP IN SYNC with
  //     synth.rs. ---
  if (hasRealModel(cfg) && attachmentFileIds.length <= 1 && !crossDocCue(question)) {
    // Doc-focus reads the WHOLE target file into the prompt, so both of its
    // bypasser entrypoints are filtered here at their own choke point: a lone
    // local-only attachment is dropped, and named-file lookup runs over the
    // shareable set only. dominantDoc is safe already — initial.references are
    // shareable.
    const target: [string, string] | null =
      attachmentFileIds.length === 1
        ? (shareableSubset(attachmentFileIds, isCloud)[0] !== undefined
            ? [attachmentFileIds[0], ""]
            : null)
        : namedFileTarget(question, shareableSubset(includedFileIds, isCloud)) ??
          dominantDoc(initial.contexts.map((c) => c.name), initial.references);
    const doc = target ? await docChunks(target[0]) : null;
    if (target && doc && !isProfileable(doc[0]) && doc[1].length > 0) {
      const [name, chunks] = doc;
      const reference: RagReference = {
        fileId: target[0],
        name,
        snippet: chunks[0].slice(0, SNIPPET_CHARS),
        score: 1,
        kind: sourceKindOf(target[0]),
      };
      const totalChars =
        chunks.reduce((sum, c) => sum + c.length, 0) + 2 * Math.max(0, chunks.length - 1);
      if (totalChars <= fullDocCharBudget(cfg)) {
        // The whole document rides in one prompt.
        yield progress(`Reading all of ${name}…`, 1, 2);
        const n = chunks.length;
        const ctxs: Ctx[] = chunks.map((t, i) => ({
          name: n === 1 ? name : `${name} — part ${i + 1}/${n}`,
          text: t,
          // Descending scores make the Rust local clamp's lowest-score-first
          // drop a deterministic tail truncation (never mid-document holes);
          // the TS local path never clamps, so they only carry the order.
          score: 1 - i * 1e-4,
        }));
        for await (const delta of streamAnswer(question, ctxs, cfg, history)) {
          yield { delta, done: false };
        }
        yield finalChunk([reference], ctxs.length, origin);
        return;
      }
      // Too big for one prompt: sweep EVERY chunk in ordered segments,
      // extract per segment, then synthesize.
      const parts = partitionSegments(chunks, docSegmentCharBudget(cfg));
      const [segs, totalSegs] = sampleSegments(parts, maxDocSegments(cfg));
      const read = segs.length;
      if (read < totalSegs) {
        yield {
          delta: `_(Long document: read ${read} of ${totalSegs} sections of “${name}”, evenly spread.)_\n\n`,
          done: false,
        };
      }
      const steps = read + 1;
      const extracts: [number, string][] = [];
      for (let i = 0; i < segs.length; i += 1) {
        yield progress(`Reading ${name} (part ${i + 1}/${read})…`, i + 1, steps);
        const ctxs: Ctx[] = [{ name: `${name} — part ${i + 1}/${read}`, text: segs[i], score: 1 }];
        let extract = "";
        try {
          extract = await collect(streamAnswer(mapQuestion(question), ctxs, cfg, []));
        } catch {
          continue; // one bad map call must not sink the whole answer
        }
        extract = stripMarkers(extract).trim().slice(0, MAP_EXTRACT_CHARS);
        // Same failure-note filter as the multi-doc map step above.
        if (
          !extract ||
          extract.startsWith("NO_RELEVANT_CONTENT") ||
          extract.includes("model unavailable —")
        ) {
          continue;
        }
        extracts.push([i + 1, extract]);
      }
      if (extracts.length > 0) {
        yield progress(`Synthesizing ${name}…`, steps, steps);
        const reduceCtxs: Ctx[] = extracts.map(([i, t]) => ({
          name: `${name} — part ${i}/${read}`,
          text: t,
          score: 1,
        }));
        for await (const delta of streamAnswer(question, reduceCtxs, cfg, history)) {
          yield { delta, done: false };
        }
        yield finalChunk([reference], reduceCtxs.length, origin);
        return;
      }
      // Every segment came back empty/failed — fall through to the ordinary
      // single-shot path below.
    }
  }

  // --- Single-shot path (today's behavior) + exact table stats for CSV hits ---
  const contexts: Ctx[] = initial.contexts.map((c) => ({
    name: ctxLabel(c),
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
  yield finalChunk(initial.references, contexts.length, origin);
}
