-- De-identified feedback/bug reports (privacy pass, 0.11.1).
--
-- The in-app form now sends exactly what it shows the user: {where, what,
-- version, os, log?}. No contact_id / guid / email is sent (the Edge Function
-- writes NULL even if a modified client supplies them). Existing identity
-- columns are kept for historical rows; new columns carry the OS name and the
-- optional user-approved shell.log excerpt.
alter table public.bug_reports
  add column if not exists os  text,
  add column if not exists log text;

comment on column public.bug_reports.os is
  'OS name (e.g. windows/macos/linux) as shown to the user in the send dialog';
comment on column public.bug_reports.log is
  'User-approved shell.log excerpt (off-by-default checkbox); clamped server-side';
