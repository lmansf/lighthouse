//! §44 §4: the trust invariant as an acceptance floor. A numeric claim about a
//! data file is EITHER shown with engine provenance whose figures match the
//! engine's exactly, OR degraded to an honest number-free reply — NEVER a bare
//! model number. The full forced-tier rig (apple-fm-4096 / desktop 7B narrating
//! real SQL) runs in CI and on device; this pins the deterministic guarantee
//! underneath it, provable by every `cargo test` with no model at all.

use lighthouse_core::numguard::{
    answer_has_unverified_number, number_free_degradation, number_tokens, verified_set,
};
use lighthouse_core::table_profile::{profile_answer, table_profile};

const SLEEP_CSV: &str = "\
date,sleep_hours,quality
2024-01-01,7.5,good
2024-01-02,6.0,fair
2024-01-03,8.0,good
2024-01-04,7.0,good
2024-01-05,6.5,fair";

#[test]
fn sleep_csv_average_is_answered_from_the_verified_profile() {
    // The sleep-CSV "average sleep_hours" case. On the on-device path where the
    // weak model can't write runnable SQL, §1b answers from the EXACT profile:
    // the answer shows the computation (§3), and every number in it is one
    // table_profile() computed — the guard would degrade 0 times.
    let profile = table_profile("sleep.csv", SLEEP_CSV).expect("a real table profiles");
    let answer = profile_answer("sleep.csv", SLEEP_CSV).expect("profileable");

    // Provenance shown by default.
    assert!(answer.contains("*Computed exactly by Lighthouse:*"), "no computation shown: {answer}");
    // The mean is engine-computed: (7.5+6.0+8.0+7.0+6.5)/5 = 7.0.
    assert!(profile.contains("mean 7"), "profile computes the mean: {profile}");

    // THE INVARIANT: no number the answer states is outside the engine's
    // verified set — the guard's counter is 0 on this verified answer.
    let verified = verified_set(&[&profile]);
    assert!(
        !answer_has_unverified_number(&answer, &verified),
        "the profile answer states only engine figures: {answer}",
    );
    // Concretely: every numeric token in the answer is one table_profile() emitted.
    let profile_nums = number_tokens(&profile);
    for n in &number_tokens(&answer) {
        assert!(
            profile_nums.contains(n) || verified.contains(n),
            "answer states a number {n} table_profile() never computed",
        );
    }
}

#[test]
fn adversarial_non_profileable_numeric_ask_degrades_with_no_free_figure() {
    // Force the SQL-fail + non-profileable case: no executed query and no
    // profile, so the engine-verified set is EMPTY. A model answer that states a
    // figure must degrade to the honest number-free reply — asserted to carry
    // none of the model's invented figures.
    let model_answer = "Your nightly average is 6.5 hours across 42 nights, up 12% since January.";
    let verified = verified_set(&[]);
    assert!(
        answer_has_unverified_number(model_answer, &verified),
        "the bare model numbers are unverified against an empty set",
    );

    let degraded = number_free_degradation("data.xlsx", &["sleep_hours".into(), "quality".into()]);
    // Names a column to retry with…
    assert!(degraded.contains("average sleep_hours"), "no retry hint: {degraded}");
    // …and — THE INVARIANT — leaks none of the model's invented figures.
    for bare in ["6.5", "42", "12"] {
        assert!(!degraded.contains(bare), "degradation leaked a free figure {bare}: {degraded}");
    }
    // The degradation states no data figure at all.
    assert!(number_tokens(&degraded).is_empty(), "the degradation is number-free: {degraded}");
}

#[test]
fn a_faithful_narration_of_the_verified_numbers_is_never_degraded() {
    // The guard must not punish a truthful answer: a narration that cites only
    // the profile's own figures (and the integer part of a verified decimal)
    // passes — so a good on-device answer is never needlessly degraded.
    let profile = table_profile("sleep.csv", SLEEP_CSV).unwrap();
    let verified = verified_set(&[&profile]);
    let faithful = "You averaged about 7 hours a night, ranging from 6 to 8.";
    assert!(
        !answer_has_unverified_number(faithful, &verified),
        "7, 6, 8 are all engine figures (mean 7, min 6, max 8): {profile}",
    );
    // But inventing one figure trips it, even amid faithful ones.
    let invented = "You averaged 7 hours, with a personal best of 11 hours.";
    assert!(
        answer_has_unverified_number(invented, &verified),
        "11 appears nowhere in the profile",
    );
}
