"use client";

/**
 * [TEAM: insights] The sidebar's proactive "What stands out" panel (openspec:
 * add-quant-depth §5) — the one surface that shows a noteworthy finding WITHOUT
 * the user asking a question. It sits at the TOP of the analytics nav group (the
 * SemanticNav / RecipesNav / ViewsNav Library siblings) so it is visible without
 * a click, and it renders whatever `ragService.insights()` returns:
 *  - one compact row per finding: a small badge for its kind (Anomaly / Mover /
 *    Changepoint), the source table, and the engine-computed `headline` rendered
 *    VERBATIM (never model text — every number in it is engine SQL);
 *  - the "scanned N of M tables" disclosure when the scan was capped
 *    (`tablesAvailable > tablesScanned`) — a capped set is never presented as
 *    exhaustive;
 *  - a loading state while the scan runs;
 *  - an honest empty state ("nothing stands out") — an empty scan is a valid,
 *    truthful result, not an error.
 *
 * v1 POSTURE: compute on show (mount) and on the shared vault-change signal (the
 * RecipesNav/SemanticNav lifecycle — the vault poll rebuilds `nodes` only on a
 * real change), NOT a new always-on background poll. The findings are already
 * ranked + bounded by the engine; this panel only presents them.
 *
 * PARITY: the scan is Rust-only (DataFusion), so the web dev twin returns an
 * empty scan and the panel naturally shows the empty state under `npm run dev` —
 * that is correct and deliberately not special-cased. Beam treatment: Fluent
 * tokens only (the ViewsNav/RecipesNav palette), both light + dark themes free.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Spinner,
  Text,
  makeStyles,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import { ChevronDownRegular, ChevronRightRegular } from "@fluentui/react-icons";
import type { InsightKind, InsightsScan } from "@/contracts";
import { ragService } from "@/contracts";
import { useRagStore } from "@/stores/useRagStore";

const useStyles = makeStyles({
  // The Library-sibling section chrome — the exact RecipesNav/SemanticNav
  // treatment (hairline below, breathing room), no new tokens.
  section: {
    display: "flex",
    flexDirection: "column",
    gap: "1px",
    paddingTop: tokens.spacingVerticalM,
    paddingBottom: tokens.spacingVerticalS,
    marginBottom: tokens.spacingVerticalS,
    ...shorthands.borderBottom("1px", "solid", tokens.colorNeutralStroke2),
  },
  // The header doubles as the collapse toggle (the "collapsible card"): a subtle
  // full-width button, chevron + label, no bespoke colors.
  header: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    width: "100%",
    textAlign: "left",
    ...shorthands.border("none"),
    backgroundColor: "transparent",
    color: "inherit",
    ...shorthands.padding("2px", tokens.spacingHorizontalS),
    borderRadius: tokens.borderRadiusMedium,
    cursor: "pointer",
    marginBottom: tokens.spacingVerticalXXS,
    ":hover": { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
  headerLabel: { color: tokens.colorNeutralForeground3, flex: 1, minWidth: 0 },
  chevron: { color: tokens.colorNeutralForeground3, flexShrink: 0, fontSize: "16px" },
  // A two-line finding row: badge + table on top, the engine headline below.
  row: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    width: "100%",
    ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalS),
    borderRadius: tokens.borderRadiusMedium,
    minHeight: "32px",
    ":hover": { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
  rowTop: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    minWidth: 0,
  },
  rowTable: {
    color: tokens.colorNeutralForeground3,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
  },
  rowHeadline: { color: tokens.colorNeutralForeground1 },
  badge: { flexShrink: 0 },
  // Quiet inline notes (loading / disclosure / empty) — the ViewsNav `note`
  // register, one shared treatment.
  note: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    color: tokens.colorNeutralForeground3,
    ...shorthands.padding("2px", tokens.spacingHorizontalS),
  },
  disclosure: {
    color: tokens.colorNeutralForeground3,
    ...shorthands.padding(tokens.spacingVerticalXXS, tokens.spacingHorizontalS, "0"),
  },
});

/**
 * How each detector's kind reads as a badge. Fluent `color` tokens are
 * theme-aware (light + dark) — no hand-picked colors. Anomaly leans danger
 * (an out-of-fence value), a mover is a brand-highlighted change, a changepoint
 * is an informative level shift.
 */
const KIND_BADGE: Record<InsightKind, { label: string; color: "danger" | "brand" | "informative" }> = {
  anomaly: { label: "Anomaly", color: "danger" },
  mover: { label: "Mover", color: "brand" },
  changepoint: { label: "Changepoint", color: "informative" },
};

const EMPTY_SCAN: InsightsScan = { findings: [], tablesScanned: 0, tablesAvailable: 0 };

export function InsightsNav() {
  const styles = useStyles();

  // The vault-change refresh signal (the RecipesNav idiom): the poll rebuilds
  // `nodes` only on a real change, and we key off the tabular-file IDENTITIES so
  // adding/removing/renaming a table re-scans while idle polls — and inclusion
  // toggles, which don't change the catalog's table set — do not.
  const nodes = useRagStore((s) => s.nodes);
  const tableKey = useMemo(
    () =>
      nodes
        .filter((n) => n.kind === "file" && /\.(csv|tsv|xlsx?|xlsm|parquet)$/i.test(n.name))
        .map((n) => n.id)
        .join("\n"),
    [nodes],
  );

  const [scan, setScan] = useState<InsightsScan>(EMPTY_SCAN);
  const [loaded, setLoaded] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  // Compute on show (mount) and whenever the vault's table set changes. No
  // background poll — the effect re-arms only on a real catalog change.
  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    ragService
      .insights()
      .then((s) => {
        if (cancelled) return;
        setScan({
          findings: Array.isArray(s.findings) ? s.findings : [],
          tablesScanned: typeof s.tablesScanned === "number" ? s.tablesScanned : 0,
          tablesAvailable: typeof s.tablesAvailable === "number" ? s.tablesAvailable : 0,
        });
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        // A failed scan degrades to the honest empty state, never an error card.
        setScan(EMPTY_SCAN);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [tableKey]);

  const findings = scan.findings;
  // Disclose whenever the scan was capped — never present a capped set as
  // exhaustive (openspec: add-quant-depth §5).
  const capped = scan.tablesAvailable > scan.tablesScanned;

  return (
    <nav aria-label="What stands out" className={styles.section}>
      <button
        type="button"
        className={styles.header}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((c) => !c)}
      >
        {collapsed ? (
          <ChevronRightRegular className={styles.chevron} aria-hidden />
        ) : (
          <ChevronDownRegular className={styles.chevron} aria-hidden />
        )}
        <Text size={200} weight="semibold" className={styles.headerLabel}>
          What stands out
        </Text>
      </button>

      {!collapsed && (
        <>
          {!loaded && (
            <div className={styles.note} role="status">
              <Spinner size="tiny" label="Scanning your data…" labelPosition="after" />
            </div>
          )}

          {loaded &&
            findings.map((f, i) => {
              const badge = KIND_BADGE[f.kind];
              return (
                <div key={`${f.table}:${f.kind}:${i}`} className={styles.row} title={f.headline}>
                  <div className={styles.rowTop}>
                    <Badge
                      className={styles.badge}
                      appearance="tint"
                      color={badge?.color ?? "informative"}
                      size="small"
                    >
                      {badge?.label ?? f.kind}
                    </Badge>
                    <Text size={200} className={styles.rowTable}>
                      {f.table}
                    </Text>
                  </div>
                  {/* The engine's headline, rendered VERBATIM — never model text. */}
                  <Text size={300} className={styles.rowHeadline}>
                    {f.headline}
                  </Text>
                </div>
              );
            })}

          {loaded && findings.length === 0 && (
            <Text size={200} className={styles.note}>
              Nothing stands out right now — your data looks steady. New findings appear here as your
              files change.
            </Text>
          )}

          {loaded && capped && (
            <Text size={200} className={styles.disclosure} role="note">
              Scanned {scan.tablesScanned} of {scan.tablesAvailable} tables.
            </Text>
          )}
        </>
      )}
    </nav>
  );
}
