/**
 * §32 §1: the tiered token budgeter — ONE seam for every prompt budget
 * decision, replacing the boolean on-device fork. KEEP IN SYNC with
 * native/crates/lighthouse-core/src/budget.rs (PARITY: this twin mirrors
 * every table and the drop planner byte-for-byte; test/budget.test.mjs and
 * the cargo tests pin the same cases).
 *
 * Tiers:
 *   - "apple-fm-4096" / "apple-fm-8192": the on-device Apple Foundation
 *     model — the window is SHARED between prompt and answer, so budgets
 *     subtract a per-call-type OUTPUT reserve before sizing input.
 *   - "llama-6144": any local OpenAI-compatible server that does NOT
 *     advertise a context size (the bundled llama-server, Ollama, LM
 *     Studio). This arm returns the field-tuned 0.6.x constants byte-for-
 *     byte — desktop behavior is unchanged by §32.
 *   - "remote-large": hosted providers (≥128k windows). The budgeter never
 *     clamps this tier; the cloud-snapshot rail (§0) pins that assembly.
 *
 * Resolution: LIGHTHOUSE_FORCE_TIER (the device-free acceptance rig)
 * overrides everything; otherwise a health-advertised context size picks the
 * apple tier (§7 plumbs the advertisement), the on-device backend flag
 * defaults to 4096 when nothing is advertised, a silent local server is
 * llama-6144, and cloud is remote-large.
 *
 * Estimation: chars/4 ≈ tokens, but budgets size to 90% of the advertised
 * window — numeric-heavy text runs 2.5-3 chars/token and the margin absorbs
 * the estimator's drift. The bridge's exact tokenCount pre-check (§7) is the
 * backstop, never the first line.
 *
 * PARITY: Rust's unbounded arms are usize::MAX; here they are Infinity —
 * same "never clamps" semantics under comparison, different representation.
 */

/** The four prompt-budget tiers. Ids are the LIGHTHOUSE_FORCE_TIER vocabulary. */
export type Tier = "apple-fm-4096" | "apple-fm-8192" | "llama-6144" | "remote-large";

const TIERS: readonly Tier[] = ["apple-fm-4096", "apple-fm-8192", "llama-6144", "remote-large"];

export function parseTier(s: string): Tier | null {
  return (TIERS as readonly string[]).includes(s) ? (s as Tier) : null;
}

/** The advertised (or assumed) token window; remote is unbounded. */
export function tierWindow(tier: Tier): number {
  switch (tier) {
    case "apple-fm-4096":
      return 4_096;
    case "apple-fm-8192":
      return 8_192;
    case "llama-6144":
      return 6_144;
    case "remote-large":
      return Infinity;
  }
}

export function isAppleFm(tier: Tier): boolean {
  return tier === "apple-fm-4096" || tier === "apple-fm-8192";
}

/**
 * The prompt-building call types the budgeter differentiates. Each carries
 * its own OUTPUT reserve: the answer space subtracted from a shared window
 * before any input segment is sized.
 */
export type CallType = "narration" | "nl-to-sql" | "report-framing";

/**
 * Output reserve in TOKENS for a call on a tier (§1: narration ≥900 on the
 * 4k tier). The llama arm keeps today's fixed `max_tokens: 1024`; remote
 * keeps its own REMOTE_MAX_TOKENS — neither is derived here, both are
 * mirrored so ONE table answers "how much answer room does this call get".
 */
export function outputReserve(tier: Tier, call: CallType): number {
  if (call === "nl-to-sql") return 300;
  if (call === "report-framing") return 400;
  switch (tier) {
    case "apple-fm-4096":
      return 900;
    case "apple-fm-8192":
      return 1_200;
    case "llama-6144":
      return 1_024;
    case "remote-large":
      return 4_096;
  }
}

/** Chars-per-token estimate (prose averages ~4; the 90% margin absorbs drift). */
export const CHARS_PER_TOKEN = 4;

/**
 * §36 (prerequisite subset, built with §38): the DIGIT-AWARE token estimator.
 * Prose ≈4 chars/token, digit runs ≈2 — numeric-heavy text under a flat len/4
 * estimate overflows the window it was sized for. Each class rounds UP so the
 * estimate errs high. KEEP IN SYNC with budget.rs::estimate_tokens.
 */
export function estimateTokens(text: string): number {
  const chars = [...text];
  const digits = chars.filter((c) => c >= "0" && c <= "9").length;
  const other = chars.length - digits;
  return Math.ceil(digits / 2) + Math.ceil(other / 4);
}

/**
 * Total INPUT char budget for a call on a tier: 90% of the window minus the
 * call's output reserve, in chars. Remote is unbounded.
 */
export function inputCharBudget(tier: Tier, call: CallType): number {
  if (tier === "remote-large") return Infinity;
  const window90 = Math.floor((tierWindow(tier) * 9) / 10);
  return Math.max(0, window90 - outputReserve(tier, call)) * CHARS_PER_TOKEN;
}

/**
 * Whole-INPUT token budget: 90% of the window minus the call's output
 * reserve. Budget-packed callers (§38 report framing — Rust-only at the
 * narrate seam) size with `estimateTokens` against this; the twin carries the
 * same table so the budget arithmetic is pinned on both sides. KEEP IN SYNC
 * with budget.rs::input_token_budget.
 */
export function inputTokenBudget(tier: Tier, call: CallType): number {
  if (tier === "remote-large") return Infinity;
  const window90 = Math.floor((tierWindow(tier) * 9) / 10);
  return Math.max(0, window90 - outputReserve(tier, call));
}

/**
 * §38 §2: the framing-call overflow ladder — one retry with headline-only
 * findings, then the deterministic engine framing (no third call). KEEP IN
 * SYNC with budget.rs::overflow_retry_verdict.
 */
export type OverflowStep = "retry-headline-only" | "engine-fallback";

export function overflowRetryVerdict(priorOverflows: number): OverflowStep {
  return priorOverflows === 0 ? "retry-headline-only" : "engine-fallback";
}

/**
 * Per-segment ceilings (chars) for the evidence/history packing — the §32
 * generalization of the 0.6.x clamp constants. The llama arm IS those
 * constants, byte-for-byte; the apple arms carry the 0.13.10 v1 numbers this
 * commit (the §2 compact profile and §8 floors retune them together).
 */
export interface SegmentBudgets {
  /** One context block's ceiling. */
  ctxBlockMax: number;
  /** All context blocks combined. */
  ctxTotalMax: number;
  /** Prior-turn history (newest wins). */
  historyMax: number;
}

export function segmentBudgets(tier: Tier): SegmentBudgets {
  switch (tier) {
    case "apple-fm-4096":
    case "apple-fm-8192":
      return { ctxBlockMax: 3_500, ctxTotalMax: 5_000, historyMax: 2_000 };
    case "llama-6144":
      return { ctxBlockMax: 6_000, ctxTotalMax: 11_000, historyMax: 6_000 };
    case "remote-large":
      return { ctxBlockMax: Infinity, ctxTotalMax: Infinity, historyMax: Infinity };
  }
}

/**
 * Sweep-segment ceiling (chars) for single-document focus: each segment is
 * one map call and must fit ONE context block of the tier with framing
 * headroom. The llama arm is the 0.11 desktop number byte-for-byte.
 */
export function docSegmentBudget(tier: Tier): number {
  switch (tier) {
    case "apple-fm-4096":
    case "apple-fm-8192":
      return 3_000;
    case "llama-6144":
      return 5_500;
    case "remote-large":
      return Infinity;
  }
}

/**
 * Tier resolution — the PURE core (`force` injected so tests never touch
 * process env). Order: forced tier → cloud → advertised window (the §7
 * /health contextSize) → the on-device flag's 4096 default → llama.
 */
export function resolveTierWith(
  force: string | null | undefined,
  cloud: boolean,
  onDevice: boolean,
  advertisedCtx: number | null,
): Tier {
  const forced = force ? parseTier(force) : null;
  if (forced) return forced;
  if (cloud) return "remote-large";
  if (advertisedCtx != null) return advertisedCtx >= 8_192 ? "apple-fm-8192" : "apple-fm-4096";
  return onDevice ? "apple-fm-4096" : "llama-6144";
}

/**
 * Production resolution: LIGHTHOUSE_FORCE_TIER honored (the forced-tier rig
 * runs the desktop 7B under apple-fm-4096 with zero Apple hardware).
 */
export function resolveTier(cloud: boolean, onDevice: boolean, advertisedCtx: number | null): Tier {
  return resolveTierWith(process.env.LIGHTHOUSE_FORCE_TIER, cloud, onDevice, advertisedCtx);
}

// --- The deterministic degradation planner -----------------------------------

/**
 * The droppable prompt segments, in drop order (first dropped first):
 * few-shots → the middle of history → unmatched semantic entries →
 * lowest-scored evidence → schema sample values → (refine only) prior SQL.
 * System, task instruction, question, and framing overhead are never dropped.
 */
export type Segment =
  | "few-shots"
  | "history-middle"
  | "semantic-unmatched"
  | "evidence-lowest"
  | "schema-samples"
  | "prior-sql";

/** One labeled droppable segment with its current char size. */
export interface SegmentSize {
  segment: Segment;
  chars: number;
}

const DROP_ORDER: readonly Segment[] = [
  "few-shots",
  "history-middle",
  "semantic-unmatched",
  "evidence-lowest",
  "schema-samples",
  "prior-sql",
];

/**
 * Deterministic drop plan: given the fixed (undroppable) chars, the
 * droppable segments, and the call's input budget, return the segments to
 * KEEP — dropping in the §1 order until the total fits.
 *
 * THE REFINEMENT KERNEL: on a refine-classified ask the clamped prior SQL
 * outranks evidence AND semantic entries — a refinement that cannot see its
 * prior query is wrong by construction — so "prior-sql" drops dead last.
 * On fresh asks it is absent by definition (`refine` documents the caller's
 * classification; the order itself is positional, mirroring budget.rs).
 */
export function planKeep(
  fixedChars: number,
  droppable: readonly SegmentSize[],
  budgetChars: number,
  _refine: boolean,
): Segment[] {
  let kept = droppable.slice();
  const total = () => kept.reduce((n, s) => n + s.chars, fixedChars);
  for (const victim of DROP_ORDER) {
    if (total() <= budgetChars) break;
    kept = kept.filter((s) => s.segment !== victim);
  }
  return kept.map((s) => s.segment);
}
