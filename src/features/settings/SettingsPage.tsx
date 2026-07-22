"use client";

/**
 * 0.13.10 §2 → §31 §5: Settings as a full-screen compact PAGE in the
 * inset-grouped idiom — rounded group cards floating on the grouped canvas,
 * 44pt rows with chevron disclosure, hairline separators inset to the label
 * edge, and footnote footers under the groups that need a word of context.
 * Every destination row opens the same dialog / fires the same event the
 * desktop gear menu does, so the two hosts can never drift. 0.13.10 §3: the
 * relocated Business definitions (SemanticNav) and Saved views (ViewsNav)
 * management groups render inline — their result-impacting CRUD stays
 * reachable with the Sections rail retired.
 *
 * History is NOT here — it lives on the chat header (both platforms, §2).
 * The "Save chats on this device" switch lives in Preferences (§2).
 */
import { useState } from "react";
import { Text, makeStyles, mergeClasses, shorthands, tokens } from "@fluentui/react-components";
import {
  IconAI,
  IconBoard,
  IconChevronRight,
  IconHelp,
  IconHistory,
  IconInfo,
  IconInsight,
  IconOpen,
  IconOptions,
  IconPin,
} from "@/shell/icons";
import {
  AboutDialog,
  AiModelsDialog,
  AuditLogDialog,
  PreferencesDialog,
  LH_REPO,
} from "./SettingsMenu";
import { openExternal } from "@/lib/openExternal";
import { START_TOUR_EVENT } from "@/features/help/FirstRunTour";
import { SemanticNav } from "@/features/semantic/SemanticNav";
import { ViewsNav } from "@/features/views/ViewsNav";

/** The icon gutter width — the inset hairlines align to the label edge. */
const ICON_GUTTER = 40;

const useStyles = makeStyles({
  // The grouped canvas: the §1 semantic pair, distinct from the cards on it.
  page: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
    paddingTop: tokens.spacingVerticalM,
    paddingBottom: tokens.spacingVerticalXXL,
    backgroundColor: "var(--lh-bg-grouped)",
  },
  groupLabel: {
    color: tokens.colorNeutralForeground3,
    paddingLeft: tokens.spacingHorizontalM,
    marginTop: tokens.spacingVerticalL,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
  },
  // The inset group card: elevated surface, 12pt corners, hairline ring.
  group: {
    display: "flex",
    flexDirection: "column",
    ...shorthands.borderRadius(tokens.borderRadiusLarge),
    backgroundColor: "var(--lh-bg-elevated)",
    boxShadow: "0 0 0 0.5px var(--lh-separator)",
    overflow: "hidden",
  },
  // §31 §5: the footnote footer — quiet context under a group.
  groupFooter: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalM, 0),
  },
  // A 44pt destination row: icon gutter · label · chevron disclosure, with
  // the separator inset to the label edge (iOS-grouped, not full-bleed).
  row: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    minHeight: "44px",
    width: "100%",
    ...shorthands.padding(0, tokens.spacingHorizontalM),
    ...shorthands.borderStyle("none"),
    backgroundColor: "transparent",
    color: tokens.colorNeutralForeground1,
    fontFamily: "inherit",
    fontSize: tokens.fontSizeBase300,
    textAlign: "left",
    cursor: "pointer",
    outlineStyle: "none",
    "::after": {
      content: '""',
      position: "absolute",
      left: `${ICON_GUTTER + 12}px`,
      right: 0,
      bottom: 0,
      height: "var(--lh-hairline)",
      backgroundColor: "var(--lh-separator)",
    },
    ":last-child": { "::after": { display: "none" } },
    ":focus-visible": {
      outlineWidth: "2px",
      outlineStyle: "solid",
      outlineColor: tokens.colorStrokeFocus2,
      outlineOffset: "-2px",
    },
  },
  rowIcon: {
    display: "inline-flex",
    width: `${ICON_GUTTER}px`,
    flexShrink: 0,
    fontSize: "20px",
    color: tokens.colorNeutralForeground2,
  },
  rowLabel: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  rowChevron: {
    display: "inline-flex",
    fontSize: "14px",
    color: "var(--lh-label-quaternary)",
  },
  // The relocated management surfaces render inline inside their group card.
  inline: {
    ...shorthands.padding(0, tokens.spacingHorizontalM, tokens.spacingVerticalS),
  },
});

/** One tappable destination row (44pt, chevron disclosure, inset hairline). */
function Row({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactElement;
  label: string;
  onClick: () => void;
}) {
  const styles = useStyles();
  return (
    <button type="button" className={mergeClasses("lh-press", styles.row)} onClick={onClick}>
      <span className={styles.rowIcon} aria-hidden>
        {icon}
      </span>
      <span className={styles.rowLabel}>{label}</span>
      <span className={styles.rowChevron} aria-hidden>
        <IconChevronRight />
      </span>
    </button>
  );
}

export function SettingsPage() {
  const styles = useStyles();
  const [aiDlg, setAiDlg] = useState(false);
  const [prefDlg, setPrefDlg] = useState(false);
  const [auditDlg, setAuditDlg] = useState(false);
  const [aboutDlg, setAboutDlg] = useState(false);

  return (
    <div className={styles.page} aria-label="Settings">
      <div className={styles.group}>
        <Row icon={<IconOptions />} label="Preferences" onClick={() => setPrefDlg(true)} />
        <Row icon={<IconAI />} label="AI models" onClick={() => setAiDlg(true)} />
        <Row
          icon={<IconPin />}
          label="Pinned questions"
          onClick={() => window.dispatchEvent(new CustomEvent("lighthouse:open-pins"))}
        />
        <Row
          icon={<IconBoard />}
          label="Board"
          onClick={() => window.dispatchEvent(new CustomEvent("lighthouse:open-board"))}
        />
        <Row icon={<IconHistory />} label="Audit log" onClick={() => setAuditDlg(true)} />
      </div>
      <Text as="p" className={styles.groupFooter}>
        Everything runs on this device unless you connect a cloud model.
      </Text>

      {/* 0.13.10 §3: Business definitions — SemanticNav's management content
          (metrics + synonyms, rename/delete, proposals) relocated from the
          Sections rail. The chat "Define metric" chip keeps working; the
          engine's semantic layer is untouched. */}
      <Text size={200} weight="semibold" className={styles.groupLabel}>
        Business definitions
      </Text>
      <div className={styles.group}>
        <div className={styles.inline}>
          <SemanticNav />
        </div>
      </div>
      <Text as="p" className={styles.groupFooter}>
        Definitions shape how new answers read your data. Files are never changed.
      </Text>

      {/* 0.13.10 §3: Saved views — ViewsNav's manage surface (list/rename/
          delete/inspect) relocated from the Library section. "Save as view"
          and "Ask about this view" chips keep working. */}
      <Text size={200} weight="semibold" className={styles.groupLabel}>
        Saved views
      </Text>
      <div className={styles.group}>
        <div className={styles.inline}>
          <ViewsNav />
        </div>
      </div>

      <Text size={200} weight="semibold" className={styles.groupLabel}>
        Help &amp; about
      </Text>
      <div className={styles.group}>
        <Row
          icon={<IconInsight />}
          label="Send feedback"
          onClick={() => window.dispatchEvent(new Event("lighthouse:open-feedback"))}
        />
        <Row
          icon={<IconHelp />}
          label="Take the tour"
          onClick={() => window.dispatchEvent(new Event(START_TOUR_EVENT))}
        />
        <Row
          icon={<IconOpen />}
          label="Lighthouse on GitHub"
          onClick={() => openExternal(LH_REPO)}
        />
        <Row icon={<IconInfo />} label="About Lighthouse" onClick={() => setAboutDlg(true)} />
      </div>

      <AiModelsDialog open={aiDlg} setOpen={setAiDlg} />
      <PreferencesDialog open={prefDlg} setOpen={setPrefDlg} />
      <AuditLogDialog open={auditDlg} setOpen={setAuditDlg} />
      <AboutDialog open={aboutDlg} setOpen={setAboutDlg} />
    </div>
  );
}
