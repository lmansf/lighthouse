/**
 * Drag-and-drop payload for moving vault files between features (explorer → chat).
 *
 * Lives in `shell` (neutral infra) so the explorer and chat features can share it
 * without importing each other. The custom MIME keeps these internal drags
 * distinguishable from OS file drops (`DataTransfer.types` includes "Files").
 */

export const FILE_DRAG_MIME = "application/x-lighthouse-file";

export interface DraggedFile {
  id: string;
  name: string;
}

export function serializeDraggedFiles(files: DraggedFile[]): string {
  return JSON.stringify(files);
}

/** Read dragged vault files from a drop, tolerating malformed/foreign payloads. */
export function parseDraggedFiles(dt: DataTransfer): DraggedFile[] {
  const raw = dt.getData(FILE_DRAG_MIME);
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (x): x is DraggedFile =>
        !!x &&
        typeof (x as DraggedFile).id === "string" &&
        typeof (x as DraggedFile).name === "string",
    );
  } catch {
    return [];
  }
}
