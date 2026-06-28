// Lighthouse trial-license Edge Function (Supabase, Deno runtime).
//
// Holds the trial secrets SERVER-SIDE so they never ship in the desktop app:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   auto-injected by Supabase
//   LICENSE_SECRET                            set via `supabase secrets set`
//   REGISTRATIONS_TABLE                       optional (default "registrations")
//
// Two operations (POST { op }):
//   start  → mint a 14-day trial: new GUID, trial_start/end, AES-256-GCM
//            license_key; insert the row (with optional contact); return the key.
//   check  → given a license_key, read the row's (extendable) trial_end and
//            report valid | expired | none.
//
// Deploy:  supabase functions deploy license
//          supabase secrets set LICENSE_SECRET="<long random string>"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TRIAL_DAYS = 14;
const DAY_MS = 86_400_000;
const TABLE = Deno.env.get("REGISTRATIONS_TABLE") ?? "registrations";

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
  const secret = Deno.env.get("LICENSE_SECRET") ?? "lighthouse-insecure-default-secret";
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
  const trialEnd = new Date(now.getTime() + TRIAL_DAYS * DAY_MS).toISOString();
  const licenseKey = await encrypt({ guid, iat: now.toISOString(), trialEnd });

  const { error } = await admin()
    .from(TABLE)
    .insert({
      first_name: contact.firstName ?? null,
      last_name: contact.lastName ?? null,
      email: contact.email ?? null,
      do_not_contact: Boolean(contact.doNotContact),
      city: contact.city ?? null,
      state: contact.state ?? null,
      guid,
      trial_start: now.toISOString(),
      trial_end: trialEnd,
      license_key: licenseKey,
    });
  if (error) return json({ ok: false, reason: "rejected", detail: error.message });
  return json({ ok: true, guid, trialEnd, licenseKey });
}

async function check(licenseKey: string): Promise<Response> {
  if (!licenseKey) return json({ status: "none" });
  const decoded = await decrypt<{ guid: string; trialEnd: string }>(licenseKey);
  // Forged / corrupt / wrong-secret: report "none" (prompt for a fresh trial)
  // rather than "expired" — only a verified time-expiry may reset a vault.
  if (!decoded?.guid) return json({ status: "none" });

  // Authoritative (and extendable) trial_end from the row; fall back to the
  // value baked into the token only when the row is genuinely absent (e.g.
  // deleted). A read error is unverifiable, not an expiry: surface it as a
  // non-2xx so the client applies offline grace instead of wiping the vault.
  const { data, error } = await admin()
    .from(TABLE)
    .select("trial_end")
    .eq("guid", decoded.guid)
    .order("trial_end", { ascending: false })
    .limit(1);
  if (error) return json({ status: "error", detail: error.message }, 503);
  const trialEnd = data?.[0]?.trial_end ?? decoded.trialEnd;

  const status = Date.now() > Date.parse(trialEnd) ? "expired" : "valid";
  return json({ status, trialEnd });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const body = await req.json().catch(() => ({}));
  switch (body.op) {
    case "start":
      return await start((body.contact ?? {}) as Contact);
    case "check":
      return await check(String(body.licenseKey ?? ""));
    default:
      return json({ error: "unknown op" }, 400);
  }
});
