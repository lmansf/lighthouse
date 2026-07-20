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
