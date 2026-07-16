/**
 * Answer cache (openspec: add-answer-cache): verbatim, freshness-stamped
 * replay of an unchanged question over unchanged data.
 *
 * The key is a sha256 over everything that could change the answer: the
 * normalized question, a digest of the provider-effective candidate set (the
 * shareable file ids paired with their `mtimeMs:size` freshness keys — which
 * already folds include flags, local-only marks under a cloud provider, and
 * per-file freshness), the provider AND model id, and the sorted attachment id
 * set. Global-digest tradeoff (v1, pinned in the design): ANY vault change
 * invalidates every entry — over-invalidation accepted, correctness beats hit
 * rate.
 *
 * Store: a bounded in-memory LRU (always on, session scope) plus an optional
 * disk mirror (`appStateDir()/answer-cache.json`, versioned envelope
 * `{v:1, entries:[…]}`) written ONLY when the triggering request carried the
 * client's `persistAllowed` verdict. A request carrying persistence-DISALLOWED
 * deletes any existing disk file (cached answers are chat content — the
 * privacy posture wins over the optimization). Never the vault; never any
 * network. Doubt of any kind (unparseable file, envelope version mismatch,
 * malformed entries) reads as empty — a miss runs live, and the next allowed
 * insert rewrites the store cleanly.
 *
 * PARITY: the byte-parallel twin of lighthouse-core/src/answer_cache.rs. The
 * twins never share a cache file — this twin's freshness keys are its own stat
 * values — but normalization, key material shape, LRU bound, envelope, and
 * the persistence gate are identical.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AnalyticsMeta, ChatChunk, RagReference } from "@/contracts";
import { appStateDir, readJson, writeJson } from "./config";
import { shareableFreshnessKeys } from "./vault";

/**
 * LRU bound — small enough that the disk envelope stays trivial to rewrite per
 * insert, large enough for a session's worth of re-asks.
 * KEEP IN SYNC with answer_cache.rs::CACHE_CAP.
 */
export const CACHE_CAP = 64;
/** Disk envelope version. A mismatch reads as empty (miss ⇒ live). */
const ENVELOPE_V = 1;
const CACHE_FILE = "answer-cache.json";

/**
 * Per-request cache controls, carried on the wire from the client:
 * `bypassCache` (the Re-run affordance) skips the lookup but still runs the
 * posture + refreshes the entry on completion; `persistAllowed` is the
 * client's chat-history verdict (`persistEnabled() && !chatHistoryLocked()`),
 * computed per ask so the engines never learn a global flag. Both default
 * false — absent fields fail toward privacy.
 */
export interface CacheCtl {
  bypassCache?: boolean;
  persistAllowed?: boolean;
}

/** The provenance stamp shape the final chunk carries. */
type ProvenanceMeta = NonNullable<ChatChunk["meta"]>;

/**
 * One stored answer: the final markdown text verbatim (SQL/chart fences and
 * honesty footers ride inside), the references, the analytics meta, the
 * provenance stamp, and when it was computed. Entries are immutable once
 * written; replay adds `cachedAt` to the stamp, never mutates the entry.
 */
export interface CachedAnswer {
  key: string;
  createdMs: number;
  text: string;
  references: RagReference[];
  analytics?: AnalyticsMeta;
  meta: ProvenanceMeta;
}

interface Envelope {
  v: number;
  entries: CachedAnswer[];
}

// In-memory store: recency order (least-recent first), plus the once-per-
// process lazy disk-load flag. Module-level state is process state — exactly
// the session scope the spec wants.
let entries: CachedAnswer[] = [];
let diskLoaded = false;

function cachePath(): string {
  return path.join(appStateDir(), CACHE_FILE);
}

// --- Key --------------------------------------------------------------------------

/**
 * Conservative question normalization: trim, lowercase, collapse internal
 * whitespace, strip trailing `?!.` — and nothing else (no stemming, no
 * synonyms): the cache must never conflate questions that could answer
 * differently. KEEP IN SYNC with answer_cache.rs::normalize_question.
 */
export function normalizeQuestion(question: string): string {
  const collapsed = question.toLowerCase().replace(/\s+/g, " ").trim();
  return collapsed.replace(/[?!.]+$/, "").trimEnd();
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Digest of the provider-effective candidate set: the sorted
 * `(file id, freshness key)` pairs, NUL-joined per pair so ids and keys can
 * never collide across the boundary. Any change — a file added, removed,
 * re-included, marked local-only under a cloud provider, or touched on disk —
 * changes the digest. KEEP IN SYNC with answer_cache.rs::candidate_digest.
 */
export function candidateDigest(pairs: [string, string][]): string {
  const lines = pairs.map(([id, key]) => `${id}\u0000${key}`).sort();
  return sha256Hex(lines.join("\n"));
}

/**
 * The full cache key from pre-computed parts (pure — unit-testable without a
 * vault). Attachments are sorted + deduped: the SET is what was asked.
 * Preferred conversation ids (openspec: add-investigations — the current
 * investigation's recall preference) join the key ONLY when non-empty, so
 * every pre-investigations key — and every ask outside one — is unchanged
 * and existing cache entries stay valid. Without this, a recall-cued answer
 * cached in one investigation could replay inside another whose preferences
 * order the references differently.
 * KEEP IN SYNC with answer_cache.rs::key_from_parts.
 */
export function keyFromParts(
  question: string,
  providerId: string | null,
  modelId: string | null,
  attachmentIds: string[],
  preferredConversationIds: string[],
  candidateDigestHex: string,
): string {
  const atts = [...new Set(attachmentIds)].sort();
  let material = [
    `q:${normalizeQuestion(question)}`,
    `c:${candidateDigestHex}`,
    `p:${providerId ?? ""}`,
    `m:${modelId ?? ""}`,
    `a:${atts.join("\u0000")}`,
  ].join("\n");
  if (preferredConversationIds.length > 0) {
    const refs = [...new Set(preferredConversationIds)].sort();
    material += `\nr:${refs.join("\u0000")}`;
  }
  return sha256Hex(material);
}

/**
 * The cache key for an ask, computed ONCE at ask entry — BEFORE retrieval —
 * from the same inputs the pipeline will use.
 * KEEP IN SYNC with answer_cache.rs::cache_key.
 */
export function cacheKey(
  question: string,
  providerId: string | null,
  modelId: string | null,
  attachmentIds: string[],
  preferredConversationIds: string[],
  isCloud: boolean,
): string {
  const digest = candidateDigest(shareableFreshnessKeys(isCloud));
  return keyFromParts(
    question,
    providerId,
    modelId,
    attachmentIds,
    preferredConversationIds,
    digest,
  );
}

// --- Store ------------------------------------------------------------------------

/** Whole-envelope shape check (mirrors serde's all-or-nothing parse): any
 *  malformed entry voids the whole file — doubt is a miss, and the next
 *  allowed insert rewrites the store cleanly. */
function validEnvelope(env: unknown): env is Envelope {
  if (!env || typeof env !== "object") return false;
  const e = env as Partial<Envelope>;
  if (e.v !== ENVELOPE_V || !Array.isArray(e.entries)) return false;
  return e.entries.every((c: unknown) => {
    if (!c || typeof c !== "object") return false;
    const a = c as Partial<CachedAnswer>;
    return (
      typeof a.key === "string" &&
      typeof a.createdMs === "number" &&
      typeof a.text === "string" &&
      Array.isArray(a.references) &&
      !!a.meta &&
      typeof a.meta === "object" &&
      typeof a.meta.origin === "string" &&
      typeof a.meta.excerptCount === "number" &&
      typeof a.meta.sourceFileCount === "number"
    );
  });
}

/**
 * Enforce the persistence posture for this request: allowed ⇒ lazily merge the
 * disk mirror into memory (once per process); disallowed ⇒ delete any existing
 * disk file (history-off clears stored chat content) and serve memory only.
 */
function applyPosture(persistAllowed: boolean): void {
  if (!persistAllowed) {
    try {
      fs.unlinkSync(cachePath());
    } catch {
      /* nothing persisted — already clean */
    }
    return;
  }
  if (diskLoaded) return;
  diskLoaded = true;
  const env = readJson<unknown>(cachePath(), null);
  if (!validEnvelope(env)) return;
  // Disk entries predate this session's: merge them in FRONT (least recent),
  // skipping keys the session has already re-answered, then re-apply the cap.
  const live = new Set(entries.map((e) => e.key));
  const merged = [...env.entries.filter((e) => !live.has(e.key)), ...entries];
  entries = merged.slice(Math.max(0, merged.length - CACHE_CAP));
}

function writeThrough(): void {
  writeJson(cachePath(), { v: ENVELOPE_V, entries } satisfies Envelope);
}

/**
 * Look up a stored answer. Always applies the persistence posture (so a
 * disallowed ask deletes the disk file even when it misses or bypasses);
 * `bypassCache` then skips the lookup itself — Re-run always runs live.
 * A hit is touched to most-recent.
 */
export function lookup(key: string, ctl: CacheCtl): CachedAnswer | null {
  applyPosture(ctl.persistAllowed === true);
  if (ctl.bypassCache === true) return null;
  const idx = entries.findIndex((e) => e.key === key);
  if (idx < 0) return null;
  const [entry] = entries.splice(idx, 1);
  entries.push(entry);
  return entry;
}

/**
 * Insert (or refresh) the entry for `key` as most-recent, evicting the least
 * recent past the cap. Callers insert only SUCCESSFUL, COMPLETED answers —
 * errored or interrupted streams must never be replayed. Write-through to the
 * disk mirror only when this request allows persistence.
 */
export function insert(key: string, entry: Omit<CachedAnswer, "key">, ctl: CacheCtl): void {
  applyPosture(ctl.persistAllowed === true);
  entries = entries.filter((e) => e.key !== key);
  entries.push({ ...entry, key });
  entries = entries.slice(Math.max(0, entries.length - CACHE_CAP));
  if (ctl.persistAllowed === true) writeThrough();
}

/**
 * Forget the in-process store and the lazy disk-load flag. Never touches the
 * disk file. For tests (which re-point VAULT_DIR / the app-state dir between
 * cases in one process); a production process never re-points its app-state
 * dir, and stale entries from a prior vault can't false-hit anyway — the
 * candidate digest in every key differs.
 */
export function resetStore(): void {
  entries = [];
  diskLoaded = false;
}
