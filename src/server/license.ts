/**
 * Trial licensing (desktop side).
 *
 * The trial SECRETS — the Supabase service-role key and the `LICENSE_SECRET`
 * that encrypts license keys — live ONLY in the hosted Supabase Edge Function
 * (`supabase/functions/license`), never in the shipped app. The desktop holds
 * just the function's public URL and the public anon key, and calls it to mint
 * ("start") and verify ("check") trials. The filesystem RESET on expiry happens
 * locally (it can't be done server-side).
 *
 * Modes:
 *   Hosted   (LICENSE_API_URL set) — the shipping config. Mint/check go through
 *            the Edge Function. No secret is present on the client.
 *   Local    (LICENSE_ENFORCE=1, no URL) — a self-contained trial using local
 *            Node crypto + a local LICENSE_SECRET. For development only.
 *   Disabled (neither) — app runs unlicensed; checkLicense() reports "disabled".
 *
 * Only a verified, time-based expiry RESETS the vault — copied files deleted,
 * index/state cleared, references unlinked (their real files left untouched),
 * local license removed. An unreadable/forged key, or an offline check, reports
 * "none"/grace and never destroys vault files. Re-registration is unlimited.
 *
 *   LICENSE_API_URL    https://<project>.supabase.co/functions/v1/license
 *   SUPABASE_ANON_KEY  public key used to authorize the function call
 *   LICENSE_ENFORCE=1  enable the local-dev trial (no hosted function)
 *   LICENSE_SECRET     local-dev-only key-encryption secret
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
  trialEnd: string; // ISO; authoritative copy refreshed on each successful check
}

/** The hosted Edge Function URL, or null when not configured. */
function licenseApi(): string | null {
  return process.env.LICENSE_API_URL?.trim() || null;
}

/** Local-dev trial: enforced, self-contained, no hosted function. */
function localMode(): boolean {
  return !licenseApi() && process.env.LICENSE_ENFORCE === "1";
}

/** Trial enforcement is on with a hosted function, or in forced local-dev. */
export function licensingEnabled(): boolean {
  return Boolean(licenseApi()) || localMode();
}

// --- hosted Edge Function ----------------------------------------------------
/** Call the license Edge Function. Throws on a non-2xx / network error. */
async function callFn(op: string, extra: Record<string, unknown>): Promise<Record<string, unknown>> {
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

// --- contact identity persists across resets (for one-click re-trial) --------
function loadIdentity(): Registration | null {
  return readJson<Registration | null>(identityPath(), null);
}
function contactRow(c: Registration) {
  return {
    firstName: c.firstName,
    lastName: c.lastName,
    email: c.email,
    doNotContact: c.doNotContact,
    city: c.city,
    state: c.state,
  };
}

/**
 * Mint a fresh trial: new GUID + 14-day window + encrypted key. In hosted mode
 * the Edge Function mints (and writes the Supabase row); locally we mint with
 * Node crypto. `contact` (from the welcome form) is remembered and reused for
 * later one-click re-trials. The local license is written from the result.
 */
export async function startTrial(contact?: Registration): Promise<{ guid: string; trialEnd: string }> {
  const useContact = contact ?? loadIdentity() ?? null;
  if (useContact) writeJson(identityPath(), useContact);

  if (licenseApi()) {
    const r = await callFn("start", { contact: useContact ? contactRow(useContact) : undefined });
    if (r.ok === false) throw new Error(String(r.detail ?? "trial start rejected"));
    const lic: LocalLicense = {
      guid: String(r.guid),
      licenseKey: String(r.licenseKey),
      trialEnd: String(r.trialEnd),
    };
    writeJson(licensePath(), lic);
    return { guid: lic.guid, trialEnd: lic.trialEnd };
  }

  // local-dev (or disabled) — self-contained trial, no Supabase
  const guid = crypto.randomUUID();
  const now = new Date();
  const trialEnd = new Date(now.getTime() + TRIAL_DAYS * DAY_MS).toISOString();
  const licenseKey = encrypt({ guid, iat: now.toISOString(), trialEnd });
  writeJson(licensePath(), { guid, licenseKey, trialEnd } satisfies LocalLicense);
  return { guid, trialEnd };
}

/**
 * Check the stored license once per launch. In hosted mode the Edge Function is
 * authoritative (so manual `trial_end` extensions apply); we cache its latest
 * `trial_end` locally for offline grace. Only a verified, time-based "expired"
 * RESETS the vault. An unreadable/forged key, or an offline check past the
 * cached end, reports "none" so the user is prompted for a fresh trial —
 * without destroying any vault files.
 */
export async function checkLicense(): Promise<{ status: LicenseStatus; trialEnd?: string }> {
  if (!licensingEnabled()) return { status: "disabled" };

  const lic = readJson<LocalLicense | null>(licensePath(), null);
  if (!lic?.guid || !lic.licenseKey) return { status: "none" };

  if (licenseApi()) {
    try {
      const r = await callFn("check", { licenseKey: lic.licenseKey });
      const status = r.status as LicenseStatus;
      if (status === "valid") {
        const trialEnd = r.trialEnd ? String(r.trialEnd) : lic.trialEnd;
        if (trialEnd !== lic.trialEnd) writeJson(licensePath(), { ...lic, trialEnd });
        return { status: "valid", trialEnd };
      }
      if (status === "expired") {
        resetVault();
        return { status: "expired" };
      }
      // "none" — forged/corrupt key. Prompt for a new trial; do NOT reset.
      return { status: "none" };
    } catch {
      // Offline / function unreachable: never reset on an unverifiable check.
      // Grant grace while the last-known trial_end is still in the future;
      // otherwise prompt for a fresh trial (still no wipe).
      const endMs = Date.parse(lic.trialEnd);
      if (!Number.isNaN(endMs) && Date.now() <= endMs) {
        return { status: "valid", trialEnd: lic.trialEnd };
      }
      return { status: "none" };
    }
  }

  // local-dev verification
  const decoded = decrypt<{ guid: string; trialEnd: string }>(lic.licenseKey);
  if (!decoded || decoded.guid !== lic.guid) return { status: "none" };
  const trialEnd = lic.trialEnd || decoded.trialEnd;
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
