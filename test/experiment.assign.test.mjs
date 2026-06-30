/**
 * End-to-end test for server-balanced A/B assignment (feat/balanced-assignment).
 *
 * Exercises the REAL pieces wired together:
 *   real client  src/server/experiment.ts  assignBalancedVariants()
 *        |  HTTP (callFn -> licenseApi URL)
 *        v
 *   real Edge Function  supabase/functions/license/index.ts  assign op
 *        |  @supabase/supabase-js  (in-memory mock, faithful to the used API)
 *        v
 *   experiment_assignments ledger
 *
 * The Deno function is loaded under Node by stubbing `globalThis.Deno` and
 * redirecting its esm.sh Supabase import (see _assign-loader-hook / _mock-supabase),
 * then its captured handler is served over real loopback HTTP. The desktop client
 * is driven exactly as registration drives it (license.startTrial awaits
 * assignBalancedVariants()), once per simulated install with an isolated vault.
 *
 * Run: `npm run test:extract`
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

register("./_assign-loader-hook.mjs", pathToFileURL(import.meta.filename));

const EVIDENCE_DIR =
  "C:/Users/lmans/AppData/Local/Temp/no-mistakes-evidence/01KWC3F8TZZ28GR46E2SYPDWA5";

// --- stub the Deno runtime the Edge Function expects --------------------------
const denoEnv = {
  SUPABASE_URL: "http://mock.local",
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
  LICENSE_SECRET: "test-secret",
};
const captured = { handler: null };
globalThis.Deno = {
  env: { get: (k) => denoEnv[k] },
  serve: (h) => {
    captured.handler = h;
    return { finished: Promise.resolve(), shutdown() {} };
  },
};

let server;
let mock; // _mock-supabase control surface
let experiment; // real client module

before(async () => {
  // Importing the function registers its handler via the Deno.serve stub.
  await import("../supabase/functions/license/index.ts");
  assert.ok(captured.handler, "Edge Function registered a request handler");
  mock = await import("./_mock-supabase.mjs");

  // Serve the real handler over loopback so the client makes a real HTTP call.
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const request = new Request("http://127.0.0.1/license", {
        method: req.method,
        headers: { "content-type": "application/json" },
        body: req.method === "POST" ? body : undefined,
      });
      const resp = await captured.handler(request);
      res.writeHead(resp.status, { "content-type": "application/json" });
      res.end(await resp.text());
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  process.env.LICENSE_API_URL = `http://127.0.0.1:${port}/license`;
  process.env.SUPABASE_ANON_KEY = "anon-key";

  experiment = await import("../src/server/experiment.ts");
});

after(() => {
  server?.close();
});

/** Fresh isolated vault => fresh random contactId, like a brand-new install. */
function freshInstall() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assign-"));
  process.env.VAULT_DIR = dir;
  return dir;
}
function readExperiments(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, ".rag-vault", "experiments.json"), "utf8"));
}
function readContactId(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, ".rag-vault", "contact.json"), "utf8")).id;
}

const ONBOARDING = ["play_first", "key_first"];
const INCLUSION = ["opt_in", "opt_out"];

test("serial installs are bucketed into an EVEN server-balanced split (not the ~50/50 hash)", async () => {
  mock.__reset();
  const N = 12;
  const got = { onboarding: { play_first: 0, key_first: 0 }, default_inclusion: { opt_in: 0, opt_out: 0 } };
  const hashWouldGive = { onboarding: { play_first: 0, key_first: 0 }, default_inclusion: { opt_in: 0, opt_out: 0 } };

  for (let i = 0; i < N; i++) {
    const dir = freshInstall();
    const variants = await experiment.assignBalancedVariants(); // what registration awaits

    assert.ok(ONBOARDING.includes(variants.onboarding));
    assert.ok(INCLUSION.includes(variants.default_inclusion));
    got.onboarding[variants.onboarding]++;
    got.default_inclusion[variants.default_inclusion]++;

    // Persisted as an authoritative server assignment so it is never re-rolled.
    const stored = readExperiments(dir);
    assert.equal(stored.source, "server", "balanced assignment is persisted with source:'server'");
    assert.equal(stored.onboarding, variants.onboarding);
    assert.equal(stored.default_inclusion, variants.default_inclusion);

    // For contrast: what the local per-install hash alone would have produced.
    const cid = readContactId(dir);
    hashWouldGive.onboarding[experiment.hashToUnit(`${cid}:onboarding:v1`) < 0.5 ? "play_first" : "key_first"]++;
    hashWouldGive.default_inclusion[experiment.hashToUnit(`${cid}:default_inclusion:v1`) < 0.5 ? "opt_in" : "opt_out"]++;
  }

  // Server balancing guarantees an exact split for an even N under serial calls.
  assert.equal(got.onboarding.play_first, N / 2, "onboarding split evenly by the server");
  assert.equal(got.onboarding.key_first, N / 2);
  assert.equal(got.default_inclusion.opt_in, N / 2, "default_inclusion split evenly by the server");
  assert.equal(got.default_inclusion.opt_out, N / 2);

  // The ledger holds exactly one balanced row per install per experiment.
  const rows = mock.__rows("experiment_assignments");
  assert.equal(rows.length, N * 2, "one assignment row per install per experiment");

  // Balancing read counts via head/count queries only (the O(1) hardening): the
  // mock returns NO rows for head queries, so an even split is only possible if
  // the function counted via head:true rather than scanning full rows.
  assert.equal(mock.stats.headCount, N * 2 * 2, "per-variant count-only head queries used for balancing");

  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, "balanced-split.json"),
    JSON.stringify(
      {
        installs: N,
        serverBalancedSplit: got,
        localHashWouldGive: hashWouldGive,
        ledgerRows: rows.length,
        countOnlyHeadQueries: mock.stats.headCount,
        fullRowScansForCounting: 0,
      },
      null,
      2,
    ),
  );
});

test("assignment is stable + idempotent: re-running (even with the local file lost) keeps the server variant", async () => {
  mock.__reset();
  const dir = freshInstall();

  const first = await experiment.assignBalancedVariants();
  const afterFirst = mock.__rows("experiment_assignments").length;
  assert.equal(afterFirst, 2, "first run records one row per experiment");

  // Simulate the local experiments.json being lost between launches.
  fs.rmSync(path.join(dir, ".rag-vault", "experiments.json"));

  const second = await experiment.assignBalancedVariants();
  assert.deepEqual(second, first, "same contact resolves to the same variants across runs");
  assert.equal(
    mock.__rows("experiment_assignments").length,
    afterFirst,
    "no new rows: the server reused the existing assignment (idempotent)",
  );
  assert.equal(readExperiments(dir).source, "server", "re-persisted as the authoritative server assignment");
});

test("missing experiment_assignments migration: DB error is surfaced, client FALLS BACK to the hash", async () => {
  mock.__reset();
  mock.__setBroken(true); // every DB op errors, as if the table was never migrated
  const dir = freshInstall();

  const variants = await experiment.assignBalancedVariants();

  // The function bails (ok:false) instead of fabricating a variant, so the client
  // keeps its deterministic local hash assignment - NOT poisoned to source:"server".
  const stored = readExperiments(dir);
  assert.equal(stored.source, "hash", "a missing migration must not persist a server source");
  assert.equal(mock.__rows("experiment_assignments").length, 0, "nothing was recorded server-side");

  // And the fallback is exactly the deterministic hash bucket for this contact.
  const cid = readContactId(dir);
  const expectOnb = experiment.hashToUnit(`${cid}:onboarding:v1`) < 0.5 ? "play_first" : "key_first";
  const expectInc = experiment.hashToUnit(`${cid}:default_inclusion:v1`) < 0.5 ? "opt_in" : "opt_out";
  assert.equal(variants.onboarding, expectOnb, "onboarding falls back to the local hash");
  assert.equal(variants.default_inclusion, expectInc, "default_inclusion falls back to the local hash");
});

test("lost insert race is recovered (idempotent), but an unrecorded insert bails to the hash", async () => {
  // (a) concurrent insert won the row: the function re-reads and returns it.
  mock.__reset();
  const dirA = freshInstall();
  mock.__forceNextInsertConflict("store"); // row gets stored, but insert reports a conflict
  const a = await experiment.assignBalancedVariants();
  assert.ok(ONBOARDING.includes(a.onboarding) && INCLUSION.includes(a.default_inclusion));
  assert.equal(readExperiments(dirA).source, "server", "recovered the concurrently-written row as authoritative");

  // (b) insert failed AND nothing is recoverable: bail -> client keeps the hash.
  mock.__reset();
  const dirB = freshInstall();
  mock.__forceNextInsertConflict("nostore"); // insert errors and stores nothing
  await experiment.assignBalancedVariants();
  assert.equal(
    readExperiments(dirB).source,
    "hash",
    "an unrecorded assignment must fall back to the hash, not persist source:'server'",
  );
});
