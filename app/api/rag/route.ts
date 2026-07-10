/** RAG read/curate endpoint: list the tree, toggle inclusion, move nodes, run retrieval. */
import { NextResponse } from "next/server";
import {
  listSources,
  listNodes,
  setIncluded,
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
      // PARITY: the SQL engine (DataFusion) lives in the desktop engine only;
      // the dev server never takes the analytics branch, so there is nothing
      // to re-execute here. The UI surfaces this as the dialog's error state.
      return NextResponse.json({
        error: "analytics queries run in the desktop engine — this dev server can't execute SQL",
      });

    default:
      return NextResponse.json({ error: "unknown op" }, { status: 400 });
  }
}
