/**
 * Survivor-killing pins for the egress registry's PARSING and ATTRIBUTION.
 *
 * egress.test.mjs beside it proves aggregation and the All-local empty state.
 * The mutation harness still scored this module 44.8% — 16 survivors — because
 * everything that decides WHICH host a request is filed under, and which hosts
 * a single question is answerable for, was unpinned. That is the part users
 * are shown: the egress panel and the audit log's per-answer host list are the
 * app's claim about where data went. A parser that quietly keeps userinfo, or
 * an off-by-one that reports a host as contacted when it wasn't, is a false
 * privacy statement, not a formatting bug.
 *
 * PARITY: hostOf/host_counts/hosts_since have Rust twins; these boundaries are
 * the ones both must agree on.
 *
 * Run: `node --test test/egressAttribution.test.mjs`
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const {
  recordEgress,
  egressSnapshot,
  hostCounts,
  hostsSince,
  resetEgressForTests,
  PURPOSE_AI_PROVIDER,
  PURPOSE_UPDATE_CHECK,
} = await import("../src/server/egress.ts");

beforeEach(() => resetEgressForTests());

/** The recorded host for one input, read back off the snapshot. */
function hostFor(input) {
  resetEgressForTests();
  recordEgress(input, PURPOSE_AI_PROVIDER);
  const { destinations } = egressSnapshot();
  return destinations.length ? destinations[0].host : null;
}

// --- hostOf: every branch of the reduction ----------------------------------

test("a scheme is stripped wherever it sits, including at index 0", () => {
  // `schemeIdx >= 0` vs `> 0`: a string STARTING with "://" has the separator
  // at index 0, the one input that tells the two apart.
  assert.equal(hostFor("https://api.example.com/v1/messages"), "api.example.com");
  assert.equal(hostFor("://api.example.com"), "api.example.com", "index 0 still strips");
});

test("a bare host with no scheme passes through untouched", () => {
  assert.equal(hostFor("api.example.com"), "api.example.com");
});

test("the path, query and fragment are dropped — never recorded", () => {
  assert.equal(hostFor("https://api.example.com/v1/secret?token=abc#frag"), "api.example.com");
  assert.equal(hostFor("api.example.com/just/a/path"), "api.example.com");
});

test("userinfo is dropped, and the LAST @ wins so it cannot be smuggled past", () => {
  // `lastIndexOf("@")` + `at >= 0` + `slice(at + 1)`: an @ at index 0 is the
  // case separating `>= 0` from `> 0`, and a second @ separates last- from
  // first-index. Both would leak credentials into the panel.
  assert.equal(hostFor("https://user:pw@api.example.com/x"), "api.example.com");
  assert.equal(hostFor("@api.example.com"), "api.example.com", "@ at index 0");
  assert.equal(hostFor("https://a@b@api.example.com"), "api.example.com", "last @ wins");
});

test("the port is dropped and the host is lowercased", () => {
  assert.equal(hostFor("https://API.Example.COM:8443/v1"), "api.example.com");
});

test("an input that reduces to nothing is not recorded at all", () => {
  // `if (!host) return` — a mutant removing it would file an empty-host row,
  // which the panel would render as a blank destination.
  resetEgressForTests();
  recordEgress("", PURPOSE_AI_PROVIDER);
  recordEgress("   ", PURPOSE_AI_PROVIDER);
  recordEgress("https://", PURPOSE_AI_PROVIDER);
  assert.deepEqual(egressSnapshot(), { total: 0, destinations: [] });
});

// --- counting ---------------------------------------------------------------

test("each call adds exactly one, starting from one and not zero", () => {
  // `e.count += 1` with 1→0 or +→- both leave a row present but miscounted.
  resetEgressForTests();
  recordEgress("api.example.com", PURPOSE_AI_PROVIDER);
  assert.equal(egressSnapshot().destinations[0].count, 1, "the first call counts as one");
  recordEgress("api.example.com", PURPOSE_AI_PROVIDER);
  recordEgress("api.example.com", PURPOSE_AI_PROVIDER);
  assert.equal(egressSnapshot().destinations[0].count, 3);
  assert.equal(egressSnapshot().total, 3);
});

test("the same host under two purposes stays two rows that both count", () => {
  resetEgressForTests();
  recordEgress("api.example.com", PURPOSE_AI_PROVIDER);
  recordEgress("api.example.com", PURPOSE_UPDATE_CHECK);
  recordEgress("api.example.com", PURPOSE_UPDATE_CHECK);
  const { total, destinations } = egressSnapshot();
  assert.equal(destinations.length, 2);
  assert.equal(total, 3, "the total sums across purposes");
});

// --- the key split: host and purpose must come back out whole ---------------

test("a purpose containing spaces round-trips exactly, host unaffected", () => {
  // The key is `host\npurpose`; slicing at the wrong index by one would shift
  // a character between the two fields. Purposes contain spaces, so this is
  // the field most likely to show it.
  resetEgressForTests();
  recordEgress("api.example.com", PURPOSE_AI_PROVIDER);
  const row = egressSnapshot().destinations[0];
  assert.equal(row.host, "api.example.com", "no newline or purpose bleed");
  assert.equal(row.purpose, PURPOSE_AI_PROVIDER, "the whole purpose, first char included");
  assert.ok(PURPOSE_AI_PROVIDER.includes(" "), "the fixture really does contain a space");
});

// --- snapshot ordering ------------------------------------------------------

test("destinations are ordered most-recent first", () => {
  resetEgressForTests();
  recordEgress("older.example.com", PURPOSE_AI_PROVIDER);
  const spin = Date.now();
  while (Date.now() === spin) { /* ensure a distinct ms */ }
  recordEgress("newer.example.com", PURPOSE_AI_PROVIDER);
  const hosts = egressSnapshot().destinations.map((d) => d.host);
  assert.deepEqual(hosts, ["newer.example.com", "older.example.com"]);
});

// --- hostCounts: accumulation ACROSS purposes -------------------------------

test("hostCounts sums a host's requests across every purpose", () => {
  // `(out.get(host) ?? 0) + e.count`: a mutant replacing + with - or dropping
  // the accumulator makes a busy host look quiet.
  resetEgressForTests();
  recordEgress("api.example.com", PURPOSE_AI_PROVIDER);
  recordEgress("api.example.com", PURPOSE_AI_PROVIDER);
  recordEgress("api.example.com", PURPOSE_UPDATE_CHECK);
  recordEgress("other.example.com", PURPOSE_UPDATE_CHECK);
  const counts = hostCounts();
  assert.equal(counts.get("api.example.com"), 3, "2 + 1 across two purposes");
  assert.equal(counts.get("other.example.com"), 1);
  assert.equal(counts.size, 2);
});

test("hostCounts keys are bare hosts, never the host\\npurpose composite", () => {
  resetEgressForTests();
  recordEgress("api.example.com", PURPOSE_AI_PROVIDER);
  for (const key of hostCounts().keys()) {
    assert.ok(!key.includes("\n"), `key leaked the separator: ${JSON.stringify(key)}`);
  }
});

// --- hostsSince: the per-answer attribution ---------------------------------

test("only hosts whose count actually ROSE are attributed to the question", () => {
  // `count > (before.get(host) ?? 0)` with `>` → `>=` would attribute EVERY
  // known host to every answer — the panel would claim contact that never
  // happened.
  resetEgressForTests();
  recordEgress("quiet.example.com", PURPOSE_AI_PROVIDER);
  const before = hostCounts();

  recordEgress("busy.example.com", PURPOSE_AI_PROVIDER);
  assert.deepEqual(hostsSince(before), ["busy.example.com"], "the quiet host is not attributed");
});

test("a host contacted again during the question IS attributed", () => {
  resetEgressForTests();
  recordEgress("api.example.com", PURPOSE_AI_PROVIDER);
  const before = hostCounts();
  recordEgress("api.example.com", PURPOSE_AI_PROVIDER);
  assert.deepEqual(hostsSince(before), ["api.example.com"]);
});

test("a first-ever contact is attributed — an absent baseline reads as zero", () => {
  // `before.get(host) ?? 0`: without the ?? the comparison is against
  // undefined and `count > undefined` is false, so a brand-new host — the
  // most important case — would silently go unreported.
  resetEgressForTests();
  const before = hostCounts();
  assert.equal(before.size, 0);
  recordEgress("first.example.com", PURPOSE_AI_PROVIDER);
  assert.deepEqual(hostsSince(before), ["first.example.com"]);
});

test("nothing new means nothing attributed", () => {
  resetEgressForTests();
  recordEgress("api.example.com", PURPOSE_AI_PROVIDER);
  const before = hostCounts();
  assert.deepEqual(hostsSince(before), [], "an answer with no egress attributes none");
});

test("attributed hosts come back sorted, for a stable audit record", () => {
  resetEgressForTests();
  const before = hostCounts();
  recordEgress("zulu.example.com", PURPOSE_AI_PROVIDER);
  recordEgress("alpha.example.com", PURPOSE_AI_PROVIDER);
  recordEgress("mike.example.com", PURPOSE_AI_PROVIDER);
  assert.deepEqual(hostsSince(before), [
    "alpha.example.com",
    "mike.example.com",
    "zulu.example.com",
  ]);
});
