# Welcome registration + trial licensing (Supabase)

After sign-in, Lighthouse shows a one-time welcome form full-screen (centered)
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

> **Partially decommissioned.** Launch logs (`userlogs`) are dead — the app no
> longer pings on launch — and bug reports are now **de-identified** (`{where,
> what, version, os, log?}`, no contact_id/guid/email; see migration
> `20260714200000_bug_reports_deidentify.sql`). The SQL below is kept as the
> historical schema; see `docs/server-decommission.md` for what to drop.

Every *feedback / purchase-interest / feature-interest* row carries a stable
`contact_id` (the same id across a user's re-trials and purchase), so you can
compare, say, comments from **paid vs unpaid** contacts by joining
`contact_id` to `registrations`. Bug reports deliberately carry none.

```sql
-- Feedback form (post-purchase survey when paid is on; end-of-trial when off;
-- plus the optional one-time mid-session nudge after a while of active use)
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

-- In-app bug reports (one row per report — a contact may file many, so no
-- UNIQUE on contact_id; older deploys that added one are fixed by migration
-- supabase/migrations/20260628162019_bug_reports_allow_multiple.sql)
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

-- A/B experiments: per-user variant on the registration, plus a thin events
-- table for funnel steps (see supabase/migrations/20260629000000_experiments_events.sql
-- and docs/experiments/onboarding-and-defaults-ab-tests.md).
alter table public.registrations
  add column if not exists exp_onboarding text,          -- play_first | key_first | null
  add column if not exists exp_default_inclusion text;   -- opt_in | opt_out | null

create table if not exists public.events (
  id          bigint generated always as identity primary key,
  contact_id  text not null,
  name        text not null,   -- onboarding_started, first_query, answer_rendered, ...
  experiment  text,            -- which experiment this row belongs to (null = untagged)
  variant     text,            -- the user's variant of that experiment
  props       jsonb not null default '{}'::jsonb,  -- e.g. { "source_count": 0 }
  created_at  timestamptz not null default now()
);
create index if not exists events_name_created_at_idx on public.events (name, created_at);
create index if not exists events_contact_id_idx on public.events (contact_id);

-- UI click events (best-effort usage logging — see "Usage logging" below)
create table if not exists public.click_events (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  contact_id  uuid,
  guid        uuid,
  email       text,
  event_type  text,        -- folder | file | toggle | button | link | nav | other
  label       text,        -- coarse label/name of the touched control (no values)
  occurred_at timestamptz,
  app_version text
);
create index if not exists click_events_contact_idx on public.click_events (contact_id);

-- Balanced A/B assignment ledger (the `assign` op's source of truth; see
-- supabase/migrations/20260630000000_experiment_assignments.sql)
create table if not exists public.experiment_assignments (
  id          bigint generated always as identity primary key,
  contact_id  text not null,
  experiment  text not null,   -- onboarding | default_inclusion
  variant     text not null,   -- play_first|key_first | opt_in|opt_out
  created_at  timestamptz not null default now(),
  unique (contact_id, experiment)
);
create index if not exists experiment_assignments_experiment_idx
  on public.experiment_assignments (experiment);
```

> The `click_events` and `experiment_assignments` tables also ship as migrations
> (`supabase/migrations/20260629120000_click_events.sql`,
> `supabase/migrations/20260630000000_experiment_assignments.sql`) — apply them
> (SQL Editor or Management API) when you deploy the updated Edge Function.

The Edge Function uses the **service-role** key, which bypasses RLS — so no
`anon` insert/select policy is needed, and emails stay private (never expose
`select` to `anon`).

### A/B experiment telemetry

> **Decommissioned.** The experiment machinery was deleted from the product
> (both engines) along with all ambient telemetry; the `assign`/`event` ops no
> longer exist on the function. Kept as the historical schema —
> `docs/server-decommission.md` lists the drops.

The desktop app used to assign each install a variant per experiment and tag
every telemetry call with them. Two seams recorded this server-side, both via
the service-role key:

- The **`event`** op inserts one `events` row **per active experiment**, each
  stamped with `experiment` + the user's `variant` (so a single `variant` column
  is unambiguous), plus a `props` jsonb. Event names:
  - Funnel: `onboarding_started`, `sample_vault_loaded`, `first_query`,
    `api_key_entered`, `answer_rendered` (`{ source_count }`), `returned`.
  - File activity (privacy-safe - **counts and a coarse dimension only, never a
    name, path, extension, size, or content**): `file_added` / `file_removed`
    (`{ kind: "file" | "folder" }`, emitted by diffing the vault scan against a
    local snapshot, so files copied in or deleted *outside* the app still count)
    and `file_made_available` / `file_made_unavailable` (`{ scope: "file" |
    "folder" | "source" }`, one per include/exclude click - the click, not the
    folder's cascade).
- The **`ping`** and **`feedback`** ops also persist the user's current variants
  onto their `registrations` row (`exp_onboarding`, `exp_default_inclusion`), so
  `feedback` / `bug_reports` / `userlogs` can all be sliced by variant through
  `registrations` by `contact_id`.

**Balanced assignment.** By default each install picks its variant from a local
hash of its `contact_id` (~50/50, stable, works offline). For a *small* pilot
that can skew (4 installs might land 3/1), so registration calls the **`assign`**
op: it buckets the install into the **least-used** variant per experiment
(recorded in `experiment_assignments`), keeping the split close to even (A, B, A,
B…) under serial / low-volume registration. The count-then-insert isn't atomic,
so a truly-concurrent burst can still land two installs on the same variant; for
a pilot's registration rate that's a non-issue. It's stable (an existing assignment is
reused) and idempotent, and upgrades the local hash assignment *before*
onboarding branches, so the user never sees a flip. A pilot-email entry in
`FIRST_USERS` still overrides everything; offline, the hash assignment stands.

All of this is best-effort: telemetry never blocks a launch, a query, or
onboarding, and the app runs normally with `LICENSE_API_URL` unset (the calls
no-op). The companion **lighthouse-analytics** dashboard reads these for its
Experiments page.

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

## Usage logging (UI click events)

> **Decommissioned.** Click capture was deleted from the product — the
> capture hook, the consent toggle, the local buffer, and the `events` op are
> all gone. Kept as the historical description; `docs/server-decommission.md`
> lists the drops.

Lighthouse used to log coarse UI interactions — folders, files, toggles,
buttons, links, nav — to understand how the app was used. It was
**best-effort** and modeled on the (also retired) launch ping.

**Capture.**
A single delegated, capture-phase click listener (`src/features/usage/useUsageCapture.ts`, mounted in `AppShell`) resolves the nearest interactive element a user touches and records a coarse `type` (`folder|file|toggle|button|link|nav|other`) plus a stable `label`.
The label prefers an explicit `data-log` attribute, then `aria-label` / `title` / trimmed text.
**Only names are recorded** — never field values, file contents, or secrets — and labels are length-capped on both the client and the Edge Function.

**Local buffer.**
Captured events are flushed to `/api/usage` and appended to a size-capped JSONL ring-buffer at `<vault>/.rag-vault/usage-events.jsonl` (`src/server/usage.ts`).
The buffer keeps the **most recent** actions (max 5000 events / ~1MB), trimming the oldest on write, and tolerates a torn last line.

**Publish on launch + purge.**
During startup, right after the launch ping, the app calls `/api/usage` `op: "publish"`, which batch-publishes the buffer to the license Edge Function's **`events`** action (keyed by `contact_id` / `guid` / `email` / `app_version`) and **purges** the published lines on success.
Offline or failed publishes keep the buffer for the next launch.

**Opt-out (default opted IN).**
The welcome form (`OnboardingPanel`) shows a checkbox — *"Help improve Lighthouse by sharing anonymous usage data"* — **checked by default**.
Unchecking it persists `optOut: true` to `<vault>/.rag-vault/usage.json`; while opted out nothing is captured, buffered, or published, and any buffered events are dropped.
**Each trial mint resets consent to the opted-in default** (`startTrial` -> `resetUsageConsent`); the welcome form re-applies the user's explicit choice afterwards, so registering or starting a fresh trial re-opts-in unless the user opts out again.

**Deploy (manual step).**
Shipping usage logging is the same two manual steps as any Edge Function change:

```sh
supabase functions deploy license   # adds the `events` action
# apply supabase/migrations/20260629120000_click_events.sql (SQL Editor or Management API)
```

Until both are applied the desktop simply buffers locally and retries on the next launch (the publish call fails closed, non-destructively).

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

- **paid on** — feedback is a **post-purchase** survey, shown in the main area
  after Stripe's receipt and before chat reopens.
- **paid off** — when a trial ends the main area shows the feedback form, which
  includes an **"email me when purchasing opens"** checkbox; the registration
  choice and the settings-gear item show **"Get notified when purchasing opens"**
  (the same slot that becomes **Subscribe** when `PAID_ENABLED=1`). Interest
  lands in `purchase_interest`.

Independently of the trial state, a gentle **mid-session nudge** can also surface
the same feedback form. After ~5 minutes of *active* use (only time the window is
visible counts), a small "What do you think so far?" bubble slides up in the
bottom-left corner; expanding it opens the form in `mid-session` mode (same
fields, gentler copy, no notify checkbox). It appears **at most once per install**
— dismissing or submitting sets a `localStorage` flag so it never returns — and
its submissions land in the same `feedback` table. The component is
`src/features/feedback/FeedbackNudge.tsx`, mounted once the user is onboarded.

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
