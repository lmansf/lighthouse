# Server-side sunset plan — decommissioning the Lighthouse backend

Two waves of client changes removed everything that ever talked to a backend:

- **Wave 1 — 0.11.1 (telemetry):** the client code that emitted ambient
  telemetry was deleted from both engines.
- **Wave 2 — this release (licensing / accounts):** the license and trial
  check, the registration/onboarding email step, Stripe checkout, and the whole
  Supabase client path were deleted. The shipping app now calls a backend for
  **nothing** — it has no accounts, no trial, and is always unlocked. The
  in-repo Edge Function source and everything that talked to it are archived on
  `archive/licensing-supabase`.

The current client is already backend-free, so **nothing here is deployed by
CI.** This is the maintainer's runbook for taking the *hosted* backend down
without stranding older clients still in the field. Do the steps in order.

---

## 0. The compatibility guarantee — why sunsetting is safe

Older clients (any build before Wave 2) still call the license Edge Function on
launch. The question that decides whether a sunset is safe is: **what happens
to those clients when the endpoint stops answering?** Answer, verified against
the shipped engine (archived at `archive/licensing-supabase`,
`native/crates/lighthouse-core/src/license.rs`):

> A dead or unreachable endpoint **never destroys anything, and never hard-locks
> a trial.** The module header states the invariant verbatim — *"Nothing is
> ever DELETED: when a license isn't valid the app locks, files stay on disk."*

`call_fn` "Errors on non-2xx / network failure" (`license.rs:150`), so a 404, a
connection refusal, and a `{"error":"unknown op"}` 400 all land in the *same*
offline branch of the launch check:

```rust
Err(_) => {
    // Offline: never lock a trial; paid falls back to cached dates.
    if lic.license_type.as_deref() == Some("paid") {
        paid_status_from(lic.trial_end.as_deref(), lic.grace_until.as_deref())
    } else {
        LicenseResult {
            status: "valid".to_string(),
            license_type: Some("trial".to_string()),
            ..Default::default()
        }
    }
}
```

Concretely, once the endpoint goes away:

| Field client | What a dead endpoint does to them |
| --- | --- |
| **Trial** | stays `valid` **forever** — a trial is never locked while offline. |
| **Paid** | falls back to the **cached** `paidThrough` / `graceUntil`: valid until that date, then a 14-day grace, then a UI `locked` — files stay on disk the whole time. |

So the worst case a hard shutdown can produce is a *paid* user whose cached
dates had already lapsed seeing a **locked UI** — their vault untouched, every
file on disk. There is **no code path** in which a missing endpoint deletes a
vault, wipes app state, or erases a key. The TypeScript twin
(`src/server/license.ts`) degrades identically; only the Rust engine ships, so
the Rust behavior above is what field clients actually run.

## 1. Recommended: keep the function up, patched always-valid, for a window

Because a *paid* client can still drift to a locked UI once its cached dates
lapse (§0), the kindest sunset is **not** to kill the endpoint outright.
Instead deploy a one-time patch so the `check` (and `start`) ops return
`{"status":"valid"}` unconditionally, then leave the function idling:

- every field client — trial or paid — reads `valid` and stays fully unlocked;
- no one drifts into grace/lock from stale cached dates;
- the function costs almost nothing to keep running.

Keep it up until download stats show the pre-Wave-2 clients have effectively
drained (a release cycle or two is plenty), then move to the teardown in §3.

If you would rather not touch the function code at all, you *may* simply delete
it now — per §0 that only risks a locked UI for already-lapsed paid users,
never data loss — but the always-valid patch is strictly gentler and is the
recommended path.

## 2. Wave 1 telemetry cleanup (do once, if not already done for 0.11.1)

These steps trim the function to reject the ambient ops and de-identify the one
explicit table the old client still wrote. They are unchanged from the 0.11.1
runbook and are harmless to re-apply.

```bash
supabase functions deploy license      # ambient ops now answer {"error":"unknown op"}
supabase db push                        # applies 20260714200000_bug_reports_deidentify.sql
```

After the deploy the function answers `{"error":"unknown op"}` (400) for `ping`,
`event`, `events`, `assign`, and `comingSoonLeaderboard`. Old app versions
(≤ 0.11.0) still emit `ping`/`event` on launch and `assign` at trial start — all
of them **fire-and-forget, best-effort** in every shipped client (errors
swallowed, launches never blocked), so rejecting them breaks nothing; they
simply stop being recorded. The migration adds nullable `os`/`log` to
`public.bug_reports` and the function writes `contact_id`/`guid`/`email` NULL
even if an old client supplies them; historical rows keep whatever they had.

## 3. Teardown — drop the backend once old clients have drained

With Wave 2 shipped, **no current client calls the backend for anything**, and
the always-valid patch (§1) has covered the stragglers. Everything below is now
dead. Snapshot/export anything whose history you want, then drop.

### 3a. Dead telemetry objects (dead since Wave 1)

| Object | Was fed by | Notes |
| --- | --- | --- |
| `public.userlogs` | `ping` (launch logs) | dead |
| `public.events` | `event` (funnel, incl. `coming_soon_interest`, `model_selected`) | dead |
| `public.click_events` | `events` (opt-in click capture) | dead |
| `public.experiment_assignments` | `assign` (A/B bucketing) | dead |
| `public.coming_soon_leaderboard` (view) | aggregated `events` | dead — drop before/with `events` |
| `registrations.exp_onboarding`, `registrations.exp_default_inclusion` (columns) | variant stamping | vestigial; drop or leave inert |

### 3b. Licensing spine + money path (dead since Wave 2)

Nothing calls these once the field has drained past Wave 2. Previously these
were the "do NOT touch" set that kept trials, paid, and checkout alive — Wave 2
retired the clients that needed them, so they are droppable too.

| Object | Was fed by | Notes |
| --- | --- | --- |
| `public.registrations` | `start`, `check`, `issuePaid`, Stripe webhook | the licensing spine (trials, paid, sign-in-day counting) — **export first** if you want the customer history |
| `public.feedback` | `feedback` (explicit survey) | user-submitted history; Wave 2 feedback is zero-backend (mailto / GitHub issue), so nothing writes here anymore — **export before dropping** |
| `public.bug_reports` | `bug` (explicit, de-identified) | user-submitted history; same — **export before dropping** |
| `public.feature_interest` | `featureInterest` (explicit vote) | user-submitted history — export before dropping |
| `public.purchase_interest` | `notify` (explicit email capture) | user-submitted history — export before dropping |
| Edge Functions `license`, `create-checkout`, `stripe-webhook` | launch check + Subscribe flow | delete after the §1 window; `create-checkout`/`stripe-webhook` are dead the moment Wave 2 ships (no client opens checkout) |
| Secrets `LICENSE_SECRET`, `ADMIN_TOKEN`, the Stripe keys | `check`/`start`/`issuePaid`, webhook | rotate out / delete with the functions |

```sql
-- 3a: telemetry
drop view  if exists public.coming_soon_leaderboard;
drop table if exists public.click_events;
drop table if exists public.experiment_assignments;
drop table if exists public.events;
drop table if exists public.userlogs;
-- optional: alter table public.registrations
--   drop column if exists exp_onboarding, drop column if exists exp_default_inclusion;

-- 3b: licensing spine + user-submitted history (export first!)
-- drop table if exists public.purchase_interest;
-- drop table if exists public.feature_interest;
-- drop table if exists public.bug_reports;
-- drop table if exists public.feedback;
-- drop table if exists public.registrations;
```

### 3c. Stripe

The app no longer opens checkout, so nothing new can be charged. Independently
of the DB: in the Stripe dashboard, deactivate the product/price behind the old
subscription, remove the webhook endpoint that fed `stripe-webhook`, and revoke
the API keys once `create-checkout`/`stripe-webhook` are deleted.

### 3d. The project

Once 3a–3c are done and the §1 window has closed, the Supabase project holds
nothing Lighthouse uses. Delete the Edge Functions, then pause or delete the
project. Keep the `archive/licensing-supabase` branch — it is the only
remaining copy of the function source, the offline-activation engine code, and
`docs/registration.md`, and it is the starting point if a paid tier ever
returns (see `docs/maintainer-provisioning.md`).

## 4. Verify after each change

```bash
# ambient ops rejected (after §2):
curl -s "$FN_URL" -H "content-type: application/json" -d '{"op":"ping"}'
#   → {"error":"unknown op"}

# always-valid patch in effect (during the §1 window):
curl -s "$FN_URL" -H "content-type: application/json" -d '{"op":"check"}'
#   → {"status":"valid", ...}

# after §3d the function is gone:
curl -s -o /dev/null -w '%{http_code}\n' "$FN_URL"     # → 404 (or connection refused)
```

A `404`/refused response is the safe terminal state: per §0, field clients read
it as offline and stay valid (trial) or fall back to cached dates (paid) — never
a wipe.
