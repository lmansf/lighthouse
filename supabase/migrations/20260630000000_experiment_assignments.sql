-- Balanced A/B assignment ledger.
--
-- The license function's `assign` op records one row per (contact_id, experiment)
-- and buckets each new install into the least-used variant, so a small pilot
-- alternates evenly instead of relying on the per-install hash. The unique
-- constraint makes assignment idempotent and stable across launches.
--
-- This is the assignment SOURCE OF TRUTH for balancing; the dashboard still reads
-- variants from registrations.exp_* / events.variant (unchanged).

create table if not exists public.experiment_assignments (
  id          bigint generated always as identity primary key,
  contact_id  text not null,
  experiment  text not null,   -- onboarding | default_inclusion
  variant     text not null,   -- play_first|key_first | opt_in|opt_out
  created_at  timestamptz not null default now(),
  unique (contact_id, experiment)
);

-- Counting per-variant assignments for the balancing query.
create index if not exists experiment_assignments_experiment_idx
  on public.experiment_assignments (experiment);
