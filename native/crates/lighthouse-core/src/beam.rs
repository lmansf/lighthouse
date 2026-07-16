//! The budgeted Beam loop control core (openspec: add-beam-loop §2).
//!
//! The multi-step analytics executor in `synth.rs` runs a sequence of verified
//! SQL steps: each iteration makes ONE combined plan+decide model call (§2.2),
//! and the engine executes the chosen SELECT through the guarded `run_query` —
//! every number stays engine-computed (§14). This module owns the loop's
//! CONTROL policy — when to run another step and when to stop — lifted out of
//! the generator so it is unit-testable WITHOUT a model. The generator keeps the
//! I/O (it must: `stream_answer`, `run_query`, and the progress `yield`s live
//! inside an `async_stream!` that a plain fn cannot host); this struct decides.
//!
//! The former bound was a bare `steps.len() < 3` count. It is replaced by a
//! `Budget` with three independent dimensions plus a no-progress guard:
//!
//! - `max_steps` — the config `beam_max_steps` (default 5), the primary bound
//!   that is ALWAYS present. The loop never runs more steps than this.
//! - `deadline` — a generous whole-loop wall-clock safety net, so a wedged
//!   provider cannot spin without end even if every other signal is absent.
//! - `token_ceiling` — an optional provider-reported token cap (openspec §1).
//!   `None` when unconfigured OR when usage went unreported (§1.4): a `None`
//!   ceiling is NEVER binding, so the loop still bounds on `max_steps`/`deadline`
//!   and NEVER runs unbounded merely because a token count is missing.
//! - the no-progress guard — stop if a planned SQL byte-repeats a prior step's
//!   (re-running it re-computes a known result) or two consecutive replies fail
//!   to advance (a corrective retry that re-fails / repeated non-answers).
//!
//! Twin PARITY: Rust-only. The multi-step loop is analytics, which is
//! Rust-engine-only (docs/ts-twin.md); the TS twin never takes the branch, so it
//! has no mirror of this module.

use std::time::{Duration, Instant};

use crate::llm::Usage;

/// A generous whole-loop wall-clock safety net (openspec: add-beam-loop §2.1).
/// Large enough that a healthy remote run of `max_steps` never approaches it,
/// small enough that a wedged provider cannot spin forever. It is NOT a per-step
/// timeout — `stream_answer`/`run_query` keep their own — but a backstop so the
/// loop is bounded even when usage is unreported (§1.4) and the token ceiling
/// therefore cannot bind. Firing it is graceful: the loop narrates over the
/// steps already completed.
pub const DEADLINE: Duration = Duration::from_secs(300);

/// The Beam loop's budget — the explicit, multi-dimensional bound that replaces
/// the former bare `steps.len() < 3` count (openspec: add-beam-loop §2.1).
#[derive(Debug, Clone)]
pub struct Budget {
    /// Hard cap on executed steps (config `beam_max_steps`, default 5). Always
    /// present — the primary bound the loop can never exceed.
    pub max_steps: usize,
    /// Whole-loop wall-clock stop: the loop does not start a step once this
    /// instant has passed. Typically `Instant::now() + DEADLINE` at loop entry.
    pub deadline: Instant,
    /// Provider-reported token ceiling (openspec §1). `None` ⇒ never binding
    /// (unconfigured, or usage unreported per §1.4) — the loop then bounds on
    /// `max_steps`/`deadline` alone, never unbounded.
    pub token_ceiling: Option<u64>,
}

impl Budget {
    pub fn new(max_steps: usize, deadline: Instant, token_ceiling: Option<u64>) -> Self {
        Self { max_steps, deadline, token_ceiling }
    }
}

/// Why the loop stopped starting new steps — returned by the pre-step gate for
/// tests (and available to callers for diagnostics). `StepReply::Done` remains
/// the model's own early stop and is handled by the generator, not here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    /// Reached `Budget::max_steps`.
    MaxSteps,
    /// Passed `Budget::deadline`.
    Deadline,
    /// Accumulated provider-reported tokens reached `Budget::token_ceiling`.
    TokenCeiling,
    /// The no-progress guard tripped: two consecutive non-advancing replies.
    NoProgress,
}

/// The owned Beam loop runner: the `Budget` plus the no-progress guard's state.
/// The generator drives it — consulting `stop_before_step` before each
/// iteration, `is_repeat_sql` on each planned SQL, and recording the outcome via
/// `record_step` / `record_non_advance` — while keeping the actual model calls,
/// query execution, and progress `yield`s itself.
#[derive(Debug)]
pub struct BeamLoop {
    budget: Budget,
    /// Byte-exact SQL of every executed step, for the repeat-SQL guard (rule a).
    executed_sql: Vec<String>,
    /// Consecutive replies that failed to advance, for the two-non-advancing
    /// guard (rule b). Reset to 0 by any successful step.
    non_advancing: usize,
}

impl BeamLoop {
    pub fn new(budget: Budget) -> Self {
        Self { budget, executed_sql: Vec::new(), non_advancing: 0 }
    }

    /// The configured step budget — the loop guard and progress labels read this
    /// in place of the former hardcoded 3.
    pub fn max_steps(&self) -> usize {
        self.budget.max_steps
    }

    /// The pre-iteration gate: may the loop start another step? Consults every
    /// budget dimension in order. `steps_run` is the count of executed steps so
    /// far; `usage_total` is the per-ask summed provider-reported usage (§1) —
    /// `None` when nothing was reported (§1.4), in which case the token ceiling
    /// simply cannot bind and the loop still stops on `max_steps`/`deadline`.
    /// Returns the stop reason, or `None` to proceed.
    pub fn stop_before_step(
        &self,
        steps_run: usize,
        usage_total: Option<Usage>,
    ) -> Option<StopReason> {
        if steps_run >= self.budget.max_steps {
            return Some(StopReason::MaxSteps);
        }
        if Instant::now() >= self.budget.deadline {
            return Some(StopReason::Deadline);
        }
        if self.non_advancing >= 2 {
            return Some(StopReason::NoProgress);
        }
        if let Some(ceiling) = self.budget.token_ceiling {
            // Only a REPORTED total can bind the ceiling; unreported (None) is
            // never binding (§1.4 fallback — bound on steps/deadline instead).
            if let Some(total) = usage_total {
                if total.total() >= ceiling {
                    return Some(StopReason::TokenCeiling);
                }
            }
        }
        None
    }

    /// No-progress guard rule (a): a planned SQL that byte-matches a prior
    /// executed step cannot advance the answer (re-running it re-computes the
    /// same result), so the generator stops instead of spending budget on it.
    pub fn is_repeat_sql(&self, sql: &str) -> bool {
        self.executed_sql.iter().any(|s| s == sql)
    }

    /// Record a step that executed successfully: it advanced the answer, so the
    /// non-advancing streak resets and its SQL joins the repeat-guard set.
    pub fn record_step(&mut self, sql: String) {
        self.executed_sql.push(sql);
        self.non_advancing = 0;
    }

    /// No-progress guard rule (b): record a reply that failed to advance (a
    /// query attempt that errored, or an unusable replan). Returns `true` once
    /// TWO have occurred consecutively — the point at which the loop should
    /// stop rather than keep spending budget on a step that cannot land.
    pub fn record_non_advance(&mut self) -> bool {
        self.non_advancing += 1;
        self.non_advancing >= 2
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn far_future() -> Instant {
        Instant::now() + Duration::from_secs(600)
    }

    #[test]
    fn stops_at_max_steps() {
        // The primary bound: the loop halts exactly at max_steps, and every
        // check below it proceeds (openspec §2.1, spec scenario "stops at
        // max_steps").
        let beam = BeamLoop::new(Budget::new(3, far_future(), None));
        assert_eq!(beam.stop_before_step(0, None), None);
        assert_eq!(beam.stop_before_step(1, None), None);
        assert_eq!(beam.stop_before_step(2, None), None);
        assert_eq!(beam.stop_before_step(3, None), Some(StopReason::MaxSteps));
        assert_eq!(beam.stop_before_step(4, None), Some(StopReason::MaxSteps));
    }

    #[test]
    fn no_progress_guard_halts_a_stuck_loop() {
        // Rule (a): a byte-identical replan is a repeat. Rule (b): two
        // consecutive non-advancing replies trip the guard; a successful step
        // resets it (spec scenario "the no-progress guard halts a stuck loop").
        let mut beam = BeamLoop::new(Budget::new(5, far_future(), None));
        beam.record_step("SELECT 1".to_string());
        assert!(beam.is_repeat_sql("SELECT 1"));
        assert!(!beam.is_repeat_sql("SELECT 2"));

        assert_eq!(beam.record_non_advance(), false); // one is tolerated
        assert_eq!(beam.stop_before_step(1, None), None);
        assert_eq!(beam.record_non_advance(), true); // two in a row → stop
        assert_eq!(beam.stop_before_step(1, None), Some(StopReason::NoProgress));

        // A successful step clears the streak.
        beam.record_step("SELECT 3".to_string());
        assert_eq!(beam.stop_before_step(2, None), None);
    }

    #[test]
    fn unreported_usage_still_bounds_on_max_steps() {
        // §1.4-critical: a token ceiling is set, but NO provider reported usage
        // (usage_total is None). The ceiling must NOT bind; the loop still stops
        // at max_steps — never unbounded because a token count is missing.
        let beam = BeamLoop::new(Budget::new(4, far_future(), Some(1_000)));
        // Under max_steps with unreported usage: proceed (ceiling can't read 0
        // as satisfied, and can't run forever either).
        assert_eq!(beam.stop_before_step(0, None), None);
        assert_eq!(beam.stop_before_step(3, None), None);
        // At max_steps: stop on MaxSteps, never having consulted the ceiling.
        assert_eq!(beam.stop_before_step(4, None), Some(StopReason::MaxSteps));
    }

    #[test]
    fn token_ceiling_binds_only_on_reported_usage() {
        // With a reported total at/over the ceiling the loop stops; an unreported
        // total (None) never binds and falls through to the other bounds.
        let beam = BeamLoop::new(Budget::new(10, far_future(), Some(100)));
        assert_eq!(beam.stop_before_step(0, None), None); // unreported: no bind
        assert_eq!(
            beam.stop_before_step(0, Some(Usage { input: 40, output: 40 })),
            None // 80 < 100
        );
        assert_eq!(
            beam.stop_before_step(0, Some(Usage { input: 60, output: 60 })),
            Some(StopReason::TokenCeiling) // 120 >= 100
        );
    }

    #[test]
    fn deadline_stops_the_loop() {
        // A whole-loop wall-clock backstop: once the deadline passes, the loop
        // stops even with budget and tokens to spare. Spin (nanoseconds) so the
        // assertion is deterministic rather than racing the clock.
        let deadline = Instant::now();
        let beam = BeamLoop::new(Budget::new(100, deadline, None));
        while Instant::now() <= deadline {
            std::hint::spin_loop();
        }
        assert_eq!(beam.stop_before_step(0, None), Some(StopReason::Deadline));
    }
}
