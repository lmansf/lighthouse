//! §32 §1: the tiered token budgeter — ONE seam for every prompt budget
//! decision, replacing the boolean `on_device` fork. KEEP IN SYNC with
//! src/server/budget.ts (PARITY: the twin mirrors every table and the drop
//! planner byte-for-byte; test/budget.test.mjs and the cargo tests below pin
//! the same cases).
//!
//! Tiers:
//!   - `AppleFm4096` / `AppleFm8192`: the on-device Apple Foundation model —
//!     the window is SHARED between prompt and answer, so budgets subtract a
//!     PER-CALL-TYPE output reserve before sizing input.
//!   - `Llama6144`: any local OpenAI-compatible server that does NOT
//!     advertise a context size (the bundled llama-server, Ollama, LM
//!     Studio). This arm returns the field-tuned 0.6.x constants BYTE-FOR-
//!     BYTE — desktop behavior is unchanged by §32 (the compact-profile flip
//!     is a recorded follow-up, not a rider).
//!   - `RemoteLarge`: hosted providers (≥128k windows). The budgeter never
//!     clamps this tier; the cloud-snapshot rail (§0) pins that assembly.
//!
//! Resolution: LIGHTHOUSE_FORCE_TIER (the device-free acceptance rig)
//! overrides everything; otherwise a health-advertised context size picks the
//! apple tier (§7 plumbs the advertisement), the on-device backend flag
//! defaults to 4096 when nothing is advertised, a silent local server is
//! llama-6144, and cloud is remote-large. The table is test-pinned.
//!
//! Estimation: chars/4 ≈ tokens, but budgets size to 90% of the advertised
//! window — numeric-heavy text runs 2.5-3 chars/token and the margin absorbs
//! the estimator's drift. The bridge's exact tokenCount pre-check (§7) is the
//! backstop, never the first line.

/// The five prompt-budget tiers. Ids are the LIGHTHOUSE_FORCE_TIER vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier {
    AppleFm4096,
    AppleFm8192,
    Llama6144,
    /// §42: the iOS Tier-2 in-process llama backend (1.5B GGUF + Metal).
    /// Same 6144-token window the bridge's /health advertises, but its OWN
    /// registry entry: phone-class prefill wants the measured on-device
    /// segment ceilings, not the desktop 7B's — and the §39 registry floor
    /// says a new backend registers a tier, never borrows one.
    LlamaMobile6144,
    RemoteLarge,
}

impl Tier {
    pub fn id(self) -> &'static str {
        match self {
            Tier::AppleFm4096 => "apple-fm-4096",
            Tier::AppleFm8192 => "apple-fm-8192",
            Tier::Llama6144 => "llama-6144",
            Tier::LlamaMobile6144 => "llama-mobile-6144",
            Tier::RemoteLarge => "remote-large",
        }
    }

    pub fn parse(s: &str) -> Option<Tier> {
        match s {
            "apple-fm-4096" => Some(Tier::AppleFm4096),
            "apple-fm-8192" => Some(Tier::AppleFm8192),
            "llama-6144" => Some(Tier::Llama6144),
            "llama-mobile-6144" => Some(Tier::LlamaMobile6144),
            "remote-large" => Some(Tier::RemoteLarge),
            _ => None,
        }
    }

    /// The advertised (or assumed) token window. Remote is "large" — the
    /// budgeter treats it as unbounded and never clamps.
    pub fn window(self) -> usize {
        match self {
            Tier::AppleFm4096 => 4_096,
            Tier::AppleFm8192 => 8_192,
            Tier::Llama6144 | Tier::LlamaMobile6144 => 6_144,
            Tier::RemoteLarge => usize::MAX,
        }
    }

    pub fn is_apple_fm(self) -> bool {
        matches!(self, Tier::AppleFm4096 | Tier::AppleFm8192)
    }
}

/// The prompt-building call types the budgeter differentiates. Each carries
/// its own OUTPUT reserve: the answer space subtracted from a shared window
/// before any input segment is sized.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallType {
    /// The grounded ask (and the warm call, which rides the same shape).
    Narration,
    /// NL→SQL planning — short structured output.
    NlToSql,
    /// The two report-framing calls — a few sentences each.
    ReportFraming,
}

/// Output reserve in TOKENS for a call on a tier (§1: narration ≥900 on the
/// 4k tier). The llama arm keeps today's fixed `max_tokens: 1024`; remote
/// keeps its own REMOTE_MAX_TOKENS — neither is derived here, both are
/// mirrored so ONE table answers "how much answer room does this call get".
pub fn output_reserve(tier: Tier, call: CallType) -> usize {
    match (tier, call) {
        (Tier::AppleFm4096, CallType::Narration) => 900,
        (Tier::AppleFm8192, CallType::Narration) => 1_200,
        // §42: the mobile llama backend keeps the desktop llama arm's proven
        // answer room — same window, same narration shape.
        (Tier::Llama6144 | Tier::LlamaMobile6144, CallType::Narration) => 1_024,
        (Tier::RemoteLarge, CallType::Narration) => 4_096,
        (_, CallType::NlToSql) => 300,
        (_, CallType::ReportFraming) => 400,
    }
}

/// Chars-per-token estimate (prose averages ~4; the 90% window margin below
/// absorbs numeric-heavy text running 2.5-3).
pub const CHARS_PER_TOKEN: usize = 4;

/// §36 (prerequisite subset, built with §38 — no fuller §36 has landed): the
/// DIGIT-AWARE token estimator. Prose averages ~4 chars/token, but digit runs
/// tokenize at ~2 — a findings block that is mostly numbers can overflow the
/// very window a flat `len/4` estimate promised to protect. Two classes:
/// ASCII digits at 2 chars/token, everything else at 4, each rounded UP, so
/// the estimate errs high and the 90% window margin stays a second belt, not
/// the only one. PARITY: mirrored by src/server/budget.ts::estimateTokens
/// (test/budget.test.mjs pins the same cases as the cargo tests below).
pub fn estimate_tokens(text: &str) -> usize {
    let total = text.chars().count();
    let digits = text.chars().filter(|c| c.is_ascii_digit()).count();
    let other = total - digits;
    digits.div_ceil(2) + other.div_ceil(4)
}

/// Whole-INPUT token budget for a call on a tier: 90% of the window minus the
/// call's output reserve. The char-space `input_char_budget` below stays for
/// the flat-estimate callers; budget-PACKED callers (§38's report framing)
/// size their text with `estimate_tokens` against THIS. Remote is unbounded.
pub fn input_token_budget(tier: Tier, call: CallType) -> usize {
    if tier == Tier::RemoteLarge {
        return usize::MAX;
    }
    (tier.window() * 9 / 10).saturating_sub(output_reserve(tier, call))
}

/// §38 §2: the framing-call overflow ladder — ONE retry with headline-only
/// findings, then the deterministic engine framing. Pure so the policy is a
/// table, not scattered control flow: `prior_overflows` is how many
/// FM_OVERFLOW refusals this framing call has already eaten. PARITY:
/// mirrored by src/server/budget.ts::overflowRetryVerdict.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OverflowStep {
    /// First refusal: retry once with the headline-only findings context.
    RetryHeadlineOnly,
    /// Second refusal: fall back to deterministic framing — no third call.
    EngineFallback,
}

pub fn overflow_retry_verdict(prior_overflows: u32) -> OverflowStep {
    if prior_overflows == 0 {
        OverflowStep::RetryHeadlineOnly
    } else {
        OverflowStep::EngineFallback
    }
}

/// Total INPUT char budget for a call on a tier: 90% of the window minus the
/// call's output reserve, in chars. Remote is unbounded.
pub fn input_char_budget(tier: Tier, call: CallType) -> usize {
    if tier == Tier::RemoteLarge {
        return usize::MAX;
    }
    let window_90 = tier.window() * 9 / 10;
    window_90.saturating_sub(output_reserve(tier, call)) * CHARS_PER_TOKEN
}

/// Per-segment ceilings (chars) for the evidence/history packing — the §32
/// generalization of the 0.6.x clamp constants. The llama arm IS those
/// constants, byte-for-byte; the apple arms carry the 0.13.10 v1 numbers this
/// commit (the §2 compact profile and §8 floors retune them together).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SegmentBudgets {
    /// One context block's ceiling.
    pub ctx_block_max: usize,
    /// All context blocks combined.
    pub ctx_total_max: usize,
    /// Prior-turn history (newest wins).
    pub history_max: usize,
}

pub fn segment_budgets(tier: Tier) -> SegmentBudgets {
    match tier {
        // v1's measured on-device numbers (0.13.10) — both apple arms for
        // now; 8192 retunes with the §8 floors once the compact profile
        // (§2) frees its share of the window.
        Tier::AppleFm4096 | Tier::AppleFm8192 => SegmentBudgets {
            ctx_block_max: 3_500,
            ctx_total_max: 5_000,
            history_max: 2_000,
        },
        // The 0.6.x field-tuned desktop constants — UNCHANGED (asserted
        // against the legacy values in the tier tests).
        Tier::Llama6144 => SegmentBudgets {
            ctx_block_max: 6_000,
            ctx_total_max: 11_000,
            history_max: 6_000,
        },
        // §42: phone-class prefill — a 1.5B on Metal pays for every prompt
        // char in latency, so the mobile llama arm carries the MEASURED
        // on-device segment ceilings (the 0.13.10 apple-arm numbers), not
        // the desktop 7B's. The 6144 window still gives narration more
        // input room than apple-fm-4096 (the reserve math below).
        Tier::LlamaMobile6144 => SegmentBudgets {
            ctx_block_max: 3_500,
            ctx_total_max: 5_000,
            history_max: 2_000,
        },
        Tier::RemoteLarge => SegmentBudgets {
            ctx_block_max: usize::MAX,
            ctx_total_max: usize::MAX,
            history_max: usize::MAX,
        },
    }
}

/// Sweep-segment ceiling (chars) for single-document focus: each segment is
/// one map call and must fit ONE context block of the tier with framing
/// headroom. The llama arm is the 0.11 desktop number byte-for-byte; the
/// mobile llama arm rides the phone-tuned apple number (§42).
pub fn doc_segment_budget(tier: Tier) -> usize {
    match tier {
        Tier::AppleFm4096 | Tier::AppleFm8192 | Tier::LlamaMobile6144 => 3_000,
        Tier::Llama6144 => 5_500,
        Tier::RemoteLarge => usize::MAX,
    }
}

/// Tier resolution — the PURE core (`force` injected so tests never touch
/// process env). Order: forced tier → cloud → llama-backend advertisement
/// (§42: the bridge's /health says `"backend":"llama"` when the Tier-2
/// in-process GGUF answers the contract — the backend field is the truth,
/// never the window size alone) → advertised window (the §7 /health
/// `contextSize`) → the on-device flag's 4096 default → llama.
pub fn resolve_tier_with(
    force: Option<&str>,
    cloud: bool,
    on_device: bool,
    advertised_ctx: Option<u32>,
    llama_backend: bool,
) -> Tier {
    if let Some(f) = force.and_then(Tier::parse) {
        return f;
    }
    if cloud {
        return Tier::RemoteLarge;
    }
    if llama_backend && advertised_ctx.is_some() {
        return Tier::LlamaMobile6144;
    }
    match advertised_ctx {
        Some(n) if n >= 8_192 => Tier::AppleFm8192,
        Some(_) => Tier::AppleFm4096,
        None if on_device => Tier::AppleFm4096,
        None => Tier::Llama6144,
    }
}

/// Production resolution: LIGHTHOUSE_FORCE_TIER honored (the forced-tier rig
/// runs the desktop 7B under apple-fm-4096 with zero Apple hardware).
pub fn resolve_tier(cloud: bool, on_device: bool, advertised_ctx: Option<u32>) -> Tier {
    let force = std::env::var("LIGHTHOUSE_FORCE_TIER").ok();
    resolve_tier_with(
        force.as_deref(),
        cloud,
        on_device,
        advertised_ctx,
        crate::local_model::advertised_llama_backend(),
    )
}

// --- The deterministic degradation planner -----------------------------------

/// The droppable prompt segments, in FRESH-ask drop order (first dropped
/// first): few-shots → the middle of history → unmatched semantic entries →
/// lowest-scored evidence → schema sample values. System, task instruction,
/// question, and framing overhead are never dropped — if they alone overflow,
/// the caller has a §2 problem, not a packing problem.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Segment {
    FewShots,
    HistoryMiddle,
    SemanticUnmatched,
    EvidenceLowest,
    SchemaSamples,
    /// The clamped prior SQL of a refinement — protected by the kernel.
    PriorSql,
}

/// One labeled droppable segment with its current char size.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SegmentSize {
    pub segment: Segment,
    pub chars: usize,
}

/// Deterministic drop plan: given the fixed (undroppable) chars, the
/// droppable segments, and the call's input budget, return the segments to
/// KEEP — dropping in the §1 order until the total fits.
///
/// THE REFINEMENT KERNEL: on a refine-classified ask the clamped prior SQL
/// outranks evidence AND semantic entries — a refinement that cannot see its
/// prior query is wrong by construction — so `PriorSql` drops dead last (it
/// would only go if fixed+prior alone still overflowed, i.e. never on a sane
/// tier). On fresh asks `PriorSql` is absent by definition.
pub fn plan_keep(
    fixed_chars: usize,
    droppable: &[SegmentSize],
    budget_chars: usize,
    refine: bool,
) -> Vec<Segment> {
    // One order serves both ask kinds BECAUSE the kernel is positional:
    // PriorSql sits dead last, and fresh asks must not carry it at all.
    debug_assert!(
        refine || droppable.iter().all(|s| s.segment != Segment::PriorSql),
        "PriorSql offered on a fresh ask — the caller misclassified"
    );
    const DROP_ORDER: [Segment; 6] = [
        Segment::FewShots,
        Segment::HistoryMiddle,
        Segment::SemanticUnmatched,
        Segment::EvidenceLowest,
        Segment::SchemaSamples,
        Segment::PriorSql,
    ];
    let mut kept: Vec<SegmentSize> = droppable.to_vec();
    let total = |fixed: usize, kept: &[SegmentSize]| {
        fixed + kept.iter().map(|s| s.chars).sum::<usize>()
    };
    for victim in &DROP_ORDER {
        if total(fixed_chars, &kept) <= budget_chars {
            break;
        }
        kept.retain(|s| s.segment != *victim);
    }
    kept.into_iter().map(|s| s.segment).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolution_table_is_pinned() {
        // Forced tier wins over everything (the device-free rig).
        assert_eq!(
            resolve_tier_with(Some("apple-fm-4096"), true, false, Some(200_000), false),
            Tier::AppleFm4096
        );
        // Unknown force strings fall through, never panic.
        assert_eq!(
            resolve_tier_with(Some("nonsense"), true, false, None, false),
            Tier::RemoteLarge
        );
        // Cloud → remote-large.
        assert_eq!(resolve_tier_with(None, true, false, None, false), Tier::RemoteLarge);
        // Advertised context sizes pick the apple tier (§7 /health).
        assert_eq!(resolve_tier_with(None, false, true, Some(8_192), false), Tier::AppleFm8192);
        assert_eq!(resolve_tier_with(None, false, true, Some(4_096), false), Tier::AppleFm4096);
        // On-device with no advertisement (today's bridge) → 4096.
        assert_eq!(resolve_tier_with(None, false, true, None, false), Tier::AppleFm4096);
        // A silent local server (desktop llama, Ollama, LM Studio) → llama.
        assert_eq!(resolve_tier_with(None, false, false, None, false), Tier::Llama6144);
        // §42: the bridge advertising the llama backend wins its own tier —
        // the backend field decides, not the window size.
        assert_eq!(
            resolve_tier_with(None, false, true, Some(6_144), true),
            Tier::LlamaMobile6144
        );
        // A llama-backend flag with NO advertisement is a half-broken health
        // body — fall through to the ordinary arms rather than mis-tier.
        assert_eq!(resolve_tier_with(None, false, true, None, true), Tier::AppleFm4096);
        // The forced-tier rig can force the mobile tier on any hardware.
        assert_eq!(
            resolve_tier_with(Some("llama-mobile-6144"), false, false, None, false),
            Tier::LlamaMobile6144
        );
    }

    #[test]
    fn llama_mobile_registration_is_pinned() {
        // §42 §1: the mobile llama tier's registry entry (the §39 floor).
        let t = Tier::LlamaMobile6144;
        assert_eq!(t.id(), "llama-mobile-6144");
        assert_eq!(Tier::parse("llama-mobile-6144"), Some(t));
        assert_eq!(t.window(), 6_144);
        assert_eq!(output_reserve(t, CallType::Narration), 1_024);
        assert_eq!(output_reserve(t, CallType::NlToSql), 300);
        assert_eq!(output_reserve(t, CallType::ReportFraming), 400);
        // Phone-tuned segments (the measured 0.13.10 numbers), NOT the
        // desktop 7B's — prefill latency is the constraint on a phone.
        let b = segment_budgets(t);
        assert_eq!((b.ctx_block_max, b.ctx_total_max, b.history_max), (3_500, 5_000, 2_000));
        assert_eq!(doc_segment_budget(t), 3_000);
        // More narration input room than apple-fm-4096 (bigger window, same
        // 90% rule) — the point of the 6144 advertisement.
        assert!(
            input_token_budget(t, CallType::Narration)
                > input_token_budget(Tier::AppleFm4096, CallType::Narration)
        );
    }

    #[test]
    fn llama_arm_is_the_legacy_constants_byte_for_byte() {
        let b = segment_budgets(Tier::Llama6144);
        assert_eq!(b.ctx_block_max, 6_000);
        assert_eq!(b.ctx_total_max, 11_000);
        assert_eq!(b.history_max, 6_000);
        // And today's fixed local answer room.
        assert_eq!(output_reserve(Tier::Llama6144, CallType::Narration), 1_024);
    }

    #[test]
    fn apple_arms_carry_v1_numbers_this_commit() {
        for t in [Tier::AppleFm4096, Tier::AppleFm8192] {
            let b = segment_budgets(t);
            assert_eq!((b.ctx_block_max, b.ctx_total_max, b.history_max), (3_500, 5_000, 2_000));
        }
        assert!(output_reserve(Tier::AppleFm4096, CallType::Narration) >= 900);
    }

    #[test]
    fn input_budget_is_ninety_percent_minus_reserve() {
        // apple-fm-4096 narration: (4096*0.9 − 900) × 4 = 11,144 chars.
        assert_eq!(input_char_budget(Tier::AppleFm4096, CallType::Narration), 11_144);
        // NL→SQL keeps a smaller reserve → more input room.
        assert_eq!(input_char_budget(Tier::AppleFm4096, CallType::NlToSql), 13_544);
        assert_eq!(input_char_budget(Tier::RemoteLarge, CallType::Narration), usize::MAX);
    }

    #[test]
    fn digit_aware_estimate_charges_numbers_double() {
        // 16 prose chars → 4 tokens; the same length all-digits → 8.
        assert_eq!(estimate_tokens("sixteen ch text!"), 4);
        assert_eq!(estimate_tokens("1234567890123456"), 8);
        // Mixed: 8 digits (→4) + 8 others (→2); classes round up separately.
        assert_eq!(estimate_tokens("12345678 prose!"), 4 + 2);
        assert_eq!(estimate_tokens(""), 0);
        // The flat estimate under-counts numeric text — the §36 motivation:
        // a digit-heavy line costs MORE tokens than len/4 claims.
        let numeric = "| 2024-10 | 400.25 | +2.85 | 118203 |";
        assert!(estimate_tokens(numeric) > numeric.chars().count() / CHARS_PER_TOKEN);
    }

    #[test]
    fn token_budget_is_ninety_percent_minus_reserve() {
        // apple-fm-4096 framing: 4096*0.9 − 400 = 3,286 tokens of input room.
        assert_eq!(input_token_budget(Tier::AppleFm4096, CallType::ReportFraming), 3_286);
        assert_eq!(input_token_budget(Tier::AppleFm4096, CallType::Narration), 2_786);
        assert_eq!(input_token_budget(Tier::RemoteLarge, CallType::ReportFraming), usize::MAX);
    }

    #[test]
    fn overflow_ladder_retries_once_then_falls_back() {
        // §38 §2: first FM_OVERFLOW → headline-only retry; second → engine
        // framing; there is never a third call.
        assert_eq!(overflow_retry_verdict(0), OverflowStep::RetryHeadlineOnly);
        assert_eq!(overflow_retry_verdict(1), OverflowStep::EngineFallback);
        assert_eq!(overflow_retry_verdict(7), OverflowStep::EngineFallback);
    }

    #[test]
    fn fresh_drop_order_is_deterministic() {
        let segs = [
            SegmentSize { segment: Segment::FewShots, chars: 1_000 },
            SegmentSize { segment: Segment::HistoryMiddle, chars: 1_000 },
            SegmentSize { segment: Segment::SemanticUnmatched, chars: 1_000 },
            SegmentSize { segment: Segment::EvidenceLowest, chars: 1_000 },
            SegmentSize { segment: Segment::SchemaSamples, chars: 1_000 },
        ];
        // Budget forces exactly two drops: few-shots then history-middle go.
        let kept = plan_keep(500, &segs, 3_600, false);
        assert_eq!(
            kept,
            vec![Segment::SemanticUnmatched, Segment::EvidenceLowest, Segment::SchemaSamples]
        );
        // Everything fits → nothing drops.
        assert_eq!(plan_keep(0, &segs, 10_000, false).len(), 5);
    }

    #[test]
    fn refinement_kernel_protects_prior_sql_to_the_last() {
        let segs = [
            SegmentSize { segment: Segment::PriorSql, chars: 800 },
            SegmentSize { segment: Segment::EvidenceLowest, chars: 2_000 },
            SegmentSize { segment: Segment::SemanticUnmatched, chars: 1_000 },
            SegmentSize { segment: Segment::SchemaSamples, chars: 700 },
        ];
        // Tight budget: evidence AND semantic AND schema all drop before the
        // prior SQL is even considered — the refinement keeps its query.
        let kept = plan_keep(400, &segs, 1_300, true);
        assert_eq!(kept, vec![Segment::PriorSql]);
    }
}
