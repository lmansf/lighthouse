/**
 * Typed accessor for the desktop file bridge (installed by the Tauri shell —
 * see src/shell/tauriTransport.ts). Lives in
 * `shell` so both the explorer and chat can use it without importing each
 * other. Returns null outside the desktop app (plain web/dev in a browser),
 * where callers fall back to byte upload.
 */

export interface DesktopBridge {
  /** Absolute path of an OS-dropped File, or "" when it has none. */
  pathForFile(file: File): string;
  /** Native picker for linking files (or a folder) in place; resolves to paths. */
  linkDialog(directory: boolean): Promise<string[]>;
  /** Native SAVE dialog (openspec: refocus-chat-attachments §1.7). Resolves to
   *  the saved file's name, or null when the user cancels. */
  saveFile(nameHint: string, ext: "md" | "html", content: string): Promise<string | null>;
  /** Attach OS files to a conversation by absolute path (openspec §2.1) — what
   *  a NATIVE drop hands the webview is paths, which it cannot read itself. */
  attachPaths(
    conversationId: string,
    paths: string[],
  ): Promise<{
    added: { newId: string; name: string }[];
    skipped: { name: string; reason: string }[];
  }>;
}

export function desktopBridge(): DesktopBridge | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { lighthouseDesktop?: DesktopBridge };
  return w.lighthouseDesktop ?? null;
}

/**
 * True inside the Tauri desktop shell. There, OS file drags arrive via the
 * NATIVE drag-drop events (re-broadcast as `lighthouse:os-drag`/`os-drop`
 * CustomEvents by the transport) and DOM "Files" drag handlers must stand
 * down — on Windows the DOM events never fire at all, and on macOS/Linux
 * reacting to both would double-add every drop.
 */
export function isDesktopShell(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Form factor of the running shell (iOS field patch 1 §1). Reported by the
 * ENGINE on the settings/rag-list payloads — never sniffed from the UA or the
 * window size. `desktop` here means form factor; note `isDesktopShell()` above
 * answers a different question ("is this an embedded Tauri shell" — true on
 * iOS too).
 */
export type PlatformKind = "desktop" | "ios" | "android";

let platformCache: PlatformKind | null = null;

/**
 * Record the engine-reported platform. Called wherever a payload carrying the
 * field is ingested (rag.real getTree — the first fetch every window makes);
 * unknown/absent values are ignored so an older engine leaves the default.
 */
export function rememberPlatform(p: unknown): void {
  if (p === "desktop" || p === "ios" || p === "android") platformCache = p;
}

/** Engine-reported form factor; "desktop" until the first payload arrives. */
export function platformKind(): PlatformKind {
  return platformCache ?? "desktop";
}

/** True on the phone/tablet shells — the §1 gate for mobile-only branches. */
export function isMobileShell(): boolean {
  const p = platformKind();
  return p === "ios" || p === "android";
}

/**
 * Resolve OS-dropped files to their real absolute paths. Only meaningful on
 * the desktop; a file that cannot be resolved (e.g. an image dragged out of a
 * web page rather than off the disk) comes back under `unresolved` so the
 * caller can upload its bytes instead.
 */
export function pathsForFiles(files: File[]): { paths: string[]; unresolved: File[] } {
  const bridge = desktopBridge();
  const paths: string[] = [];
  const unresolved: File[] = [];
  for (const f of files) {
    const p = bridge ? bridge.pathForFile(f) : "";
    if (p) paths.push(p);
    else unresolved.push(f);
  }
  return { paths, unresolved };
}

/**
 * Save engine-composed content wherever the USER picks (openspec:
 * refocus-chat-attachments §1.7). Exports used to be WRITTEN by the engine into
 * `Lighthouse Notes/` or `Lighthouse Results/`; with the vault gone an export
 * belongs to the user's filesystem, not the app's, and the save dialog is the
 * permission.
 *
 * Desktop shell: the native save dialog, which returns the saved file's display
 * name (or null when the user cancels — a cancel is not an error). Browser: a
 * download, which the browser routes through its own save flow; there is no way
 * to learn where it landed, so the suggested name is reported.
 */
export async function saveArtifact(
  nameHint: string,
  ext: "md" | "html" | "csv",
  content: string,
): Promise<string | null> {
  const bridge = desktopBridge();
  // The native dialog's allowlist is markdown/HTML (it is the app's, not the
  // client's); a CSV falls through to the browser download path.
  if (bridge && (ext === "md" || ext === "html")) {
    return bridge.saveFile(nameHint, ext, content);
  }
  if (typeof document === "undefined") return null;
  const type =
    ext === "csv" ? "text/csv" : ext === "html" ? "text/html" : "text/markdown";
  const name = `${nameHint.replace(/[/\\]/g, "-").trim() || "Lighthouse"}.${ext}`;
  const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return name;
}
