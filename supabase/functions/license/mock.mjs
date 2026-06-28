// Mock of the Lighthouse license Edge Function for testing the desktop app's
// HOSTED mode without deploying. Mirrors the wire contract of index.ts: trials
// counted in sign-in DAYS, paid grace/lock, admin issuePaid. An in-memory "DB"
// plays the role of Supabase, with test-only helpers to manipulate rows.
import http from "node:http";
import crypto from "node:crypto";

const TRIAL_DAYS = 14;
const GRACE_DAYS = 14;
const DAY_MS = 86_400_000;
const SECRET = process.env.LICENSE_SECRET || "mock-secret";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "mock-admin";
const rows = new Map(); // guid -> { license_type, trial_days, active_days, last_active_day, paid_through, grace_days }

function key() {
  return crypto.createHash("sha256").update("lighthouse-license-v1:" + SECRET).digest();
}
function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString("base64"); // iv||ct||tag (WebCrypto order)
}
function decrypt(token) {
  try {
    const buf = Buffer.from(token, "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(buf.length - 16);
    const ct = buf.subarray(12, buf.length - 16);
    const d = crypto.createDecipheriv("aes-256-gcm", key(), iv);
    d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString("utf8"));
  } catch {
    return null;
  }
}
const today = () => new Date().toISOString().slice(0, 10);

const server = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    const body = (() => { try { return JSON.parse(b); } catch { return {}; } })();
    const send = (o, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };

    if (body.op === "start") {
      const guid = crypto.randomUUID();
      const now = new Date();
      const trialEnd = new Date(now.getTime() + TRIAL_DAYS * DAY_MS).toISOString();
      const licenseKey = encrypt({ guid, iat: now.toISOString(), type: "trial" });
      rows.set(guid, { license_type: "trial", trial_days: TRIAL_DAYS, active_days: 0, last_active_day: null });
      return send({ ok: true, guid, trialEnd, licenseKey, trialDays: TRIAL_DAYS, remainingDays: TRIAL_DAYS });
    }

    if (body.op === "check") {
      const decoded = decrypt(String(body.licenseKey || ""));
      if (!decoded?.guid) return send({ status: "none" });
      const guid = decoded.guid;
      const row = rows.get(guid);
      const type = row?.license_type ?? decoded.type ?? "trial";
      const now = Date.now();

      if (type === "paid") {
        const end = row?.paid_through ?? decoded.paidThrough ?? null;
        if (!end) return send({ status: "valid", licenseType: "paid", guid });
        const endMs = Date.parse(end);
        const graceUntil = new Date(endMs + (row?.grace_days ?? GRACE_DAYS) * DAY_MS).toISOString();
        if (now <= endMs) return send({ status: "valid", licenseType: "paid", paidThrough: end, guid });
        if (now <= Date.parse(graceUntil))
          return send({ status: "grace", licenseType: "paid", paidThrough: end, graceUntil, guid });
        return send({ status: "locked", licenseType: "paid", paidThrough: end, graceUntil, guid });
      }

      const trialDays = row?.trial_days ?? TRIAL_DAYS;
      let activeDays = row?.active_days ?? 0;
      if (row && row.last_active_day !== today()) {
        activeDays += 1;
        rows.set(guid, { ...row, active_days: activeDays, last_active_day: today() });
      }
      const remainingDays = Math.max(0, trialDays - activeDays);
      const status = activeDays > trialDays ? "expired" : "valid";
      return send({ status, licenseType: "trial", trialDays, activeDays, remainingDays, guid });
    }

    if (body.op === "issuePaid") {
      if (req.headers["x-admin-token"] !== ADMIN_TOKEN) return send({ ok: false, reason: "unauthorized" }, 401);
      const paidThrough = String(body.paidThrough || "");
      if (!paidThrough || Number.isNaN(Date.parse(paidThrough)))
        return send({ ok: false, reason: "rejected", detail: "paidThrough required" }, 400);
      const guid = String(body.guid || crypto.randomUUID());
      const now = new Date();
      const licenseKey = encrypt({ guid, iat: now.toISOString(), type: "paid", paidThrough });
      rows.set(guid, { license_type: "paid", paid_through: paidThrough, grace_days: Number(body.graceDays ?? GRACE_DAYS) });
      return send({ ok: true, guid, paidThrough, licenseKey });
    }

    // test helper: directly edit a row (simulate Supabase manual changes)
    if (body.op === "__setLicense") {
      rows.set(body.guid, { ...(rows.get(body.guid) || {}), ...body.fields });
      return send({ ok: true, row: rows.get(body.guid) });
    }

    send({ error: "unknown op" }, 400);
  });
});
const PORT = Number(process.env.MOCK_PORT || 4555);
server.listen(PORT, () => console.log("mock license fn on " + PORT));
