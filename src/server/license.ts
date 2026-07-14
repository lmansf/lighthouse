/**
 * Licensing (desktop side).
 *
 * The secrets — the Supabase service-role key and the `LICENSE_SECRET` that
 * encrypts license keys — live ONLY in the hosted Supabase Edge Function
 * (`supabase/functions/license`), never in the shipped app. The desktop holds
 * just the function's public URL and the public anon key, and calls it to mint
 * ("start"), verify ("check"), and activate paid keys.
 *
 * Nothing is ever DELETED. When a license isn't valid the app locks: the vault
 * files stay on disk (greyed out in the UI) and the user is shown a sign-in /
 * start-a-new-trial gate. Files are never reset.
 *
 * Trial: 14 days of use, counted only on distinct days the user signs in (a
 * launch that reaches `check`). The count is authoritative in Supabase
 * (`active_days`/`last_active_day`); local-dev keeps its own counter.
 *
 * Paid: never expires destructively. Past `paid_through` the license enters a
 * 14-day GRACE window (still usable, with a banner), then LOCKS (files greyed,
 * sign-in gate) until renewed. A paid key is pasted into the activate field.
 *
 * Modes:
 *   Hosted   (LICENSE_API_URL set) — the shipping config. No secret on client.
 *   Local    (LICENSE_ENFORCE=1, no URL) — self-contained, local crypto. Dev.
 *   Disabled (neither) — app runs unlicensed; checkLicense() == "disabled".
 *
 *   LICENSE_API_URL    https://<project>.supabase.co/functions/v1/license
 *   SUPABASE_ANON_KEY  public key used to authorize the function call
 *   LICENSE_ENFORCE=1  enable the local-dev trial (no hosted function)
 *   LICENSE_SECRET     local-dev-only key-encryption secret
 */
import crypto from "node:crypto";
import path from "node:path";
import { appStateDir, readJson, writeJson } from "./config";
import { getState as profileState } from "./profile";
import { getAllVariants, assignBalancedVariants } from "./experiment";
import type { Registration } from "./registration";
import {
  isUsageOptedOut,
  readUsageBuffer,
  purgeUsageBuffer,
  resetUsageConsent,
} from "./usage";

const TRIAL_DAYS = 14; // sign-in days a trial lasts
const GRACE_DAYS = 14; // paid: grace window after paid_through before locking
const DAY_MS = 24 * 60 * 60 * 1000;

// License state is install-global (appStateDir), NOT per-vault: switching
// vaults must not sign the user out. See config.appStateDir.
const licensePath = () => path.join(appStateDir(), "license.json");
const identityPath = () => path.join(appStateDir(), "identity.json");
const contactIdPath = () => path.join(appStateDir(), "contact.json");
const launchPath = () => path.join(appStateDir(), "launch.json");

/**
 * A stable per-user contact id, generated once and kept across trials, locks,
 * and purchases (each trial mints a fresh guid, so the guid can't play this
 * role). Stamped on every form/log row so paid vs unpaid contacts can be told
 * apart in Supabase.
 */
export function getContactId(): string {
  const existing = readJson<{ id?: string } | null>(contactIdPath(), null);
  if (existing?.id) return existing.id;
  const id = crypto.randomUUID();
  writeJson(contactIdPath(), { id });
  return id;
}

/** UTC calendar day (YYYY-MM-DD) — the unit a trial's sign-in days are counted in. */
function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

export type LicenseType = "trial" | "paid";

// trial: valid | expired (locked, NOT deleted) | none
// paid:  valid | grace (lapsed, still usable) | locked (NOT deleted) | none
export type LicenseStatus = "valid" | "expired" | "grace" | "locked" | "none" | "disabled";

interface LocalLicense {
  guid: string;
  licenseKey: string;
  licenseType?: LicenseType; // absent ⇒ "trial" (back-compat)
  trialEnd?: string; // paid: paid_through; trial: nominal (display only)
  graceUntil?: string; // paid: when grace ends and it locks
  activeDays?: number; // local-dev trial: distinct sign-in days counted
  lastActiveDay?: string; // local-dev trial: UTC day of the last count
}

export interface LicenseResult {
  status: LicenseStatus;
  licenseType?: LicenseType;
  trialEnd?: string;
  graceUntil?: string;
  remainingDays?: number; // trial: sign-in days left of the 14
}

/** The hosted Edge Function URL, or null when not configured. */
function licenseApi(): string | null {
  return process.env.LICENSE_API_URL?.trim() || null;
}

/** Local-dev trial: enforced, self-contained, no hosted function. */
function localMode(): boolean {
  return !licenseApi() && process.env.LICENSE_ENFORCE === "1";
}

/** Licensing is enforced with a hosted function, or in forced local-dev. */
export function licensingEnabled(): boolean {
  return Boolean(licenseApi()) || localMode();
}

/**
 * Whether paid subscriptions are offered. Off by default — flip PAID_ENABLED=1
 * (in .env.production, then restart) to surface the Subscribe affordances. When
 * off, the app is trial-only and the subscribe UI stays hidden.
 */
export function paidEnabled(): boolean {
  return process.env.PAID_ENABLED === "1";
}

// --- hosted Edge Function ----------------------------------------------------
/** Call the license Edge Function. Throws on a non-2xx / network error. */
export async function callFn(op: string, extra: Record<string, unknown>): Promise<Record<string, unknown>> {
  const url = licenseApi();
  if (!url) throw new Error("LICENSE_API_URL not configured");
  const anon = process.env.SUPABASE_ANON_KEY?.trim();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(anon ? { apikey: anon, authorization: `Bearer ${anon}` } : {}),
    },
    body: JSON.stringify({ op, ...extra }),
  });
  if (!res.ok) throw new Error(`license fn ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as Record<string, unknown>;
}

// --- local-dev crypto (AES-256-GCM) ------------------------------------------
function secretKey(): Buffer {
  const secret = process.env.LICENSE_SECRET?.trim() || "lighthouse-insecure-default-secret";
  return crypto.scryptSync(secret, "lighthouse-license-v1", 32);
}
function encrypt(payload: unknown): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secretKey(), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}
function decrypt<T>(token: string): T | null {
  try {
    const buf = Buffer.from(token, "base64");
    const d = crypto.createDecipheriv("aes-256-gcm", secretKey(), buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    const pt = Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
    return JSON.parse(pt) as T;
  } catch {
    return null;
  }
}

// --- contact identity persists across locks (for one-click re-trial) ---------
function loadIdentity(): Registration | null {
  return readJson<Registration | null>(identityPath(), null);
}
function contactRow(c: Registration) {
  return {
    contactId: getContactId(),
    firstName: c.firstName,
    lastName: c.lastName,
    email: c.email,
    doNotContact: c.doNotContact,
    city: c.city,
    state: c.state,
  };
}

/**
 * Email to stamp on logs/bug reports. Prefers the signed-in account (the auth
 * profile), since a user can be signed in without ever having started a trial /
 * left feedback / checked out — in which case the license identity has no email.
 * Falls back to that license identity.
 */
export function accountEmail(): string | undefined {
  const fromProfile = profileState().user?.email?.trim();
  if (fromProfile) return fromProfile;
  return loadIdentity()?.email || undefined;
}

/**
 * Mint a fresh trial: new GUID + encrypted key + a 14 sign-in-day allowance. In
 * hosted mode the Edge Function mints (and writes the Supabase row); locally we
 * mint with Node crypto. `contact` is remembered for later one-click re-trials.
 */
export async function startTrial(contact?: Registration): Promise<{ guid: string }> {
  const useContact = contact ?? loadIdentity() ?? null;
  if (useContact) writeJson(identityPath(), useContact);

  // A fresh trial resets usage-logging consent to its default (opted OUT). The
  // registration form may then re-apply the user's explicit choice afterwards.
  resetUsageConsent();

  // Balance this install into the under-represented variant server-side, so a
  // small pilot splits evenly instead of relying on the ~50/50 hash. Best-effort
  // and idempotent: offline / unconfigured it keeps the local hash assignment.
  // Done here at registration - before onboarding branches on the variant.
  await assignBalancedVariants().catch(() => {});

  if (licenseApi()) {
    const r = await callFn("start", { contact: useContact ? contactRow(useContact) : undefined });
    if (r.ok === false) throw new Error(String(r.detail ?? "trial start rejected"));
    writeJson(licensePath(), {
      guid: String(r.guid),
      licenseKey: String(r.licenseKey),
      licenseType: "trial",
      trialEnd: r.trialEnd ? String(r.trialEnd) : undefined,
    } satisfies LocalLicense);
    return { guid: String(r.guid) };
  }

  // local-dev (or disabled) — self-contained trial, no Supabase
  const guid = crypto.randomUUID();
  const now = new Date();
  const licenseKey = encrypt({ guid, iat: now.toISOString(), type: "trial" });
  writeJson(licensePath(), {
    guid,
    licenseKey,
    licenseType: "trial",
    activeDays: 0,
    lastActiveDay: undefined,
  } satisfies LocalLicense);
  return { guid };
}

/**
 * Activate a license key the user pasted (e.g. a purchased PAID key). Validates
 * it via the function (hosted) or by decoding it (local-dev); on a usable status
 * (valid/grace) it's stored locally so the next check picks it up. Never deletes
 * or resets anything. Returns the resolved status.
 */
export async function activateLicense(licenseKey: string): Promise<LicenseResult> {
  const key = licenseKey.trim();
  if (!key) return { status: "none" };

  if (licenseApi()) {
    let r: Record<string, unknown>;
    try {
      r = await callFn("check", { licenseKey: key });
    } catch {
      return { status: "none" }; // unreachable — can't validate an unknown key
    }
    const status = r.status as LicenseStatus;
    if (status === "valid" || status === "grace") {
      const lic: LocalLicense = {
        guid: String(r.guid ?? crypto.randomUUID()),
        licenseKey: key,
        licenseType: (r.licenseType as LicenseType) ?? "paid",
        trialEnd: String(r.paidThrough ?? r.trialEnd ?? "") || undefined,
        graceUntil: r.graceUntil ? String(r.graceUntil) : undefined,
      };
      writeJson(licensePath(), lic);
      return { status, licenseType: lic.licenseType, trialEnd: lic.trialEnd, graceUntil: lic.graceUntil };
    }
    return { status };
  }

  // local-dev: decode and validate the pasted key BEFORE persisting, so pasting
  // an already-locked/expired key never clobbers a currently-valid license
  // (mirrors the hosted path, which only stores a usable valid/grace status).
  const decoded = decrypt<{ guid: string; type?: LicenseType; paidThrough?: string }>(key);
  if (!decoded?.guid) return { status: "none" };
  const type = decoded.type ?? "trial";
  const result: LicenseResult =
    type === "paid"
      ? paidStatusFrom(decoded.paidThrough, undefined)
      : { status: "valid", licenseType: "trial", remainingDays: TRIAL_DAYS };
  if (result.status === "valid" || result.status === "grace") {
    writeJson(licensePath(), {
      guid: decoded.guid,
      licenseKey: key,
      licenseType: type,
      trialEnd: decoded.paidThrough,
      activeDays: type === "trial" ? 0 : undefined,
    } satisfies LocalLicense);
  }
  return result;
}

export interface FeedbackInput {
  firstName: string;
  lastName: string;
  easeOfUse: number;
  overallValue: number;
  liked: string;
  changeOrAdd: string;
  notifyWhenAvailable?: boolean; // "email me when purchasing opens" (pre-launch)
}

/**
 * Record a feedback-form submission (a post-purchase survey when paid is on, or
 * an end-of-trial survey while paid is off). Stamped with the stable contact id
 * so paid vs unpaid responses can be told apart. The contact fields are
 * remembered. In local-dev (no hosted function) feedback is accepted but not
 * stored.
 */
export async function submitFeedback(f: FeedbackInput): Promise<{ ok: boolean }> {
  // Feedback is always from the signed-in account: link it by the stable contact
  // id and stamp the account's own email — the form no longer asks for an email
  // or a contact preference. doNotContact keeps whatever the account already set
  // (e.g. at registration).
  const existing = loadIdentity();
  const email = accountEmail() ?? existing?.email ?? "";
  const doNotContact = existing?.doNotContact ?? false;
  writeJson(identityPath(), {
    firstName: f.firstName,
    lastName: f.lastName,
    email,
    doNotContact,
    city: existing?.city ?? "",
    state: existing?.state ?? "",
  });
  if (!licenseApi()) return { ok: true };
  try {
    const r = await callFn("feedback", {
      feedback: { ...f, email, doNotContact, contactId: getContactId(), experiments: getAllVariants() },
    });
    return { ok: r.ok !== false };
  } catch {
    return { ok: false };
  }
}

/**
 * Record a feature-interest vote — which of the shelved features (read-aloud,
 * converse, …) the user would actually use. Linked by the stable contact id and
 * stored in its own `feature_interest` Supabase table (separate from feedback).
 * In local-dev (no hosted function) the vote is accepted but not stored.
 */
export async function submitFeatureInterest(
  shown: string[],
  wanted: string[],
): Promise<{ ok: boolean }> {
  if (!licenseApi()) return { ok: true };
  try {
    const r = await callFn("featureInterest", {
      vote: { shown, wanted, contactId: getContactId() },
    });
    return { ok: r.ok !== false };
  } catch {
    return { ok: false };
  }
}

/**
 * Register interest in purchasing while paid mode is off ("notify me when
 * purchasing opens"). Lands in the same Supabase pipeline, tagged by contact id.
 */
export async function submitNotify(email: string): Promise<{ ok: boolean }> {
  const trimmed = email.trim();
  if (!trimmed) return { ok: false };
  const id = loadIdentity();
  writeJson(identityPath(), {
    firstName: id?.firstName ?? "",
    lastName: id?.lastName ?? "",
    email: trimmed,
    doNotContact: id?.doNotContact ?? false,
    city: id?.city ?? "",
    state: id?.state ?? "",
  });
  if (!licenseApi()) return { ok: true };
  try {
    const r = await callFn("notify", { email: trimmed, contactId: getContactId() });
    return { ok: r.ok !== false };
  } catch {
    return { ok: false };
  }
}

/**
 * Get a Stripe Checkout URL for this install. Calls the `create-checkout` Edge
 * Function (which holds the Stripe secret + price) with the install's guid — so
 * the webhook can upgrade exactly this row — and the buyer's email, so the paid
 * license is tied to a user (a business can buy many under one card). Ensures a
 * guid exists first. Returns null when checkout isn't configured/reachable.
 */
export async function checkoutUrl(email?: string): Promise<string | null> {
  const api = process.env.CHECKOUT_API_URL?.trim();
  if (!api) return null;
  let lic = readJson<LocalLicense | null>(licensePath(), null);
  if (!lic?.guid) {
    await startTrial();
    lic = readJson<LocalLicense | null>(licensePath(), null);
  }
  // The paid license is tied to an email. Prefer the one entered at checkout
  // (lets a business buy a license for a specific user); fall back to identity.
  const id = loadIdentity();
  const buyerEmail = email?.trim() || id?.email || "";
  if (buyerEmail) {
    writeJson(identityPath(), {
      firstName: id?.firstName ?? "",
      lastName: id?.lastName ?? "",
      email: buyerEmail,
      doNotContact: id?.doNotContact ?? false,
      city: id?.city ?? "",
      state: id?.state ?? "",
    });
  }
  const anon = process.env.SUPABASE_ANON_KEY?.trim();
  try {
    const res = await fetch(api, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(anon ? { apikey: anon, authorization: `Bearer ${anon}` } : {}),
      },
      body: JSON.stringify({ guid: lic?.guid, email: buyerEmail || undefined }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { url?: string };
    return data.url ?? null;
  } catch {
    return null;
  }
}

/** Send an in-app bug report (with the install's guid/email) to Supabase. */
export async function submitBug(where: string, what: string): Promise<{ ok: boolean }> {
  if (!licenseApi()) return { ok: true };
  const lic = readJson<LocalLicense | null>(licensePath(), null);
  try {
    const r = await callFn("bug", {
      where,
      what,
      contactId: getContactId(),
      guid: lic?.guid,
      email: accountEmail(),
      version: process.env.npm_package_version,
    });
    return { ok: r.ok !== false };
  } catch {
    return { ok: false };
  }
}

/** Log an app launch to the userlogs table (best-effort; hosted mode only). */
export async function pingLaunch(): Promise<void> {
  if (!licenseApi()) return;
  const lic = readJson<LocalLicense | null>(licensePath(), null);
  try {
    await callFn("ping", {
      contactId: getContactId(),
      guid: lic?.guid,
      email: accountEmail(),
      version: process.env.npm_package_version,
      // Stamp the user's variants so userlogs rows can be sliced by experiment.
      experiments: getAllVariants(),
    });
  } catch {
    /* logging must never break a launch */
  }
  // Derive a `returned` event: any launch on a later calendar day than the
  // first, at most once per day. Best-effort and never blocks the launch.
  try {
    const launch = readJson<{ firstDay?: string; lastReturnedDay?: string }>(launchPath(), {});
    const today = utcDay();
    if (!launch.firstDay) {
      writeJson(launchPath(), { ...launch, firstDay: today });
    } else if (today !== launch.firstDay && launch.lastReturnedDay !== today) {
      writeJson(launchPath(), { ...launch, lastReturnedDay: today });
      const day = Math.round((Date.parse(today) - Date.parse(launch.firstDay)) / DAY_MS);
      void recordEvent("returned", { day });
    }
  } catch {
    /* returned-event derivation is best-effort */
  }
}

/**
 * Record a funnel/telemetry event to the `events` table (best-effort; hosted
 * mode only). Every event carries the user's variant for each active experiment
 * so the dashboard can split any metric by variant. Like pingLaunch, this must
 * never throw into a launch, a query, or onboarding - all errors are swallowed.
 */
export async function recordEvent(name: string, props: Record<string, unknown> = {}): Promise<void> {
  if (!licenseApi()) return;
  try {
    await callFn("event", {
      contactId: getContactId(),
      name,
      experiments: getAllVariants(),
      props,
    });
  } catch {
    /* telemetry must never break the app */
  }
}

/**
 * Publish buffered UI click events to Supabase, then purge what was sent. Called
 * during startup right after `pingLaunch`. Best-effort and non-blocking: opted
 * out, offline, or not hosted ⇒ nothing happens and the buffer is kept for next
 * launch. The buffer is ring-capped (see usage.ts), so a single batch is bounded
 * (~5000 events / ~1MB). Keyed by contactId/guid/email/version like the ping.
 */
export async function publishUsageEvents(): Promise<void> {
  if (!licenseApi() || isUsageOptedOut()) return;
  const { events, lineCount } = readUsageBuffer();
  if (!events.length) return;
  const lic = readJson<LocalLicense | null>(licensePath(), null);
  try {
    const r = await callFn("events", {
      contactId: getContactId(),
      guid: lic?.guid,
      email: accountEmail(),
      version: process.env.npm_package_version,
      events,
    });
    if (r.ok === false) return; // keep the buffer; retry next launch
    // Purge exactly the lines we read (preserving any appended since), so a
    // dropped/sanitized line is cleared too rather than retried forever.
    purgeUsageBuffer(lineCount);
  } catch {
    /* offline / unreachable — keep the buffer for the next launch */
  }
}

// --- paid status from an end date (shared by offline + local-dev paths) -------
function paidStatusFrom(end: string | undefined, graceUntil: string | undefined): LicenseResult {
  const endMs = Date.parse(end ?? "");
  if (Number.isNaN(endMs)) return { status: "valid", licenseType: "paid" }; // open-ended
  const graceMs = graceUntil ? Date.parse(graceUntil) : endMs + GRACE_DAYS * DAY_MS;
  const now = Date.now();
  const gu = new Date(graceMs).toISOString();
  if (now <= endMs) return { status: "valid", licenseType: "paid", trialEnd: end };
  if (now <= graceMs) return { status: "grace", licenseType: "paid", trialEnd: end, graceUntil: gu };
  return { status: "locked", licenseType: "paid", trialEnd: end, graceUntil: gu };
}

/**
 * Check the stored license once per launch. Authoritative in hosted mode (the
 * Edge Function counts trial sign-in days and applies paid grace/lock). NOTHING
 * is ever deleted: an expired trial or a locked paid license just reports its
 * status so the UI can grey the vault and show the sign-in gate. An unreachable
 * function is treated leniently (never locks a trial offline; paid falls back to
 * its cached dates).
 */
export async function checkLicense(): Promise<LicenseResult> {
  if (!licensingEnabled()) return { status: "disabled" };

  const lic = readJson<LocalLicense | null>(licensePath(), null);
  if (!lic?.guid || !lic.licenseKey) return { status: "none" };

  if (licenseApi()) {
    try {
      const r = await callFn("check", { licenseKey: lic.licenseKey });
      const status = r.status as LicenseStatus;
      const licenseType = (r.licenseType as LicenseType) ?? lic.licenseType ?? "trial";
      const trialEnd = r.paidThrough ? String(r.paidThrough) : r.trialEnd ? String(r.trialEnd) : lic.trialEnd;
      const graceUntil = r.graceUntil ? String(r.graceUntil) : undefined;
      const remainingDays = typeof r.remainingDays === "number" ? r.remainingDays : undefined;

      // Cache the latest authoritative values for offline fallback (no reset).
      if (status === "valid" || status === "grace" || status === "locked") {
        writeJson(licensePath(), { ...lic, licenseType, trialEnd, graceUntil });
      }
      return { status, licenseType, trialEnd, graceUntil, remainingDays };
    } catch {
      // Offline / unreachable: never lock a trial (sign-in days only count when
      // the user actually reaches the server). Paid falls back to cached dates.
      if ((lic.licenseType ?? "trial") === "paid") {
        return paidStatusFrom(lic.trialEnd, lic.graceUntil);
      }
      return { status: "valid", licenseType: "trial" };
    }
  }

  // --- local-dev verification ---
  const decoded = decrypt<{ guid: string; type?: LicenseType; paidThrough?: string }>(lic.licenseKey);
  if (!decoded || decoded.guid !== lic.guid) return { status: "none" };
  const type = lic.licenseType ?? decoded.type ?? "trial";

  if (type === "paid") {
    return paidStatusFrom(lic.trialEnd ?? decoded.paidThrough, lic.graceUntil);
  }

  // trial: count one sign-in day per new UTC day, lock past the allowance
  const today = utcDay();
  let activeDays = lic.activeDays ?? 0;
  if (lic.lastActiveDay !== today) {
    activeDays += 1;
    writeJson(licensePath(), { ...lic, activeDays, lastActiveDay: today });
  }
  const remainingDays = Math.max(0, TRIAL_DAYS - activeDays);
  if (activeDays > TRIAL_DAYS) return { status: "expired", licenseType: "trial", remainingDays: 0 };
  return { status: "valid", licenseType: "trial", remainingDays };
}
