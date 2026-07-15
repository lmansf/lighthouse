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
 */
import { useEffect, useState, type ReactNode } from "react";
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
  shorthands,
  tokens,
} from "@fluentui/react-components";
import {
  EyeOffRegular,
  EyeRegular,
  LockClosedRegular,
  LockOpenRegular,
  SearchRegular,
} from "@fluentui/react-icons";
import { ragService, type FileInspection } from "@/contracts";

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
  hit: {
    display: "flex",
    flexDirection: "column",
    ...shorthands.gap("4px"),
    ...shorthands.padding("6px", "8px"),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    backgroundColor: tokens.colorNeutralBackground2,
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
}: {
  /** The file to inspect; null closes the panel. */
  fileId: string | null;
  /** The row's display name, shown immediately while the payload loads. */
  fileName: string;
  /** True in the packaged desktop app — the web dev twin omits Rust-only fields. */
  desktop: boolean;
  onClose: () => void;
}) {
  const styles = useStyles();
  const [data, setData] = useState<FileInspection | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<FileInspection["testSearch"] | null>(null);

  // Fetch the (metadata-only) inspection whenever a new file is opened.
  useEffect(() => {
    if (!fileId) return;
    let live = true;
    setData(null);
    setError(null);
    setHits(null);
    setQuery("");
    setLoading(true);
    ragService
      .inspect(fileId)
      .then((res) => {
        if (live) setData(res);
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
  }, [fileId]);

  const runSearch = () => {
    const q = query.trim();
    if (!fileId || !q) return;
    setSearching(true);
    ragService
      .inspect(fileId, q)
      .then((res) => setHits(res.testSearch ?? []))
      .catch(() => setHits([]))
      .finally(() => setSearching(false));
  };

  const name = data?.name ?? fileName;
  const included = data?.included;
  const localOnly = data?.localOnly === true;
  const tabular = data?.chunkMode === "tabular";

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
                {/* Visibility + private mark — the SAME wording as the row. */}
                <div className={styles.section}>
                  <Text className={styles.label}>Status</Text>
                  <div className={styles.stateRow}>
                    <span className={styles.pill}>
                      {included ? <EyeRegular /> : <EyeOffRegular />}
                      <Text>{included ? "Visible to AI" : "Hidden from AI"}</Text>
                    </span>
                    <span className={styles.pill}>
                      {localOnly ? <LockClosedRegular /> : <LockOpenRegular />}
                      <Text>{localOnly ? "Private — this device only" : "Shareable with cloud models"}</Text>
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
                        {hits.map((h, i) => (
                          <div key={i} className={styles.hit}>
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
            <Button appearance="secondary" onClick={onClose}>
              Close
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
