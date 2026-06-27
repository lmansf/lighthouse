# Welcome registration (Supabase)

After sign-in, Lighthouse shows a one-time welcome form in the left rail
(first name, last name, email, "do not contact me", city, state). Submitting
inserts a row into a Supabase table; **Skip** is always available and the rest
of onboarding proceeds either way. If Supabase isn't configured, Submit simply
reports "not configured" — the app stays fully usable.

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

> Prefer the **service-role key** (server-side only, never shipped to a browser)
> if you'd rather not open an anon insert policy. Lighthouse only ever uses the
> key from the server route `/api/register`, so it never reaches the client.

## 2. Configure env

Copy `.env.local.example` → `.env.local` and set:

```
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_ANON_KEY=<anon-or-service-role-key>
SUPABASE_REGISTRATIONS_TABLE=registrations
```

Restart the app. Submitting the welcome form now writes a row; verify it in the
Supabase table editor.
