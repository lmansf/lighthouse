# Welcome registration + trial licensing (Supabase)

After sign-in, Lighthouse shows a one-time welcome form in the left rail
(first name, last name, email, "do not contact me", city, state). Submitting —
or **Skip**, which is always available — mints a [14-day trial](#licensing-model)
and the rest of onboarding proceeds either way.

## Security model (read this first)

The trial secrets — the Supabase **service-role key** and the `LICENSE_SECRET`
that encrypts license keys — live **only** inside a hosted Supabase **Edge
Function**. They are never shipped in the desktop app. A locally-run server
cannot safely hold a secret: the app's files are readable on the user's disk, so
anything bundled with it is extractable.

The desktop app holds only **public** values — the Edge Function's URL and the
Supabase **anon** key — committed in `.env.production`. It calls the function to
mint (`start`) and verify (`check`) licenses. The vault is never reset; a lock
is purely a UI state the app applies locally.

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

### License columns

Add the license columns (safe to run on an existing table — `if not exists`
makes it idempotent):

```sql
alter table public.registrations
  -- identity + key
  add column if not exists guid         uuid        not null default gen_random_uuid(),
  add column if not exists license_key  text,
  -- trial vs paid
  add column if not exists license_type text        not null default 'trial'
    check (license_type in ('trial','paid')),
  -- TRIAL: counted in sign-in DAYS, not calendar time
  add column if not exists trial_start  timestamptz not null default now(),
  add column if not exists trial_end    timestamptz not null default (now() + interval '14 days'),
  add column if not exists trial_days   int         not null default 14,
  add column if not exists active_days  int         not null default 0,
  add column if not exists last_active_day date,
  -- PAID: subscription end + grace window before locking
  add column if not exists paid_through timestamptz,
  add column if not exists grace_days   int         not null default 14;

-- The function looks up the license by its guid.
create unique index if not exists registrations_guid_idx on public.registrations (guid);
```

> **Upgrading from the earlier (single-column) schema?** Run exactly the block above. The new
> columns (`license_type`, `trial_days`, `active_days`, `last_active_day`,
> `paid_through`, `grace_days`) are additive; `trial_end` is now only a nominal
> display date — trials are gated by `active_days` vs `trial_days`.

The Edge Function uses the **service-role** key, which bypasses RLS — so no
`anon` insert/select policy is needed, and emails stay private (never expose
`select` to `anon`).

## 2. Deploy the Edge Function

The function lives at `supabase/functions/license/`. With the
[Supabase CLI](https://supabase.com/docs/guides/cli) linked to your project:

```sh
supabase functions deploy license

# Encryption secret (long random string). Stays server-side; changing it later
# invalidates existing license keys (users re-trial). SUPABASE_URL and
# SUPABASE_SERVICE_ROLE_KEY are auto-injected by Supabase.
supabase secrets set LICENSE_SECRET="$(openssl rand -hex 32)"

# Admin token that guards `issuePaid` (minting paid keys). Needed only once you
# start issuing paid licenses; a future purchase webhook (e.g. Stripe) sends it
# as the `x-admin-token` header.
supabase secrets set ADMIN_TOKEN="$(openssl rand -hex 32)"
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

## Licensing model

**Nothing is ever deleted.** When a license isn't valid the app *locks*: the
vault files stay on disk but are greyed out, and a sign-in / start-a-new-trial
gate is shown over them. Files are never reset, copied files are never removed,
and references are never unlinked.

Once per launch the app calls the function's `check`, which returns the
authoritative status. The desktop maps it to UI:

| Status    | When                                  | App behavior                              |
|-----------|---------------------------------------|-------------------------------------------|
| `valid`   | trial has days left / paid current    | runs normally                             |
| `grace`   | paid lapsed, within `grace_days`      | runs normally + a renewal banner          |
| `expired` | trial's sign-in days used up          | **locks** (greyed vault + gate); no delete |
| `locked`  | paid grace elapsed                    | **locks** (greyed vault + gate); no delete |
| `none`    | no/forged key                         | gate (start a trial or activate a key)    |

### Trials — 14 **sign-in days**

A trial lasts **14 days of use, counted only on distinct days the user signs in**
(launches the app and reaches `check`), not 14 calendar days. The function bumps
`active_days` the first time it's checked each UTC day (`last_active_day`); the
trial is `expired` once `active_days > trial_days`. The token holds only the
`guid` — the count lives in Supabase, so it can't be reset by editing the clock.

From the lock screen the user can **start a new trial** (a fresh 14-day
allowance, files kept) or **activate a license key**. Re-trials are unlimited and
non-destructive.

### Paid licenses

A paid license sets `license_type = 'paid'` and a `paid_through` date. It is
**never** locked destructively:

- on/before `paid_through` → `valid`
- after `paid_through`, within `grace_days` (default 14) → `grace` (still fully
  usable, with a "renew before <date>" banner)
- past the grace window → `locked` (vault greyed, files intact, renew to unlock)

**Issuing a paid key** (admin-only, guarded by `ADMIN_TOKEN`) — this is the seam
a future purchase webhook calls:

```sh
curl -X POST "$LICENSE_API_URL" \
  -H "x-admin-token: $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"op":"issuePaid","paidThrough":"2027-01-01T00:00:00Z","contact":{"email":"buyer@example.com"}}'
# → { ok, guid, paidThrough, licenseKey }
```

Hand the returned `licenseKey` to the buyer; they paste it into the app's
**activate** field. To renew, re-issue with a later `paidThrough` for the same
`guid` (or just edit `paid_through` in the table).

**Offline:** if the function is unreachable the app never locks a trial (sign-in
days only count when the user reaches the server) and falls back to a paid
license's last cached dates — always non-destructive.

### Extending / adjusting in Supabase

In the table editor, open the user's row (by `email` or `guid`) and:

- **extend a trial** — raise `trial_days` (e.g. to 45), or lower `active_days`.
- **extend/grant paid** — set `license_type = 'paid'` and a future `paid_through`
  (and re-issue a key if they don't have a paid one yet).
- **lengthen the paid grace** — raise `grace_days`.

The next launch's `check` picks the changes up.
