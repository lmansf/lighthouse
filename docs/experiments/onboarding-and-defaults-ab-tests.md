# A/B Testing Guide: Onboarding (Exp 5) and Default Inclusion (Exp 6)

This guide covers how to run two experiments end to end: the onboarding flow (play-first vs key-first) and the default RAG inclusion behavior (opt-in vs opt-out).
It covers the analytics to build first, the branch and flag strategy, and a week-by-week plan for each.

## TL;DR

Use one feature flag per experiment on `main`, not two long-lived branches.
Assign each user to a variant once, persist it, and send that variant tag with every event.
Build the analytics instrumentation first, ship the experiment second.
Call the winner on a single pre-declared primary metric, then clean up by deleting the flag and the losing code path.

---

## 1. Branch and project strategy

You asked about branching two copies from `main` and merging the winner.
That works for *building* the variants, but it is the wrong unit for *running* the test.
A live 50/50 split needs both code paths in production at the same time, which two divergent branches cannot give you without two deployments and a traffic router.

### Recommended: one flag, short-lived branches

Keep a single experiment flag that both variants live behind, on `main`.
The flag's value comes from the user's variant assignment (see section 2), so one shipped build serves both A and B and buckets users itself.

Develop each variant on its own short-lived branch so the work stays isolated:

- `exp/onboarding-play-first` and `exp/onboarding-key-first` for Exp 5.
- `exp/default-opt-in` and `exp/default-opt-out` for Exp 6.

Both branches merge back into `main` behind the same flag.
Production then has both paths, and the assignment logic decides which a given user sees.

If you want to build the two variants in parallel without constantly switching branches, use a git worktree per variant (you already use this pattern for the feature teams):

```
git worktree add ../rag-vault-playfirst exp/onboarding-play-first
git worktree add ../rag-vault-keyfirst  exp/onboarding-key-first
```

### Why this is actually less work

One deployment instead of two, and no router to maintain.
The variants cannot silently drift, because they share everything except the code behind the flag.
Calling the winner is a single small PR: hard-code the winning path, delete the flag and the losing branch of the `if`, delete the dead component.
No "merge the loser's unrelated changes" cleanup, because there are none.

---

## 2. Build the analytics first (shared by both experiments)

Do this before either experiment ships, so the data is clean from the first user.

### 2a. Variant assignment

Assign each user once, on first run, and persist it next to the existing profile (in `profile.json` under the vault state dir).
Use a deterministic hash of `contact_id` with a per-experiment salt, so the two experiments randomize independently:

```
variant(contactId, experiment) =
  hashToUnitInterval(contactId + ":" + experiment) < 0.5 ? "A" : "B"
```

A deterministic hash means the assignment is stable across launches and reproducible from the analytics side, and the salt stops a user's Exp 5 bucket from correlating with their Exp 6 bucket.
Store the resolved label (not "A"/"B" but the meaningful name, e.g. `play_first`) so the data reads clearly later.

The hash alone splits ~50/50 only at scale and can skew at low N (4 installs might land 3/1), which matters for a small pilot.
So registration calls the license function's **`assign`** op, which buckets each install into the *least-used* variant per experiment (recorded in the `experiment_assignments` table) and keeps a small pilot close to an even split under serial / low-volume registration.
It is stable and idempotent (an existing assignment is reused), a pilot-email override still wins, and offline or with the function unconfigured the local hash assignment stands.
The balanced assignment is applied at registration *before* onboarding branches on the variant, so the user never sees a flip.
See `src/server/experiment.ts` (`assignBalancedVariants`) and the `assign` op in `supabase/functions/license/index.ts`.

### 2b. Events to log

The app already sends one `userlogs` row per launch.
Add a small `events` table for funnel steps, because activation is a sequence, not a launch count.
Every event carries the user's variant for each active experiment, so the dashboard can split any metric by variant.

Minimum events to define now:

- `onboarding_started`
- `sample_vault_loaded`
- `first_query` (the activation moment)
- `api_key_entered`
- `rag_inclusion_changed` (a toggle action)
- `answer_rendered` with a `source_count` prop (so you can see empty-answer rates)
- `returned` (any launch after day 0, for retention)

### 2c. Supabase changes

Keep it minimal and join everything by the existing stable `contact_id`.

Add experiment assignment to `registrations`:

- `exp_onboarding text` (values: `play_first`, `key_first`, or null)
- `exp_default text` (values: `opt_in`, `opt_out`, or null)

Add a thin events table:

```
events (
  id          bigint generated always as identity primary key,
  contact_id  text not null,
  name        text not null,
  variant     text,            -- the variant of the experiment this event belongs to
  experiment  text,            -- which experiment, so one column of variant is unambiguous
  props       jsonb default '{}'::jsonb,
  created_at  timestamptz not null default now()
)
```

Add a thin assignment ledger so the `assign` op can balance the split (one row per `contact_id` + `experiment`, the unique constraint making assignment idempotent):

```
experiment_assignments (
  id          bigint generated always as identity primary key,
  contact_id  text not null,
  experiment  text not null,   -- onboarding | default_inclusion
  variant     text not null,   -- play_first|key_first | opt_in|opt_out
  created_at  timestamptz not null default now(),
  unique (contact_id, experiment)
)
```

This is the assignment source of truth for balancing only; the dashboard still reads variants from `registrations.exp_*` and `events.variant`.

Everything else (`feedback`, `bug_reports`, `purchase_interest`) already joins by `contact_id`, so you can slice those by variant through `registrations` without schema changes.

### 2d. Dashboard: an Experiments page

Build one new page in lighthouse-analytics ahead of time: `/(dashboard)/experiments`.
Design it once and reuse it for both experiments via a selector.

The page should show, for a chosen experiment, side by side per variant:

- N assigned (from `registrations`), to confirm the split is roughly even.
- The primary metric as a conversion: count and rate, with the two variants next to each other.
- A small funnel (assigned, started, sample loaded, first query, key entered) per variant.
- Guardrail metrics (defined per experiment below), so a "win" that quietly harms something else is visible.
- Run length so far (days) and whether the minimum N and minimum duration have been met.

Deliberately do not put a giant "Variant A is winning!" banner that invites stopping early.
Show the numbers; make the call at the planned end (section 5).

---

## 3. Experiment 5: Onboarding (play-first vs key-first)

### Hypothesis

Letting a user reach a real answer in the pre-loaded sample vault before asking for an API key will raise activation, because they see value before they hit friction.

### Variants

- `key_first` (control): the current flow, ask for the model and API key during onboarding, then reach the workspace.
- `play_first`: drop the user straight into the bundled Coastal Wildlife sample vault with a working query, then prompt for a key when they try to use their own files.

### Metrics

- Primary: activation rate = users who fire `first_query` within their first session, divided by users assigned.
- Guardrail 1: `api_key_entered` rate, so you catch it if play-first activates more people but fewer ever connect a real key (a monetization risk).
- Guardrail 2: day-2 `returned` rate.

### Week by week (about 4 weeks)

- Week 0 (prep): land the section 2 analytics, the flag, and the assignment logic on `main`. Confirm events arrive in Supabase tagged with the variant.
- Week 1 (build): implement both variants on their branches behind the flag, merge to `main`, and QA both paths by forcing each variant locally. Verify the sample vault loads cleanly in play-first.
- Weeks 2-3 (collect): release. Watch the dashboard daily for data integrity only (even split, events landing), not to peek-and-stop. Let it run across two full weeks so weekday/weekend patterns wash out.
- Week 4 (decide): freeze, read the primary metric and guardrails, make the call, ship the cleanup PR.

---

## 4. Experiment 6: Default inclusion (opt-in vs opt-out)

Run this after Exp 5 has concluded, or on a separate user population, so the two flag changes do not confound each other.

### Hypothesis

Including everything by default gets users to a useful answer faster (no empty "0 sources" first query), at the possible cost of weakening the control story.
Opt-in by default protects the control narrative but may delay the first useful answer.

### Variants

- `opt_in` (the control-story default): nothing is included until the user toggles it on.
- `opt_out`: everything is included by default, with a prominent "you control what AI sees" affordance.

### Metrics

- Primary: 7-day retention (users with a `returned` event 7 days after first run), because this experiment is about durable value, not first-click.
- Guardrail 1: empty-answer rate (`answer_rendered` with `source_count = 0`), which opt-in is expected to inflate.
- Guardrail 2: `rag_inclusion_changed` actions per user, so you can see whether opt-out kills the deliberate control behavior that is core to the brand.
- Guardrail 3: feedback sentiment mentioning control, privacy, or "it saw something it should not have," read from the `feedback` table sliced by variant.

### Week by week (about 4 weeks)

- Week 0 (prep): the section 2 analytics already exist; add the `answer_rendered` source-count prop if it is not live yet, and confirm `exp_default` assignment is recorded.
- Week 1 (build): implement both defaults behind the flag, merge to `main`, QA both, and specifically check that opt-out shows the control affordance loudly.
- Weeks 2-3 (collect): release, let it run two full weeks, watch for data integrity only.
- Week 4 (decide): read retention plus all three guardrails together, because this is the experiment where a raw-metric "win" can still be the wrong call for the brand. Decide, then clean up.

---

## 5. Calling a winner and cleaning up

Decide the rule before you ship, not after you see the numbers.

- Minimum run time: two full calendar weeks, regardless of how fast the numbers move.
- Minimum sample: a floor of roughly 30 to 50 activations per variant before the result means anything. Below that, treat the result as directional only.
- Primary metric decides; guardrails can veto. If a variant wins the primary metric but trips a guardrail (for Exp 6, an empty-answer spike or control-related complaints), that is a reason to hold or rethink, not to ship blindly.
- Pre-launch, prefer obvious effects. If the difference is small, it does not matter yet; pick the simpler variant and move on.

Cleanup is one small PR:

- Hard-code the winning path.
- Delete the flag, the losing branch of the `if`, and the losing component.
- Delete the losing variant branch and any worktree.
- Leave the assignment column and events in place; they are your record of why the decision was made.

---

## 6. Sequencing across the calendar

Run the two experiments back to back, not on top of each other, so each flag change is the only variable.

- Weeks 1-4: Exp 5 (onboarding), ending in a decision and cleanup.
- Weeks 5-8: Exp 6 (default inclusion), on top of the shipped onboarding winner.

The Experiments dashboard page is built once in Exp 5's week 0 and reused for Exp 6 by switching the selector.
