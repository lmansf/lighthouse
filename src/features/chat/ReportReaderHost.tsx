"use client";

/**
 * §49 §2: the in-app report reader. An event-driven overlay (opened by the
 * `lighthouse:open-report` {id} event) that reads a saved report note by its
 * vault id and renders it at the §35 reading scale, DRAWING the persisted key
 * chart from its ```lighthouse-chart fence (the same parseChartSpec →
 * AnalyticsChart path the chat answer uses). Desktop centered card / compact
 * swipe sheet via LhDialogSurface. Header: the report title, its generation
 * stamp, and Export (HTML / Markdown / Print) + Reveal-in-Files + Close.
 *
 * Reading NEVER egresses — it is a local vault read (ragService.readNote);
 * report GENERATION is untouched. Mounted once, beside FileInspectorHost, so its
 * listener persists for the whole session.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogTitle,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { type Components } from "react-markdown";
import { LhDialogSurface, LhMenu } from "@/shell/controls";
import { ragService } from "@/contracts";
import { parseChartSpec } from "@/lib/chartSpec";
import { AnalyticsChart } from "@/features/chat/AnalyticsChart";
import { exportReportHtml, exportReportMarkdown, printReport } from "@/lib/reportExport";
import { OPEN_REPORT_EVENT } from "@/lib/openReport";
import { IconDoc, IconReport } from "@/shell/icons";
import { CONTENT_TYPE } from "@/shell/theme";

const MarkdownView = dynamic(() => import("@/shell/MarkdownView"), { ssr: false });

const CHART_LANG = "language-lighthouse-chart";

/** True when a hast <pre> wraps exactly a lighthouse-chart code fence — the
 *  <pre> is unwrapped so the figure isn't inside preformatted text. */
function isChartPre(node: unknown): boolean {
  const child = (node as { children?: unknown[] })?.children?.[0] as
    | { tagName?: string; properties?: { className?: unknown } }
    | undefined;
  const cls = child?.properties?.className;
  return child?.tagName === "code" && Array.isArray(cls) && cls.includes(CHART_LANG);
}

/** Render the persisted key chart from its fence; every other block is default.
 *  Byte-for-byte the chat answer's chart handling (ChatPanel), so a report reads
 *  in the reader exactly as its finding reads in chat. */
const readerComponents: Components = {
  pre: ({ node, children, ...props }) =>
    isChartPre(node) ? <>{children}</> : <pre {...props}>{children}</pre>,
  code: ({ node, className, children, ...props }) => {
    if (className?.split(" ").includes(CHART_LANG)) {
      const spec = parseChartSpec(String(children ?? ""));
      if (spec) return <AnalyticsChart spec={spec} />;
      return <em>Chart couldn&apos;t be drawn — its saved spec didn&apos;t validate.</em>;
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
};

const useStyles = makeStyles({
  header: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalM,
  },
  titleWrap: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
    minWidth: 0,
    flex: 1,
  },
  titleRow: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalXS },
  stamp: { color: tokens.colorNeutralForeground3 },
  actions: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalXS, flexShrink: 0 },
  center: { display: "flex", justifyContent: "center", padding: tokens.spacingVerticalXXL },
  body: { maxHeight: "70vh", overflowY: "auto" },
  // §35 reading scale — the report reads at the same measure as a chat answer.
  reading: {
    fontSize: CONTENT_TYPE.body,
    lineHeight: CONTENT_TYPE.bodyLineHeight,
    color: tokens.colorNeutralForeground1,
    // The report's own `# title` is shown in the header; hide the in-body dup.
    "& > h1:first-child": { display: "none" },
    "& h2": {
      fontSize: `min(${CONTENT_TYPE.h2}, ${CONTENT_TYPE.h2Max})`,
      marginTop: tokens.spacingVerticalL,
      marginBottom: tokens.spacingVerticalS,
    },
    "& h3": {
      fontSize: `min(${CONTENT_TYPE.h3}, ${CONTENT_TYPE.h3Max})`,
      marginTop: tokens.spacingVerticalM,
      marginBottom: tokens.spacingVerticalXS,
    },
    "& table": {
      borderCollapse: "collapse",
      display: "block",
      overflowX: "auto",
      fontVariantNumeric: "tabular-nums",
      marginTop: tokens.spacingVerticalS,
    },
    "& th, & td": {
      borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
      padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalS}`,
      textAlign: "left",
      fontSize: CONTENT_TYPE.tableCellCompact,
    },
    "& pre": {
      backgroundColor: tokens.colorNeutralBackground3,
      padding: tokens.spacingVerticalS,
      borderRadius: tokens.borderRadiusMedium,
      overflowX: "auto",
    },
  },
});

export function ReportReaderHost() {
  const styles = useStyles();
  const [id, setId] = useState<string | null>(null);
  const [note, setNote] = useState<{ markdown: string; name: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  // Open on the event — every report door dispatches lighthouse:open-report {id}.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<{ id?: string }>).detail;
      if (d?.id) setId(d.id);
    };
    window.addEventListener(OPEN_REPORT_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_REPORT_EVENT, onOpen);
  }, []);

  // Read the saved note's full markdown when an id arrives (local vault read).
  useEffect(() => {
    if (!id) {
      setNote(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    setNote(null);
    ragService
      .readNote(id)
      .then((r) => {
        if (cancelled) return;
        setLoading(false);
        if (r.markdown) setNote(r);
        else setFailed(true);
      })
      .catch(() => {
        if (!cancelled) {
          setLoading(false);
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const title = useMemo(() => (note?.name ?? "").replace(/\.md$/, ""), [note]);
  const generated = useMemo(() => note?.markdown.match(/_Generated (.+?) —/)?.[1]?.trim() ?? "", [note]);
  const reportInput = useMemo(
    () => (note ? { title: title || "Report", markdown: note.markdown } : null),
    [note, title],
  );

  const close = useCallback(() => setId(null), []);

  return (
    <Dialog
      open={id !== null}
      onOpenChange={(_, d) => {
        if (!d.open) close();
      }}
    >
      <LhDialogSurface>
        <DialogBody>
          <DialogTitle>
            <div className={styles.header}>
              <div className={styles.titleWrap}>
                <div className={styles.titleRow}>
                  <IconReport />
                  <Text weight="semibold" size={400} truncate wrap={false}>
                    {title || "Report"}
                  </Text>
                </div>
                {generated && (
                  <Text size={200} className={styles.stamp}>
                    Generated {generated}
                  </Text>
                )}
              </div>
              <div className={styles.actions}>
                {reportInput && (
                  <LhMenu
                    trigger={
                      <Button appearance="subtle" size="small" icon={<IconDoc />}>
                        Export
                      </Button>
                    }
                    items={[
                      {
                        key: "md",
                        label: "Markdown (.md)",
                        onClick: () => void exportReportMarkdown(reportInput.title, reportInput.markdown),
                      },
                      {
                        key: "html",
                        label: "Web page (.html)",
                        onClick: () => void exportReportHtml(reportInput),
                      },
                      {
                        key: "print",
                        label: "Print / Save as PDF",
                        onClick: () => {
                          printReport(reportInput);
                        },
                      },
                    ]}
                    aria-label="Export report"
                  />
                )}
                {id && (
                  <Button
                    appearance="subtle"
                    size="small"
                    onClick={() => {
                      if (typeof window !== "undefined") {
                        window.dispatchEvent(
                          new CustomEvent("lighthouse:reveal-node", { detail: { id } }),
                        );
                      }
                    }}
                  >
                    Reveal in Files
                  </Button>
                )}
                <Button appearance="subtle" size="small" onClick={close} aria-label="Close report">
                  Close
                </Button>
              </div>
            </div>
          </DialogTitle>
          <DialogContent className={styles.body}>
            {loading && (
              <div className={styles.center}>
                <Spinner size="tiny" label="Opening report…" />
              </div>
            )}
            {failed && !loading && (
              <Text className={styles.stamp}>
                This report couldn&apos;t be opened — it may have been moved or removed.
              </Text>
            )}
            {note && !loading && !failed && (
              <div className={styles.reading}>
                <MarkdownView content={note.markdown} components={readerComponents} />
              </div>
            )}
          </DialogContent>
        </DialogBody>
      </LhDialogSurface>
    </Dialog>
  );
}
