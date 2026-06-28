/**
 * Trial licensing (server-side, single-user).
 *
 * On registration the app mints a trial: a unique GUID, a start/end window
 * (14 days), and an AES-256-GCM-encrypted `license_key` binding the GUID. The
 * row is written to Supabase (so a trial can be extended by editing `trial_end`
 * there) and a copy is stored locally in `.rag-vault/license.json`.
 *
 * Once per launch the app checks the license. When the trial has ended the
 * vault is RESET — copied files deleted, index/state cleared, references
 * unlinked (their real files left untouched), and the local license removed —
 * and the user is prompted to start a new trial. Re-registration is unlimited.
 *
 * Enforcement is active only when Supabase is configured (or LICENSE_ENFORCE=1);
 * otherwise the app runs unlicensed and `checkLicense()` reports "disabled".
 *
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  server-side Supabase access
 *   SUPABASE_REGISTRATIONS_TABLE             table name (default "registrations")
 *   LICENSE_SECRET                           key-encryption secret (set in prod!)
 *   LICENSE_ENFORCE=1                        force enforcement without Supabase
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { vaultDir, stateDir, statePath, readJson, writeJson } from "./config";
import type { Registration } from "./registration";

const TRIAL_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

const licensePath = () => path.join(stateDir(), "license.json");
const identityPath = () => path.join(stateDir(), "identity.json");

export type LicenseStatus = "valid" | "expired" | "none" | "disabled";

interface LocalLicense {
  guid: string;
  licenseKey: string;
  trialEnd: string; // ISO; local copy / fallback when Supabase is absent
}

/** Supabase access for license rows — prefers the service-role key. */
function sb(): { base: string; key: string; table: string } | null {
  const url = process.env.SUPABASE_URL?.trim();
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_ANON_KEY?.trim();
  const table = process.env.SUPABASE_REGISTRATIONS_TABLE?.trim() || "registrations";
  if (!url || !key) return null;
  return { base: url.replace(/\/$/, ""), key, table };
}

/** Trial enforcement is on only with Supabase configured, or when forced. */
export function licensingEnabled(): boolean {
  return Boolean(sb()) || process.env.LICENSE_ENFORCE === "1";
}

// --- crypto (AES-256-GCM) ----------------------------------------------------
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

// --- Supabase REST -----------------------------------------------------------
async function sbInsert(row: Record<string, unknown>): Promise<void> {
  const c = sb();
  if (!c) return;
  const res = await fetch(`${c.base}/rest/v1/${encodeURIComponent(c.table)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: c.key,
      authorization: `Bearer ${c.key}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    throw new Error(`supabase insert ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}
/** The authoritative (extendable) trial end for a GUID, or null. */
async function sbTrialEnd(guid: string): Promise<string | null> {
  const c = sb();
  if (!c) return null;
  const q = `guid=eq.${encodeURIComponent(guid)}&select=trial_end&order=trial_end.desc&limit=1`;
  const res = await fetch(`${c.base}/rest/v1/${encodeURIComponent(c.table)}?${q}`, {
    headers: { apikey: c.key, authorization: `Bearer ${c.key}` },
  });
  if (!res.ok) return null;
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) && rows[0]?.trial_end ? String(rows[0].trial_end) : null;
}

// --- contact identity persists across resets (for one-click re-trial) --------
function loadIdentity(): Registration | null {
  return readJson<Registration | null>(identityPath(), null);
}

/**
 * Mint a fresh trial: new GUID + 14-day window + encrypted key. Persists to
 * Supabase (if configured) and locally. `contact` (from the welcome form) is
 * remembered and reused for later one-click re-trials.
 */
export async function startTrial(contact?: Registration): Promise<{ guid: string; trialEnd: string }> {
  const guid = crypto.randomUUID();
  const now = new Date();
  const end = new Date(now.getTime() + TRIAL_DAYS * DAY_MS);
  const trialEnd = end.toISOString();
  const licenseKey = encrypt({ guid, iat: now.toISOString(), trialEnd });

  const useContact = contact ?? loadIdentity() ?? null;
  if (sb()) {
    await sbInsert({
      ...(useContact
        ? {
            first_name: useContact.firstName,
            last_name: useContact.lastName,
            email: useContact.email,
            do_not_contact: useContact.doNotContact,
            city: useContact.city,
            state: useContact.state,
          }
        : {}),
      guid,
      trial_start: now.toISOString(),
      trial_end: trialEnd,
      license_key: licenseKey,
    });
  }
  if (useContact) writeJson(identityPath(), useContact);
  writeJson(licensePath(), { guid, licenseKey, trialEnd } satisfies LocalLicense);
  return { guid, trialEnd };
}

/**
 * Check the stored license once per launch. Reads the authoritative `trial_end`
 * from Supabase when configured (so manual extensions apply). On expiry or a
 * tampered key, RESETS the vault and reports "expired".
 */
export async function checkLicense(): Promise<{ status: LicenseStatus; trialEnd?: string }> {
  if (!licensingEnabled()) return { status: "disabled" };

  const lic = readJson<LocalLicense | null>(licensePath(), null);
  if (!lic?.guid || !lic.licenseKey) return { status: "none" };

  const decoded = decrypt<{ guid: string; trialEnd: string }>(lic.licenseKey);
  if (!decoded || decoded.guid !== lic.guid) {
    resetVault(); // forged/corrupt key
    return { status: "expired" };
  }

  let trialEnd = lic.trialEnd || decoded.trialEnd;
  const remote = await sbTrialEnd(lic.guid);
  if (remote) trialEnd = remote;

  const endMs = Date.parse(trialEnd);
  if (Number.isNaN(endMs) || Date.now() > endMs) {
    resetVault();
    return { status: "expired" };
  }
  return { status: "valid", trialEnd };
}

/**
 * Reset the vault on trial expiry. Deletes everything copied into the vault and
 * clears the index/inclusion state and references (an UNLINK — the real files a
 * reference points to are left in place). Removes the local license so the next
 * launch prompts for a new trial. The contact identity and profile are kept.
 */
export function resetVault(): void {
  const dir = vaultDir();
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    /* nothing to clear */
  }
  for (const e of entries) {
    if (e === ".rag-vault") continue; // keep state dir; we rewrite/prune below
    try {
      fs.rmSync(path.join(dir, e), { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  // Clear inclusion + references (unlink in place; external real files untouched).
  writeJson(statePath(), { sourceAvailable: true, included: {}, references: {} });
  try {
    fs.rmSync(licensePath(), { force: true });
  } catch {
    /* already gone */
  }
}
