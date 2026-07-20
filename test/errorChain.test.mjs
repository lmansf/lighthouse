/**
 * §4 (iOS field patch 1) pin: transport errors surface their FULL cause
 * chain. Node's fetch rejects with a bare "fetch failed" whose real cause
 * (DNS, connect refused, a TLS trust failure) hangs off `err.cause` — the ask
 * note and the Settings key test must show that layer, or a broken network
 * path reads as a mystery. KEEP IN SYNC with the Rust pin
 * llm.rs::error_chain_walks_sources_and_skips_echoes.
 *
 * Run: `node --test test/errorChain.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { errorChain } = await import("../src/server/llm.ts");

test("errorChain walks the cause chain (the fetch-failed shape)", () => {
  const err = new Error("fetch failed", {
    cause: new Error("unable to verify the first certificate"),
  });
  assert.equal(errorChain(err), "fetch failed: unable to verify the first certificate");
});

test("errorChain skips echo layers and survives non-Error causes", () => {
  // A wrapper that already includes its cause's text adds no duplicate line.
  const echo = new Error("connect failed: connection refused", {
    cause: new Error("connection refused"),
  });
  assert.equal(errorChain(echo), "connect failed: connection refused");
  // Non-Error causes stringify; non-Error throwables don't crash the formatter.
  const stringCause = new Error("request aborted", { cause: "timeout at 10s" });
  assert.equal(errorChain(stringCause), "request aborted: timeout at 10s");
  assert.equal(errorChain("boom"), "boom");
  assert.equal(errorChain(undefined), "error");
});
