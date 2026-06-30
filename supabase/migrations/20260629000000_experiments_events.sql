-- A/B experiments (Exp 5 onboarding, Exp 6 default inclusion).
--
-- Records each user's assigned variant on their registration, and adds a thin
-- events table for funnel/telemetry steps (a launch count alone can't express a
-- funnel). Everything joins by the existing stable contact_id, so feedback,
-- bug_reports, and purchase_interest can be sliced by variant through
-- registrations without further schema changes.

alter table registrations
  add column if not exists exp_onboarding text,
  add column if not exists exp_default_inclusion text;

create table if not exists events (
  id          bigint generated always as identity primary key,
  contact_id  text not null,
  name        text not null,
  experiment  text,            -- which experiment this row belongs to (null = untagged)
  variant     text,            -- the user's variant of that experiment
  props       jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

-- Funnel queries filter by event name over a window; per-user joins read by contact.
create index if not exists events_name_created_at_idx on events (name, created_at);
create index if not exists events_contact_id_idx on events (contact_id);
