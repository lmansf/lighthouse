"use client";

/**
 * 0.13.10 §2: Settings as a full-screen compact PAGE — the third tab. The
 * grouped, scrollable reorganization of SettingsMenu's popup content (§31
 * restyles it iOS-grouped; here just structure): every destination is a 44pt
 * row that opens the same dialog / fires the same event the desktop gear menu
 * does, so the two hosts can never drift. 0.13.10 §3: the relocated
 * Business definitions (SemanticNav) and Saved views (ViewsNav) management
 * groups render inline — their result-impacting CRUD stays reachable with
 * the Sections rail retired.
 *
 * History is NOT here — it lives on the chat header (both platforms, §2).
 * The "Save chats on this device" switch lives in Preferences (§2).
 */
import { useState } from "react";
import { Button, Text, makeStyles, shorthands, tokens } from "@fluentui/react-components";
import { IconAI, IconBoard, IconHelp, IconHistory, IconInfo, IconInsight, IconOpen, IconOptions, IconPin } from "@/shell/icons";
import {
  AboutDialog,
  AiModelsDialog,
  AuditLogDialog,
  PreferencesDialog,
  LH_REPO,
} from "./SettingsMenu";
import { START_TOUR_EVENT } from "@/features/help/FirstRunTour";
import { SemanticNav } from "@/features/semantic/SemanticNav";
import { ViewsNav } from "@/features/views/ViewsNav";

const useStyles = makeStyles({
  page: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    paddingTop: tokens.spacingVerticalM,
    paddingBottom: tokens.spacingVerticalXXL,
  },
  groupLabel: {
    color: tokens.colorNeutralForeground3,
    paddingLeft: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalM,
  },
  group: {
    display: "flex",
    flexDirection: "column",
    ...shorthands.borderRadius(tokens.borderRadiusLarge),
    backgroundColor: tokens.colorNeutralBackground1,
    overflow: "hidden",
  },
  // A 44pt tappable settings row: icon + label, full width, quiet.
  row: {
    justifyContent: "flex-start",
    minHeight: "44px",
    ...shorthands.borderRadius(0),
  },
  // The relocated management surfaces render inline inside their group card.
  inline: {
    ...shorthands.padding(0, tokens.spacingHorizontalM, tokens.spacingVerticalS),
  },
});

/** One tappable destination row. */
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
    <Button appearance="subtle" icon={icon} className={styles.row} onClick={onClick}>
      {label}
    </Button>
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
          onClick={() => window.open(LH_REPO, "_blank", "noopener,noreferrer")}
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
