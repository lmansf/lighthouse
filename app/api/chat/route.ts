/** Chat endpoint: retrieve from the included set, then stream a grounded answer
 *  as newline-delimited ChatChunk JSON (the final line carries references). */
import type { ChatChunk } from "@/contracts";
import { retrieve } from "@/server/vault";
import { streamAnswer } from "@/server/llm";
import { modelConfig } from "@/server/profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const question = typeof body.question === "string" ? body.question : "";
  const includedFileIds = Array.isArray(body.includedFileIds) ? body.includedFileIds : [];

  const { references, contexts } = retrieve(question, includedFileIds);
  const cfg = modelConfig();

  const encoder = new TextEncoder();
  const line = (c: ChatChunk) => encoder.encode(JSON.stringify(c) + "\n");

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const delta of streamAnswer(question, contexts, cfg)) {
          controller.enqueue(line({ delta, done: false }));
        }
      } catch (err) {
        controller.enqueue(
          line({ delta: `\n\n_(error: ${err instanceof Error ? err.message : "unknown"})_`, done: false }),
        );
      }
      controller.enqueue(line({ delta: "", references, done: true }));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
}
