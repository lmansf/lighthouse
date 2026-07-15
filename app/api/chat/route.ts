/** Chat endpoint: the full answer pipeline (single-shot RAG or multi-document
 *  synthesis — see docs/multi-doc-synthesis.md) streamed as newline-delimited
 *  ChatChunk JSON. Progress chunks precede the answer; the final line carries
 *  references. */
import type { ChatChunk, ChatTurn } from "@/contracts";
import { answerPipeline } from "@/server/synth";
import { modelConfig } from "@/server/profile";
import { isSameOrigin } from "@/server/http";
import { beginAudit, finishAudit } from "@/server/audit";

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
  // Answer cache controls (openspec: add-answer-cache): Re-run's lookup
  // bypass, and the client's per-request persistence verdict. Both default
  // false — an absent field fails toward privacy (memory-only cache).
  const bypassCache = body.bypassCache === true;
  const persistAllowed = body.persistAllowed === true;
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

  // Audit choke point (openspec: add-audit-log): snapshot the egress baseline
  // before the answer, then record what this question read + which hosts it
  // dialed once the final chunk lands. PARITY: chat_post in routes.rs.
  const egressBefore = beginAudit();
  const provider = cfg.providerId ?? "none";

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let finalFiles: string[] = [];
      let artifacts: string[] = [];
      try {
        for await (const chunk of answerPipeline(
          question,
          includedFileIds,
          attachmentFileIds,
          history,
          cfg,
          { bypassCache, persistAllowed },
        )) {
          if (chunk.done) {
            if (chunk.references) finalFiles = chunk.references.map((r) => r.fileId);
            if (chunk.analytics?.fileIds) artifacts = chunk.analytics.fileIds;
          }
          controller.enqueue(line(chunk));
        }
        // Best-effort, after the user has the answer; no-op when logging is off.
        finishAudit(egressBefore, { question, provider, fileIds: finalFiles, artifacts });
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
