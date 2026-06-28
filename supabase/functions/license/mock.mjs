// Mock of the Supabase Edge Function (start/check) for testing the desktop
// app's HOSTED license mode without deploying. Same wire contract; an in-memory
// "DB" plays the role of Supabase so we can also simulate manual trial extends.
import http from "node:http";
import crypto from "node:crypto";

const TRIAL_DAYS = 14;
const SECRET = process.env.LICENSE_SECRET || "mock-secret";
const rows = new Map(); // guid -> { trial_end }

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

const server = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    const body = (() => { try { return JSON.parse(b); } catch { return {}; } })();
    const send = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (body.op === "start") {
      const guid = crypto.randomUUID();
      const now = new Date();
      const trialEnd = new Date(now.getTime() + TRIAL_DAYS * 86400000).toISOString();
      const licenseKey = encrypt({ guid, iat: now.toISOString(), trialEnd });
      rows.set(guid, { trial_end: trialEnd });
      return send({ ok: true, guid, trialEnd, licenseKey });
    }
    if (body.op === "check") {
      const decoded = decrypt(String(body.licenseKey || ""));
      if (!decoded?.guid) return send({ status: "none" }); // forged/corrupt — no wipe
      const trialEnd = rows.get(decoded.guid)?.trial_end ?? decoded.trialEnd;
      return send({ status: Date.now() > Date.parse(trialEnd) ? "expired" : "valid", trialEnd });
    }
    // test helper: simulate a Supabase manual extend/expire by editing the row
    if (body.op === "__setTrialEnd") {
      rows.set(body.guid, { trial_end: body.trialEnd });
      return send({ ok: true });
    }
    res.writeHead(400); res.end("{}");
  });
});
const PORT = Number(process.env.MOCK_PORT || 4555);
server.listen(PORT, () => console.log("mock license fn on " + PORT));
