import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { RagTransport } = await import("../src/contracts/real/ragTransport.ts");

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test("RagTransport owns the stable RAG HTTP contract", async () => {
  const calls = [];
  const transport = new RagTransport(async (input, init) => {
    calls.push({ input, init });
    // The engines still answer the vault-era `sources`/`nodes` keys as empty
    // arrays so an older client parses cleanly; the transport reads neither.
    return response(200, { sources: [], nodes: [], desktop: true, platform: "ios" });
  });

  assert.deepEqual(await transport.getCapabilities(), { desktop: true, platform: "ios" });
  assert.deepEqual(calls, [{ input: "/api/rag", init: { cache: "no-store" } }]);
});

test("RagTransport centralizes POST serialization and preserves inline errors", async () => {
  const calls = [];
  const transport = new RagTransport(async (input, init) => {
    calls.push({ input, init });
    return response(400, { error: "invalid rule" });
  });

  const result = await transport.postResult({ op: "exportChat", title: "x" });
  assert.deepEqual(result, { ok: false, status: 400, body: { error: "invalid rule" } });
  await assert.rejects(() => transport.post({ op: "exportChat", title: "x" }), /POST \/api\/rag 400/);
  assert.deepEqual(calls[0], {
    input: "/api/rag",
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"op":"exportChat","title":"x"}',
    },
  });
});
