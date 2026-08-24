/**
 * Report export actions. One place any report-shaped surface (deep-analysis
 * reports, evidence packs, answer exports, transcripts) reaches for to save
 * itself three ways:
 *
 *  - (a) self-contained HTML — composeReportHtml (inline CSS + charts baked to
 *        SVG, ZERO external references).
 *  - (b) PDF — the system-print / "Save as PDF" flow: open the self-contained
 *        HTML and invoke print.
 *  - (c) Markdown — the raw markdown.
 *
 * (a) and (c) go through the OS SAVE DIALOG (openspec:
 * refocus-chat-attachments §1.7). They used to write into vault allowlist
 * folders — `Lighthouse Results/`, `Lighthouse Notes/` — because the app had a
 * folder of its own to write into and no save dialog was wired. With the vault
 * gone, an export belongs to the user's filesystem: they choose the
 * destination, the app writes exactly one file there, and the dialog IS the
 * permission. In the browser dev twin there is no native dialog, so the same
 * call falls back to a download.
 *
 * Nothing egresses: every path here is local disk or an OS dialog.
 */
import { composeReportHtml, type ReportInput } from "@/lib/evidencePack";
import { desktopBridge } from "@/shell/desktopBridge";

export interface ExportResult {
  ok: boolean;
  /** The saved file's display name, on success. */
  name?: string;
  /** True when the user dismissed the save dialog — not a failure to report. */
  cancelled?: boolean;
  error?: string;
}

/** A filename hint from a title (the engine sanitizes further). */
function fileHint(title: string): string {
  return title.trim().replace(/\s+/g, " ").slice(0, 60) || "Report";
}

/**
 * Save `content` where the user picks. Desktop: the native save dialog. Browser
 * dev twin: an anchor download, which is that platform's save dialog.
 */
async function saveWhereverTheUserPicks(
  title: string,
  ext: "md" | "html",
  content: string,
): Promise<ExportResult> {
  const hint = fileHint(title);
  const bridge = desktopBridge();
  if (bridge) {
    try {
      const name = await bridge.saveFile(hint, ext, content);
      return name ? { ok: true, name } : { ok: false, cancelled: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "save failed" };
    }
  }
  if (typeof document === "undefined") return { ok: false, error: "no save target" };
  const name = `${hint}.${ext}`;
  const type = ext === "md" ? "text/markdown" : "text/html";
  const url = URL.createObjectURL(new Blob([content], { type }));
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    return { ok: true, name };
  } finally {
    // Revoke on the next tick: revoking synchronously can beat the download.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** (a) Save the report as a self-contained HTML file. */
export async function exportReportHtml(input: ReportInput): Promise<ExportResult> {
  return saveWhereverTheUserPicks(input.title, "html", composeReportHtml(input));
}

/** (c) Save the report's raw markdown. */
export async function exportReportMarkdown(title: string, markdown: string): Promise<ExportResult> {
  return saveWhereverTheUserPicks(title, "md", markdown);
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
