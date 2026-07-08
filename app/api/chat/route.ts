/** Chat endpoint: the full answer pipeline (single-shot RAG or multi-document
 *  synthesis — see docs/multi-doc-synthesis.md) streamed as newline-delimited
 *  ChatChunk JSON. Progress chunks precede the answer; the final line carries
 *  references. */
import type { ChatChunk, ChatTurn } from "@/contracts";
import { answerPipeline } from "@/server/synth";
import { modelConfig } from "@/server/profile";
import { isSameOrigin } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isSameOrigin(req)) {
    return new Response(JSON.stringify({ error: "cross-origin request rejected" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }
  const body = await req.json().catch(() => ({}));
  const question = typeof body.question === "string" ? body.question : "";
  const includedFileIds = Array.isArray(body.includedFileIds) ? body.includedFileIds : [];
  // Files the user explicitly attached to this question (dragged from the
  // explorer, or dropped from the OS onto chat). When present, retrieval is
  // scoped to just these files — see retrieve()/vaultRetrieve.
  const attachmentFileIds: string[] = Array.isArray(body.attachmentFileIds)
    ? body.attachmentFileIds.filter((id: unknown): id is string => typeof id === "string")
    : [];
  // Prior turns (sanitized) so follow-ups have conversational context.
  const history: ChatTurn[] = Array.isArray(body.history)
    ? body.history
        .filter(
          (t: unknown): t is ChatTurn =>
            !!t &&
            typeof (t as ChatTurn).content === "string" &&
            ((t as ChatTurn).role === "user" || (t as ChatTurn).role === "assistant"),
        )
        .slice(-8) // cap context: last few turns are enough and bound token cost
    : [];

  const cfg = modelConfig();

  const encoder = new TextEncoder();
  const line = (c: ChatChunk) => encoder.encode(JSON.stringify(c) + "\n");

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of answerPipeline(
          question,
          includedFileIds,
          attachmentFileIds,
          history,
          cfg,
        )) {
          controller.enqueue(line(chunk));
        }
      } catch (err) {
        controller.enqueue(
          line({ delta: `\n\n_(error: ${err instanceof Error ? err.message : "unknown"})_`, done: false }),
        );
        controller.enqueue(line({ delta: "", references: [], done: true }));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
}
