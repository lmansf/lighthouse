# Welcome registration (Supabase)

After sign-in, Lighthouse shows a one-time welcome form in the left rail
(first name, last name, email, "do not contact me", city, state). Submitting —
or **Skip**, which is always available — mints a [14-day trial](#trial-licensing)
and the rest of onboarding proceeds either way. When Supabase is configured the
contact info and trial are written to the registrations table; otherwise the
trial is kept locally and the app stays fully usable (trial enforcement is off
unless `LICENSE_ENFORCE=1`).

## 1. Create the table

In the Supabase SQL editor:

```sql
create table if not exists public.registrations (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  first_name   text,
  last_name    text,
  email        text not null,
  do_not_contact boolean not null default false,
  city         text,
  state        text
);

-- The app inserts via the REST API. If you use the anon key (not the
-- service-role key), enable RLS and allow inserts:
alter table public.registrations enable row level security;

create policy "anon can insert registrations"
  on public.registrations
  for insert
  to anon
  with check (true);
```

### Trial-license columns

Add the trial columns (safe to run on an existing table):

```sql
alter table public.registrations
  add column if not exists guid        uuid        not null default gen_random_uuid(),
  add column if not exists trial_start timestamptz not null default now(),
  add column if not exists trial_end   timestamptz not null default (now() + interval '14 days'),
  add column if not exists license_key text;

-- The app looks up the active trial by its guid.
create unique index if not exists registrations_guid_idx on public.registrations (guid);
```

The app reads/extends trials with the **service-role** key from the server, so
no extra `select` policy is needed (and emails stay private — never expose
`select` to `anon`).

## Trial licensing

Each registration mints a **14-day trial**: a unique `guid`, a
`trial_start`/`trial_end` window, and an AES-256-GCM `license_key` (encrypts the
guid with `LICENSE_SECRET`). The row goes to Supabase; a copy is stored locally
in `.rag-vault/license.json`.

Once per launch the app calls `/api/license check`. It reads the authoritative
`trial_end` from Supabase (so manual extensions apply). When the trial has
ended the vault is **reset** — copied files deleted, index/state cleared,
references unlinked (their real files left in place), local license removed —
and the user is shown **Start new trial** (a one-click new 14-day trial, reusing
their saved contact info). Re-registration is unlimited.

Enforcement is active only when Supabase is configured (or `LICENSE_ENFORCE=1`);
otherwise the app runs unlicensed.

### Extending a trial

In the Supabase table editor, open the user's most recent row (by `email` or
`guid`) and set `trial_end` to a later date. The next launch check picks it up
and the trial stays valid — no reset.

> Prefer the **service-role key** (server-side only, never shipped to a browser)
> if you'd rather not open an anon insert policy. Lighthouse only ever uses the
> key from the server route `/api/register`, so it never reaches the client.

## 2. Configure env

Copy `.env.local.example` → `.env.local` and set:

```
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service-role key — server-side only, for licensing>
SUPABASE_REGISTRATIONS_TABLE=registrations
LICENSE_SECRET=<long random string — encrypts the license key>
```

Restart the app. Submitting the welcome form now writes a row; verify it in the
Supabase table editor.
