/**
 * Report export actions (openspec: add-usability-field-patch §4). One place any
 * report-shaped surface (deep-analysis reports, briefings, evidence packs, board
 * exports, Notes/transcripts) reaches for to save itself three ways:
 *
 *  - (a) self-contained HTML — composeReportHtml (inline CSS + charts baked to
 *        SVG, ZERO external references), written to the vault's allowlist folder
 *        via the existing exportChat path (no OS save dialog exists on desktop).
 *  - (b) PDF — the system-print / "Save as PDF" flow: open the self-contained
 *        HTML and invoke print. A confirmed wry print-to-PDF API is the deferred
 *        built-app step (design.md §4); this is the shipping fallback.
 *  - (c) Markdown — the raw markdown saved as a .md note.
 *
 * Nothing egresses: HTML/markdown land in the vault; print is an OS dialog.
 */
import { ragService } from "@/contracts";
import { composeReportHtml, type ReportInput } from "@/lib/evidencePack";

export interface ExportResult {
  ok: boolean;
  /** The saved file's display name, on success. */
  name?: string;
  error?: string;
}

/** A vault-safe filename hint from a title (the exportChat writer sanitizes further). */
function fileHint(title: string): string {
  return title.trim().replace(/\s+/g, " ").slice(0, 60) || "Report";
}

function toResult(res: { error?: string; savedId?: string; savedName?: string }): ExportResult {
  return res.error || !res.savedId
    ? { ok: false, error: res.error ?? "save failed" }
    : { ok: true, name: res.savedName };
}

/** (a) Save the report as a self-contained HTML file in `Lighthouse Results`. */
export async function exportReportHtml(input: ReportInput): Promise<ExportResult> {
  const html = composeReportHtml(input);
  return toResult(
    await ragService.exportChat(fileHint(input.title), html, {
      subdir: "Lighthouse Results",
      ext: "html",
    }),
  );
}

/** (c) Save the report's markdown as a `.md` note in `Lighthouse Notes`. */
export async function exportReportMarkdown(title: string, markdown: string): Promise<ExportResult> {
  return toResult(
    await ragService.exportChat(fileHint(title), markdown, {
      subdir: "Lighthouse Notes",
      ext: "md",
    }),
  );
}

/** (b) Open the self-contained report in the system print flow (Save as PDF).
 *  Returns false when a window can't be opened (caller can fall back to HTML). */
export function printReport(input: ReportInput): boolean {
  if (typeof window === "undefined") return false;
  const html = composeReportHtml(input);
  const w = window.open("", "_blank", "noopener,noreferrer");
  if (!w) return false;
  w.document.write(html);
  w.document.close();
  // Let the inlined styles + SVG settle before the OS print dialog.
  window.setTimeout(() => {
    try {
      w.focus();
      w.print();
    } catch {
      /* the tab is still a readable, printable copy */
    }
  }, 250);
  return true;
}
