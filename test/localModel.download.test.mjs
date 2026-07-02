/**
 * E2E test for the OPTIONAL, on-demand private-model download (src/server/localModel.ts).
 *
 * This drives the REAL module - the same code app/api/model's GET/POST call and
 * the "＋" button in the model picker triggers - against a local HTTPS server that
 * stands in for Hugging Face. It exercises the whole lifecycle a user experiences:
 *
 *   1. absent      - nothing downloaded yet (the "＋" affordance shows).
 *   2. interrupted - a mid-download connection drop leaves NO installed model and
 *                    NO leftover `.part`, so a partial never later looks "ready".
 *   3. downloading - progress (received/total) is observable while it streams
 *                    (the picker shows the spinner + %).
 *   4. ready       - once the full byte count lands and the file exceeds the
 *                    real-model size guard, status flips to "ready" (the check).
 *   5. no-op       - asking again when already installed does NOT re-download.
 *
 * It also proves the cross-host redirect follow (HF `resolve` -> CDN) by pointing
 * the model URL at a 302 that bounces to the real payload.
 *
 * A throwaway self-signed cert is used only so the module's hardcoded `https.get`
 * can reach 127.0.0.1; NODE_TLS_REJECT_UNAUTHORIZED is scoped to this test proc.
 *
 * Run: `npm run test:extract`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createServer } from "node:https";
import { mkdtempSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// localModel.ts uses TypeScript's extensionless relative import (`./config`);
// register the same resolve hook the other server-module tests rely on so Node
// can find `config.ts` when we import the real module below.
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
const FILE = "test-model-Q4_K_M.gguf";
const CHUNK = Buffer.alloc(MB, 0); // 1 MB of zeros, streamed repeatedly
// The first MB carries the "GGUF" magic so the completed file passes the module's
// real-model check (detection requires the magic, not just size).
const FIRST_CHUNK = Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(MB - 4, 0)]);

// Server behaviour is switched per phase via this mutable knob.
let mode = "full"; // "full" | "interrupt"
let payloadHits = 0; // how many times the actual weights endpoint was requested

function log(...a) {
  console.log("[localModel]", ...a);
}

async function withServer(run) {
  const server = createServer({ cert: CERT, key: KEY }, (req, res) => {
    if (req.url === "/resolve/model.gguf") {
      // Stand in for Hugging Face's cross-path 302 to a CDN URL.
      res.writeHead(302, { location: "/cdn/model.gguf" });
      res.end();
      return;
    }
    // /cdn/model.gguf - the actual weights.
    payloadHits++;
    res.writeHead(200, { "content-length": String(SIZE), "content-type": "application/octet-stream" });
    let sent = 0;
    const pump = () => {
      if (res.writableEnded) return;
      if (mode === "interrupt" && sent >= 8 * MB) {
        req.socket.destroy(); // drop the connection mid-stream
        return;
      }
      if (sent >= SIZE) {
        res.end();
        return;
      }
      const chunk = sent === 0 ? FIRST_CHUNK : CHUNK; // first chunk carries the GGUF magic
      sent += chunk.length;
      // Throttle a touch so the "downloading" state is observable to a poller.
      res.write(chunk, () => setTimeout(pump, 8));
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

test("optional private model: absent -> interrupted (clean) -> downloading -> ready -> no-op", async () => {
  const modelsDir = mkdtempSync(path.join(tmpdir(), "lh-models-"));
  process.env.LIGHTHOUSE_MODELS_DIR = modelsDir;
  process.env.LIGHTHOUSE_LOCAL_MODEL_FILE = FILE;

  await withServer(async (port) => {
    // The model URL points at the redirecting endpoint, so success requires the
    // module to follow the cross-path 302. Set before importing (read as a const).
    process.env.LIGHTHOUSE_LOCAL_MODEL_URL = `https://127.0.0.1:${port}/resolve/model.gguf`;

    const { modelStatus, startDownload } = await import("../src/server/localModel.ts");
    const partPath = path.join(modelsDir, `${FILE}.part`);
    const destPath = path.join(modelsDir, FILE);

    // 1. Absent - nothing installed, the picker would show "＋".
    assert.equal(modelStatus().status, "absent", "fresh dir must report absent");
    log("1. status =", modelStatus().status, "(picker shows ＋)");

    // 2. Interrupted download - connection drops mid-stream.
    mode = "interrupt";
    startDownload();
    let s = modelStatus();
    while (s.status === "downloading") {
      await sleep(30);
      s = modelStatus();
    }
    assert.equal(s.status, "error", "an interrupted download must surface as error");
    assert.equal(existsSync(destPath), false, "no installed model after an interrupted download");
    assert.equal(existsSync(partPath), false, "the partial .part file must be cleaned up");
    log("2. interrupted ->", s.status + ";", "installed?", existsSync(destPath), "leftover .part?", existsSync(partPath));

    // 3 + 4. A clean run: observe progress, then ready.
    mode = "full";
    startDownload();
    let sawProgress = null;
    let cur = modelStatus();
    while (cur.status !== "ready") {
      if (cur.status === "downloading" && cur.received > 0 && !sawProgress) {
        sawProgress = { ...cur };
        const pct = Math.floor((cur.received / cur.total) * 100);
        log(`3. downloading -> ${pct}% (${(cur.received / MB).toFixed(0)}/${(cur.total / MB).toFixed(0)} MB) (picker shows spinner + %)`);
      }
      if (cur.status === "error") assert.fail(`clean run errored: ${cur.error}`);
      await sleep(40);
      cur = modelStatus();
    }
    assert.ok(sawProgress, "progress (received/total) must be observable mid-download");
    assert.equal(sawProgress.total, SIZE, "total must equal the server's Content-Length");
    assert.ok(sawProgress.received > 0 && sawProgress.received < SIZE, "received advances between 0 and total");

    // 5. Ready - the full file landed, exceeds the real-model size guard, no .part left.
    assert.equal(modelStatus().status, "ready", "status must be ready once the file lands");
    const installed = readdirSync(modelsDir).filter((n) => n.toLowerCase().endsWith(".gguf"));
    assert.deepEqual(installed, [FILE], "exactly the downloaded model is present");
    assert.equal(statSync(destPath).size, SIZE, "installed file is the complete payload");
    assert.ok(statSync(destPath).size > 1e8, "installed file exceeds the >100MB real-model guard");
    assert.equal(existsSync(partPath), false, "no .part remains after a successful rename");
    log(`4. ready; installed ${installed[0]} (${(statSync(destPath).size / MB).toFixed(0)} MB), no leftover .part (picker shows ✓)`);

    // 6. No-op - already installed, so a second request does not re-download.
    const hitsBefore = payloadHits;
    const again = startDownload();
    assert.equal(again.status, "ready", "re-requesting an installed model reports ready");
    await sleep(200);
    assert.equal(payloadHits, hitsBefore, "no new download is started when already installed");
    log(`5. re-request while installed -> ${again.status}; payload fetches stayed at ${payloadHits} (no re-download)`);
  });

  rmSync(modelsDir, { recursive: true, force: true });
});
