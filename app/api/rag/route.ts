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
import { isDesktopApp } from "@/server/config";
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
import { addPin, listPins, removePin } from "@/server/pins";
import {
  addInvestigationConversationRef,
  createInvestigation,
  exportMarkdown,
  forkInvestigation,
  investigationNotesSubdir,
  investigationView,
  investigationsListing,
  renameInvestigation,
  setInvestigationArchived,
} from "@/server/investigations";
import {
  createBoard,
  deleteBoard,
  listBoards,
  parseBoardCards,
  refreshBoardCards,
  renameBoard,
  setBoardCards,
} from "@/server/boards";
import {
  addBriefing,
  listBriefings,
  removeBriefing,
  runBriefing,
  composeBriefingNote,
} from "@/server/briefings";
import {
  createView,
  deleteView,
  dependentsOf,
  inspectView,
  listViews,
  renameView,
  transitiveDependents,
} from "@/server/views";
import {
  applicableSemantics,
  createMetric,
  createSynonym,
  deleteMetric,
  deleteSynonym,
  renameMetric,
} from "@/server/semantic";
import { modelConfig } from "@/server/profile";
import { isCloudProvider } from "@/server/synth";
import type { Cadence } from "@/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [sources, nodes] = await Promise.all([listSources(), listNodes()]);
  // PARITY: mirrors rag_list (commands.rs). `platform` is the §1 form-factor
  // signal; the TS twin only ever runs in the web dev flow on a computer, so
  // it is constant "desktop" here while the Rust shell reports its target_os.
  return NextResponse.json({ sources, nodes, desktop: isDesktopApp(), platform: "desktop" });
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

    // Investigations (openspec: add-investigations): named, durable
    // containers for analysis. CRUD on the vault-scoped STRUCTURE store —
    // ids are minted engine-side and validation failures → 400 with the
    // engine's reason, like rules. Conversation-ref writes are gated
    // engine-side: the client's persistAllowed verdict AND the managed
    // history policy must both allow (either false ⇒ silent no-op). PARITY:
    // routes.rs / commands.rs mirror this op exactly.
    case "investigations": {
      if (body.action === "list") {
        return NextResponse.json({ investigations: investigationsListing() });
      }
      if (body.action === "create") {
        const providerPolicy =
          body.providerPolicy === undefined || body.providerPolicy === null
            ? "default"
            : body.providerPolicy;
        if (providerPolicy !== "default" && providerPolicy !== "local-only") {
          return NextResponse.json(
            { error: 'providerPolicy must be "default" or "local-only"' },
            { status: 400 },
          );
        }
        const scopeFileIds = Array.isArray(body.scopeFileIds)
          ? body.scopeFileIds.filter((x: unknown): x is string => typeof x === "string")
          : [];
        try {
          const investigation = createInvestigation(
            typeof body.name === "string" ? body.name : "",
            scopeFileIds,
            providerPolicy,
          );
          return NextResponse.json({ investigation: investigationView(investigation) });
        } catch (err) {
          return NextResponse.json(
            { error: err instanceof Error ? err.message : "could not create the investigation" },
            { status: 400 },
          );
        }
      }
      if (body.action === "rename") {
        if (typeof body.id !== "string" || !body.id) {
          return NextResponse.json({ error: "id required" }, { status: 400 });
        }
        try {
          const investigation = renameInvestigation(
            body.id,
            typeof body.name === "string" ? body.name : "",
          );
          return NextResponse.json({ investigation: investigationView(investigation) });
        } catch (err) {
          return NextResponse.json(
            { error: err instanceof Error ? err.message : "could not rename the investigation" },
            { status: 400 },
          );
        }
      }
      if (body.action === "setArchived") {
        if (typeof body.id !== "string" || !body.id || typeof body.archived !== "boolean") {
          return NextResponse.json({ error: "id and archived required" }, { status: 400 });
        }
        try {
          const investigation = setInvestigationArchived(body.id, body.archived);
          return NextResponse.json({ investigation: investigationView(investigation) });
        } catch (err) {
          return NextResponse.json(
            { error: err instanceof Error ? err.message : "could not update the investigation" },
            { status: 400 },
          );
        }
      }
      if (body.action === "addConversationRef") {
        if (
          typeof body.id !== "string" ||
          !body.id ||
          typeof body.conversationId !== "string" ||
          !body.conversationId
        ) {
          return NextResponse.json({ error: "id and conversationId required" }, { status: 400 });
        }
        try {
          // persistAllowed defaults false — an absent field fails toward
          // privacy, exactly like the ask path's cache controls.
          const investigation = addInvestigationConversationRef(
            body.id,
            body.conversationId,
            body.persistAllowed === true,
          );
          return NextResponse.json({ investigation: investigationView(investigation) });
        } catch (err) {
          return NextResponse.json(
            { error: err instanceof Error ? err.message : "could not record the conversation" },
            { status: 400 },
          );
        }
      }
      // Fork a line of inquiry (openspec: add-automation §4): a fresh record
      // copying the parent's STRUCTURE only (scope, policy, conversation
      // refs), engine-minted id, its own empty notes folder, same name rule
      // as create. PARITY: routes.rs / commands.rs mirror this arm.
      if (body.action === "fork") {
        if (typeof body.id !== "string" || !body.id) {
          return NextResponse.json({ error: "id required" }, { status: 400 });
        }
        try {
          const investigation = forkInvestigation(
            body.id,
            typeof body.name === "string" ? body.name : "",
          );
          return NextResponse.json({ investigation: investigationView(investigation) });
        } catch (err) {
          return NextResponse.json(
            { error: err instanceof Error ? err.message : "could not fork the investigation" },
            { status: 400 },
          );
        }
      }
      // Export to an in-vault markdown note (openspec: add-automation §4):
      // render structure + derived membership (references, never transcripts),
      // then WRITE under the investigation's own notes folder via the
      // exportChat precedent (investigationNotesSubdir + writeArtifact — a
      // non-egress, sanitized in-vault write). Render + folder resolution are
      // validation-like (unknown id / unusable folder → 400); the write error
      // comes back as {error} like exportChat. Titles is omitted: the op
      // renders conversation ids.
      if (body.action === "export") {
        if (typeof body.id !== "string" || !body.id) {
          return NextResponse.json({ error: "id required" }, { status: 400 });
        }
        const title =
          typeof body.title === "string" && body.title.trim() ? body.title : "Investigation";
        let markdown: string;
        let subdir: string;
        try {
          markdown = exportMarkdown(body.id);
          subdir = investigationNotesSubdir(body.id);
        } catch (err) {
          return NextResponse.json(
            { error: err instanceof Error ? err.message : "could not export the investigation" },
            { status: 400 },
          );
        }
        try {
          const { id, name } = writeArtifact(subdir, title, "md", Buffer.from(markdown, "utf8"));
          return NextResponse.json({ savedId: id, savedName: name });
        } catch (err) {
          return NextResponse.json({
            error: err instanceof Error ? err.message : "could not write the export",
          });
        }
      }
      return NextResponse.json(
        {
          error:
            "investigations action must be list, create, rename, setArchived, addConversationRef, fork, or export",
        },
        { status: 400 },
      );
    }

    // Boards (openspec: add-boards): pin-backed local dashboards. CRUD on
    // the vault-scoped boards store — engine-minted ids, per-scope name
    // validation, lazy virtual defaults that materialize on first mutation.
    // Validation failures → 400 with the engine's reason, like
    // investigations. PARITY: routes.rs / commands.rs mirror this op;
    // refreshCards HERE answers from stored pin state (live: false) because
    // analytics/DataFusion is Rust-engine-only.
    case "boards": {
      if (body.action === "list") {
        // Optional investigation filter — absent (or blank) is "all", the
        // listPins convention exactly.
        return NextResponse.json({
          boards: listBoards(
            typeof body.investigationId === "string" && body.investigationId
              ? body.investigationId
              : undefined,
          ),
        });
      }
      if (body.action === "create") {
        try {
          const board = createBoard(
            typeof body.name === "string" ? body.name : "",
            typeof body.investigationId === "string" ? body.investigationId : undefined,
          );
          return NextResponse.json({ board });
        } catch (err) {
          return NextResponse.json(
            { error: err instanceof Error ? err.message : "could not create the board" },
            { status: 400 },
          );
        }
      }
      if (body.action === "rename") {
        if (typeof body.id !== "string" || !body.id) {
          return NextResponse.json({ error: "id required" }, { status: 400 });
        }
        try {
          const board = renameBoard(body.id, typeof body.name === "string" ? body.name : "");
          return NextResponse.json({ board });
        } catch (err) {
          return NextResponse.json(
            { error: err instanceof Error ? err.message : "could not rename the board" },
            { status: 400 },
          );
        }
      }
      if (body.action === "delete") {
        if (typeof body.id !== "string" || !body.id) {
          return NextResponse.json({ error: "id required" }, { status: 400 });
        }
        try {
          deleteBoard(body.id);
          return NextResponse.json({ ok: true });
        } catch (err) {
          return NextResponse.json(
            { error: err instanceof Error ? err.message : "could not delete the board" },
            { status: 400 },
          );
        }
      }
      if (body.action === "setCards") {
        if (typeof body.id !== "string" || !body.id) {
          return NextResponse.json({ error: "id required" }, { status: 400 });
        }
        try {
          const board = setBoardCards(body.id, parseBoardCards(body.cards));
          return NextResponse.json({ board });
        } catch (err) {
          return NextResponse.json(
            { error: err instanceof Error ? err.message : "could not update the board" },
            { status: 400 },
          );
        }
      }
      if (body.action === "refreshCards") {
        const pinIds = Array.isArray(body.pinIds)
          ? body.pinIds.filter((x: unknown): x is string => typeof x === "string")
          : [];
        return NextResponse.json({ cards: refreshBoardCards(pinIds) });
      }
      return NextResponse.json(
        { error: "boards action must be list, create, rename, delete, setCards, or refreshCards" },
        { status: 400 },
      );
    }

    // Shaped views (openspec: add-shaped-views §3): CRUD runs FOR REAL against
    // the twin store (src/server/views.ts — same envelope, name rules, and
    // DAG/lifecycle checks as views.rs), plus `dependents`, the name lists the
    // rename/delete dialogs show. The wire carries the summary FLATTENED
    // (summaryText + summarySource); the ViewSummary is built here. Validation
    // failures → 400 with the engine's reason, like boards. PARITY: routes.rs /
    // commands.rs mirror this op exactly.
    case "views": {
      if (body.action === "list") {
        return NextResponse.json({ views: listViews() });
      }
      if (body.action === "create") {
        const raw = body.summarySource;
        const summarySource =
          raw === undefined || raw === null || raw === "question"
            ? "question"
            : raw === "model"
              ? "model"
              : null;
        if (summarySource === null) {
          return NextResponse.json(
            { error: 'summarySource must be "question" or "model"' },
            { status: 400 },
          );
        }
        const fileIds = Array.isArray(body.fileIds)
          ? body.fileIds.filter((x: unknown): x is string => typeof x === "string")
          : [];
        try {
          const view = createView(
            typeof body.name === "string" ? body.name : "",
            typeof body.sql === "string" ? body.sql : "",
            {
              text: typeof body.summaryText === "string" ? body.summaryText : "",
              source: summarySource,
            },
            fileIds,
          );
          return NextResponse.json({ view });
        } catch (err) {
          return NextResponse.json(
            { error: err instanceof Error ? err.message : "could not create the view" },
            { status: 400 },
          );
        }
      }
      if (body.action === "rename") {
        if (typeof body.id !== "string" || !body.id) {
          return NextResponse.json({ error: "id required" }, { status: 400 });
        }
        try {
          const view = renameView(body.id, typeof body.name === "string" ? body.name : "");
          return NextResponse.json({ view });
        } catch (err) {
          return NextResponse.json(
            { error: err instanceof Error ? err.message : "could not rename the view" },
            { status: 400 },
          );
        }
      }
      if (body.action === "delete") {
        if (typeof body.id !== "string" || !body.id) {
          return NextResponse.json({ error: "id required" }, { status: 400 });
        }
        try {
          return NextResponse.json({ deletedIds: deleteView(body.id, body.cascade === true) });
        } catch (err) {
          return NextResponse.json(
            { error: err instanceof Error ? err.message : "could not delete the view" },
            { status: 400 },
          );
        }
      }
      if (body.action === "dependents") {
        if (typeof body.id !== "string" || !body.id) {
          return NextResponse.json({ error: "id required" }, { status: 400 });
        }
        return NextResponse.json({
          dependents: dependentsOf(body.id).map((v) => v.name),
          transitive: transitiveDependents(body.id).map((v) => v.name),
        });
      }
      // Inspector on a view (openspec: add-shaped-views §4): stored-state read
      // that runs FOR REAL against the twin store — definition SQL, labeled
      // summary, transitive source names + saved-age freshness, local-only
      // flag, dependents. No SQL executes, so the shape matches inspect_view.
      if (body.action === "inspect") {
        if (typeof body.id !== "string" || !body.id) {
          return NextResponse.json({ error: "id required" }, { status: 400 });
        }
        return NextResponse.json({ inspection: inspectView(body.id) });
      }
      return NextResponse.json(
        { error: "views action must be list, create, rename, delete, dependents, or inspect" },
        { status: 400 },
      );
    }

    // PARITY: the shaping ask runs the model AND DataFusion (one guarded
    // completion + before/after sampling) — Rust-engine-only, like
    // analyticsSql. This dev twin reports unavailable with an honest reason;
    // the dialog explains instead of pretending. NOTHING is ever persisted by
    // this op on any engine — saving goes through op:"views" create.
    case "shapeView":
      return NextResponse.json({
        available: false,
        reason: "shaping runs in the Rust engine — this dev server can't execute SQL",
      });

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

    // The capability map (openspec: add-deep-analysis §4.2). PARITY: it aggregates
    // the column catalog + recipe/metric applicability, which live in the Rust
    // engine only, so the twin returns an EMPTY map (nothing to aggregate) rather
    // than a partial or fabricated one.
    case "capabilityMap":
      return NextResponse.json({
        map: {
          tables: [],
          recipes: [],
          metrics: [],
          suggestedAsks: [],
          suggestedInvestigations: [],
        },
      });

    // PARITY: recipe EXECUTION runs guarded SELECTs through DataFusion (Rust
    // engine only) — this dev twin never takes the analytics branch, so a direct
    // recipes op is honestly unavailable (the shapeView precedent). On the Rust
    // engine execution rides the ask path via the `run-recipe:{id} on {table}`
    // cue; the twin's ask path likewise has no recipe branch.
    case "recipes":
      return NextResponse.json({
        available: false,
        reason: "recipes run in the Rust engine — this dev server can't execute SQL",
      });

    // Semantic layer (openspec: add-semantic-layer §6.1). PARITY: `list` needs
    // NO analytics (a metric carries its `reads`), so the twin computes the same
    // applicable subset as meta.rs and the create/rename/delete lifecycle runs
    // FOR REAL against the twin store; only op:"defineMetric" below is Rust-only.
    // Refusals ride back as 400 + {error}, shown verbatim (the views op posture).
    case "semantic": {
      if (body.action === "list") {
        const ids = Array.isArray(body.includedFileIds)
          ? body.includedFileIds.filter((x: unknown): x is string => typeof x === "string")
          : [];
        return NextResponse.json({
          semantic: applicableSemantics(ids, isCloudProvider(modelConfig())),
        });
      }
      if (body.action === "create-metric") {
        const raw = body.summarySource;
        const summarySource =
          raw === undefined || raw === null || raw === "question"
            ? "question"
            : raw === "model"
              ? "model"
              : null;
        if (summarySource === null) {
          return NextResponse.json(
            { error: 'summarySource must be "question" or "model"' },
            { status: 400 },
          );
        }
        const fileIds = Array.isArray(body.fileIds)
          ? body.fileIds.filter((x: unknown): x is string => typeof x === "string")
          : [];
        try {
          const metric = createMetric(
            typeof body.name === "string" ? body.name : "",
            typeof body.expression === "string" ? body.expression : "",
            typeof body.description === "string" ? body.description : "",
            typeof body.entity === "string" ? body.entity : "",
            {
              text: typeof body.summaryText === "string" ? body.summaryText : "",
              source: summarySource,
            },
            fileIds,
          );
          return NextResponse.json({ metric });
        } catch (err) {
          return NextResponse.json(
            { error: err instanceof Error ? err.message : "could not create the metric" },
            { status: 400 },
          );
        }
      }
      if (body.action === "create-synonym") {
        try {
          const synonym = createSynonym(
            typeof body.term === "string" ? body.term : "",
            typeof body.canonical === "string" ? body.canonical : "",
          );
          return NextResponse.json({ synonym });
        } catch (err) {
          return NextResponse.json(
            { error: err instanceof Error ? err.message : "could not create the synonym" },
            { status: 400 },
          );
        }
      }
      if (body.action === "rename") {
        if (typeof body.id !== "string" || !body.id) {
          return NextResponse.json({ error: "id required" }, { status: 400 });
        }
        try {
          const metric = renameMetric(body.id, typeof body.name === "string" ? body.name : "");
          return NextResponse.json({ metric });
        } catch (err) {
          return NextResponse.json(
            { error: err instanceof Error ? err.message : "could not rename the metric" },
            { status: 400 },
          );
        }
      }
      if (body.action === "delete") {
        try {
          if (typeof body.id === "string" && body.id) {
            return NextResponse.json({ deletedId: deleteMetric(body.id, body.cascade === true) });
          }
          if (typeof body.term === "string" && body.term) {
            deleteSynonym(body.term);
            return NextResponse.json({ ok: true });
          }
          return NextResponse.json(
            { error: "id (metric) or term (synonym) required" },
            { status: 400 },
          );
        } catch (err) {
          return NextResponse.json(
            { error: err instanceof Error ? err.message : "could not delete the definition" },
            { status: 400 },
          );
        }
      }
      return NextResponse.json(
        {
          error:
            "semantic action must be list, create-metric, create-synonym, rename, or delete",
        },
        { status: 400 },
      );
    }

    // PARITY: proposing a metric parses the executed SQL (analytics/DataFusion),
    // Rust-engine-only — this dev twin can't, so op:"defineMetric" is honestly
    // unavailable (the shapeView posture). The Rust engine proposes an aggregate
    // expression + entity for the "Define as metric" dialog.
    case "defineMetric":
      return NextResponse.json({
        available: false,
        reason:
          "defining a metric from an answer runs in the Rust engine — this dev server can't parse SQL",
      });

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
      // The current investigation, when one is (openspec:
      // add-investigations) — the pin carries it as its membership.
      const investigationId =
        typeof body.investigationId === "string" ? body.investigationId : undefined;
      try {
        return NextResponse.json({ pin: addPin(question, sql, fileIds, investigationId) });
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
      // Optional investigation filter (openspec: add-investigations); absent
      // (or blank) keeps the original "all pins" behavior.
      return NextResponse.json({
        pins: listPins(
          typeof body.investigationId === "string" && body.investigationId
            ? body.investigationId
            : undefined,
        ),
      });

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
      let subdir = body.subdir === undefined ? "Lighthouse Notes" : body.subdir;
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
      // Investigation notes (openspec: add-investigations §3): a non-empty
      // investigationId routes the NOTES destination to the investigation's
      // own folder — resolved ENGINE-SIDE from the store (`Lighthouse
      // Notes/<stored folderName>`, re-validated at use); a client-sent
      // folder is never trusted and the subdir allowlist above is unchanged.
      // An explicit "Lighthouse Results" (the evidence pack) stays in
      // Results — packs are results, not notes, and note membership =
      // location. An unknown id rejects: a silently-global note would lose
      // its membership. Parsed like the ask wire's investigationId
      // (non-string reads as absent).
      const investigationId =
        typeof body.investigationId === "string" ? body.investigationId.trim() : "";
      if (investigationId && subdir === "Lighthouse Notes") {
        try {
          subdir = investigationNotesSubdir(investigationId);
        } catch (err) {
          return NextResponse.json(
            { error: err instanceof Error ? err.message : "investigation not found" },
            { status: 400 },
          );
        }
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
