/** RAG read/curate endpoint: list the tree, toggle inclusion, run retrieval. */
import { NextResponse } from "next/server";
import {
  listSources,
  listNodes,
  setIncluded,
  setSourceAvailable,
  retrieve,
} from "@/server/vault";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ sources: listSources(), nodes: listNodes() });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  switch (body.op) {
    case "include":
      if (typeof body.nodeId !== "string" || typeof body.included !== "boolean") {
        return NextResponse.json({ error: "nodeId and included required" }, { status: 400 });
      }
      setIncluded(body.nodeId, body.included);
      return NextResponse.json({ ok: true });

    case "source":
      if (typeof body.available !== "boolean") {
        return NextResponse.json({ error: "available required" }, { status: 400 });
      }
      setSourceAvailable(body.available);
      return NextResponse.json({ ok: true });

    case "search": {
      const query = typeof body.query === "string" ? body.query : "";
      const ids = Array.isArray(body.includedFileIds) ? body.includedFileIds : [];
      return NextResponse.json({ references: retrieve(query, ids).references });
    }

    default:
      return NextResponse.json({ error: "unknown op" }, { status: 400 });
  }
}
