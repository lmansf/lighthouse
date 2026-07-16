/**
 * E2E test for RESUMABLE private-model downloads (src/server/localModel.ts) —
 * the HTTP-Range machinery behind "start it during onboarding, pause it from
 * the AI-models dialog, pick it back up later without re-fetching gigabytes".
 *
 * Drives the REAL module (the same code GET/POST/DELETE /api/model call)
 * against a local HTTPS server standing in for Hugging Face, covering:
 *
 *   A. interrupt   - a mid-stream connection drop keeps the `.part` (status
 *                    "error" + partialBytes), instead of throwing the bytes away.
 *   B. resume      - the next install sends `Range: bytes=<size>-` (carried
 *                    across the HF-style redirect), the server's 206 is APPENDED
 *                    (only the missing tail travels), progress reflects the
 *                    resumed offset immediately, and the file completes to
 *                    "ready". Also proves the onboarding shape: startDownload()
 *                    returns instantly and the download finishes in the
 *                    background with no further calls (no user wait at the end).
 *   C. pause       - requestUninstall() DURING a download = pause: the transfer
 *                    stops, the `.part` survives (also a rapid second DELETE),
 *                    NO `.uninstall` marker is dropped, status settles at
 *                    "absent" (not "error"), and a later install resumes.
 *   D. 200 fallback- a server that ignores Range answers 200: the module
 *                    truncates and restarts from zero (never appends twice).
 *   E. junk .part  - a partial without the GGUF magic is discarded up front
 *                    (no Range sent) so it can never poison the resumed file.
 *   F. bad payload - a completed download that is not a valid GGUF model is
 *                    DELETED and surfaces as an error — a corrupt part must
 *                    never become a "ready" model.
 *   G. 416         - a `.part` at/past the asset size gets 416: it is
 *                    discarded and the download restarts fresh.
 *
 * A throwaway self-signed cert is used only so the module's hardcoded
 * `https.get` can reach 127.0.0.1; NODE_TLS_REJECT_UNAUTHORIZED is scoped to
 * this test process (it also ignores the cert's validity window).
 *
 * Run: `npm run test:extract`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createServer } from "node:https";
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// localModel.ts uses TypeScript's extensionless relative import (`./config`);
// register the same resolve hook the other server-module tests rely on.
register("./_ts-extensionless-hook.mjs", import.meta.url);

// The module talks to a self-signed local server; accept it for this proc only.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const CERT = `-----BEGIN CERTIFICATE-----
MIIDGjCCAgKgAwIBAgIUSgvUiR9Ew6yIYdTKpgeYe1zS5YYwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MDcwMTAwNTczNVoXDTI2MDcw
MzAwNTczNVowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAlSoILRLf+4R1zsbvT/s0O1z49UPgbpWF36OuXITfKAWE
h117P+OqrA1jNLuvwkq8FG6ODkV5FHRYf4ZhVX2GSwWJiHycVho9nr1yYUpCYhta
mW2Zo+AhmJ8FS7R5iHjObEGVVDQDLLyXQtRTjpMth80WOEkHP+SsKW/t554J8iGU
qGBlkR5g4UJKoNiySqS4u2oCgNwBLswOhOCufM5oi0kg2sgT4djW6MjsbBsMvdxm
41UPy1c9Pt57RypiktTvKy30hpLYBegrV7emBnO+C98yd0Skzg0a34xMQW3mnjlN
3PJ9u5PCImpWO1mFSTzjoxEf3WAEYgEP3WiAjXDK3wIDAQABo2QwYjAdBgNVHQ4E
FgQUF2OWc3OetBEzy9IcsKW/kPH2zyswHwYDVR0jBBgwFoAUF2OWc3OetBEzy9Ic
sKW/kPH2zyswDwYDVR0TAQH/BAUwAwEB/zAPBgNVHREECDAGhwR/AAABMA0GCSqG
SIb3DQEBCwUAA4IBAQCC+5EF9zkGKfnjapcN5eICbcKFoU5sXwnls0/7hbrLBNfT
DP6Qe9sHH8hTRfg3yLLJPeqvA6L3TR9pPto74/FHilYg74lBiAoTECD2CrRcrTWX
gOL4l6Xhc4oVgPDF5Yrey8nksaQMqf/jjPnCNwu8GyoskPBCKGd20rsFzvqnhpR9
w25i8++GvUll+1k10xwMGKMoXO15vfjFAK3Hz11FZFLLwAVb2760kaCaZ7DpryM2
mctK4/F4/UJh7+DSX8Q3UkVCfo3fx14AVxvxXRogTZzLp8gE+zHDqHtGuL7zDuuc
JA6BRcKJlYG9QewnQVZQZRcF19L1o/vu/EPJ/W+v
-----END CERTIFICATE-----
`;
const KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCVKggtEt/7hHXO
xu9P+zQ7XPj1Q+BulYXfo65chN8oBYSHXXs/46qsDWM0u6/CSrwUbo4ORXkUdFh/
hmFVfYZLBYmIfJxWGj2evXJhSkJiG1qZbZmj4CGYnwVLtHmIeM5sQZVUNAMsvJdC
1FOOky2HzRY4SQc/5Kwpb+3nngnyIZSoYGWRHmDhQkqg2LJKpLi7agKA3AEuzA6E
4K58zmiLSSDayBPh2NboyOxsGwy93GbjVQ/LVz0+3ntHKmKS1O8rLfSGktgF6CtX
t6YGc74L3zJ3RKTODRrfjExBbeaeOU3c8n27k8IialY7WYVJPOOjER/dYARiAQ/d
aICNcMrfAgMBAAECggEAAceLwRc8YyXsOTMdWsET7ptdgEuMK2A5myE67Mahr5AK
nzTJyh7UrpMa+l+SKV62igXcSFD4MKVyAtTJvM6FDMhm9iEKb7/bY//oPpSMtdqU
BPLjm4AKgTrFwjvycTguZOiOt/+bhBaciq25cMt9BmWMx3oeOIW+r2CISt7onndX
FNvfXtCLvO6Ch1fNe+XmuF4Otpc+9YCfr34j3Rhee5iWmDUqCXNT6z7r/9X6+E6/
4KgSjUzrVKupg65RctJpzeRTXvKq7TAnRlVH262O2eJIrYVuvf+Jp/M4NBj6re4n
ee9b8amIrsypjnNnNGebovv2HycTk6wfObYljM3o0QKBgQDSrsIxE4npL5DxHCrd
FGzSQZ8p3nOpi/+diZ5K5+94UByTBg1S83bHmCMLZvLKCiLD7hUdreIU4q0Aphln
FO2SCGaTHdZD/qlvPKUUiV8KSgBy6YGuEUGlcbG+R9zRidUkQs3erGKiAZZHHQWW
M1lsa0BDuYu+4ZqGQAB2sVaLjwKBgQC1P8JBzK7dCvJpxkajYDjmAXphPFDOJA3P
9EbNRCLpCfsaeg3lkP/DRXVIn6ityc9Luin+b31a62ThYtqV8OD9+HFJvoMZj2Ci
88MaQtMmps/+Uku+4LiUpgy2CVU8EvjnRGiojEeNDhso5O5E087S3qqt0zcU9aqf
f5jZlD5jsQKBgBHghFfXuZcQ0zKyWizCQ+2fZdsOpi/X0kvS1pyyi45g9du/4reM
MyMClM6t4KImNAb+F8qZ65osFdP9RCCMFRCUJ+gJ2xmP7V6j/bn9YhQkbV9S0w8r
Ja/dMuDbhjA9itl11bQ0WnY2vkKwgr3ZA5iAjUZx4xrCV/NWUPPBXn+fAoGAceJ1
EdkliphlRxchrWg5eDQ3jD9U2qIG18K6diG4+cqer70/XB6mxjCviAlh+IjUqtV3
q3qsPmOoCIKPrCUlig8ASADf6UCQzPLzhV21xRSNnlRhabdT43sOg5cLqmqVYOM4
C6fREY1qfWCTYkXgL9lfT0dm1dGi+wM2rIgcR5ECgYBLIHql0jSsnD+hVxQlpnet
ExpJYTiryhyICod7KcUGb1zwaettG7Y4VUalJHWkdTwgFuiM9vmEm29wWctuORLu
6oA/Jzd5P8m+orM9CADHTEh6ZqxpYowl4lYoEMgxDdx4yxFZYW/12YuKiWi/hzaQ
1twk8vFZNPrsx0wHxqs7bA==
-----END PRIVATE KEY-----
`;

const MB = 1024 * 1024;
const SIZE = 100 * MB + MB; // just over the module's 1e8-byte "real model" guard
const INTERRUPT_AT = 8 * MB;
const FILE = "test-model-Q4_K_M.gguf";

// Server behaviour is switched per phase via this mutable knob.
// kind: "range" (honors Range with 206/416) | "interrupt" (drop mid-stream)
//     | "ignoreRange" (always 200 full) | "noMagic" (200 full, not a GGUF).
// slow: stretch the stream so mid-flight states are observable.
let mode = { kind: "range", slow: false };
/** Every hit on the payload endpoint: { range, status, sent }. */
const requests = [];

function log(...a) {
  console.log("[resume]", ...a);
}

/** One MB of payload starting at absolute position `pos`; the file's first
 *  four bytes carry the GGUF magic (except in "noMagic" mode). */
function chunkAt(pos, kind) {
  const len = Math.min(MB, SIZE - pos);
  const buf = Buffer.alloc(len, 0);
  if (pos === 0 && kind !== "noMagic") buf.write("GGUF", 0, "latin1");
  return buf;
}

async function withServer(run) {
  const server = createServer({ cert: CERT, key: KEY }, (req, res) => {
    if (req.url === "/resolve/model.gguf") {
      // Stand in for Hugging Face's cross-path 302 to a CDN URL — the resume
      // Range header must survive this hop.
      res.writeHead(302, { location: "/cdn/model.gguf" });
      res.end();
      return;
    }
    // /cdn/model.gguf - the actual weights.
    const { kind, slow } = mode;
    const range = req.headers.range ?? null;
    const rec = { range, status: 0, sent: 0 };
    requests.push(rec);
    const m = /^bytes=(\d+)-$/.exec(range ?? "");
    let start = 0;
    if (m && kind === "range" && Number(m[1]) >= SIZE) {
      rec.status = 416;
      res.writeHead(416, { "content-range": `bytes */${SIZE}` });
      res.end();
      return;
    }
    if (m && kind === "range") {
      start = Number(m[1]);
      rec.status = 206;
      res.writeHead(206, {
        "content-length": String(SIZE - start),
        "content-range": `bytes ${start}-${SIZE - 1}/${SIZE}`,
        "content-type": "application/octet-stream",
      });
    } else {
      rec.status = 200;
      res.writeHead(200, { "content-length": String(SIZE), "content-type": "application/octet-stream" });
    }
    let pos = start;
    const pump = () => {
      if (res.writableEnded || res.destroyed) return;
      if (kind === "interrupt" && rec.sent >= INTERRUPT_AT) {
        req.socket.destroy(); // drop the connection mid-stream
        return;
      }
      if (pos >= SIZE) {
        res.end();
        return;
      }
      const chunk = chunkAt(pos, kind);
      pos += chunk.length;
      rec.sent += chunk.length;
      // Throttle so in-flight states are observable to a poller.
      res.write(chunk, () => setTimeout(pump, slow ? 15 : 2));
    };
    pump();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    return await run(port);
  } finally {
    server.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("private model download: interrupt keeps .part; Range resume; pause; 200/416 fallbacks; strict integrity", async () => {
  // Hermetic dirs: a fresh models dir per phase (the module reads the env on
  // every call) and an empty resources dir so a dev machine's fetched model
  // can't leak into the "installed" checks.
  const resourcesDir = mkdtempSync(path.join(tmpdir(), "lh-resume-res-"));
  process.env.LIGHTHOUSE_RESOURCES_PATH = resourcesDir;
  process.env.LIGHTHOUSE_LOCAL_MODEL_FILE = FILE;
  const dirs = [];
  const freshDir = () => {
    const d = mkdtempSync(path.join(tmpdir(), "lh-resume-"));
    dirs.push(d);
    process.env.LIGHTHOUSE_MODELS_DIR = d;
    return d;
  };

  await withServer(async (port) => {
    // Point at the redirecting endpoint so resume must survive the 302 hop.
    process.env.LIGHTHOUSE_LOCAL_MODEL_URL = `https://127.0.0.1:${port}/resolve/model.gguf`;
    const { modelStatus, startDownload, requestUninstall } = await import("../src/server/localModel.ts");

    /** Poll until the download reaches a terminal state, collecting samples. */
    async function settle() {
      const samples = [];
      const deadline = Date.now() + 60_000;
      let s = modelStatus();
      while (s.status === "downloading") {
        samples.push(s);
        assert.ok(Date.now() < deadline, "download never reached a terminal state");
        await sleep(20);
        s = modelStatus();
      }
      return { final: s, samples };
    }

    // --- A. Interrupt: the partial is KEPT (that's the whole feature) -------
    const dirA = freshDir();
    const partA = path.join(dirA, `${FILE}.part`);
    mode = { kind: "interrupt", slow: false };
    const kickedA = startDownload();
    assert.equal(kickedA.status, "downloading", "kickoff returns immediately (fire-and-forget)");
    const a = await settle();
    assert.equal(a.final.status, "error", "an interrupted download surfaces as error");
    assert.equal(existsSync(path.join(dirA, FILE)), false, "no installed model after an interruption");
    assert.ok(existsSync(partA), "the .part is KEPT after an interruption (resumable)");
    const partASize = statSync(partA).size;
    assert.ok(partASize > 4 && partASize < SIZE, `.part holds a real prefix (${partASize} bytes)`);
    assert.equal(a.final.partialBytes, partASize, "status reports the resumable bytes (partialBytes)");
    assert.equal(requests[0].range, null, "a fresh download sends no Range header");
    log(`A. interrupted -> error; .part kept (${(partASize / MB).toFixed(0)} MB), partialBytes reported`);

    // --- B. Resume: Range → 206 appended → ready, all in the background -----
    mode = { kind: "range", slow: true };
    const before = requests.length;
    const kickedB = startDownload();
    assert.equal(kickedB.status, "downloading", "resume kickoff also returns immediately");
    assert.equal(kickedB.received, partASize, "progress reflects the resumed offset immediately");
    // "Onboarding shape": the user walks through the remaining setup steps
    // while the download runs — we just poll (as the UI does) and never call
    // startDownload again; readiness must arrive with no user wait at the end.
    const b = await settle();
    assert.equal(b.final.status, "ready", "resumed download completes to ready in the background");
    const resumeReq = requests[before];
    assert.equal(resumeReq.range, `bytes=${partASize}-`, "resume sends Range from the kept .part size");
    assert.equal(resumeReq.status, 206, "the server honored the Range (206)");
    assert.equal(resumeReq.sent, SIZE - partASize, "only the missing tail traveled (206 APPEND, not a refetch)");
    const observed = b.samples.filter((s) => s.total > 0);
    assert.ok(observed.length > 0, "mid-flight progress is observable");
    for (const s of observed) {
      assert.ok(s.received >= partASize, `resumed progress never dips below the offset (${s.received})`);
    }
    const destB = path.join(dirA, FILE);
    assert.equal(statSync(destB).size, SIZE, "installed file is the complete payload");
    const fd = openSync(destB, "r");
    const magic = Buffer.alloc(4);
    readSync(fd, magic, 0, 4, 0);
    closeSync(fd);
    assert.equal(magic.toString("latin1"), "GGUF", "the resumed file begins with the GGUF magic");
    assert.equal(existsSync(partA), false, "no .part remains after a successful resume");
    assert.equal(modelStatus().partialBytes, undefined, "ready status carries no partialBytes");
    log(`B. resumed with Range: bytes=${partASize}- -> 206; server sent only ${(resumeReq.sent / MB).toFixed(0)} MB; ready`);

    // --- C. Pause = DELETE while downloading: .part survives, no marker -----
    const dirC = freshDir();
    const partC = path.join(dirC, `${FILE}.part`);
    mode = { kind: "range", slow: true };
    startDownload();
    {
      const deadline = Date.now() + 30_000;
      while (modelStatus().received < 3 * MB) {
        assert.ok(Date.now() < deadline, "download never got going for the pause phase");
        assert.notEqual(modelStatus().status, "error", "pause-phase download must not error before the pause");
        await sleep(15);
      }
    }
    const paused = requestUninstall();
    assert.equal(paused.status, "absent", "DELETE during a download pauses (reports absent, not uninstalling)");
    await sleep(400); // let the torn-down stream settle
    const afterPause = modelStatus();
    assert.equal(afterPause.status, "absent", "a paused download settles at absent, never error");
    assert.ok(existsSync(partC), "pause KEEPS the .part");
    assert.ok(afterPause.partialBytes > 0, "paused status reports the resumable bytes");
    assert.equal(existsSync(path.join(dirC, ".uninstall")), false, "pause drops NO uninstall marker");
    const again = requestUninstall();
    assert.equal(again.status, "absent", "a second DELETE is a safe no-op");
    assert.ok(existsSync(partC), "a rapid second DELETE does not discard the resumable .part");
    const partCSize = statSync(partC).size;
    mode = { kind: "range", slow: false };
    const beforeResumeC = requests.length;
    startDownload();
    const c = await settle();
    assert.equal(c.final.status, "ready", "a paused download resumes to ready");
    assert.equal(requests[beforeResumeC].range, `bytes=${partCSize}-`, "the resume after pause sends Range");
    assert.equal(statSync(path.join(dirC, FILE)).size, SIZE, "paused+resumed file is byte-exact");
    log(`C. paused at ${(partCSize / MB).toFixed(0)} MB (absent, .part kept, no marker) -> resumed -> ready`);

    // --- D. Server ignores Range: 200 → truncate + clean full restart -------
    const dirD = freshDir();
    const partD = path.join(dirD, `${FILE}.part`);
    mode = { kind: "interrupt", slow: false };
    startDownload();
    await settle();
    const partDSize = statSync(partD).size;
    assert.ok(partDSize > 0, "interrupted again: .part kept for the fallback phase");
    mode = { kind: "ignoreRange", slow: false };
    const beforeD = requests.length;
    startDownload();
    const d = await settle();
    assert.equal(d.final.status, "ready", "the 200 fallback still completes to ready");
    assert.equal(requests[beforeD].range, `bytes=${partDSize}-`, "the module DID ask to resume");
    assert.equal(requests[beforeD].status, 200, "…but the server ignored the Range (200)");
    assert.equal(requests[beforeD].sent, SIZE, "the server sent the full body");
    assert.equal(statSync(path.join(dirD, FILE)).size, SIZE, "truncate-restart yields the exact size (no double-append)");
    log("D. server ignored Range -> 200 full restart -> ready with the exact byte count");

    // --- E. Junk .part (no GGUF magic) is discarded before any Range --------
    const dirE = freshDir();
    writeFileSync(path.join(dirE, `${FILE}.part`), Buffer.concat([Buffer.from("JUNK"), Buffer.alloc(2 * MB, 7)]));
    mode = { kind: "range", slow: false };
    const beforeE = requests.length;
    startDownload();
    const e = await settle();
    assert.equal(e.final.status, "ready", "a junk partial never blocks a clean install");
    assert.equal(requests[beforeE].range, null, "a junk .part is discarded — no Range sent (integrity gate)");
    assert.equal(statSync(path.join(dirE, FILE)).size, SIZE, "clean install after junk discard");
    log("E. junk .part discarded up front (no Range) -> fresh download -> ready");

    // --- F. Completed-but-corrupt payload: DELETED + error (strict) ---------
    const dirF = freshDir();
    mode = { kind: "noMagic", slow: false };
    startDownload();
    const f = await settle();
    assert.equal(f.final.status, "error", "a corrupt completed download surfaces as error");
    assert.match(f.final.error ?? "", /not a valid GGUF model/, "the error names the integrity failure");
    assert.equal(existsSync(path.join(dirF, `${FILE}.part`)), false, "the corrupt .part is DELETED, never kept");
    assert.equal(existsSync(path.join(dirF, FILE)), false, "a corrupt part never becomes a ready model");
    assert.equal(f.final.partialBytes, undefined, "no resumable bytes are advertised after an integrity failure");
    log("F. full-size non-GGUF payload -> integrity error; .part deleted; nothing installed");

    // --- G. Oversized .part → 416 → discard → fresh restart -----------------
    const dirG = freshDir();
    const partG = path.join(dirG, `${FILE}.part`);
    {
      // Sparse GGUF-prefixed .part LARGER than the asset (e.g. the URL now
      // serves a smaller file than an old attempt did).
      const fdG = openSync(partG, "w");
      writeSync(fdG, Buffer.from("GGUF"));
      ftruncateSync(fdG, SIZE + MB);
      closeSync(fdG);
    }
    mode = { kind: "range", slow: false };
    const beforeG = requests.length;
    startDownload();
    const g = await settle();
    assert.equal(g.final.status, "ready", "the 416 path recovers to a clean install");
    assert.equal(requests[beforeG].status, 416, "the oversized resume got 416");
    assert.equal(requests[beforeG + 1].range, null, "after 416 the .part is discarded and the refetch is rangeless");
    assert.equal(statSync(path.join(dirG, FILE)).size, SIZE, "the fresh download is byte-exact");
    log("G. oversized .part -> 416 -> discarded -> fresh download -> ready");
  });

  rmSync(resourcesDir, { recursive: true, force: true });
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
