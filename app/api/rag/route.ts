/** RAG read/curate endpoint: list the tree, toggle inclusion, move nodes, run retrieval. */
import { NextResponse } from "next/server";
import {
  listSources,
  listNodes,
  setIncluded,
  setLocalOnly,
  setSourceAvailable,
  retrieve,
  moveNode,
  renameNode,
  createFolder,
  addReference,
  removeReference,
  removeFromVault,
  restoreFromVault,
} from "@/server/sources/registry";
import { isSameOrigin } from "@/server/http";
import { isDesktopApp } from "@/server/config";
import { policySnapshot } from "@/server/policy";
import { egressSnapshot } from "@/server/egress";
import { recentAudit, verifyActiveAudit, exportCsvAudit } from "@/server/audit";
import {
  writeArtifact,
  refreshArtifact,
  writeConversationNote,
  purgeConversationNotes,
} from "@/server/vault";
import { addPin, listPins, removePin } from "@/server/pins";
import {
  addBriefing,
  listBriefings,
  removeBriefing,
  runBriefing,
  composeBriefingNote,
} from "@/server/briefings";
import type { Cadence } from "@/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [sources, nodes] = await Promise.all([listSources(), listNodes()]);
  return NextResponse.json({ sources, nodes, desktop: isDesktopApp() });
}

export async function POST(req: Request) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  switch (body.op) {
    case "include":
      if (typeof body.nodeId !== "string" || typeof body.included !== "boolean") {
        return NextResponse.json({ error: "nodeId and included required" }, { status: 400 });
      }
      await setIncluded(body.nodeId, body.included);
      return NextResponse.json({ ok: true });

    // "Private — this device only": a per-node mark the engine enforces by
    // withholding the node from anything a cloud provider would receive.
    case "localOnly":
      if (typeof body.nodeId !== "string" || typeof body.localOnly !== "boolean") {
        return NextResponse.json({ error: "nodeId and localOnly required" }, { status: 400 });
      }
      await setLocalOnly(body.nodeId, body.localOnly);
      return NextResponse.json({ ok: true });

    case "source":
      if (typeof body.available !== "boolean") {
        return NextResponse.json({ error: "available required" }, { status: 400 });
      }
      await setSourceAvailable(
        body.available,
        typeof body.sourceId === "string" ? body.sourceId : undefined,
      );
      return NextResponse.json({ ok: true });

    case "search": {
      const query = typeof body.query === "string" ? body.query : "";
      const ids = Array.isArray(body.includedFileIds) ? body.includedFileIds : [];
      return NextResponse.json({ references: (await retrieve(query, ids)).references });
    }

    case "move": {
      if (typeof body.from !== "string") {
        return NextResponse.json({ error: "from required" }, { status: 400 });
      }
      const toParentId = typeof body.toParentId === "string" ? body.toParentId : null;
      try {
        return NextResponse.json(await moveNode(body.from, toParentId));
      } catch (err) {
        return NextResponse.json(
          { error: err instanceof Error ? err.message : "move failed" },
          { status: 400 },
        );
      }
    }

    case "rename": {
      if (typeof body.id !== "string" || typeof body.name !== "string") {
        return NextResponse.json({ error: "id and name required" }, { status: 400 });
      }
      try {
        return NextResponse.json(await renameNode(body.id, body.name));
      } catch (err) {
        return NextResponse.json(
          { error: err instanceof Error ? err.message : "rename failed" },
          { status: 400 },
        );
      }
    }

    case "newFolder": {
      if (typeof body.name !== "string") {
        return NextResponse.json({ error: "name required" }, { status: 400 });
      }
      try {
        const parentId = typeof body.parentId === "string" ? body.parentId : null;
        return NextResponse.json(await createFolder(parentId, body.name));
      } catch (err) {
        return NextResponse.json(
          { error: err instanceof Error ? err.message : "could not create folder" },
          { status: 400 },
        );
      }
    }

    case "addReference": {
      if (!isDesktopApp()) {
        return NextResponse.json(
          { error: "linking files is available only in the desktop app" },
          { status: 403 },
        );
      }
      if (typeof body.path !== "string" || !body.path.trim()) {
        return NextResponse.json({ error: "path required" }, { status: 400 });
      }
      try {
        return NextResponse.json(await addReference(body.path));
      } catch (err) {
        return NextResponse.json(
          { error: err instanceof Error ? err.message : "link failed" },
          { status: 400 },
        );
      }
    }

    case "removeReference":
      if (typeof body.refId !== "string") {
        return NextResponse.json({ error: "refId required" }, { status: 400 });
      }
      await removeReference(body.refId);
      return NextResponse.json({ ok: true });

    case "remove": {
      // Remove a node from the vault (non-destructive: links unlink, vault items
      // move to a recoverable trash). Returns a restore token so the client can
      // offer Undo.
      if (typeof body.nodeId !== "string" || !body.nodeId.trim()) {
        return NextResponse.json({ error: "nodeId required" }, { status: 400 });
      }
      try {
        const restore = await removeFromVault(body.nodeId);
        return NextResponse.json({ ok: true, restore });
      } catch (err) {
        return NextResponse.json(
          { error: err instanceof Error ? err.message : "remove failed" },
          { status: 400 },
        );
      }
    }

    case "restore": {
      // Undo a previous remove from the token it returned.
      if (!body.token || typeof body.token !== "object") {
        return NextResponse.json({ error: "token required" }, { status: 400 });
      }
      try {
        return NextResponse.json(await restoreFromVault(body.token));
      } catch (err) {
        return NextResponse.json(
          { error: err instanceof Error ? err.message : "restore failed" },
          { status: 400 },
        );
      }
    }

    case "analyticsSql":
      // PARITY: the SQL engine (DataFusion) lives in the Rust engine only
      // (desktop app + headless lighthouse-server); this dev twin never takes
      // the analytics branch, so there is nothing to re-execute here. The UI
      // surfaces this as the dialog's error state.
      return NextResponse.json({
        error: "analytics queries run in the Rust engine — this dev server can't execute SQL",
      });

    case "suggestedAsks":
      // PARITY: suggestions derive from the column catalog, which lives in
      // the Rust engine only. Empty means the chat keeps its static
      // empty-state hint — exactly the no-tabular-files behavior.
      return NextResponse.json({ asks: [] });

    // --- Pinned questions (openspec: add-pinned-questions). PARITY: rechecks
    //     re-run SQL through DataFusion (Rust engine only) — this dev
    //     server does CRUD and reports "no changes" on recheck, so pinned
    //     summaries simply stay as of pin time.
    case "pinAsk": {
      const question = typeof body.question === "string" ? body.question : "";
      const sql = typeof body.sql === "string" ? body.sql : "";
      const fileIds = Array.isArray(body.fileIds)
        ? body.fileIds.filter((x: unknown): x is string => typeof x === "string")
        : [];
      try {
        return NextResponse.json({ pin: addPin(question, sql, fileIds) });
      } catch (err) {
        return NextResponse.json({
          error: err instanceof Error ? err.message : "could not pin",
        });
      }
    }

    case "unpinAsk":
      if (typeof body.id !== "string" || !body.id) {
        return NextResponse.json({ error: "id required" }, { status: 400 });
      }
      removePin(body.id);
      return NextResponse.json({ ok: true });

    case "listPins":
      return NextResponse.json({ pins: listPins() });

    case "recheckPins":
      return NextResponse.json({ changed: [], pins: listPins() });

    case "listBriefings":
      return NextResponse.json({ briefings: listBriefings() });

    case "saveBriefing": {
      const title = typeof body.title === "string" ? body.title : "";
      const pinIds = Array.isArray(body.pinIds)
        ? body.pinIds.filter((x: unknown): x is string => typeof x === "string")
        : [];
      const cadence: Cadence =
        body.cadence === "daily" || body.cadence === "weekly" ? body.cadence : "manual";
      try {
        return NextResponse.json({ briefing: addBriefing(title, pinIds, cadence) });
      } catch (err) {
        return NextResponse.json({
          error: err instanceof Error ? err.message : "could not save briefing",
        });
      }
    }

    case "removeBriefing":
      if (typeof body.id !== "string" || !body.id) {
        return NextResponse.json({ error: "id required" }, { status: 400 });
      }
      removeBriefing(body.id);
      return NextResponse.json({ ok: true });

    case "runBriefing":
      if (typeof body.id !== "string" || !body.id) {
        return NextResponse.json({ error: "id required" }, { status: 400 });
      }
      return NextResponse.json({ report: runBriefing(body.id) ?? undefined });

    case "exportChat": {
      // Write the client-rendered transcript as a markdown note into
      // Lighthouse Notes/ (openspec: add-answer-artifacts). Implemented in
      // BOTH engines — writing a vault file needs no desktop machinery.
      const title = typeof body.title === "string" && body.title.trim() ? body.title : "Chat";
      const markdown = typeof body.markdown === "string" ? body.markdown : "";
      if (!markdown.trim()) {
        return NextResponse.json({ error: "markdown required" }, { status: 400 });
      }
      try {
        const { id, name } = writeArtifact("Lighthouse Notes", title, "md", Buffer.from(markdown, "utf8"));
        return NextResponse.json({ savedId: id, savedName: name });
      } catch (err) {
        return NextResponse.json({
          error: err instanceof Error ? err.message : "could not write the note",
        });
      }
    }

    // G6: auto-export a chat as an indexed vault note, OVERWRITTEN in place per
    // conversation id (one current note per chat). Client-gated on "Save chats
    // on this device". KEEP IN SYNC with the desktop/server ops.
    case "exportConversationNote": {
      const conversationId =
        typeof body.conversationId === "string" ? body.conversationId : "";
      const title =
        typeof body.title === "string" && body.title.trim() ? body.title : "Conversation";
      const markdown = typeof body.markdown === "string" ? body.markdown : "";
      if (!conversationId.trim() || !markdown.trim()) {
        return NextResponse.json(
          { error: "conversationId and markdown required" },
          { status: 400 },
        );
      }
      try {
        const { id, name } = writeConversationNote(
          conversationId,
          title,
          Buffer.from(markdown, "utf8"),
        );
        return NextResponse.json({ savedId: id, savedName: name });
      } catch (err) {
        return NextResponse.json({
          error: err instanceof Error ? err.message : "could not write the conversation note",
        });
      }
    }

    // G6 fail-closed opt-out: delete every auto-exported chat note.
    case "purgeConversationNotes":
      try {
        purgeConversationNotes();
        return NextResponse.json({ ok: true });
      } catch (err) {
        return NextResponse.json({
          error: err instanceof Error ? err.message : "could not purge conversation notes",
        });
      }

    // G5: refresh the briefing note on demand. PARITY: the desktop engine
    // rechecks each pin's SQL for a real before→after; the web dev twin can't
    // run DataFusion, so it composes from each pin's last known summary (no
    // `before`). The composer + refreshArtifact writer are byte-identical.
    case "refreshBriefingNote": {
      try {
        const changed = listPins()
          .filter((p) => p.lastSummary)
          .map((p) => ({ question: p.question, after: p.lastSummary as string }));
        const md = composeBriefingNote(changed, Date.now());
        const { id, name } = refreshArtifact(
          "Lighthouse Notes",
          "Lighthouse Briefing",
          "md",
          Buffer.from(md, "utf8"),
        );
        return NextResponse.json({ savedId: id, savedName: name });
      } catch (err) {
        return NextResponse.json({
          error: err instanceof Error ? err.message : "could not write the briefing note",
        });
      }
    }

    // Read-only managed-policy snapshot; the UI renders its locks as "Managed by your organization".
    case "policy":
      return NextResponse.json(policySnapshot());

    // Session egress snapshot (S3); the header shield renders "All local" / "N to <host>".
    case "egress":
      return NextResponse.json(egressSnapshot());

    // Local audit log (openspec: add-audit-log). List/verify are read-only;
    // export writes a CSV into the vault via the same writeArtifact helper as
    // exportChat. The twin has no HMAC chain, so verify always reports intact.
    case "auditList": {
      const limit = typeof body.limit === "number" ? body.limit : 100;
      return NextResponse.json(recentAudit(limit));
    }

    case "auditVerify":
      return NextResponse.json(verifyActiveAudit());

    case "auditExport":
      try {
        const { id, name } = writeArtifact(
          "Lighthouse Notes",
          "Audit Log",
          "csv",
          Buffer.from(exportCsvAudit(), "utf8"),
        );
        return NextResponse.json({ savedId: id, savedName: name });
      } catch (err) {
        return NextResponse.json({
          error: err instanceof Error ? err.message : "could not write the audit log",
        });
      }

    default:
      return NextResponse.json({ error: "unknown op" }, { status: 400 });
  }
}
