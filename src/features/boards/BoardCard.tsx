"use client";

/**
 * [TEAM: boards] One board card (openspec: add-boards §2.1, §4.1).
 *
 * A card renders its pin's latest DETERMINISTIC result — engine numbers only,
 * the model is never consulted:
 *
 *  - chart card: the engine's chart spec through the same AnalyticsChart the
 *    transcript uses (parseChartSpec fails closed → next shape);
 *  - stat tile: a single-row/single-value result as a large tabular numeral,
 *    with a ▲/▼ delta and before→after mini-chart when a retained
 *    `pins-changed` payload carries comparable summaries;
 *  - compact table: the engine's row-capped markdown table, statically
 *    rendered (no markdown stack needed for a `|`-grammar table);
 *  - stored snapshot (twin / PARITY: analytics is Rust-only): the pin's last
 *    summary, mini-charted when it parses, labeled "stored";
 *  - tombstone: the pin was deleted — the card says so and offers removal
 *    (removing a card never touches a pin, so this is the one-way cleanup);
 *  - error/staleReason: the engine's reason in the body, freshness line kept
 *    — the pins dialog's honesty.
 *
 * Every card carries a freshness line: live cards show the engine footer's
 * own `Computed from: …` sentence verbatim; stored cards show
 * "stored · checked <relative>" like the pins dialog. Clicking the body
 * drills into the full narrated answer through the normal ask path.
 *
 * Beam treatment (0.12.0): radius-10 card, hairline + ambient rest shadow
 * (tokens.shadow2), tabular numerals, quiet chrome — tokens only, both
 * themes. Reordering is keyboard-first (menu Move up/down); HTML5 drag is an
 * enhancement (the FileExplorer dataTransfer-MIME pattern).
 */

import { type DragEvent, type KeyboardEvent } from "react";
import {
  Badge,
  Button,
  Menu,
  MenuDivider,
  MenuItem,
  MenuItemRadio,
  MenuList,
  MenuTrigger,
  Spinner,
  Text,
  Tooltip,
  makeStyles,
  mergeClasses,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import {
  ArrowDownRegular,
  ArrowUpRegular,
  DeleteRegular,
  MoreHorizontalRegular,
  ReOrderDotsVerticalRegular,
} from "@fluentui/react-icons";
import type {
  BoardCardRef,
  BoardCardRefresh,
  BoardCardSize,
  ChangedPin,
} from "@/contracts";
import { formatGrouped, parseChartSpec } from "@/lib/chartSpec";
import { pinChartData } from "@/lib/pinChart";
import { AnalyticsChart } from "@/features/chat/AnalyticsChart";
import { PinMiniChart } from "@/features/chat/PinMiniChart";
import {
  cardFreshness,
  detectStat,
  parseMarkdownTable,
  spanForSize,
  statDelta,
} from "@/features/boards/boardModel";
import { LhMenuPopover } from "@/shell/controls";

/** Internal drag payload (the FileExplorer FILE_DRAG_MIME idiom): the dragged
 *  card's index, so a drop reorders without any global drag state. */
export const BOARD_CARD_MIME = "application/x-lighthouse-board-card";

const useStyles = makeStyles({
  // The Beam card: radius 10 (borderRadiusLarge), the rest elevation's
  // hairline ring + ambient shade (shadow2) — border and shadow are one thing.
  card: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
    minWidth: 0,
    ...shorthands.padding(tokens.spacingVerticalM, tokens.spacingHorizontalM),
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow2,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  // Size classes share spanForSize (the tested map). The narrow-viewport
  // override keeps a two-track span from overflowing a one-column grid.
  cardS: { gridColumn: spanForSize("S") },
  cardM: {
    gridColumn: spanForSize("M"),
    "@media (max-width: 640px)": { gridColumn: "1 / -1" },
  },
  cardL: { gridColumn: spanForSize("L") },
  // Drop-target highlight while a dragged card hovers (rowDropInto's idiom).
  cardDropTarget: {
    ...shorthands.outline("2px", "solid", tokens.colorBrandStroke1),
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    minWidth: 0,
  },
  dragHandle: { color: tokens.colorNeutralForeground3, flexShrink: 0, cursor: "grab" },
  question: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // The body doubles as the drill-in control (role=button; a real <button>
  // can't wrap the chart, whose PNG affordance is itself a button).
  body: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
    minWidth: 0,
    flexGrow: 1,
    cursor: "pointer",
    borderRadius: tokens.borderRadiusMedium,
    ":hover": { backgroundColor: tokens.colorSubtleBackgroundHover },
    ":focus-visible": {
      ...shorthands.outline("2px", "solid", tokens.colorStrokeFocus2),
    },
  },
  bodyStatic: { cursor: "default", ":hover": { backgroundColor: "transparent" } },
  // Stat tile: the one number, large. Tabular numerals are the Beam number
  // surface (and keep a ticking value from wobbling between refreshes).
  statValue: {
    fontSize: tokens.fontSizeHero800,
    lineHeight: tokens.lineHeightHero800,
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: "tabular-nums",
    color: tokens.colorNeutralForeground1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  statMeta: { color: tokens.colorNeutralForeground3 },
  // Delta in quiet ink, not a judgment color: whether "up" is good is the
  // analyst's call, so the arrow carries direction and nothing else.
  statDelta: {
    color: tokens.colorNeutralForeground2,
    fontVariantNumeric: "tabular-nums",
  },
  tableWrap: { overflowX: "auto", overflowY: "auto", maxHeight: "280px" },
  table: {
    borderCollapse: "collapse",
    width: "100%",
    "& th": {
      textAlign: "left",
      fontSize: tokens.fontSizeBase200,
      fontWeight: tokens.fontWeightSemibold,
      color: tokens.colorNeutralForeground2,
      ...shorthands.padding("3px", tokens.spacingHorizontalS),
      ...shorthands.borderBottom("1px", "solid", tokens.colorNeutralStroke2),
    },
    "& td": {
      fontSize: tokens.fontSizeBase200,
      color: tokens.colorNeutralForeground1,
      fontVariantNumeric: "tabular-nums",
      ...shorthands.padding("3px", tokens.spacingHorizontalS),
      ...shorthands.borderBottom("1px", "solid", tokens.colorNeutralStroke3),
    },
  },
  summaryText: { color: tokens.colorNeutralForeground2 },
  // The pins dialog's staleness posture: the reason in danger ink, quietly.
  errorText: { color: tokens.colorPaletteRedForeground1 },
  freshness: { color: tokens.colorNeutralForeground3 },
  tombstone: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    color: tokens.colorNeutralForeground3,
  },
  loading: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    color: tokens.colorNeutralForeground3,
    minHeight: "48px",
  },
});

export interface BoardCardProps {
  cardRef: BoardCardRef;
  index: number;
  count: number;
  /** The pin's latest refresh answer; undefined while the fetch is in flight. */
  answer?: BoardCardRefresh;
  /** Retained `pins-changed` payload → change badge + stat delta/mini-chart. */
  changed?: ChangedPin;
  busy: boolean;
  onMove: (index: number, dir: -1 | 1) => void;
  onSize: (index: number, size: BoardCardSize) => void;
  onRemove: (index: number) => void;
  onDrill: (question: string, pinId: string) => void;
  /** HTML5 drag enhancement (keyboard move controls are the primary path). */
  dropTarget: boolean;
  onDragStartCard: (index: number, e: DragEvent<HTMLDivElement>) => void;
  onDragOverCard: (index: number, e: DragEvent<HTMLDivElement>) => void;
  onDragLeaveCard: () => void;
  onDropCard: (index: number, e: DragEvent<HTMLDivElement>) => void;
}

/** The card body for a LIVE answer that isn't a chart: stat tile, compact
 *  table, or (fallback) the raw result text. */
function LiveBody({
  answer,
  changed,
  styles,
}: {
  answer: BoardCardRefresh;
  changed?: ChangedPin;
  styles: ReturnType<typeof useStyles>;
}) {
  const markdown = answer.markdown ?? "";
  const stat = detectStat(markdown, undefined);
  if (stat) {
    // Delta vs the previous summary — both sides parsed by the pinChart
    // helpers, so only cleanly comparable engine numbers ever subtract.
    const delta = changed ? statDelta(changed.before, changed.after) : null;
    const mini = changed ? pinChartData(changed.before, changed.after) : null;
    return (
      <>
        <span className={styles.statValue} title={stat.raw}>
          {stat.raw}
        </span>
        {stat.label && (
          <Text size={200} className={styles.statMeta}>
            {stat.label}
          </Text>
        )}
        {delta !== null && (
          <Text
            size={200}
            className={styles.statDelta}
            aria-label={`${delta > 0 ? "up" : "down"} ${formatGrouped(Math.abs(delta))} since the previous check`}
          >
            {delta > 0 ? "▲" : "▼"} {formatGrouped(Math.abs(delta))}
          </Text>
        )}
        {mini && <PinMiniChart data={mini} />}
      </>
    );
  }
  const table = parseMarkdownTable(markdown);
  if (table) {
    return (
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              {table.header.map((h, i) => (
                <th key={`h${i}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((r, i) => (
              <tr key={`r${i}`}>
                {r.map((c, j) => (
                  <td key={`c${i}-${j}`}>{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <Text size={200} className={styles.summaryText}>
      {markdown.trim() || "No result."}
    </Text>
  );
}

/** The card body for a STORED answer (the twin's last-known snapshot). */
function StoredBody({
  answer,
  changed,
  styles,
}: {
  answer: BoardCardRefresh;
  changed?: ChangedPin;
  styles: ReturnType<typeof useStyles>;
}) {
  const summary = answer.lastSummary;
  const stat = detectStat(undefined, summary);
  if (stat) {
    const delta = changed ? statDelta(changed.before, changed.after) : null;
    const mini = changed ? pinChartData(changed.before, changed.after) : null;
    return (
      <>
        <span className={styles.statValue} title={stat.raw}>
          {stat.raw}
        </span>
        {stat.label && (
          <Text size={200} className={styles.statMeta}>
            {stat.label}
          </Text>
        )}
        {delta !== null && (
          <Text
            size={200}
            className={styles.statDelta}
            aria-label={`${delta > 0 ? "up" : "down"} ${formatGrouped(Math.abs(delta))} since the previous check`}
          >
            {delta > 0 ? "▲" : "▼"} {formatGrouped(Math.abs(delta))}
          </Text>
        )}
        {mini && <PinMiniChart data={mini} />}
      </>
    );
  }
  // Mini-chart when the stored summary parses cleanly; the summary text
  // stays either way (it IS the data). pinChartData fails closed.
  const mini = summary ? pinChartData(changed?.before, summary) : null;
  return (
    <>
      {mini && <PinMiniChart data={mini} />}
      <Text size={200} className={styles.summaryText}>
        {summary ?? "Not checked yet."}
      </Text>
    </>
  );
}

export function BoardCard(props: BoardCardProps) {
  const styles = useStyles();
  const { cardRef, index, count, answer, changed, busy } = props;

  const sizeClass =
    cardRef.size === "L" ? styles.cardL : cardRef.size === "M" ? styles.cardM : styles.cardS;
  const question = answer?.question;
  const tombstone = answer?.tombstone === true;
  const failed = Boolean(answer && !tombstone && (answer.error || answer.staleReason));
  const drillable = Boolean(question && !tombstone);

  // Freshness, per card (spec: every card carries one): the ONE shared
  // helper — live → the engine footer's own freshness sentence VERBATIM,
  // stored → "stored · checked <relative>" — also used by the board export,
  // so the pack can never label a card differently than the screen does.
  const freshness = answer && !tombstone ? cardFreshness(answer, Date.now()) : null;

  let body: React.ReactNode;
  if (!answer) {
    body = (
      <div className={styles.loading}>
        <Spinner size="extra-tiny" />
        <Text size={200}>checking…</Text>
      </div>
    );
  } else if (tombstone) {
    body = (
      <div className={styles.tombstone}>
        <Text size={200}>This pin was removed.</Text>
        <Button
          size="small"
          appearance="secondary"
          icon={<DeleteRegular />}
          disabled={busy}
          onClick={() => props.onRemove(index)}
        >
          Remove card
        </Button>
      </div>
    );
  } else if (failed) {
    // staleReason posture: the engine's reason in the body, freshness kept.
    body = (
      <Text size={200} className={styles.errorText}>
        {answer.error ?? `stale: ${answer.staleReason}`}
      </Text>
    );
  } else if (answer.live) {
    const spec = answer.chart ? parseChartSpec(answer.chart) : null;
    body = spec ? (
      <AnalyticsChart spec={spec} />
    ) : (
      <LiveBody answer={answer} changed={changed} styles={styles} />
    );
  } else {
    body = <StoredBody answer={answer} changed={changed} styles={styles} />;
  }

  const drill = () => {
    if (drillable && question) props.onDrill(question, cardRef.pinId);
  };

  return (
    <div
      role="listitem"
      // The export's capture anchor (§5.1): "Export board" serializes the
      // ALREADY-RENDERED chart via `[data-lh-board-card=…] figure svg[role=img]`
      // — AnalyticsChart's figure only; the PinMiniChart svg has no figure.
      data-lh-board-card={cardRef.pinId}
      className={mergeClasses(styles.card, sizeClass, props.dropTarget && styles.cardDropTarget)}
      draggable
      onDragStart={(e) => props.onDragStartCard(index, e)}
      onDragOver={(e) => props.onDragOverCard(index, e)}
      onDragLeave={props.onDragLeaveCard}
      onDrop={(e) => props.onDropCard(index, e)}
    >
      <div className={styles.header}>
        <ReOrderDotsVerticalRegular fontSize={14} className={styles.dragHandle} aria-hidden />
        <Text size={300} weight="semibold" className={styles.question} title={question}>
          {tombstone ? "Removed pin" : question ?? "…"}
        </Text>
        {changed && !tombstone && (
          <Tooltip
            content={
              changed.before
                ? `was: ${changed.before} → now: ${changed.after}`
                : `now: ${changed.after}`
            }
            relationship="description"
          >
            <Badge appearance="tint" color="brand" size="small">
              changed
            </Badge>
          </Tooltip>
        )}
        <Menu
          checkedValues={{ size: [cardRef.size] }}
          onCheckedValueChange={(_, data) => {
            const next = data.checkedItems[0];
            if (next === "S" || next === "M" || next === "L") props.onSize(index, next);
          }}
        >
          <MenuTrigger disableButtonEnhancement>
            <Button
              size="small"
              appearance="subtle"
              icon={<MoreHorizontalRegular />}
              aria-label={`Card options: ${question ?? "removed pin"}`}
            />
          </MenuTrigger>
          <LhMenuPopover>
            <MenuList>
              {/* Keyboard-first reorder: these controls are the primary path;
                  pointer drag is only an enhancement. */}
              <MenuItem
                icon={<ArrowUpRegular />}
                disabled={busy || index === 0}
                onClick={() => props.onMove(index, -1)}
              >
                Move up
              </MenuItem>
              <MenuItem
                icon={<ArrowDownRegular />}
                disabled={busy || index === count - 1}
                onClick={() => props.onMove(index, 1)}
              >
                Move down
              </MenuItem>
              <MenuDivider />
              <MenuItemRadio name="size" value="S" disabled={busy}>
                Small
              </MenuItemRadio>
              <MenuItemRadio name="size" value="M" disabled={busy}>
                Medium
              </MenuItemRadio>
              <MenuItemRadio name="size" value="L" disabled={busy}>
                Large
              </MenuItemRadio>
              <MenuDivider />
              {/* A card is a reference — removing it never touches the pin. */}
              <MenuItem
                icon={<DeleteRegular />}
                disabled={busy}
                onClick={() => props.onRemove(index)}
              >
                Remove card
              </MenuItem>
            </MenuList>
          </LhMenuPopover>
        </Menu>
      </div>
      <div
        className={mergeClasses(styles.body, !drillable && styles.bodyStatic)}
        role={drillable ? "button" : undefined}
        tabIndex={drillable ? 0 : undefined}
        aria-label={drillable ? `Ask again: ${question}` : undefined}
        onClick={(e) => {
          // Real buttons inside the body (the chart's PNG download, the
          // tombstone's Remove) own their clicks — they never drill.
          if ((e.target as HTMLElement).closest("button")) return;
          drill();
        }}
        onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
          if ((e.target as HTMLElement).closest("button")) return;
          if (drillable && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            drill();
          }
        }}
      >
        {body}
      </div>
      {freshness && (
        <Text size={200} className={styles.freshness}>
          {freshness}
        </Text>
      )}
    </div>
  );
}
