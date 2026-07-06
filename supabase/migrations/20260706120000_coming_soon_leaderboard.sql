-- Coming-soon interest leaderboard (cross-user).
--
-- Aggregates the `coming_soon_interest` telemetry events — logged from the app's
-- "coming soon" buttons and the Experiments board (see src/lib/comingSoon.ts) —
-- into a per-feature ranking, so the TRUE cross-user demand can be read
-- server-side. (The in-app Experiments board only counts the local device; this
-- view is the real aggregate across every install.)
--
-- Dedupe note: each interest click is recorded by the license Edge Function's
-- event() action, which writes ONE ROW PER ACTIVE EXPERIMENT for the clicking
-- user (or a single untagged row if they have none) — so one click can fan out
-- to several rows in `events`. Counting raw rows would inflate the numbers, and
-- unevenly (a user in more experiments would weigh more). We collapse the fan-out
-- instead:
--   clicks = count(distinct (contact_id, created_at))  -- all rows from one
--            click share the same insert() timestamp, so each click counts once
--   users  = count(distinct contact_id)                -- unique interested people
--
-- Read it via the Edge Function's `comingSoonLeaderboard` op (admin-token gated),
-- or ad hoc in the SQL editor:  select * from public.coming_soon_leaderboard;
--
-- Apply via the Supabase SQL Editor or the Management API against the license
-- project (POST /v1/projects/<ref>/database/query). Idempotent.

create or replace view public.coming_soon_leaderboard as
select
  props ->> 'feature'                        as feature,
  count(distinct (contact_id, created_at))   as clicks,
  count(distinct contact_id)                 as users
from public.events
where name = 'coming_soon_interest'
  and props ->> 'feature' is not null
group by props ->> 'feature';

-- Internal product analytics — the Edge Function reads this with the service-role
-- key, so keep it off the anon/authenticated roles and never expose it publicly.
revoke all on public.coming_soon_leaderboard from anon, authenticated;
