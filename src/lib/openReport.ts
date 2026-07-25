/**
 * §49 §2: the report-reader open event. Dispatch `openReport(id)` from any
 * report door — generate → "Report saved — Open", the per-answer Report action,
 * and the Reports home — to open the saved note in the in-app reader
 * (`ReportReaderHost` listens). Mirrors the `citePreview.ts` INSPECT_FILE_EVENT
 * pattern so every door speaks the same, typo-proof event.
 */
export const OPEN_REPORT_EVENT = "lighthouse:open-report";

export interface OpenReportDetail {
  /** The saved report note's vault node id. */
  id: string;
}

/** Open the saved report note `id` in the in-app reader. No-op server-side. */
export function openReport(id: string): void {
  if (typeof window === "undefined" || !id) return;
  window.dispatchEvent(new CustomEvent(OPEN_REPORT_EVENT, { detail: { id } }));
}
