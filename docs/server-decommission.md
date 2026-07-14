# Server-side decommission checklist — telemetry removal (0.11.1)

The client code that emitted ambient telemetry is deleted (both engines), and
the in-repo Edge Function source (`supabase/functions/license/index.ts`) has
had the matching op handlers removed. **Nothing here is deployed by CI — the
maintainer runs the deploys/drops below, in this order.**

## 1. Deploy the trimmed license function

```bash
supabase functions deploy license
```

After deploy, the function answers `{"error":"unknown op"}` (400) for `ping`,
`event`, `events`, `assign`, and `comingSoonLeaderboard`. Old app versions in
the field (≤ 0.11.0) still emit `ping`/`event` on launch and `assign` at trial
start — all of these were **fire-and-forget, best-effort** in every shipped
client (errors swallowed, launches never blocked), so rejecting them breaks
nothing. They simply stop being recorded the moment the function is deployed.

## 2. Apply the bug-report migration

```bash
supabase db push        # applies 20260714200000_bug_reports_deidentify.sql
```

Adds nullable `os` and `log` columns to `public.bug_reports`. New reports are
de-identified (`contact_id`/`guid`/`email` written NULL by the function even
if supplied); historical rows keep whatever they had.

## 3. Dead tables/views — drop when you're ready

Nothing writes to these once step 1 is deployed. Snapshot/export first if you
want the history, then drop:

| Object | Was fed by | Notes |
|---|---|---|
| `public.userlogs` | `ping` (launch logs) | dead |
| `public.events` | `event` (funnel events, incl. `coming_soon_interest` and `model_selected`) | dead — nothing reads or writes it after the seam split |
| `public.click_events` | `events` (opt-in click capture) | dead |
| `public.experiment_assignments` | `assign` (A/B bucketing) | dead |
| `public.coming_soon_leaderboard` (view) | aggregated `events` | dead — drop before/with `events` |
| `registrations.exp_onboarding`, `registrations.exp_default_inclusion` (columns) | variant stamping via `ping`/`feedback` | vestigial columns on a LIVE table — safe to drop, or leave as inert historical data |

```sql
drop view  if exists public.coming_soon_leaderboard;
drop table if exists public.click_events;
drop table if exists public.experiment_assignments;
drop table if exists public.events;
drop table if exists public.userlogs;
-- optional: alter table public.registrations
--   drop column if exists exp_onboarding,
--   drop column if exists exp_default_inclusion;
```

## 4. What the license function still needs (do NOT touch)

| Object | Fed by | Why it stays |
|---|---|---|
| `public.registrations` | `start`, `check`, `issuePaid`, Stripe webhook | the licensing spine (trials, paid, sign-in-day counting) |
| `public.feedback` | `feedback` (explicit survey) | user-submitted |
| `public.bug_reports` | `bug` (explicit, de-identified) | user-submitted |
| `public.feature_interest` | `featureInterest` (explicit vote) | user-submitted |
| `public.purchase_interest` | `notify` (explicit email capture) | user-submitted |
| Edge Functions `create-checkout`, `stripe-webhook` | Subscribe flow | unchanged by this pass |
| Secrets `LICENSE_SECRET`, `ADMIN_TOKEN` | `check`/`start`/`issuePaid` | unchanged |

## 5. Verify after deploy

```bash
# ambient ops rejected:
curl -s "$LICENSE_API_URL" -H "apikey: $SUPABASE_ANON_KEY" \
  -H "authorization: Bearer $SUPABASE_ANON_KEY" -H "content-type: application/json" \
  -d '{"op":"ping"}'          # → {"error":"unknown op"}

# explicit path alive (de-identified):
curl -s "$LICENSE_API_URL" -H "apikey: $SUPABASE_ANON_KEY" \
  -H "authorization: Bearer $SUPABASE_ANON_KEY" -H "content-type: application/json" \
  -d '{"op":"bug","what":"decommission smoke test","version":"0.11.1","os":"linux"}'  # → {"ok":true}
```

Then confirm the new `bug_reports` row has NULL `contact_id`/`guid`/`email`
and the `os` column filled.
