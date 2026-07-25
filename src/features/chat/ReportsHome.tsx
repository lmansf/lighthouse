"use client";

/**
 * §49 §4: the Reports HOME — a first-class library of every saved report. Lists
 * the reports the engine knows about (`ragService.listReports`, newest-first: a
 * `.md` under `Lighthouse Reports/` or an investigation's `Lighthouse Notes/`
 * subdir carrying the report signature), each row opening the §2 in-app reader
 * via `openSavedReport(id)`. A "New report" composer runs the SAME templated
 * deep analysis the chat doors do — capability-gated on an investigable table
 * (`ragService.capabilityMap` over the included files); the engine's numbers are
 * untouched, an optional hypothesis only frames the write-up.
 *
 * TWO containers, ONE content: `ReportsHome` renders the composer + list and is
 * dropped into the compact Reports PAGE (AppShell) AND the desktop dialog
 * (`ReportsHomeHost`, opened by `lighthouse:open-reports` from the Sidebar
 * footer) — the Settings pattern (SettingsPage in a compact page + a desktop
 * dialog). Rust-engine-only: the web twin has no reports (empty list) and
 * `investigate` throws (an honest note, never a fake save).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogTitle,
  Spinner,
  Text,
  Textarea,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import { IconDocAdd, IconReport } from "@/shell/icons";
import type { CapabilityMap, ReportSummary, ReportTemplate } from "@/contracts";
import { EMPTY_CAPABILITY_MAP, ragService } from "@/contracts";
import { LhDialogSurface, LhSegmented, LhSelect } from "@/shell/controls";
import { openSavedReport, OPEN_REPORT_EVENT } from "@/lib/openReport";
import { isSheetName, resolveSheetTable } from "@/lib/reportTargets";
import { useRagStore } from "@/stores/useRagStore";

/** The standalone-report vault folder (mirrors Rust `reports::REPORTS_SUBDIR`).
 *  A row whose folder IS this is a standalone report — its title already says
 *  so, so no "from <folder>" subtitle; any OTHER folder is an investigation. */
const REPORTS_SUBDIR = "Lighthouse Reports";

/** The UI offers three; the wire template is only "imrad" | "bluf" — "standard"
 *  maps to NO template (the deterministic report), like every other door. */
type Picked = ReportTemplate | "standard";

/** A composer choice: an already-investigable INCLUDED table, or a HIDDEN vault
 *  spreadsheet that "New report" makes visible to the AI before analyzing it —
 *  so the Reports library builds from any spreadsheet in the vault, not only the
 *  ones the user has already made visible (make-visible-and-keep). */
type Opt =
  | { key: string; label: string; kind: "table"; table: string }
  | { key: string; label: string; kind: "sheet"; id: string; name: string };

/** A compact "saved N ago", falling back to the absolute date past a month (and
 *  to nothing when the engine couldn't stat the file). */
function savedAgo(ms: number): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(ms).toLocaleDateString();
}

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM },
  // The New-report action row + its inline composer (no nested modal — the home
  // is itself shown in a dialog on desktop).
  composer: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
  },
  composerActions: { display: "flex", gap: tokens.spacingHorizontalS, justifyContent: "flex-end" },
  hint: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  errorNote: { color: tokens.colorPaletteRedForeground1, fontSize: tokens.fontSizeBase200 },
  list: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS },
  row: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    width: "100%",
    textAlign: "left",
    minHeight: "44px", // touch target (fp3 §2)
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    border: "none",
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: "transparent",
    color: tokens.colorNeutralForeground1,
    cursor: "pointer",
    fontFamily: "inherit",
    ":hover": { backgroundColor: tokens.colorNeutralBackground1Hover },
    ":focus-visible": {
      outlineWidth: "2px",
      outlineStyle: "solid",
      outlineColor: tokens.colorStrokeFocus2,
      outlineOffset: "-2px",
    },
  },
  rowIcon: { flexShrink: 0, color: tokens.colorNeutralForeground3, fontSize: "20px", display: "inline-flex" },
  rowText: { display: "flex", flexDirection: "column", minWidth: 0, flex: 1 },
  rowName: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  rowMeta: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  empty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: tokens.spacingVerticalS,
    color: tokens.colorNeutralForeground3,
    textAlign: "center",
    padding: `${tokens.spacingVerticalXXL} ${tokens.spacingHorizontalL}`,
  },
  center: { display: "flex", justifyContent: "center", padding: tokens.spacingVerticalXL },
});

/**
 * The Reports library content — the composer + the saved-report list. Container-
 * agnostic (compact page or desktop dialog). `onOpened` fires when a row is
 * tapped, so a container can dismiss itself (the compact page yields to Chat
 * as the reader takes over).
 */
export function ReportsHome({ onOpened }: { onOpened?: () => void }) {
  const styles = useStyles();
  const nodes = useRagStore((s) => s.nodes);
  const toggleIncluded = useRagStore((s) => s.toggleIncluded);
  const includedFileIds = useMemo(
    () => nodes.filter((n) => n.kind === "file" && n.ragIncluded).map((n) => n.id),
    [nodes],
  );
  // Spreadsheets sitting in the vault but NOT yet visible to the AI. The engine
  // binds exclusion (it never reads a hidden file), so these can't be profiled
  // for investigability up front — "New report" offers them anyway and makes
  // the chosen one visible before analyzing it.
  const hiddenSheets = useMemo(
    () => nodes.filter((n) => n.kind === "file" && !n.ragIncluded && isSheetName(n.name)),
    [nodes],
  );

  const [reports, setReports] = useState<ReportSummary[] | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    setLoading(true);
    ragService
      .listReports()
      .then((rs) => setReports(rs))
      .catch(() => setReports([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // A report saved elsewhere (a chat door opens the reader on the fresh report)
  // is very likely a NEW report — refresh the library so it appears at the top.
  useEffect(() => {
    const onOpen = () => reload();
    window.addEventListener(OPEN_REPORT_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_REPORT_EVENT, onOpen);
  }, [reload]);

  // Which included tables a real report can run over (the investigable gate the
  // chat doors use), resolved from the included files. Empty on the web twin.
  const [map, setMap] = useState<CapabilityMap>(EMPTY_CAPABILITY_MAP);
  const includedKey = useMemo(() => includedFileIds.join("\n"), [includedFileIds]);
  useEffect(() => {
    if (!includedKey) {
      setMap(EMPTY_CAPABILITY_MAP);
      return;
    }
    let cancelled = false;
    ragService
      .capabilityMap(includedKey.split("\n"))
      .then((m) => {
        if (!cancelled) setMap(m ?? EMPTY_CAPABILITY_MAP);
      })
      .catch(() => {
        if (!cancelled) setMap(EMPTY_CAPABILITY_MAP);
      });
    return () => {
      cancelled = true;
    };
  }, [includedKey]);

  const tables = useMemo(() => map.tables.filter((t) => t.investigable).map((t) => t.name), [map]);

  // Everything a report can be built from: the already-investigable included
  // tables first, then the hidden vault spreadsheets (each will be made visible
  // on Generate). One combined picker, so the Reports library is never a dead
  // door just because the user hasn't made a spreadsheet visible yet.
  const options = useMemo<Opt[]>(() => {
    const t: Opt[] = tables.map((name) => ({ key: `t:${name}`, label: name, kind: "table", table: name }));
    const s: Opt[] = hiddenSheets.map((n) => ({
      key: `s:${n.id}`,
      label: `${n.name} — make visible`,
      kind: "sheet",
      id: n.id,
      name: n.name,
    }));
    return [...t, ...s];
  }, [tables, hiddenSheets]);
  const canReport = options.length > 0;

  // The New-report composer (inline — never a nested modal).
  const [composing, setComposing] = useState(false);
  const [selKey, setSelKey] = useState<string>("");
  const [template, setTemplate] = useState<Picked>("standard");
  const [hypoText, setHypoText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = useMemo(() => options.find((o) => o.key === selKey) ?? options[0], [options, selKey]);

  function openComposer() {
    setSelKey(options[0]?.key ?? "");
    setTemplate("standard");
    setHypoText("");
    setError(null);
    setComposing(true);
  }

  async function generate() {
    const opt = chosen;
    if (!opt || busy) return;
    setBusy(true);
    setError(null);
    try {
      const wire: ReportTemplate | undefined = template === "standard" ? undefined : template;
      const tableName = await resolveTable(opt);
      if (!tableName) return; // resolveTable set an honest error (stay in composer)
      const { savedId } = await ragService.investigate(tableName, undefined, wire, hypoText.trim() || undefined);
      setComposing(false);
      // Open the reader on the fresh report and highlight the saved node — the
      // §3 "don't just save silently" behavior, shared with the chat doors.
      openSavedReport(savedId);
      if (typeof window !== "undefined" && savedId) {
        window.dispatchEvent(new CustomEvent("lighthouse:reveal-node", { detail: { id: savedId } }));
      }
      reload();
      onOpened?.();
    } catch {
      // Rust-only: the web twin throws — an honest note, never a fake save.
      setError("Deep analysis runs in the desktop engine.");
    } finally {
      setBusy(false);
    }
  }

  // Resolve the SQL table to analyze. An included table is already itself; a
  // hidden spreadsheet is made visible first (make-visible-and-keep), then
  // confirmed to yield an investigable table BEFORE the (saving) deep analysis
  // runs — so a sheet with no dated numeric series never writes an empty report.
  async function resolveTable(opt: Opt): Promise<string | null> {
    if (opt.kind === "table") return opt.table;
    if (!includedFileIds.includes(opt.id)) await toggleIncluded(opt.id);
    const ids = includedFileIds.includes(opt.id) ? includedFileIds : [...includedFileIds, opt.id];
    const m2 = await ragService.capabilityMap(ids).catch(() => EMPTY_CAPABILITY_MAP);
    const resolved = resolveSheetTable(opt.name, m2.tables, tables);
    if ("table" in resolved) return resolved.table;
    if ("none" in resolved) {
      // The engine profiled the sheet but it has no dated numeric series → an
      // honest note, never an empty saved report.
      setError(`“${opt.name}” has no date + number column, so there’s nothing to analyze yet.`);
      return null;
    }
    // The engine returned no tables at all (the web dev twin): pass the name
    // through so investigate's own throw surfaces the desktop-only message
    // rather than a misleading "no columns" note.
    return opt.name;
  }

  function openRow(id: string) {
    openSavedReport(id);
    onOpened?.();
  }

  return (
    <div className={styles.root}>
      {composing ? (
        <div className={styles.composer}>
          <Text weight="semibold">New report</Text>
          {options.length > 1 && (
            <LhSelect
              options={options.map((o) => ({ value: o.key, label: o.label }))}
              value={chosen?.key ?? ""}
              onChange={setSelKey}
              aria-label="Spreadsheet to analyze"
            />
          )}
          {options.length === 1 && chosen && (
            <Text className={styles.hint}>
              A deep analysis of {chosen.kind === "table" ? chosen.table : chosen.name}, saved to your vault.
            </Text>
          )}
          {chosen?.kind === "sheet" && (
            <Text className={styles.hint}>
              “{chosen.name}” isn’t visible to the AI yet — generating a report makes it visible.
            </Text>
          )}
          <LhSegmented
            options={[
              { value: "standard", label: "Standard" },
              { value: "imrad", label: "Scientific" },
              { value: "bluf", label: "Business" },
            ]}
            value={template}
            onChange={(v) => setTemplate(v === "imrad" || v === "bluf" ? v : "standard")}
            aria-label="Report style"
          />
          <Textarea
            value={hypoText}
            onChange={(_, d) => setHypoText(d.value)}
            placeholder="Optional hypothesis to frame around, e.g. “churn rose after the price change”"
            aria-label="Working hypothesis"
            resize="vertical"
          />
          <Text className={styles.hint}>
            Every figure is computed by the engine — an optional hypothesis only frames the write-up,
            never the numbers.
          </Text>
          {error && (
            <Text className={styles.errorNote} role="status">
              {error}
            </Text>
          )}
          <div className={styles.composerActions}>
            <Button appearance="secondary" size="small" onClick={() => setComposing(false)}>
              Cancel
            </Button>
            <Button appearance="primary" size="small" disabled={busy || !chosen} onClick={() => void generate()}>
              {busy ? "Generating…" : "Generate"}
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button
            appearance="primary"
            icon={<IconDocAdd />}
            disabled={!canReport}
            onClick={openComposer}
            title={
              canReport
                ? "Write a new deep-analysis report"
                : "Add a spreadsheet to your vault to write a report"
            }
          >
            New report
          </Button>
          {!canReport && (
            <Text as="p" className={styles.hint} style={{ marginTop: tokens.spacingVerticalXS }}>
              Add a spreadsheet to your vault to write a report.
            </Text>
          )}
        </div>
      )}

      {loading && reports === null ? (
        <div className={styles.center}>
          <Spinner size="tiny" label="Loading reports…" />
        </div>
      ) : reports && reports.length > 0 ? (
        <div className={styles.list} role="list" aria-label="Saved reports">
          {reports.map((r) => {
            const title = r.name.replace(/\.md$/, "");
            const when = savedAgo(r.generatedAtMs);
            // The folder subtitle names the investigation; a standalone report's
            // folder IS "Lighthouse Reports", which the title already implies.
            const from = r.folder && r.folder !== REPORTS_SUBDIR ? r.folder : "";
            const meta = [from, when].filter(Boolean).join(" · ");
            return (
              <button
                key={r.id}
                type="button"
                role="listitem"
                className={mergeClasses("lh-press", styles.row)}
                onClick={() => openRow(r.id)}
                title={`Open ${title}`}
              >
                <span className={styles.rowIcon} aria-hidden>
                  <IconReport />
                </span>
                <span className={styles.rowText}>
                  <Text className={styles.rowName}>{title}</Text>
                  {meta && (
                    <Text className={styles.rowMeta} truncate wrap={false}>
                      {meta}
                    </Text>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className={styles.empty} data-testid="reports-empty">
          <IconReport />
          <Text>No reports yet.</Text>
          <Text className={styles.hint}>
            Run a deep analysis from a spreadsheet answer — or “New report” above — and it lands here.
          </Text>
        </div>
      )}
    </div>
  );
}

/** §49 §4: the event that opens the desktop Reports dialog. The Sidebar footer's
 *  Reports entry dispatches it; `ReportsHomeHost` (mounted once in the composition
 *  root) listens. The compact shell shows the Reports PAGE instead (a tab), so
 *  this is desktop-only in practice. */
export const OPEN_REPORTS_EVENT = "lighthouse:open-reports";

/**
 * Desktop host: the Reports home in a centered dialog, opened by
 * `lighthouse:open-reports`. Mounted once beside the other overlay hosts; the
 * compact shell renders `ReportsHome` directly in its Reports page instead.
 */
export function ReportsHomeHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_REPORTS_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_REPORTS_EVENT, onOpen);
  }, []);
  return (
    <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
      <LhDialogSurface>
        <DialogBody>
          <DialogTitle>Reports</DialogTitle>
          <DialogContent>
            {/* A row tap opens the reader over this dialog; leave the library up
                so the user returns to it when the reader closes. */}
            {open && <ReportsHome />}
          </DialogContent>
        </DialogBody>
      </LhDialogSurface>
    </Dialog>
  );
}
