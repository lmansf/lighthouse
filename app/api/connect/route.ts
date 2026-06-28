/**
 * SharePoint / Microsoft connection endpoint.
 *
 * Drives the device-code sign-in and connector lifecycle:
 *   start   → begin device-code sign-in (returns the code + URL to show)
 *   poll    → poll once for completion; on success, refresh the file listing
 *   status  → current connection state for the UI
 *   refresh → re-fetch the SharePoint placeholder tree
 *   disconnect → sign out and drop tokens + mirrored content
 */
import { NextResponse } from "next/server";
import { isSameOrigin } from "@/server/http";
import {
  startDeviceCode,
  pollDeviceCode,
  disconnect,
  isConnected,
  loadState,
} from "@/server/sources/microsoft/auth";
import { refreshListing } from "@/server/sources/sharepoint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusPayload() {
  const s = loadState();
  return {
    connected: isConnected(),
    account: s.account ?? null,
    available: s.available ?? true,
    nodeCount: s.nodes?.length ?? 0,
    pending: Boolean(s.pending),
  };
}

export async function POST(req: Request) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  try {
    switch (body.op) {
      case "status":
        return NextResponse.json(statusPayload());

      case "start": {
        const flow = await startDeviceCode();
        return NextResponse.json(flow);
      }

      case "poll": {
        const result = await pollDeviceCode();
        // On first success, populate the placeholder tree so files appear.
        if (result.status === "connected") {
          try {
            await refreshListing();
          } catch {
            // listing can be retried via "refresh"; connection still succeeded
          }
        }
        return NextResponse.json({ ...result, ...statusPayload() });
      }

      case "refresh": {
        if (!isConnected()) {
          return NextResponse.json({ error: "not connected" }, { status: 400 });
        }
        const nodeCount = await refreshListing();
        return NextResponse.json({ ok: true, nodeCount });
      }

      case "disconnect":
        disconnect();
        return NextResponse.json({ ok: true });

      default:
        return NextResponse.json({ error: "unknown op" }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "connection error" },
      { status: 500 },
    );
  }
}
