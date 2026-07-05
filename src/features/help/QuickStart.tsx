"use client";

/**
 * Quick start guide — a single friendly, scannable dialog that teaches the
 * whole app in three steps (add files → choose what the AI sees → ask). It
 * opens automatically exactly once on a fresh install (QuickStartAuto) and is
 * always re-openable from the settings menu ("Quick start"), so skimming it the
 * first time costs nothing.
 */
import { useEffect, useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  Divider,
  Text,
  makeStyles,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import {
  ChatSparkleRegular,
  DocumentAddRegular,
  EyeRegular,
  LightbulbRegular,
  ShieldCheckmarkRegular,
} from "@fluentui/react-icons";

/** localStorage key — set once the auto-open has fired, so it never repeats. */
const SHOWN_KEY = "lighthouse.quickstart.shown";

const useStyles = makeStyles({
  content: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalL },
  steps: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalL },
  step: { display: "flex", alignItems: "flex-start", gap: tokens.spacingHorizontalM },
  // The step number wears the brand tint so the 1-2-3 rhythm reads at a glance.
  stepNumber: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "28px",
    height: "28px",
    flexShrink: 0,
    borderRadius: "50%",
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground2,
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase300,
  },
  stepText: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXXS, minWidth: 0 },
  stepTitle: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    fontWeight: tokens.fontWeightSemibold,
  },
  stepIcon: { display: "inline-flex", color: tokens.colorBrandForeground1 },
  stepBody: { color: tokens.colorNeutralForeground2 },
  tipsTitle: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    fontWeight: tokens.fontWeightSemibold,
  },
  tipsList: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
    color: tokens.colorNeutralForeground2,
    marginTop: tokens.spacingVerticalXS,
    marginBottom: 0,
    paddingLeft: tokens.spacingHorizontalXL,
  },
  // Keyboard keys as tiny keycaps so shortcuts pop out of the prose.
  kbd: {
    ...shorthands.padding("1px", tokens.spacingHorizontalXS),
    ...shorthands.border("1px", "solid", tokens.colorNeutralStroke1),
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackground3,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase100,
    whiteSpace: "nowrap",
  },
  privacy: {
    display: "flex",
    alignItems: "flex-start",
    gap: tokens.spacingHorizontalS,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  privacyIcon: { flexShrink: 0, display: "inline-flex", marginTop: "2px" },
});

/** One numbered step: brand-tinted number, icon + title, one-line body. */
function Step({
  n,
  icon,
  title,
  body,
}: {
  n: number;
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  const styles = useStyles();
  return (
    <div className={styles.step}>
      <span className={styles.stepNumber} aria-hidden>
        {n}
      </span>
      <div className={styles.stepText}>
        <span className={styles.stepTitle}>
          <span className={styles.stepIcon} aria-hidden>
            {icon}
          </span>
          {title}
        </span>
        <Text className={styles.stepBody}>{body}</Text>
      </div>
    </div>
  );
}

/** The one-page tutorial. Controlled, so the settings menu can reopen it. */
export function QuickStartDialog({ open, setOpen }: { open: boolean; setOpen: (b: boolean) => void }) {
  const styles = useStyles();
  return (
    <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Get started in three steps</DialogTitle>
          <DialogContent>
            <div className={styles.content}>
              <div className={styles.steps}>
                <Step
                  n={1}
                  icon={<DocumentAddRegular />}
                  title="Add your files"
                  body="Browse or drag them in — they stay on your machine."
                />
                <Step
                  n={2}
                  icon={<EyeRegular />}
                  title="Choose what the AI sees"
                  body="The eye on each file or folder toggles visibility — the AI only reads what's visible."
                />
                <Step
                  n={3}
                  icon={<ChatSparkleRegular />}
                  title="Ask anything"
                  body="Answers cite the exact files they came from — click a citation to see the source."
                />
              </div>

              <Divider />

              <div>
                <span className={styles.tipsTitle}>
                  <LightbulbRegular aria-hidden />
                  Tips
                </span>
                <ul className={styles.tipsList}>
                  <li>Drag a file onto the chat to ask about just that file.</li>
                  <li>
                    <kbd className={styles.kbd}>Enter</kbd> sends —{" "}
                    <kbd className={styles.kbd}>Shift + Enter</kbd> for a new line.
                  </li>
                  <li>
                    <kbd className={styles.kbd}>Ctrl/Cmd + N</kbd> starts a new chat.
                  </li>
                  <li>
                    <kbd className={styles.kbd}>Ctrl/Cmd + B</kbd> hides the file list.
                  </li>
                </ul>
              </div>

              <div className={styles.privacy}>
                <span className={styles.privacyIcon} aria-hidden>
                  <ShieldCheckmarkRegular />
                </span>
                <Text size={200}>
                  With the local model, nothing leaves your device; with a cloud model, excerpts of
                  visible files are sent to your chosen provider.
                </Text>
              </div>
            </div>
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="primary">Got it</Button>
            </DialogTrigger>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/**
 * Auto-opens the guide exactly once per install. The flag is written the moment
 * we decide to show, so a reload mid-tour can't replay it; if storage is
 * blocked we skip entirely rather than risk greeting the user on every launch.
 */
export function QuickStartAuto() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem(SHOWN_KEY)) return;
      localStorage.setItem(SHOWN_KEY, "1");
    } catch {
      return; // storage blocked — don't risk re-showing the tour every launch
    }
    setOpen(true);
  }, []);

  return <QuickStartDialog open={open} setOpen={setOpen} />;
}
