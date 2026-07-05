/**
 * Typed accessor for the desktop (Electron preload) file bridge. Lives in
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
