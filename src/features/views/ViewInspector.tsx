"use client";

/**
 * [TEAM: views] "Inspector on a view" (openspec: add-shaped-views §4) — a
 * READ-ONLY inspector for one saved view, the FileInspector sibling for the
 * Library. Opened by the `lighthouse:inspect-view` DOM event the Library nav
 * dispatches (requestViewInspect); the nav owns the single instance and drives
 * it via `viewId` (mirrors how a file row opens FileInspector).
 *
 * It renders `inspectView(id)` — pure stored state, so BOTH engines fill the
 * identical shape (no Rust-only fields, unlike FileInspection): the exact
 * definition SELECT, the provenance-labeled summary, the source files it reads
 * (transitively) with their saved-age freshness, an effectively-local-only
 * badge + explanation, the views it builds on, and who reads it. Rename and
 * delete live in the nav's menu + their dialogs — this panel NEVER mutates and
 * NEVER calls the model. Unknown id → the empty `{}` inspection, rendered as an
 * honest "no longer available" rather than a blank.
 *
 * Beam treatment: Fluent tokens only, so both light and dark come for free; the
 * SQL block mirrors the ShapeViewDialog / Edit-SQL monospace code register.
 */
import { useEffect, useState } from "react";
import {
  Badge,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Spinner,
  Text,
  makeStyles,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import { LockClosedRegular } from "@fluentui/react-icons";
import { ragService, type ViewInspection } from "@/contracts";

/** DOM CustomEvent that opens the Library's view inspector. Dispatched by the
 *  ViewsNav rows/menu (requestViewInspect); listened for in ViewsNav, which
 *  owns the single inspector instance (the FileInspectorHost idiom). */
export const INSPECT_VIEW_EVENT = "lighthouse:inspect-view";

export interface InspectViewDetail {
  viewId: string;
}

/** Open the view inspector (same-window path). No-op outside a browser. */
export function requestViewInspect(viewId: string): void {
  if (typeof window === "undefined" || !viewId) return;
  window.dispatchEvent(new CustomEvent(INSPECT_VIEW_EVENT, { detail: { viewId } }));
}

const useStyles = makeStyles({
  body: {
    display: "flex",
    flexDirection: "column",
    ...shorthands.gap("14px"),
    minWidth: "min(560px, 80vw)",
  },
  section: { display: "flex", flexDirection: "column", ...shorthands.gap("4px") },
  label: { color: tokens.colorNeutralForeground3, fontWeight: tokens.fontWeightSemibold },
  // The definition SELECT — the Edit-SQL / ShapeViewDialog monospace register.
  sql: {
    margin: 0,
    ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalM),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    backgroundColor: tokens.colorNeutralBackground3,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground1,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    overflowX: "auto",
  },
  sourceRow: { display: "flex", flexWrap: "wrap", alignItems: "baseline", ...shorthands.gap("6px") },
  muted: { color: tokens.colorNeutralForeground3, fontStyle: "italic" },
  // Local-only: the same lock language the file inspector uses, no new colors.
  privatePill: { display: "inline-flex", alignItems: "center", ...shorthands.gap("6px") },
  footNote: { color: tokens.colorNeutralForeground3 },
});

/** The human label for where a summary came from — the provenance the view
 *  never carries without. */
function provenanceLabel(source: ViewInspection["summarySource"]): string {
  return source === "question" ? "from your question" : "described by the model";
}

export function ViewInspector({
  viewId,
  onClose,
}: {
  /** The view to inspect; null closes the panel. */
  viewId: string | null;
  onClose: () => void;
}) {
  const styles = useStyles();
  const [data, setData] = useState<ViewInspection | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-fetch whenever a new view opens. Pure stored-state read — no SQL runs,
  // no model is consulted.
  useEffect(() => {
    if (!viewId) return;
    let live = true;
    setData(null);
    setError(null);
    setLoading(true);
    ragService
      .inspectView(viewId)
      .then((res) => {
        if (live) setData(res);
      })
      .catch(() => {
        if (live) setError("Couldn't inspect this view.");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [viewId]);

  // The empty `{}` inspection (unknown / just-deleted id) carries no id.
  const known = data != null && !!data.id;
  const title = data?.name ?? "";
  const sources = data?.sources ?? [];
  const readsViews = data?.readsViews ?? [];
  const dependents = data?.dependents ?? [];
  const localOnly = data?.localOnly === true;

  return (
    <Dialog
      open={viewId !== null}
      onOpenChange={(_, d) => {
        if (!d.open) onClose();
      }}
    >
      <DialogSurface aria-describedby={undefined}>
        <DialogBody>
          <DialogTitle>Saved view{title ? ` — ${title}` : ""}</DialogTitle>
          <DialogContent className={styles.body}>
            {loading && <Spinner size="tiny" label="Loading…" labelPosition="after" />}
            {error && <Text className={styles.muted}>{error}</Text>}

            {data && !loading && !known && (
              <Text className={styles.muted}>This view is no longer available.</Text>
            )}

            {known && !loading && (
              <>
                <div className={styles.section}>
                  <Badge appearance="tint" color="informative">
                    Saved view
                  </Badge>
                </div>

                {/* The exact SELECT the engine re-guards and runs at ask time. */}
                <div className={styles.section}>
                  <Text className={styles.label}>Definition</Text>
                  <pre className={styles.sql}>{data.sql ?? ""}</pre>
                </div>

                {/* The one-line summary with its provenance label — a view never
                    carries an unlabeled summary. */}
                <div className={styles.section}>
                  <Text className={styles.label}>Summary</Text>
                  {data.summary ? (
                    <div className={styles.sourceRow}>
                      <Text>{data.summary}</Text>
                      <Badge appearance="outline" color="informative">
                        {provenanceLabel(data.summarySource)}
                      </Badge>
                    </div>
                  ) : (
                    <Text className={styles.muted}>No description.</Text>
                  )}
                </div>

                {/* The source files it reads (transitively), with freshness from
                    their saved times — a source the id no longer resolves to is
                    reported honestly, never dropped. */}
                <div className={styles.section}>
                  <Text className={styles.label}>Reads from</Text>
                  {sources.length === 0 ? (
                    <Text className={styles.muted}>No source files.</Text>
                  ) : (
                    sources.map((s) => (
                      <div key={s.fileId} className={styles.sourceRow}>
                        {s.missing ? (
                          <Text>
                            {s.name} <span className={styles.muted}>(no longer in the vault)</span>
                          </Text>
                        ) : (
                          <Text>
                            {s.name}
                            {s.savedAge ? ` · saved ${s.savedAge}` : ""}
                          </Text>
                        )}
                      </div>
                    ))
                  )}
                </div>

                {/* Views this one builds on (the stack above the files). */}
                {readsViews.length > 0 && (
                  <div className={styles.section}>
                    <Text className={styles.label}>Builds on</Text>
                    <Text>{readsViews.join(", ")}</Text>
                  </div>
                )}

                {/* Effectively local-only: any transitive source file is marked
                    private, so the view never leaves this device. */}
                {localOnly && (
                  <div className={styles.section}>
                    <span className={styles.privatePill}>
                      <LockClosedRegular />
                      <Text>Private — this device only</Text>
                    </span>
                    <Text size={200} className={styles.footNote}>
                      A source this view reads is marked private, so it is never sent to a cloud
                      model and never appears in a cloud answer.
                    </Text>
                  </div>
                )}

                {/* Who reads it — what the rename/delete dialogs warn with. */}
                {dependents.length > 0 && (
                  <div className={styles.section}>
                    <Text className={styles.label}>Used by</Text>
                    <Text>{dependents.join(", ")}</Text>
                  </div>
                )}

                <Text size={200} className={styles.footNote}>
                  Read-only — nothing here changes your files, their data, or this view.
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
