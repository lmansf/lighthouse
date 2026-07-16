"use client";

/**
 * [TEAM: explorer]
 *
 * "What the AI sees" — a READ-ONLY per-file inspector (openspec:
 * add-file-inspector). Opened from a file row's context menu, it shows exactly
 * what the engine extracted, chunked, catalogued, and indexed for one file — in
 * plain language, next to the same inclusion + local-only wording the row uses —
 * plus a bounded test-search that reuses the real retrieval scorer, scoped to
 * this one file.
 *
 * It NEVER mutates: every value is surfaced, nothing is written. The Rust engine
 * fills every field; the web dev twin omits the Rust-engine-only ones (OCR flag,
 * chunk count, column catalog, index freshness), which this panel renders as a
 * muted "desktop app only" rather than a blank (honest degradation).
 *
 * Citation → preview (time-savers, feature 4): the panel doubles as the in-app
 * preview a chat citation opens. `initialQuery` prefills the test-search and
 * runs it in the same round trip; `highlightTop` lands the selection on the
 * cited chunk (scrolled + highlighted), and ‹ › / ← → step through the scored
 * chunk list. "Open in app" stays available as the secondary action.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Badge,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Input,
  Spinner,
  Text,
  makeStyles,
  mergeClasses,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import {
  ChevronLeftRegular,
  ChevronRightRegular,
  EyeOffRegular,
  EyeRegular,
  LockClosedRegular,
  LockOpenRegular,
  OpenRegular,
  SearchRegular,
} from "@fluentui/react-icons";
import { ragService, type FileInspection } from "@/contracts";
import { useRagStore } from "@/stores/useRagStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { cloudProviderActive } from "@/lib/privacyState";
import {
  citedChunkIndex,
  INSPECT_FILE_EVENT,
  type InspectFileDetail,
} from "@/lib/citePreview";

const useStyles = makeStyles({
  body: { display: "flex", flexDirection: "column", ...shorthands.gap("14px"), minWidth: "min(560px, 80vw)" },
  section: { display: "flex", flexDirection: "column", ...shorthands.gap("4px") },
  label: { color: tokens.colorNeutralForeground3, fontWeight: tokens.fontWeightSemibold },
  stateRow: { display: "flex", flexWrap: "wrap", alignItems: "center", ...shorthands.gap("8px") },
  pill: { display: "inline-flex", alignItems: "center", ...shorthands.gap("6px") },
  preview: {
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    maxHeight: "180px",
    overflowY: "auto",
    ...shorthands.padding("8px", "10px"),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    backgroundColor: tokens.colorNeutralBackground3,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground1,
  },
  muted: { color: tokens.colorNeutralForeground3, fontStyle: "italic" },
  ocr: { color: tokens.colorPaletteDarkOrangeForeground1 },
  cols: { display: "flex", flexWrap: "wrap", ...shorthands.gap("6px") },
  searchRow: { display: "flex", ...shorthands.gap("8px") },
  // Chunk navigation header: "Chunk k of n" + the ‹ › steppers.
  navRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    ...shorthands.gap("8px"),
  },
  navBtns: { display: "flex", alignItems: "center", ...shorthands.gap("2px") },
  hit: {
    display: "flex",
    flexDirection: "column",
    ...shorthands.gap("4px"),
    ...shorthands.padding("6px", "8px"),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    backgroundColor: tokens.colorNeutralBackground2,
  },
  // The selected (cited / stepped-to) chunk: brand tint + inset ring — an
  // inset shadow rather than a border so selection never shifts layout, and
  // theme tokens so it reads in both light and dark.
  hitActive: {
    backgroundColor: tokens.colorBrandBackground2,
    boxShadow: `inset 0 0 0 2px ${tokens.colorBrandStroke1}`,
  },
  hitText: { whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: tokens.fontSizeBase200 },
  bar: {
    position: "relative",
    height: "5px",
    ...shorthands.borderRadius("3px"),
    backgroundColor: tokens.colorNeutralBackground5,
    overflow: "hidden",
  },
  barFill: { position: "absolute", left: 0, top: 0, bottom: 0, backgroundColor: tokens.colorBrandBackground },
  hitMeta: { display: "flex", justifyContent: "space-between", ...shorthands.gap("8px") },
  footNote: { color: tokens.colorNeutralForeground3 },
});

/** A Rust-only datum: its value on the shipping engine, "desktop app only" on
 *  the web twin (which omits it), never a blank. */
function Engineered({
  desktop,
  present,
  children,
}: {
  desktop: boolean;
  /** Whether the value is present (desktop, and computed). */
  present: boolean;
  children: ReactNode;
}) {
  const styles = useStyles();
  if (!desktop) return <Text className={styles.muted}>desktop app only</Text>;
  if (!present) return <Text className={styles.muted}>not yet indexed</Text>;
  return <>{children}</>;
}

/** Render "mtimeMs:size" as a friendly local timestamp (falls back to raw). */
function indexedLabel(key: string): string {
  const ms = Number.parseFloat(key.split(":")[0] ?? "");
  if (!Number.isFinite(ms) || ms <= 0) return key;
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return key;
  }
}

export function FileInspector({
  fileId,
  fileName,
  desktop,
  onClose,
  initialQuery,
  highlightTop,
}: {
  /** The file to inspect; null closes the panel. */
  fileId: string | null;
  /** The row's display name, shown immediately while the payload loads. */
  fileName: string;
  /** True in the packaged desktop app — the web dev twin omits Rust-only fields. */
  desktop: boolean;
  onClose: () => void;
  /** Citation → preview: prefill the test-search with this query and run it in
   *  the same round trip as the inspection (absent/empty ⇒ plain inspector). */
  initialQuery?: string;
  /** With `initialQuery`: select, scroll to, and highlight the cited chunk —
   *  the best-scored hit still containing the query (see citedChunkIndex). */
  highlightTop?: boolean;
}) {
  const styles = useStyles();
  const [data, setData] = useState<FileInspection | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<FileInspection["testSearch"] | null>(null);
  // The selected chunk (rank index into `hits`): the cited chunk on a
  // citation open, then wherever ‹ › / ← → step. null = nothing selected.
  const [active, setActive] = useState<number | null>(null);
  const hitsRef = useRef<FileInspection["testSearch"] | null>(null);
  hitsRef.current = hits;
  const hitEls = useRef<(HTMLDivElement | null)[]>([]);

  // Fetch the inspection whenever a new file is opened. A citation preview
  // (initialQuery) folds the chunk-locating test-search into the SAME round
  // trip and — with highlightTop — lands selected on the cited chunk.
  useEffect(() => {
    if (!fileId) return;
    let live = true;
    const q = initialQuery?.trim() ?? "";
    setData(null);
    setError(null);
    setHits(null);
    setActive(null);
    setQuery(q);
    setLoading(true);
    ragService
      .inspect(fileId, q || undefined)
      .then((res) => {
        if (!live) return;
        setData(res);
        if (q) {
          const hs = res.testSearch ?? [];
          setHits(hs);
          if (highlightTop) {
            const cited = citedChunkIndex(hs, q);
            if (cited >= 0) setActive(cited);
          }
        }
      })
      .catch(() => {
        if (live) setError("Couldn't inspect this file.");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [fileId, initialQuery, highlightTop]);

  const runSearch = () => {
    const q = query.trim();
    if (!fileId || !q) return;
    setSearching(true);
    setActive(null); // a fresh manual search starts unselected
    ragService
      .inspect(fileId, q)
      .then((res) => setHits(res.testSearch ?? []))
      .catch(() => setHits([]))
      .finally(() => setSearching(false));
  };

  /** Step the selection through the scored chunk list (buttons and ← →). */
  const stepChunk = useCallback((delta: number) => {
    setActive((a) => {
      const n = hitsRef.current?.length ?? 0;
      if (n === 0) return a;
      if (a === null) return 0; // first step from "nothing selected" selects the top hit
      return Math.min(n - 1, Math.max(0, a + delta));
    });
  }, []);

  // ← / → step through the chunks while the dialog is open — except while
  // typing in a field, where the arrows must keep moving the caret.
  useEffect(() => {
    if (!fileId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if ((hitsRef.current?.length ?? 0) === 0) return;
      e.preventDefault();
      stepChunk(e.key === "ArrowRight" ? 1 : -1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fileId, stepChunk]);

  // Bring the selected chunk into view (citation opens land scrolled to it).
  useEffect(() => {
    if (active === null || !hits || hits.length === 0) return;
    hitEls.current[active]?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [active, hits]);

  /** Secondary action: hand the file to its OS app (desktop only; same route
   *  as the chat reference cards — the web twin's route no-ops). */
  const openInApp = () => {
    if (!fileId) return;
    void fetch("/api/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId: fileId }),
    }).catch(() => {});
  };

  const name = data?.name ?? fileName;
  const included = data?.included;
  const localOnly = data?.localOnly === true;
  const tabular = data?.chunkMode === "tabular";
  // The private pill carries the lock's two states (0.12.1 §2, the row's
  // vocabulary): under a cloud provider the mark is ENFORCING right now;
  // under the private model it's armed but idle. Same single rule as the
  // engine's is_cloud_provider (src/lib/privacyState.ts).
  const providerId = useAuthStore((s) => s.onboarding.providerId);
  const privatePill = localOnly
    ? cloudProviderActive(providerId)
      ? "Private — hidden from cloud models right now"
      : "Private — hidden from cloud models. The private model can always read it."
    : "Shareable with cloud models";

  return (
    <Dialog open={fileId !== null} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface aria-describedby={undefined}>
        <DialogBody>
          <DialogTitle>What the AI sees — {name}</DialogTitle>
          <DialogContent className={styles.body}>
            {loading && <Spinner size="tiny" label="Inspecting…" labelPosition="after" />}
            {error && <Text className={styles.muted}>{error}</Text>}

            {data && !loading && (
              <>
                {/* Visibility + private mark — the row's two-state vocabulary
                    (see privatePill above). */}
                <div className={styles.section}>
                  <Text className={styles.label}>Status</Text>
                  <div className={styles.stateRow}>
                    <span className={styles.pill}>
                      {included ? <EyeRegular /> : <EyeOffRegular />}
                      <Text>{included ? "Visible to AI" : "Hidden from AI"}</Text>
                    </span>
                    <span className={styles.pill}>
                      {localOnly ? <LockClosedRegular /> : <LockOpenRegular />}
                      <Text>{privatePill}</Text>
                    </span>
                  </div>
                  {/* Attribution (openspec: add-curation-rules): when a RULE set
                      an effective flag, say so by name — the legibility line.
                      Explicit/ancestor/default states keep the plain pills. */}
                  {data.includedBy?.source === "rule" && data.includedBy.ruleName && (
                    <Text size={200} className={styles.footNote}>
                      {included ? "Included" : "Hidden"} by rule &ldquo;{data.includedBy.ruleName}&rdquo;.
                    </Text>
                  )}
                  {data.localOnlyBy?.source === "rule" && data.localOnlyBy.ruleName && localOnly && (
                    <Text size={200} className={styles.footNote}>
                      Kept on this device by rule &ldquo;{data.localOnlyBy.ruleName}&rdquo;.
                    </Text>
                  )}
                </div>

                {/* Extracted text preview — what the model would actually read. */}
                <div className={styles.section}>
                  <Text className={styles.label}>Extracted text</Text>
                  {data.extractPreview ? (
                    <>
                      <div className={styles.preview}>{data.extractPreview}</div>
                      {desktop ? (
                        data.fromOcr ? (
                          <Text size={200} className={styles.ocr}>
                            Read by OCR — may contain recognition errors.
                          </Text>
                        ) : null
                      ) : (
                        <Text size={200} className={styles.muted}>
                          OCR detection: desktop app only
                        </Text>
                      )}
                    </>
                  ) : (
                    <Text className={styles.muted}>
                      No extractable text — this file is found by name only.
                    </Text>
                  )}
                </div>

                {/* Chunking mode + count. */}
                <div className={styles.section}>
                  <Text className={styles.label}>Chunking</Text>
                  <div className={styles.stateRow}>
                    <Text>
                      {tabular ? "By rows (tabular)" : "By words (prose)"}
                    </Text>
                    <Text>·</Text>
                    <Engineered desktop={desktop} present={data.chunkCount != null}>
                      <Text>{data.chunkCount} chunks</Text>
                    </Engineered>
                  </div>
                </div>

                {/* Detected columns + kinds — tabular files only. */}
                {tabular && (
                  <div className={styles.section}>
                    <Text className={styles.label}>Columns</Text>
                    <Engineered desktop={desktop} present={(data.columns?.length ?? 0) > 0}>
                      <div className={styles.cols}>
                        {data.columns?.map((c) => (
                          <Badge key={c.name} appearance="outline" color="informative">
                            {c.name} · {c.kind}
                          </Badge>
                        ))}
                      </div>
                    </Engineered>
                  </div>
                )}

                {/* Index freshness. */}
                <div className={styles.section}>
                  <Text className={styles.label}>Index</Text>
                  <Engineered desktop={desktop} present={data.indexedAt != null}>
                    <Text>
                      Indexed {data.indexedAt ? indexedLabel(data.indexedAt) : ""} —{" "}
                      {data.fresh ? "up to date" : "changed on disk; re-read on the next question"}
                    </Text>
                  </Engineered>
                </div>

                {/* Test-search — the real scorer, scoped to this one file. */}
                <div className={styles.section}>
                  <Text className={styles.label}>Test a search</Text>
                  <div className={styles.searchRow}>
                    <Input
                      style={{ flex: 1 }}
                      value={query}
                      placeholder="See which chunks a question would retrieve…"
                      aria-label="Test a search against this file"
                      contentBefore={<SearchRegular />}
                      onChange={(_, d) => setQuery(d.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          runSearch();
                        }
                      }}
                    />
                    <Button appearance="primary" onClick={runSearch} disabled={!query.trim() || searching}>
                      Search
                    </Button>
                  </div>
                  {searching && <Spinner size="tiny" label="Searching…" labelPosition="after" />}
                  {hits && !searching && (
                    hits.length === 0 ? (
                      <Text className={styles.muted}>
                        {included
                          ? "No chunks matched — the AI would retrieve nothing from this file for that query."
                          : "This file is hidden from the AI, so it retrieves nothing from it."}
                      </Text>
                    ) : (
                      <div className={styles.section}>
                        {/* Prev/next chunk navigation over the scored list. */}
                        <div className={styles.navRow}>
                          <Text size={200} className={styles.label} aria-live="polite">
                            {active !== null
                              ? `Chunk ${active + 1} of ${hits.length}`
                              : `${hits.length} matching chunk${hits.length === 1 ? "" : "s"}`}
                          </Text>
                          <span className={styles.navBtns}>
                            <Button
                              size="small"
                              appearance="subtle"
                              icon={<ChevronLeftRegular />}
                              aria-label="Previous chunk (left arrow)"
                              title="Previous chunk (←)"
                              disabled={active === null || active === 0}
                              onClick={() => stepChunk(-1)}
                            />
                            <Button
                              size="small"
                              appearance="subtle"
                              icon={<ChevronRightRegular />}
                              aria-label="Next chunk (right arrow)"
                              title="Next chunk (→)"
                              disabled={active !== null && active >= hits.length - 1}
                              onClick={() => stepChunk(1)}
                            />
                          </span>
                        </div>
                        {hits.map((h, i) => (
                          <div
                            key={i}
                            ref={(el) => {
                              hitEls.current[i] = el;
                            }}
                            className={mergeClasses(styles.hit, i === active && styles.hitActive)}
                          >
                            <div className={styles.hitMeta}>
                              <Text size={200} className={styles.label}>
                                chunk {i + 1}
                              </Text>
                              <Text size={200}>score {h.score.toFixed(2)}</Text>
                            </div>
                            <div className={styles.bar}>
                              <div
                                className={styles.barFill}
                                style={{ width: `${Math.round(Math.min(1, Math.max(0, h.score)) * 100)}%` }}
                              />
                            </div>
                            <Text className={styles.hitText}>{h.text}</Text>
                          </div>
                        ))}
                        {highlightTop && (initialQuery?.trim() ?? "") !== "" && active !== null && (
                          <Text size={200} className={styles.footNote}>
                            Opened from a citation — the highlighted chunk is the passage the
                            answer drew on; ‹ › (or ← →) steps through the other matches.
                          </Text>
                        )}
                      </div>
                    )
                  )}
                </div>

                <Text size={200} className={styles.footNote}>
                  Read-only — nothing here changes your files, their visibility, or the index.
                </Text>
              </>
            )}
          </DialogContent>
          <DialogActions>
            {/* Secondary action: the old cold-open, one click away. */}
            {desktop && (
              <Button appearance="secondary" icon={<OpenRegular />} onClick={openInApp}>
                Open in app
              </Button>
            )}
            <Button appearance="secondary" onClick={onClose}>
              Close
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/**
 * App-wide preview host (citation → preview, time-savers feature 4): ONE
 * FileInspector driven by the INSPECT_FILE_EVENT DOM event — dispatched by the
 * chat's citation chips and reference cards (requestFileInspect), and
 * re-broadcast by the desktop transport for the widget's cross-window handoff.
 * Mounted once in app/page.tsx like the other overlays; the explorer keeps its
 * own context-menu-driven FileInspector instance, unchanged.
 */
export function FileInspectorHost() {
  const desktop = useRagStore((s) => s.desktop);
  const [req, setReq] = useState<InspectFileDetail | null>(null);

  useEffect(() => {
    const onInspect = (e: Event) => {
      const d = (e as CustomEvent<Partial<InspectFileDetail>>).detail;
      if (!d || typeof d.fileId !== "string" || !d.fileId) return;
      setReq({
        fileId: d.fileId,
        name: typeof d.name === "string" ? d.name : "",
        query: typeof d.query === "string" && d.query.trim() ? d.query : undefined,
      });
    };
    window.addEventListener(INSPECT_FILE_EVENT, onInspect);
    return () => window.removeEventListener(INSPECT_FILE_EVENT, onInspect);
  }, []);

  return (
    <FileInspector
      fileId={req?.fileId ?? null}
      fileName={req?.name ?? ""}
      desktop={desktop}
      initialQuery={req?.query}
      highlightTop
      onClose={() => setReq(null)}
    />
  );
}
