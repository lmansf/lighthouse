/** RAG read/curate endpoint: list the tree, toggle inclusion, move nodes, run retrieval. */
import { NextResponse } from "next/server";
import {
  listSources,
  listNodes,
  setIncluded,
  setLocalOnly,
  setSourceAvailable,
  retrieve,
  inspect,
  moveNode,
  renameNode,
  createFolder,
  addReference,
  addRule,
  removeReference,
  removeFromVault,
  removeRule,
  restoreFromVault,
  rulesListing,
} from "@/server/sources/registry";
import { isSameOrigin } from "@/server/http";
import { isDesktopApp, platformKind } from "@/server/config";
import { readDesktopSettings, writeDesktopSettings } from "@/server/settings";
import { policySnapshot } from "@/server/policy";
import { egressSnapshot } from "@/server/egress";
import { recentAudit, verifyActiveAudit, exportCsvAudit } from "@/server/audit";
import {
  writeArtifact,
  refreshArtifact,
  writeConversationNote,
  purgeConversationNotes,
} from "@/server/vault";
import { modelConfig } from "@/server/profile";
import { isCloudProvider } from "@/server/synth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [sources, nodes] = await Promise.all([listSources(), listNodes()]);
  // PARITY: mirrors rag_list (commands.rs). `platform` is the §1 form-factor
  // signal (config.ts platformKind — constant "desktop" on the twin, while
  // the Rust shell reports its compile target).
  return NextResponse.json({ sources, nodes, desktop: isDesktopApp(), platform: platformKind() });
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

    // Bulk curation rules (openspec: add-curation-rules): a per-folder
    // predicate layer resolved live at walk time — never per-node writes.
    // `add` validates (predicate/action whitelists, glob parse) → 400 with
    // the reason; ids are minted engine-side. PARITY: routes.rs / commands.rs
    // mirror this op exactly.
    case "rules": {
      if (body.action === "list") {
        return NextResponse.json({ rules: await rulesListing() });
      }
      if (body.action === "add") {
        const r = (body.rule ?? {}) as Record<string, unknown>;
        try {
          const rule = await addRule({
            scope: typeof r.scope === "string" ? r.scope : "",
            ...(typeof r.kind === "string" ? { kind: r.kind } : {}),
            ...(Array.isArray(r.ext)
              ? { ext: r.ext.filter((x: unknown): x is string => typeof x === "string") }
              : {}),
            ...(typeof r.glob === "string" ? { glob: r.glob } : {}),
            action: typeof r.action === "string" ? r.action : "",
          });
          return NextResponse.json({ rule });
        } catch (err) {
          return NextResponse.json(
            { error: err instanceof Error ? err.message : "could not add the rule" },
            { status: 400 },
          );
        }
      }
      if (body.action === "remove") {
        if (typeof body.id !== "string" || !body.id) {
          return NextResponse.json({ error: "id required" }, { status: 400 });
        }
        await removeRule(body.id);
        return NextResponse.json({ ok: true });
      }
      return NextResponse.json(
        { error: "rules action must be list, add, or remove" },
        { status: 400 },
      );
    }

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

    // Read-only per-file inspector ("What the AI sees", openspec:
    // add-file-inspector): what the engine extracted/chunked/indexed for one
    // file, plus an optional file-scoped test-search. PURE READ — no setter.
    // PARITY: the twin's payload omits the Rust-engine-only fields.
    case "inspect": {
      const fileId = typeof body.fileId === "string" ? body.fileId : "";
      if (!fileId) return NextResponse.json({ error: "fileId required" }, { status: 400 });
      const query = typeof body.query === "string" ? body.query : undefined;
      return NextResponse.json(await inspect(fileId, query));
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
    // runs the recipe battery through DataFusion (Rust engine only) and writes an
    // in-vault report — this dev twin never takes the analytics branch, so it is
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
      // Write a client-composed artifact into the vault (openspec:
      // add-answer-artifacts). Default: the chat transcript as a markdown
      // note into Lighthouse Notes/. Optional subdir/ext route the analytics
      // evidence pack (self-contained HTML into Lighthouse Results/) through
      // the SAME sanitized writeArtifact path — STRICT allowlist, the client
      // never names arbitrary folders or extensions. Implemented in BOTH
      // engines (PARITY: routes.rs / commands.rs "exportChat").
      const title = typeof body.title === "string" && body.title.trim() ? body.title : "Chat";
      const markdown = typeof body.markdown === "string" ? body.markdown : "";
      if (!markdown.trim()) {
        return NextResponse.json({ error: "markdown required" }, { status: 400 });
      }
      const subdir = body.subdir === undefined ? "Lighthouse Notes" : body.subdir;
      if (subdir !== "Lighthouse Notes" && subdir !== "Lighthouse Results") {
        return NextResponse.json(
          { error: 'subdir must be "Lighthouse Notes" or "Lighthouse Results"' },
          { status: 400 },
        );
      }
      const ext = body.ext === undefined ? "md" : body.ext;
      if (ext !== "md" && ext !== "html") {
        return NextResponse.json({ error: 'ext must be "md" or "html"' }, { status: 400 });
      }
      try {
        const { id, name } = writeArtifact(subdir, title, ext, Buffer.from(markdown, "utf8"));
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
