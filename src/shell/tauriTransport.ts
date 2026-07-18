/**
 * Tauri IPC transport (Phase 4 of docs/rewrite-scope.md).
 *
 * Inside the Tauri shell there is no local HTTP server — the engine runs
 * in-process. This module keeps the entire React tree unmodified by
 * intercepting `fetch("/api/…")` and carrying each call over Tauri's invoke
 * (and a Channel for the streamed chat), returning real `Response` objects
 * with the same shapes and status codes as the Next.js routes. It also
 * installs the `window.lighthouseDesktop` bridge (real paths for OS drops,
 * the native link picker) that the Electron preload used to provide.
 *
 * Outside Tauri (web deploy, `next dev`) this is a no-op.
 */

import {
  INSPECT_FILE_EVENT,
  INSPECT_FILE_SHELL_EVENT,
  type InspectFileDetail,
} from "@/lib/citePreview";

type TauriCore = typeof import("@tauri-apps/api/core");
type TauriEvent = typeof import("@tauri-apps/api/event");
type TauriWebviewWindow = typeof import("@tauri-apps/api/webviewWindow");

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Map a command error to the HTTP status the route would have used. */
function errorResponse(path: string, message: string): Response {
  if ((path === "/api/open" || path === "/api/reveal") && message === "file no longer exists") {
    return json({ error: message }, 404);
  }
  if (path === "/api/connect") {
    return json({ error: message }, message === "not connected" ? 400 : 500);
  }
  return json({ error: message }, 400);
}

async function readBody(init?: RequestInit): Promise<Record<string, unknown>> {
  const raw = init?.body;
  if (typeof raw !== "string" || !raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** A well-formed resizable-explorer patch (openspec: add-usability-field-patch
 *  §1): {mode, width} for one window mode. The engine's narrow setter clamps +
 *  merges; this only screens shape before forwarding. Mirrors the /api/settings
 *  route twin's guard. */
function isExplorerWidthPatch(v: unknown): v is { mode: "window" | "widget"; width: number } {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (o.mode === "window" || o.mode === "widget") && typeof o.width === "number";
}

async function handleUpload(core: TauriCore, init: RequestInit | undefined): Promise<Response> {
  const form = init?.body;
  if (!(form instanceof FormData)) {
    return json({ error: "expected multipart/form-data" }, 400);
  }
  const dirRaw = form.get("dir");
  const dest = typeof dirRaw === "string" && dirRaw ? dirRaw : null;
  const rawPaths = form.getAll("paths");
  const items = form
    .getAll("files")
    .map((entry, i) => ({
      file: entry,
      path: typeof rawPaths[i] === "string" ? (rawPaths[i] as string) : "",
    }))
    .filter((p): p is { file: File; path: string } => typeof p.file !== "string");

  const MAX_FILES = 50;
  const MAX_TOTAL = 200 * 1024 * 1024;
  const added: { newId: string }[] = [];
  const skipped: { name: string; reason: string }[] = [];
  let accepted = 0;
  let totalBytes = 0;
  for (const { file, path: rel } of items) {
    if (accepted >= MAX_FILES) {
      skipped.push({ name: file.name, reason: `exceeds max of ${MAX_FILES} files` });
      continue;
    }
    if (totalBytes + file.size > MAX_TOTAL) {
      skipped.push({ name: file.name, reason: `request exceeds ${MAX_TOTAL / (1024 * 1024)}MB total` });
      continue;
    }
    const subDir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : null;
    const target = subDir || dest;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await core.invoke<{ newId: string }>("upload_file", bytes, {
        headers: {
          "x-file-name": encodeURIComponent(file.name),
          ...(target ? { "x-dest-dir": encodeURIComponent(target) } : {}),
        },
      });
      added.push(result);
      accepted++;
      totalBytes += file.size;
    } catch (err) {
      skipped.push({ name: file.name, reason: String(err) });
    }
  }
  return json({ added, skipped });
}

function handleChat(
  core: TauriCore,
  body: Record<string, unknown>,
  signal?: AbortSignal | null,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Honor AbortSignal like a real fetch would: without this, Stop was
      // inert on the desktop until the next token happened to arrive (the
      // reader's pending read() never rejected). The engine keeps generating
      // in the background — same as an aborted HTTP fetch server-side — but
      // the UI settles instantly.
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      if (signal?.aborted) {
        finish(() => controller.error(new DOMException("The user aborted a request.", "AbortError")));
        return;
      }
      signal?.addEventListener(
        "abort",
        () => finish(() => controller.error(new DOMException("The user aborted a request.", "AbortError"))),
        { once: true },
      );
      const channel = new core.Channel<unknown>();
      channel.onmessage = (chunk) => {
        if (settled) return; // aborted — drop late chunks
        controller.enqueue(encoder.encode(JSON.stringify(chunk) + "\n"));
        const done = (chunk as { done?: boolean }).done;
        if (done) finish(() => controller.close());
      };
      core
        .invoke("chat_ask", {
          question: typeof body.question === "string" ? body.question : "",
          includedFileIds: Array.isArray(body.includedFileIds) ? body.includedFileIds : [],
          history: Array.isArray(body.history) ? body.history : [],
          attachmentFileIds: Array.isArray(body.attachmentFileIds) ? body.attachmentFileIds : [],
          // The investigation this ask runs inside (openspec:
          // add-investigations); absent serializes away → None on the Rust
          // side (the global context).
          investigationId: typeof body.investigationId === "string" ? body.investigationId : undefined,
          // Answer-cache controls (openspec: add-answer-cache) ride the IPC
          // verbatim; absent fields fail toward privacy (false).
          bypassCache: body.bypassCache === true,
          persistAllowed: body.persistAllowed === true,
          onChunk: channel,
        })
        .catch((err) => {
          if (settled) return;
          // Mirror the route: errors surface as an italic delta, then a
          // terminal chunk, never a broken stream.
          controller.enqueue(
            encoder.encode(JSON.stringify({ delta: `\n\n_(error: ${String(err)})_`, done: false }) + "\n"),
          );
          controller.enqueue(
            encoder.encode(JSON.stringify({ delta: "", references: [], done: true }) + "\n"),
          );
          finish(() => controller.close());
        });
    },
  });
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
}

async function route(
  core: TauriCore,
  path: string,
  init: RequestInit | undefined,
): Promise<Response> {
  const method = (init?.method ?? "GET").toUpperCase();
  const body = await readBody(init);
  const call = async (cmd: string, args?: Record<string, unknown>): Promise<Response> => {
    try {
      return json(await core.invoke(cmd, args));
    } catch (err) {
      return errorResponse(path, String(err));
    }
  };

  switch (path) {
    case "/api/rag":
      return method === "GET" ? call("rag_list") : call("rag_op", { body });
    case "/api/chat":
      return handleChat(core, body, init?.signal);
    case "/api/profile":
      return method === "GET" ? call("profile_get") : call("profile_op", { body });
    case "/api/diagnostics":
      return call("diagnostics");
    case "/api/connect":
      return call("connect_op", { body });
    case "/api/model":
      return method === "GET"
        ? call("model_status")
        : method === "DELETE"
          ? call("model_uninstall")
          : call("model_download");
    case "/api/open":
      return call("open_node", { nodeId: typeof body.nodeId === "string" ? body.nodeId : "" });
    case "/api/reveal":
      return call("reveal_node", { nodeId: typeof body.nodeId === "string" ? body.nodeId : "" });
    case "/api/upload":
      return handleUpload(core, init);
    case "/api/settings":
      return method === "GET"
        ? call("settings_get")
        : call("settings_set", {
            runOnStartup: typeof body.runOnStartup === "boolean" ? body.runOnStartup : null,
            startupAsked: typeof body.startupAsked === "boolean" ? body.startupAsked : null,
            uiMode: body.uiMode === "window" || body.uiMode === "widget" ? body.uiMode : null,
            whisperMode: typeof body.whisperMode === "boolean" ? body.whisperMode : null,
            summonShortcut: typeof body.summonShortcut === "string" ? body.summonShortcut : null,
            semanticSearch: typeof body.semanticSearch === "boolean" ? body.semanticSearch : null,
            backgroundConserve:
              typeof body.backgroundConserve === "boolean" ? body.backgroundConserve : null,
            ocrEnabled: typeof body.ocrEnabled === "boolean" ? body.ocrEnabled : null,
            auditEnabled: typeof body.auditEnabled === "boolean" ? body.auditEnabled : null,
            draftAnswers: typeof body.draftAnswers === "boolean" ? body.draftAnswers : null,
            briefingNotify: typeof body.briefingNotify === "boolean" ? body.briefingNotify : null,
            briefingNoteHour: typeof body.briefingNoteHour === "number" ? body.briefingNoteHour : null,
            tourShown: typeof body.tourShown === "boolean" ? body.tourShown : null,
            // Resizable explorer width (openspec §1): a per-mode {mode,width}
            // routed to the engine's narrow merge-setter (set_explorer_width),
            // NOT the positional writer — forwarded verbatim when well-formed,
            // else null (dropped). Mirrors the /api/settings route twin.
            explorerWidth: isExplorerWidthPatch(body.explorerWidth) ? body.explorerWidth : null,
            // Appearance customization (openspec §3): a permissive object the
            // engine validates against the whitelist (set_appearance). null when
            // absent or malformed. Mirrors the /api/settings route twin.
            appearance:
              body.appearance && typeof body.appearance === "object" ? body.appearance : null,
          });
    default:
      return json({ error: "unknown route" }, 404);
  }
}

/** Paths from the most recent OS drag-drop, consumed by `pathForFile`. */
let lastDroppedPaths: string[] = [];

/**
 * Native drag position → CSS client coordinates. Only WebView2 (Windows)
 * reports physical device pixels; WKWebView (macOS) and WebKitGTK (Linux)
 * already deliver logical coordinates despite the payload's Physical label —
 * dividing those by devicePixelRatio would halve them on HiDPI displays and
 * misroute drops between the explorer and chat panes.
 */
const DRAG_POS_IS_PHYSICAL =
  typeof navigator !== "undefined" && navigator.userAgent.includes("Windows");

function toClientXY(pos: { x?: number; y?: number } | undefined): { x: number; y: number } {
  const scale = DRAG_POS_IS_PHYSICAL ? window.devicePixelRatio || 1 : 1;
  return { x: (pos?.x ?? 0) / scale, y: (pos?.y ?? 0) / scale };
}

function installDesktopBridge(
  core: TauriCore,
  eventApi: TauriEvent,
  webviewWindow: TauriWebviewWindow,
): void {
  // --- OS drag-drop, driven by the NATIVE events. On Windows, WebView2 never
  // delivers DOM drag events while Tauri's drag-drop handler is active — so
  // the DOM-based handlers the explorer/chat used were dead there and OS drops
  // did nothing. The native events fire on every platform and carry real
  // paths (whole folders included), so they are the single source of truth on
  // the desktop: re-broadcast them as window CustomEvents for the UI, which
  // ignores DOM "Files" drags inside the shell (see isDesktopShell()).
  //
  // Drag events are PER-WINDOW state: a bare listen() defaults to
  // EventTarget.Any and hears EVERY window's drags, so with more than one
  // webview (main + widget + explorer) a single OS drop would be processed by
  // each of them — the same file added twice, or attached to a chat pane the
  // user never dropped on. Scope them to this window's label.
  type DragPayload = { paths?: string[]; position?: { x: number; y: number } };
  const here = { target: webviewWindow.getCurrentWebviewWindow().label };
  const broadcast = (name: string, detail?: unknown) =>
    window.dispatchEvent(new CustomEvent(name, { detail }));
  void eventApi.listen<DragPayload>(
    "tauri://drag-enter",
    (e) => {
      broadcast("lighthouse:os-drag", toClientXY(e.payload?.position));
    },
    here,
  );
  void eventApi.listen<DragPayload>(
    "tauri://drag-over",
    (e) => {
      broadcast("lighthouse:os-drag", toClientXY(e.payload?.position));
    },
    here,
  );
  void eventApi.listen(
    "tauri://drag-leave",
    () => {
      broadcast("lighthouse:os-drag-leave");
    },
    here,
  );
  void eventApi.listen<DragPayload>(
    "tauri://drag-drop",
    (e) => {
      lastDroppedPaths = e.payload?.paths ?? [];
      broadcast("lighthouse:os-drop", {
        paths: e.payload?.paths ?? [],
        ...toClientXY(e.payload?.position),
      });
    },
    here,
  );

  // --- Vault freshness pushed from the shell (tray/menu adds, the FS watcher)
  // so the tree refreshes instantly without the old full-page reload and
  // without leaning on the polling loop.
  void eventApi.listen("vault-changed", () => broadcast("lighthouse:vault-changed"));
  void eventApi.listen("vault-generation", () => broadcast("lighthouse:vault-changed"));

  // --- Pinned questions whose recomputed result changed (the shell's
  // watcher-driven recheck pass) → the chat's alert banner.
  void eventApi.listen<{ changed?: unknown[] }>("pins-changed", (e) => {
    broadcast("lighthouse:pins-changed", { changed: e.payload?.changed ?? [] });
  });

  // --- Widget → chat hand-off: the shell raises the main window and emits
  // this with the query typed into the floating search bar ("Ask Lighthouse
  // →"); the chat panel listens for the DOM event and asks it.
  void eventApi.listen<{ question?: string }>("ask-question", (e) => {
    const question = e.payload?.question;
    if (question) broadcast("lighthouse:ask-question", { question });
  });

  // --- Widget → preview hand-off (citation → preview, time-savers feature 4):
  // a citation button in the widget's inline answer raises the main window and
  // emits this (JS emitTo — no shell command involved) with the cited file +
  // chunk-locating query; re-broadcast as the DOM event the FileInspectorHost
  // in the main window listens for. Windows without the host ignore it.
  void eventApi.listen<Partial<InspectFileDetail>>(INSPECT_FILE_SHELL_EVENT, (e) => {
    const d = e.payload;
    if (d && typeof d.fileId === "string" && d.fileId) {
      broadcast(INSPECT_FILE_EVENT, {
        fileId: d.fileId,
        name: typeof d.name === "string" ? d.name : "",
        ...(typeof d.query === "string" && d.query ? { query: d.query } : {}),
      });
    }
  });

  // --- Shell-driven pin changes (switching interface mode applies the new
  // mode's pin semantics) so the widget's pin button tracks the shell state.
  void eventApi.listen<{ pinned?: boolean }>("widget-pin", (e) => {
    broadcast("lighthouse:widget-pin", { pinned: e.payload?.pinned === true });
  });

  // --- Update check result (boot-time, best-effort) → the sidebar banner.
  void eventApi.listen("update:state", (e) => {
    broadcast("lighthouse:update-state", e.payload);
  });
  const bridge = {
    // Correlate the DOM File with the shell's drag-drop payload by basename —
    // both fire from the same gesture. Consumed on match so duplicate names
    // across two drops can't cross-resolve.
    pathForFile(file: File): string {
      const idx = lastDroppedPaths.findIndex((p) => {
        const base = p.split(/[\\/]/).pop() ?? "";
        return base === file.name;
      });
      if (idx === -1) return "";
      const [path] = lastDroppedPaths.splice(idx, 1);
      return path;
    },
    linkDialog(directory: boolean): Promise<string[]> {
      return core.invoke<string[]>("pick_link_paths", { directory });
    },
  };
  (window as unknown as { lighthouseDesktop?: typeof bridge }).lighthouseDesktop = bridge;
}

let installed = false;

/**
 * Install the IPC transport (fetch interceptor + desktop bridge). Idempotent;
 * a no-op outside the Tauri shell. The interceptor is swapped in
 * synchronously — API calls issued before the Tauri module finishes loading
 * simply await it — so no early fetch can slip through to a nonexistent
 * HTTP server.
 */
export function installTauriTransport(): void {
  if (installed || !isTauri()) return;
  installed = true;
  const modules = Promise.all([
    import("@tauri-apps/api/core"),
    import("@tauri-apps/api/event"),
    import("@tauri-apps/api/webviewWindow"),
  ]).then(([core, eventApi, webviewWindow]) => {
    installDesktopBridge(core, eventApi, webviewWindow);
    return core;
  });
  const original = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("/api/")) {
      return modules.then((core) => route(core, url.split("?")[0], init));
    }
    return original(input as RequestInfo, init);
  }) as typeof window.fetch;
}
