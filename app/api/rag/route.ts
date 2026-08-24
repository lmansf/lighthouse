/**
 * The app's read/act endpoint. Since 0.15.0 there is no tree to list and no
 * inclusion to toggle — the corpus is a conversation's attachments — so what
 * remains is retrieval, the file inspector, the analytics/meta ops the Rust
 * engine answers, and the read-only snapshots.
 */
import { NextResponse } from "next/server";
import { retrieve } from "@/server/workspace";
import { inspect } from "@/server/inspect";
import { isSameOrigin } from "@/server/http";
import { isDesktopApp, platformKind } from "@/server/config";
import { readDesktopSettings, writeDesktopSettings } from "@/server/settings";
import { policySnapshot } from "@/server/policy";
import { egressSnapshot } from "@/server/egress";
import { recentAudit, verifyActiveAudit, exportCsvAudit } from "@/server/audit";
import { modelConfig } from "@/server/profile";
import { isCloudProvider } from "@/server/synth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // 0.15.0: there is no tree. The payload keeps its SHAPE (clients read
  // `desktop`/`platform` off it) with empty lists where the vault's sources and
  // nodes used to be. PARITY: rag_get in routes.rs / rag_list in commands.rs.
  return NextResponse.json({
    sources: [],
    nodes: [],
    desktop: isDesktopApp(),
    platform: platformKind(),
  });
}

export async function POST(req: Request) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  switch (body.op) {
    case "search": {
      const query = typeof body.query === "string" ? body.query : "";
      const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
      const ids = Array.isArray(body.attachmentFileIds) ? body.attachmentFileIds : [];
      const { references } = await retrieve(conversationId, query, ids);
      return NextResponse.json({ references });
    }

    // Read-only per-file inspector ("What the AI sees", openspec:
    // add-file-inspector): what the engine extracted/chunked/indexed for one
    // file, plus an optional file-scoped test-search. PURE READ — no setter.
    // PARITY: the twin's payload omits the Rust-engine-only fields.
    case "inspect": {
      const fileId = typeof body.fileId === "string" ? body.fileId : "";
      if (!fileId) return NextResponse.json({ error: "fileId required" }, { status: 400 });
      const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
      const query = typeof body.query === "string" ? body.query : undefined;
      return NextResponse.json(await inspect(conversationId, fileId, query));
    }

    // The tree ops (move, rename, newFolder, addReference, removeReference,
    // remove, restore) and the curation ops (include, localOnly, rules, source)
    // all went with the vault in 0.15.0. There is no folder to reorganize and
    // no inclusion gate to toggle: a file is attached to a chat, or it is not.

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

    // Recipes (openspec: add-recipes §2). PARITY: applicability derives from the
    // column catalog + DataFusion view resolution, which live in the Rust engine
    // only, so the twin returns [] (an empty gallery/no chips — the same
    // no-tabular-files behavior as suggestedAsks).
    case "applicableRecipes":
      return NextResponse.json({ recipes: [] });

    // PARITY: proactive insights run the cheap detectors as guarded SELECTs
    // through DataFusion (Rust engine only) — this dev twin never takes the
    // analytics branch, so it returns an honest EMPTY scan (no findings, nothing
    // scanned) rather than a fabricated one (openspec: add-quant-depth §5).
    case "insights":
      return NextResponse.json({
        insights: { findings: [], tablesScanned: 0, tablesAvailable: 0 },
      });

    // Deep analysis (openspec: add-deep-analysis §4.1). PARITY: `investigate`
    // runs the recipe battery through DataFusion (Rust engine only) and saves a
    // report — this dev twin never takes the analytics branch, so it is
    // honestly unavailable rather than writing a fabricated report.
    case "investigate":
      return NextResponse.json({
        available: false,
        reason: "deep analysis runs in the Rust engine — this dev server can't execute SQL",
      });

    // The capability map (openspec: add-deep-analysis §4.2). PARITY: it
    // aggregates the column catalog + recipe applicability, which live in the
    // Rust engine only, so the twin returns an EMPTY map (nothing to aggregate)
    // rather than a partial or fabricated one.
    case "capabilityMap":
      return NextResponse.json({
        map: { tables: [], recipes: [], suggestedAsks: [], suggestedInvestigations: [] },
      });

    // PARITY: recipe EXECUTION runs guarded SELECTs through DataFusion (Rust
    // engine only) — this dev twin never takes the analytics branch, so a direct
    // recipes op is honestly unavailable. On the Rust engine execution rides the
    // ask path via the `run-recipe:{id} on {table}` cue; the twin's ask path
    // likewise has no recipe branch.
    case "recipes":
      return NextResponse.json({
        available: false,
        reason: "recipes run in the Rust engine — this dev server can't execute SQL",
      });

    case "exportChat": {
      // Hand the client-composed artifact BACK for the OS save dialog. It used
      // to land in a `Lighthouse Notes/` or `Lighthouse Results/` vault folder;
      // with the vault gone (openspec: refocus-chat-attachments) the app writes
      // nothing on its own. The ext allowlist stays — it is the app's, never
      // the client's. PARITY: routes.rs / commands.rs "exportChat".
      const title = typeof body.title === "string" && body.title.trim() ? body.title : "Chat";
      const markdown = typeof body.markdown === "string" ? body.markdown : "";
      if (!markdown.trim()) {
        return NextResponse.json({ error: "markdown required" }, { status: 400 });
      }
      const ext = body.ext === undefined ? "md" : body.ext;
      if (ext !== "md" && ext !== "html") {
        return NextResponse.json({ error: 'ext must be "md" or "html"' }, { status: 400 });
      }
      return NextResponse.json({ savedName: `${title}.${ext}`, content: markdown });
    }

    // The G6 conversation-note auto-export and its purge lived here. Both wrote
    // INDEXED vault notes — a chat became a retrievable file so later asks could
    // recall it — which only means anything with a vault to index into. Chat
    // history is UI state again (0.15.0).

    // Provider sign-in (0.12.1 §3). PARITY: the RFC 8628 device flow lives in
    // the desktop engine only (native provider_auth.rs — itself inert until a
    // maintainer registers with a vendor and configures the four
    // LIGHTHOUSE_SIGNIN_* identifiers); this dev twin never dials an auth
    // host, so every action answers the fail-closed stub. `status` is
    // honest-empty (available:false + the persisted method) so the UI's gate
    // reads the same shape it would from the engine, and `setMethod "key"`
    // mirrors the settings write (restoring the default is always safe);
    // "signin" is refused like the flow it would arm.
    case "providerAuth": {
      if (body.action === "status") {
        return NextResponse.json({
          available: false,
          signedIn: false,
          method: readDesktopSettings().openaiAuthMethod === "signin" ? "signin" : "key",
          reason: "sign-in runs in the desktop app",
        });
      }
      if (body.action === "setMethod" && body.method === "key") {
        writeDesktopSettings({ openaiAuthMethod: "key" });
        return NextResponse.json({ ok: true, method: "key" });
      }
      return NextResponse.json({
        available: false,
        reason: "sign-in runs in the desktop app",
      });
    }

    // Read-only managed-policy snapshot; the UI renders its locks as "Managed by your organization".
    case "policy":
      return NextResponse.json(policySnapshot());

    // Session egress snapshot (S3); the header shield renders "All local" / "N to <host>".
    case "egress":
      return NextResponse.json(egressSnapshot());

    // Local audit log (openspec: add-audit-log). List/verify are read-only;
    // export RETURNS a CSV for the OS save dialog, exactly as exportChat does.
    // The twin has no HMAC chain, so verify always reports intact.
    case "auditList": {
      const limit = typeof body.limit === "number" ? body.limit : 100;
      return NextResponse.json(recentAudit(limit));
    }

    case "auditVerify":
      return NextResponse.json(verifyActiveAudit());

    case "auditExport":
      return NextResponse.json({ savedName: "Audit Log.csv", content: exportCsvAudit() });

    default:
      return NextResponse.json({ error: "unknown op" }, { status: 400 });
  }
}
