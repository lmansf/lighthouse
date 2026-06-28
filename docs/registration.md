# Welcome registration + trial licensing (Supabase)

After sign-in, Lighthouse shows a one-time welcome form in the left rail
(first name, last name, email, "do not contact me", city, state). Submitting —
or **Skip**, which is always available — mints a [14-day trial](#trial-licensing)
and the rest of onboarding proceeds either way.

## Security model (read this first)

The trial secrets — the Supabase **service-role key** and the `LICENSE_SECRET`
that encrypts license keys — live **only** inside a hosted Supabase **Edge
Function**. They are never shipped in the desktop app. A locally-run server
cannot safely hold a secret: the app's files are readable on the user's disk, so
anything bundled with it is extractable.

The desktop app holds only **public** values — the Edge Function's URL and the
Supabase **anon** key — committed in `.env.production`. It calls the function to
mint (`start`) and verify (`check`) trials. The filesystem **reset** on expiry
runs locally (only the app can touch the vault).

```
 Desktop app  ──POST {op:start|check}──▶  Edge Function  ──service-role──▶  Supabase
 (anon key,                               (LICENSE_SECRET,                  registrations
  function URL)                            service-role key)                table
```

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
```

### Trial-license columns

Add the trial columns (safe to run on an existing table):

```sql
alter table public.registrations
  add column if not exists guid        uuid        not null default gen_random_uuid(),
  add column if not exists trial_start timestamptz not null default now(),
  add column if not exists trial_end   timestamptz not null default (now() + interval '14 days'),
  add column if not exists license_key text;

-- The function looks up the active trial by its guid.
create unique index if not exists registrations_guid_idx on public.registrations (guid);
```

The Edge Function uses the **service-role** key, which bypasses RLS — so no
`anon` insert/select policy is needed, and emails stay private (never expose
`select` to `anon`).

## 2. Deploy the Edge Function

The function lives at `supabase/functions/license/`. With the
[Supabase CLI](https://supabase.com/docs/guides/cli) linked to your project:

```sh
supabase functions deploy license

# Set the encryption secret (a long random string). This stays server-side;
# changing it later invalidates existing license keys (users re-trial). The
# SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected by Supabase.
supabase secrets set LICENSE_SECRET="$(openssl rand -hex 32)"
```

The function is **free** on the Supabase Free tier (well within the included
Edge Function invocation quota for a once-per-launch check).

## 3. Point the app at it

The shipped app reads the function URL and anon key from the committed
`.env.production`:

```
LICENSE_API_URL=https://<project>.supabase.co/functions/v1/license
SUPABASE_ANON_KEY=<anon key>
```

Both are **public** and safe to commit/ship. For a local dev build, copy them
into `.env.local` (which overrides `.env.production`) so dev hits the same
hosted function. To develop without deploying, set `LICENSE_ENFORCE=1` and
`LICENSE_SECRET=...` in `.env.local` instead for a self-contained local trial.

## Trial licensing

Each registration mints a **14-day trial**: a unique `guid`, a
`trial_start`/`trial_end` window, and an AES-256-GCM `license_key` (the GUID
encrypted with `LICENSE_SECRET`, inside the Edge Function). The function inserts
the row; the app stores a copy in `.rag-vault/license.json`.

Once per launch the app calls the function's `check`. The function returns the
authoritative (extendable) `trial_end` from the row, and:

| Result    | Meaning                              | App behavior                        |
|-----------|--------------------------------------|-------------------------------------|
| `valid`   | within the window                    | runs normally; caches `trial_end`   |
| `expired` | verified past `trial_end`            | **resets the vault**, prompts retrial |
| `none`    | unreadable/forged/corrupt key        | prompts a fresh trial, **no reset** |

Only a verified time-expiry resets. On reset: copied files are deleted, the
index/inclusion state is cleared, references are **unlinked** (their real files
on disk are left untouched), and the local license is removed. The user then
sees **Start new trial** — a one-click 14-day trial reusing their saved contact
info. Re-registration is unlimited.

**Offline grace:** if the function is unreachable, the app never resets. It
honors the last cached `trial_end` while it's still in the future, and otherwise
shows "Start your trial" (still no wipe).

### Extending a trial

In the Supabase table editor, open the user's most recent row (by `email` or
`guid`) and set `trial_end` to a later date. The next launch's `check` reads it
and the trial stays valid — no reset.
