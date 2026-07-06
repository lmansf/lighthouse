// Lighthouse license Edge Function (Supabase, Deno runtime).
//
// Holds the secrets SERVER-SIDE so they never ship in the desktop app:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   auto-injected by Supabase
//   LICENSE_SECRET                            set via `supabase secrets set`
//   ADMIN_TOKEN                               guards issuePaid (paid issuance)
//   REGISTRATIONS_TABLE                       optional (default "registrations")
//
// Operations (POST { op }):
//   start      → mint a 14-day TRIAL. New GUID + AES-256-GCM key; insert the row
//                (with optional contact + contact_id); return the key.
//   check      → given a license_key, report its status. Trials are
//                valid | expired | none. PAID licenses are valid | grace |
//                locked | none — they NEVER report a destructive expiry; once
//                past `paid_through` they enter a grace window, then lock.
//   feedback   → record a feedback-form submission (post-purchase survey).
//   bug        → record an in-app bug report.
//   ping       → log an app launch to the userlogs table.
//   event      → record an A/B funnel event into the events table (one row per
//                active experiment, stamped with experiment + variant). `ping`
//                and `feedback` also persist the user's assigned variants onto
//                their registration row (exp_onboarding / exp_default_inclusion).
//   events     → batch-insert UI click events (best-effort usage logging) into
//                the click_events table; published on launch and then purged.
//   assign     → balanced A/B assignment: bucket a contact into the
//                least-used variant per experiment (even split at low N under
//                serial registration), recording it in experiment_assignments.
//                Stable + idempotent.
//   All form rows carry a stable contact_id so paid vs unpaid can be compared.
//   issuePaid  → (admin-only; needs x-admin-token == ADMIN_TOKEN) mint/activate
//                a PAID license for a guid/email with a paid_through date. This
//                is the seam the Stripe webhook calls.
//   comingSoonLeaderboard → (admin-only; x-admin-token == ADMIN_TOKEN) the
//                cross-user ranking of "coming soon" features by interest,
//                aggregated from coming_soon_interest events via the
//                coming_soon_leaderboard view. Returns [{feature,clicks,users}].
//
// Deploy:  supabase functions deploy license
//          supabase secrets set LICENSE_SECRET="<long random string>"
//          supabase secrets set ADMIN_TOKEN="<long random string>"   # for paid
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TRIAL_DAYS = 14; // every trial is 14 sign-in days
const GRACE_DAYS = 14; // paid: grace window after paid_through before locking
const DAY_MS = 86_400_000;
const TABLE = Deno.env.get("REGISTRATIONS_TABLE") ?? "registrations";
const FEEDBACK_TABLE = Deno.env.get("FEEDBACK_TABLE") ?? "feedback";
const USERLOGS_TABLE = Deno.env.get("USERLOGS_TABLE") ?? "userlogs";
const BUGS_TABLE = Deno.env.get("BUGS_TABLE") ?? "bug_reports";
const NOTIFY_TABLE = Deno.env.get("NOTIFY_TABLE") ?? "purchase_interest";
const EVENTS_TABLE = Deno.env.get("EVENTS_TABLE") ?? "events";
const CLICK_EVENTS_TABLE = Deno.env.get("CLICK_EVENTS_TABLE") ?? "click_events";
const LEADERBOARD_VIEW = Deno.env.get("COMING_SOON_LEADERBOARD_VIEW") ?? "coming_soon_leaderboard";
const EVENT_TYPES = ["folder", "file", "toggle", "button", "link", "nav", "other"];
const MAX_EVENTS_PER_BATCH = 5000; // matches the desktop ring-buffer cap
const ASSIGN_TABLE = Deno.env.get("EXPERIMENT_ASSIGNMENTS_TABLE") ?? "experiment_assignments";
// The variants of each experiment, in alternation order: with even counts the
// FIRST listed wins, so serial installs land A, B, A, B, ... for an even small-N
// split (a concurrent burst can still collide since count-then-insert isn't atomic).
const EXP_VARIANTS: Record<string, string[]> = {
  onboarding: ["play_first", "key_first"],
  default_inclusion: ["opt_in", "opt_out"],
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function admin() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

// --- AES-256-GCM (Web Crypto). Token = base64(iv[12] || ciphertext+tag). ------
async function aesKey(): Promise<CryptoKey> {
  // Fail closed: refuse to run with a public, source-committed default secret.
  // A missing secret degrades to controlled errors (see the handler's try/catch),
  // which the client treats as offline grace — never as a forgeable "valid".
  const secret = Deno.env.get("LICENSE_SECRET");
  if (!secret) {
    throw new Error(
      "LICENSE_SECRET is not configured. Run `supabase secrets set LICENSE_SECRET=<long random string>` before deploying.",
    );
  }
  const material = new TextEncoder().encode("lighthouse-license-v1:" + secret);
  const hash = await crypto.subtle.digest("SHA-256", material);
  return crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
const b64e = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const b64d = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function encrypt(payload: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = new TextEncoder().encode(JSON.stringify(payload));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(), pt));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64e(out);
}
async function decrypt<T>(token: string): Promise<T | null> {
  try {
    const buf = b64d(token);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: buf.subarray(0, 12) },
      await aesKey(),
      buf.subarray(12),
    );
    return JSON.parse(new TextDecoder().decode(pt)) as T;
  } catch {
    return null;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

interface Contact {
  contactId?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  doNotContact?: boolean;
  city?: string;
  state?: string;
}

async function start(contact: Contact): Promise<Response> {
  const guid = crypto.randomUUID();
  const now = new Date();
  // trial_end is a nominal date for display only — the trial is gated by sign-in
  // DAYS (active_days vs trial_days), not by the calendar.
  const trialEnd = new Date(now.getTime() + TRIAL_DAYS * DAY_MS).toISOString();
  const licenseKey = await encrypt({ guid, iat: now.toISOString(), type: "trial" });

  const { error } = await admin()
    .from(TABLE)
    .insert({
      contact_id: contact.contactId ?? null,
      first_name: contact.firstName ?? null,
      last_name: contact.lastName ?? null,
      email: contact.email ?? null,
      do_not_contact: Boolean(contact.doNotContact),
      city: contact.city ?? null,
      state: contact.state ?? null,
      guid,
      license_type: "trial",
      trial_start: now.toISOString(),
      trial_end: trialEnd,
      trial_days: TRIAL_DAYS,
      active_days: 0,
      last_active_day: null,
      license_key: licenseKey,
    });
  if (error) return json({ ok: false, reason: "rejected", detail: error.message });
  return json({ ok: true, guid, trialEnd, licenseKey, trialDays: TRIAL_DAYS, remainingDays: TRIAL_DAYS });
}

interface Feedback {
  contactId?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  easeOfUse?: number;
  overallValue?: number;
  liked?: string;
  changeOrAdd?: string;
  doNotContact?: boolean;
  notifyWhenAvailable?: boolean;
}
const score = (n: unknown): number | null => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v >= 0 && v <= 5 ? v : null;
};

/** Record a feedback submission. Submitting once unlocks 14-day trials. */
async function feedback(f: Feedback): Promise<Response> {
  if (!f.email) return json({ ok: false, reason: "rejected", detail: "email required" }, 400);
  const { error } = await admin().from(FEEDBACK_TABLE).insert({
    contact_id: f.contactId ?? null,
    first_name: f.firstName ?? null,
    last_name: f.lastName ?? null,
    email: f.email,
    ease_of_use: score(f.easeOfUse),
    overall_value: score(f.overallValue),
    liked: f.liked ?? null,
    change_or_add: f.changeOrAdd ?? null,
    do_not_contact: Boolean(f.doNotContact),
    notify_when_available: Boolean(f.notifyWhenAvailable),
  });
  if (error) return json({ ok: false, reason: "rejected", detail: error.message });
  await persistExperiments(f.contactId, (f as { experiments?: Experiments }).experiments);
  return json({ ok: true });
}

/** "Notify me when purchasing opens" — pre-launch interest capture. */
async function notify(body: Record<string, unknown>): Promise<Response> {
  const email = body.email ? String(body.email) : "";
  if (!email) return json({ ok: false, reason: "rejected", detail: "email required" }, 400);
  const { error } = await admin().from(NOTIFY_TABLE).insert({
    contact_id: body.contactId ? String(body.contactId) : null,
    email,
  });
  if (error) return json({ ok: false, reason: "rejected", detail: error.message });
  return json({ ok: true });
}

/** Record a bug report from the in-app form. */
async function bug(body: Record<string, unknown>): Promise<Response> {
  const where = body.where ? String(body.where) : null;
  const what = body.what ? String(body.what) : null;
  if (!where && !what) return json({ ok: false, reason: "rejected", detail: "empty report" }, 400);
  // A contact may file many reports — see migration
  // 20260628162019_bug_reports_allow_multiple.sql, which removed the UNIQUE
  // constraint on contact_id (issue #26). Each report is its own row.
  const { error } = await admin().from(BUGS_TABLE).insert({
    contact_id: body.contactId ? String(body.contactId) : null,
    where_at: where,
    description: what,
    guid: body.guid ? String(body.guid) : null,
    email: body.email ? String(body.email) : null,
    app_version: body.version ? String(body.version) : null,
  });
  if (error) return json({ ok: false, reason: "rejected", detail: error.message });
  return json({ ok: true });
}

/** Log an app launch to userlogs. Best-effort — never blocks a launch. */
async function ping(body: Record<string, unknown>): Promise<Response> {
  const { error } = await admin().from(USERLOGS_TABLE).insert({
    contact_id: body.contactId ? String(body.contactId) : null,
    guid: body.guid ? String(body.guid) : null,
    email: body.email ? String(body.email) : null,
    event: "launch",
    app_version: body.version ? String(body.version) : null,
  });
  // Stamp the user's current experiment variants onto their registration row so
  // userlogs/feedback/etc. can be sliced by variant through registrations.
  await persistExperiments(body.contactId, body.experiments);
  return json({ ok: !error });
}

/** Map of experiment -> assigned variant, as sent by the desktop app. */
type Experiments = Record<string, unknown> | undefined;

/**
 * Best-effort: persist the user's assigned variants onto their registration row
 * (matched by stable contact_id). A no-op when there's no contact, no variants,
 * or no matching row yet — telemetry must never fail because of this.
 */
async function persistExperiments(contactId: unknown, experiments: Experiments): Promise<void> {
  const id = contactId ? String(contactId) : "";
  if (!id || !experiments || typeof experiments !== "object") return;
  const patch: Record<string, string> = {};
  if (experiments.onboarding) patch.exp_onboarding = String(experiments.onboarding);
  if (experiments.default_inclusion) patch.exp_default_inclusion = String(experiments.default_inclusion);
  if (Object.keys(patch).length === 0) return;
  await admin().from(TABLE).update(patch).eq("contact_id", id);
}

/**
 * Record a funnel/telemetry event. Writes ONE row per active experiment, each
 * stamped with that experiment + the user's variant, so a single `variant`
 * column is unambiguous. With no variants assigned yet, records one untagged
 * row. Best-effort — never blocks the app.
 */
async function event(body: Record<string, unknown>): Promise<Response> {
  const contactId = body.contactId ? String(body.contactId) : "";
  const name = body.name ? String(body.name) : "";
  if (!contactId || !name) return json({ ok: false, reason: "rejected", detail: "contactId and name required" }, 400);
  const props = body.props && typeof body.props === "object" ? body.props : {};
  const experiments = (body.experiments ?? {}) as Record<string, unknown>;
  const tagged = Object.entries(experiments).filter(([, v]) => Boolean(v));
  const rows =
    tagged.length > 0
      ? tagged.map(([experiment, variant]) => ({
          contact_id: contactId,
          name,
          experiment,
          variant: String(variant),
          props,
        }))
      : [{ contact_id: contactId, name, experiment: null, variant: null, props }];
  const { error } = await admin().from(EVENTS_TABLE).insert(rows);
  return json({ ok: !error });
}

/**
 * Balanced A/B assignment. For each requested experiment, returns this contact's
 * variant - reusing an existing assignment (stable across launches), otherwise
 * bucketing them into the variant with the FEWEST assignments so far (ties go to
 * the first listed), then recording it. Under serial / low-volume registration
 * (the pilot case) this keeps a small pilot close to an even split instead of
 * relying on a per-install hash that can skew at low N. The count-then-insert is
 * not atomic, so a truly-concurrent burst can still collide on the same variant.
 *
 * Idempotent per (contact_id, experiment) via the table's unique constraint: a
 * lost insert race just re-reads the winning row.
 */
async function assign(body: Record<string, unknown>): Promise<Response> {
  const contactId = body.contactId ? String(body.contactId) : "";
  if (!contactId) return json({ ok: false, reason: "rejected", detail: "contactId required" }, 400);
  const requested =
    Array.isArray(body.experiments) && body.experiments.length > 0
      ? (body.experiments as unknown[]).map(String).filter((e) => e in EXP_VARIANTS)
      : Object.keys(EXP_VARIANTS);

  const db = admin();
  const variants: Record<string, string> = {};
  for (const exp of requested) {
    const choices = EXP_VARIANTS[exp];
    // Stable: an existing assignment for this contact wins.
    const existing = await db
      .from(ASSIGN_TABLE)
      .select("variant")
      .eq("contact_id", contactId)
      .eq("experiment", exp)
      .limit(1);
    // A DB error (e.g. the assignments table not migrated yet) must not fabricate an
    // authoritative variant: bail so the client keeps its local hash fallback.
    if (existing.error) return json({ ok: false, reason: "error", detail: existing.error.message });
    const prior = existing.data?.[0]?.variant as string | undefined;
    if (prior) {
      variants[exp] = prior;
      continue;
    }
    // Balance: pick the least-represented variant (ties -> first listed). Count-only
    // head queries stay O(1) per variant and dodge PostgREST's ~1000-row cap.
    const counts: Record<string, number> = {};
    for (const v of choices) {
      const c = await db
        .from(ASSIGN_TABLE)
        .select("*", { count: "exact", head: true })
        .eq("experiment", exp)
        .eq("variant", v);
      if (c.error) return json({ ok: false, reason: "error", detail: c.error.message });
      counts[v] = c.count ?? 0;
    }
    let chosen = choices[0];
    let min = Infinity;
    for (const v of choices) {
      if (counts[v] < min) {
        min = counts[v];
        chosen = v;
      }
    }
    const { error } = await db
      .from(ASSIGN_TABLE)
      .insert({ contact_id: contactId, experiment: exp, variant: chosen });
    if (error) {
      // Likely a concurrent assign for the same contact: re-read the winner. If the
      // insert failed for some other reason and no row can be recovered, the variant
      // was never recorded - bail so the client keeps its local hash fallback instead
      // of persisting an unrecorded source:"server" assignment.
      const again = await db
        .from(ASSIGN_TABLE)
        .select("variant")
        .eq("contact_id", contactId)
        .eq("experiment", exp)
        .limit(1);
      const recovered = again.data?.[0]?.variant as string | undefined;
      if (again.error || !recovered) {
        return json({ ok: false, reason: "error", detail: again.error?.message ?? error.message });
      }
      chosen = recovered;
    }
    variants[exp] = chosen;
  }
  return json({ ok: true, variants });
}

/**
 * Batch-insert UI click events (best-effort usage logging). The desktop buffers
 * events locally and publishes them on launch, keyed by the same contact_id /
 * guid / email as the other tables. Labels are names only (no field values or
 * file contents); we clamp them again here defensively.
 */
async function events(body: Record<string, unknown>): Promise<Response> {
  const list = Array.isArray(body.events) ? body.events : [];
  if (!list.length) return json({ ok: true, inserted: 0 });
  const contactId = body.contactId ? String(body.contactId) : null;
  const guid = body.guid ? String(body.guid) : null;
  const email = body.email ? String(body.email) : null;
  const appVersion = body.version ? String(body.version) : null;

  const rows = list.slice(0, MAX_EVENTS_PER_BATCH).map((raw) => {
    const e = (raw ?? {}) as Record<string, unknown>;
    const type = EVENT_TYPES.includes(String(e.type)) ? String(e.type) : "other";
    const label = e.label ? String(e.label).slice(0, 200) : null;
    const ts = e.at ? Date.parse(String(e.at)) : NaN;
    return {
      contact_id: contactId,
      guid,
      email,
      event_type: type,
      label,
      occurred_at: Number.isNaN(ts) ? null : new Date(ts).toISOString(),
      app_version: appVersion,
    };
  });

  const { error } = await admin().from(CLICK_EVENTS_TABLE).insert(rows);
  if (error) return json({ ok: false, reason: "rejected", detail: error.message });
  return json({ ok: true, inserted: rows.length });
}

/**
 * Cross-user "coming soon" interest leaderboard. Returns the per-feature ranking
 * of which teasers have drawn the most interest, aggregated from the
 * `coming_soon_interest` events via the `coming_soon_leaderboard` view (which
 * dedupes the per-experiment row fan-out — see the view's migration). Shape:
 * [{ feature, clicks, users }], most-wanted first. Internal product analytics —
 * admin-gated at the route, never exposed to the app or anon callers.
 */
async function comingSoonLeaderboard(): Promise<Response> {
  const { data, error } = await admin()
    .from(LEADERBOARD_VIEW)
    .select("feature, clicks, users")
    .order("clicks", { ascending: false })
    .order("users", { ascending: false });
  if (error) return json({ ok: false, reason: "error", detail: error.message });
  return json({ ok: true, leaderboard: data ?? [] });
}

interface Decoded {
  guid: string;
  type?: "trial" | "paid";
  trialEnd?: string;
  paidThrough?: string;
}

async function check(licenseKey: string): Promise<Response> {
  if (!licenseKey) return json({ status: "none" });
  const decoded = await decrypt<Decoded>(licenseKey);
  // Forged / corrupt / wrong-secret: report "none" (prompt to start a trial)
  // rather than "expired", so a bad key never trips the lock screen falsely.
  if (!decoded?.guid) return json({ status: "none" });

  // Authoritative row. A read error is unverifiable, not an expiry: surface it
  // as a non-2xx so the client stays usable (offline grace) instead of locking.
  const { data, error } = await admin()
    .from(TABLE)
    .select("license_type, trial_days, active_days, last_active_day, paid_through, grace_days")
    .eq("guid", decoded.guid)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) return json({ status: "error", detail: error.message }, 503);
  const row = data?.[0] as
    | {
        license_type?: string;
        trial_days?: number;
        active_days?: number;
        last_active_day?: string | null;
        paid_through?: string;
        grace_days?: number;
      }
    | undefined;

  const guid = decoded.guid;
  // Entitlement is authoritative from the DB row. A genuine paid or trial license
  // always has a backing row (issuePaid/activate upsert one), so a token WITHOUT a
  // row — including a "paid" token forged from a leaked or defaulted signing
  // secret — cannot prove standing. Report "none" rather than trusting the token's
  // own decoded.type / decoded.paidThrough claims.
  if (!row) return json({ status: "none", guid });
  const type = (row.license_type ?? "trial") as "trial" | "paid";
  const now = Date.now();

  if (type === "paid") {
    // Paid vaults are NEVER locked destructively. Past paid_through → grace,
    // then locked (files kept, sign-in gate) until renewed.
    const end = row.paid_through ?? null;
    if (!end) return json({ status: "valid", licenseType: "paid", guid }); // open-ended
    const endMs = Date.parse(end);
    const graceUntil = new Date(endMs + (row?.grace_days ?? GRACE_DAYS) * DAY_MS).toISOString();
    if (now <= endMs) return json({ status: "valid", licenseType: "paid", paidThrough: end, guid });
    if (now <= Date.parse(graceUntil))
      return json({ status: "grace", licenseType: "paid", paidThrough: end, graceUntil, guid });
    return json({ status: "locked", licenseType: "paid", paidThrough: end, graceUntil, guid });
  }

  // Trial: 14 days of USE, counted once per distinct UTC day the user signs in.
  // Nothing is ever deleted — once the allowance is spent the status is
  // "expired" and the app locks (greyed vault + sign-in gate).
  // A trial carries no expiry in its token — the sign-in-day count lives only in
  // the row, which is guaranteed present here (row-less tokens returned "none"
  // above).
  const trialDays = row.trial_days ?? TRIAL_DAYS;
  let activeDays = row.active_days ?? 0;
  const today = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
  if (row.last_active_day !== today) {
    activeDays += 1;
    await admin().from(TABLE).update({ active_days: activeDays, last_active_day: today }).eq("guid", guid);
  }
  const remainingDays = Math.max(0, trialDays - activeDays);
  const status = activeDays > trialDays ? "expired" : "valid";
  return json({ status, licenseType: "trial", trialDays, activeDays, remainingDays, guid });
}

/**
 * Admin-only: mint/activate a PAID license for a guid (or a fresh one) with a
 * paid_through date. Guarded by ADMIN_TOKEN so only the maintainer or a trusted
 * purchase webhook can issue paid keys. Returns the license_key to hand to the
 * buyer (they paste it into the app's "activate" field).
 */
async function issuePaid(body: Record<string, unknown>): Promise<Response> {
  const paidThrough = String(body.paidThrough ?? "");
  if (!paidThrough || Number.isNaN(Date.parse(paidThrough)))
    return json({ ok: false, reason: "rejected", detail: "valid paidThrough (ISO) required" }, 400);

  const guid = String(body.guid ?? crypto.randomUUID());
  const graceDays = Number(body.graceDays ?? GRACE_DAYS);
  const contact = (body.contact ?? {}) as Contact;
  const now = new Date();
  const licenseKey = await encrypt({ guid, iat: now.toISOString(), type: "paid", paidThrough });

  const { error } = await admin()
    .from(TABLE)
    .upsert(
      {
        first_name: contact.firstName ?? null,
        last_name: contact.lastName ?? null,
        email: contact.email ?? null,
        do_not_contact: Boolean(contact.doNotContact),
        city: contact.city ?? null,
        state: contact.state ?? null,
        guid,
        license_type: "paid",
        paid_through: paidThrough,
        grace_days: graceDays,
        trial_start: now.toISOString(),
        trial_end: paidThrough, // keep the NOT NULL column satisfied; unused for paid
        license_key: licenseKey,
      },
      { onConflict: "guid" },
    );
  if (error) return json({ ok: false, reason: "rejected", detail: error.message });
  return json({ ok: true, guid, paidThrough, licenseKey });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const body = await req.json().catch(() => ({}));
  try {
    return await route(body, req);
  } catch (err) {
    // Controlled failure (e.g. a missing LICENSE_SECRET) — never leak a stack and
    // never fall through to a state a client could read as a valid entitlement.
    console.error("license fn error:", err instanceof Error ? err.message : err);
    return json({ status: "error", error: "server error" }, 500);
  }
});

async function route(body: Record<string, unknown>, req: Request): Promise<Response> {
  switch (body.op) {
    case "start":
      return await start((body.contact ?? {}) as Contact);
    case "check":
      return await check(String(body.licenseKey ?? ""));
    case "feedback":
      return await feedback((body.feedback ?? {}) as Feedback);
    case "notify":
      return await notify(body);
    case "bug":
      return await bug(body);
    case "ping":
      return await ping(body);
    case "event":
      return await event(body);
    case "events":
      return await events(body);
    case "assign":
      return await assign(body);
    case "issuePaid": {
      const admin = Deno.env.get("ADMIN_TOKEN");
      if (!admin || req.headers.get("x-admin-token") !== admin)
        return json({ ok: false, reason: "unauthorized" }, 401);
      return await issuePaid(body);
    }
    case "comingSoonLeaderboard": {
      // Internal analytics — same admin gate as issuePaid.
      const admin = Deno.env.get("ADMIN_TOKEN");
      if (!admin || req.headers.get("x-admin-token") !== admin)
        return json({ ok: false, reason: "unauthorized" }, 401);
      return await comingSoonLeaderboard();
    }
    default:
      return json({ error: "unknown op" }, 400);
  }
}
