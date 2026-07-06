-- Feature-interest votes.
--
-- The mid-session feedback nudge now asks "Would you use any of these features?"
-- — features shelved from the app to keep it lean (see src/lib/shelvedFeatures.ts
-- and docs/blueprints/*) — instead of a long 6-field survey. Each submission
-- records ONE ROW PER SHOWN FEATURE with a `wanted` flag, so per-feature demand
-- and its yes-rate (wanted / shown) can be read directly. Kept in its OWN table,
-- separate from `feedback`.
--
-- Written only by the license Edge Function with the service-role key (which
-- bypasses RLS), so enable RLS with no policies to keep anon/authenticated out —
-- the same posture as the other product-analytics tables.
--
-- Read the per-feature ranking ad hoc in the SQL editor:
--   select feature,
--          count(*) filter (where wanted)         as yes,
--          count(*)                                as shown,
--          count(distinct contact_id)             as people
--   from public.feature_interest
--   group by feature
--   order by yes desc;
--
-- Apply via the Supabase SQL Editor or the Management API against the license
-- project (POST /v1/projects/<ref>/database/query). Idempotent.

create table if not exists public.feature_interest (
  id           bigint generated always as identity primary key,
  contact_id   text,
  feature      text not null,
  wanted       boolean not null default true,
  app_version  text,
  created_at   timestamptz not null default now()
);

-- Per-feature aggregate reads filter by feature; per-user joins read by contact.
create index if not exists feature_interest_feature_idx on public.feature_interest (feature);
create index if not exists feature_interest_contact_id_idx on public.feature_interest (contact_id);

-- Internal product analytics — only the Edge Function (service-role) writes here.
alter table public.feature_interest enable row level security;
revoke all on public.feature_interest from anon, authenticated;
