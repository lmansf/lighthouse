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
  add column if not exists contact_id   uuid,        -- stable per-user id (persists across re-trials)
  add column if not exists license_key  text,
  -- trial vs paid
  add column if not exists license_type text        not null default 'trial',
  -- TRIAL: counted in sign-in DAYS, not calendar time
  add column if not exists trial_start  timestamptz not null default now(),
  add column if not exists trial_end    timestamptz not null default (now() + interval '14 days'),
  add column if not exists trial_days   int         not null default 14,
  add column if not exists active_days  int         not null default 0,
  add column if not exists last_active_day date,
  -- PAID: subscription end + grace window before locking
  add column if not exists paid_through timestamptz,
  add column if not exists grace_days   int         not null default 14,
  -- PAID via Stripe (set by the stripe-webhook function)
  add column if not exists stripe_customer_id     text,
  add column if not exists stripe_subscription_id text;

-- The function looks up the license by its guid.
create unique index if not exists registrations_guid_idx on public.registrations (guid);

-- Constrain license_type as a separate statement (an inline CHECK inside a
-- multi-column ADD COLUMN trips some clients, e.g. the Supabase SQL editor).
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'registrations_license_type_chk') then
    alter table public.registrations
      add constraint registrations_license_type_chk check (license_type in ('trial','paid'));
  end if;
end $$;

-- A trial can be minted before an email is known (it's tied to email later).
alter table public.registrations alter column email drop not null;
```

> Apply schema changes via the Supabase **SQL Editor** or the **Management API**
> (`POST /v1/projects/<ref>/database/query`). The SQL editor can mangle pasted
> SQL with nested parentheses or inline constraints — the Management API does not.

> **Upgrading from the earlier (single-column) schema?** Run exactly the block above. The new
> columns (`license_type`, `trial_days`, `active_days`, `last_active_day`,
> `paid_through`, `grace_days`, `stripe_*`) are additive; `trial_end` is now only
> a nominal display date — trials are gated by `active_days` vs `trial_days`.

### Feedback, launch logs, bug reports, purchase interest

Every row carries a stable `contact_id` (the same id across a user's re-trials
and purchase), so you can compare, say, comments from **paid vs unpaid** contacts
by joining `contact_id` to `registrations`.

```sql
-- Feedback form (post-purchase survey when paid is on; end-of-trial when off)
create table if not exists public.feedback (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  contact_id    uuid,
  first_name    text,
  last_name     text,
  email         text not null,
  ease_of_use   int,        -- 0..5
  overall_value int,        -- 0..5
  liked         text,
  change_or_add text,
  do_not_contact        boolean not null default false,
  notify_when_available boolean not null default false  -- "email me when purchasing opens"
);
create index if not exists feedback_contact_idx on public.feedback (contact_id);

-- One row per app launch (the "ping")
create table if not exists public.userlogs (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  contact_id  uuid,
  guid        uuid,
  email       text,
  event       text,
  app_version text
);

-- In-app bug reports
create table if not exists public.bug_reports (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  contact_id  uuid,
  where_at    text,        -- "Describe where the bug is happening"
  description text,        -- "Describe the bug"
  guid        uuid,
  email       text,
  app_version text
);

-- "Notify me when purchasing opens" (pre-launch interest, captured while paid is off)
create table if not exists public.purchase_interest (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  contact_id uuid,
  email      text not null
);
```

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

Every trial is **14 days of use** — distinct days the user signs in (launches
the app and reaches `check`), not calendar days. The function bumps `active_days`
the first time it's checked each UTC day (`last_active_day`); the trial is
`expired` once `active_days > trial_days`. The token holds only the `guid` — the
count lives in Supabase, so it can't be reset by editing the clock. Re-trials are
unlimited and non-destructive.

**Feedback timing** depends on whether paid mode is on:

- **paid on** — feedback is a **post-purchase** survey, shown in the left rail
  after Stripe's receipt and before chat reopens.
- **paid off** — when a trial ends the rail shows the feedback form, which
  includes an **"email me when purchasing opens"** checkbox; the registration
  choice and the settings-gear item show **"Get notified when purchasing opens"**
  (the same slot that becomes **Subscribe** when `PAID_ENABLED=1`). Interest
  lands in `purchase_interest`.

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
`guid` (or just edit `paid_through` in the table). For the normal self-serve
purchase, **Stripe does this automatically** (below) — no key changes hands.

**Offline:** if the function is unreachable the app never locks a trial (sign-in
days only count when the user reaches the server) and falls back to a paid
license's last cached dates — always non-destructive.

## Payments (Stripe) — $14.99/mo, no key entry

Two Edge Functions:

- **`create-checkout`** — the app's **Subscribe** button calls it with the
  install's `guid` + buyer email; it creates a Stripe **Checkout Session** for
  the subscription price and returns the URL the app opens in the browser.
- **`stripe-webhook`** — on payment, flips that guid's row to
  `license_type='paid'` with `paid_through` = the subscription's period end (and
  stores `stripe_customer_id` / `stripe_subscription_id` + the email).

The app **polls `check`** after opening checkout and unlocks itself
automatically — the buyer never types a key. `invoice.paid` extends
`paid_through` each cycle; cancellation just lets the normal grace→lock take
over. Each subscription is tied to its **email**, so a business can buy several
licenses (one per user/device, each its own `guid`) under one card via separate
transactions.

### Set it up

1. **Stripe dashboard** → create a Product with a recurring **$14.99/month**
   price. Copy the **price ID** (`price_…`).
2. **Deploy both functions** and set secrets:
   ```sh
   supabase functions deploy create-checkout
   supabase functions deploy stripe-webhook
   supabase secrets set STRIPE_SECRET_KEY="sk_live_…"
   supabase secrets set STRIPE_PRICE_ID="price_…"        # your $14.99/mo price
   supabase secrets set STRIPE_WEBHOOK_SECRET="whsec_…"  # from step 3
   ```
3. **Stripe dashboard** → Developers → Webhooks → add an endpoint at the deployed
   `stripe-webhook` URL; subscribe to `checkout.session.completed`,
   `invoice.paid`, `customer.subscription.deleted`. Copy its signing secret into
   `STRIPE_WEBHOOK_SECRET` above.
4. Set `CHECKOUT_API_URL` in `.env.production` to the deployed `create-checkout`
   URL (already pre-filled for this project; public/safe to ship).
5. Set `PAID_ENABLED=1` in `.env.production` and restart to surface the Subscribe
   affordances (left-nav button, registration screen, lock gate). While it stays
   `0`, those slots show "Get notified when purchasing opens" instead.

> Both functions must be public (no JWT) so the app and Stripe can reach them.
> The webhook authenticates by verifying the Stripe **signature**; `create-checkout`
> only ever returns a hosted Stripe URL and exposes no secret.

### Extending / adjusting in Supabase

In the table editor, open the user's row (by `email` or `guid`) and:

- **extend a trial** — raise `trial_days` (e.g. to 45), or lower `active_days`.
- **extend/grant paid** — set `license_type = 'paid'` and a future `paid_through`
  (and re-issue a key if they don't have a paid one yet).
- **lengthen the paid grace** — raise `grace_days`.

The next launch's `check` picks the changes up.
