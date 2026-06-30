-- Usage click-logging: destination table for best-effort UI telemetry.
--
-- The desktop app captures coarse click events (folders, files, toggles,
-- buttons, links, nav), buffers them locally, and batch-publishes them on the
-- next launch via the license Edge Function's `events` action (see
-- supabase/functions/license/index.ts -> events()). Each row carries the same
-- stable contact_id / guid / email as the other tables, so usage can be joined
-- back to a registration (e.g. paid vs unpaid) on contact_id.
--
-- Labels are NAMES ONLY (a control's text/aria-label, or a file/folder name) -
-- never field values or file contents.
--
-- Apply via the Supabase SQL Editor or the Management API against the license
-- project (POST /v1/projects/<ref>/database/query). Idempotent.

create table if not exists public.click_events (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  contact_id  uuid,
  guid        uuid,
  email       text,
  event_type  text,        -- folder | file | toggle | button | link | nav | other
  label       text,        -- coarse label/name of the touched control (no values)
  occurred_at timestamptz, -- when the interaction happened (client clock)
  app_version text
);

-- Join usage back to a registration by contact_id (the common analytics path).
create index if not exists click_events_contact_idx on public.click_events (contact_id);

-- The Edge Function uses the service-role key (bypasses RLS), so no anon policy
-- is needed and the table is never exposed to anon select/insert.
