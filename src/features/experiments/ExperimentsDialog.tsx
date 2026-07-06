"use client";

/**
 * Experiments — a peek at what's coming, ranked by how much interest each teaser
 * has drawn ON THIS DEVICE. Tapping a row is a vote ("I want this"): it logs the
 * interest event (the hosted, cross-user aggregate) and bumps the local tally
 * that orders this list. See src/lib/comingSoon.ts for why the in-app board is
 * local rather than the true cross-user ranking.
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
  Text,
  makeStyles,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import { HandRightRegular } from "@fluentui/react-icons";
import {
  CHANGED_EVENT,
  getLeaderboard,
  recordInterest,
  type LeaderboardEntry,
} from "@/lib/comingSoon";

const useStyles = makeStyles({
  content: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
    minWidth: "min(440px, 78vw)",
  },
  intro: { color: tokens.colorNeutralForeground2 },
  list: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS },
  // Each row is a real button so it's keyboard-focusable and votes on click.
  row: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalM,
    width: "100%",
    ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalM),
    ...shorthands.border("1px", "solid", tokens.colorNeutralStroke2),
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    fontFamily: "inherit",
    textAlign: "left",
    cursor: "pointer",
    transition: "background-color 120ms ease, border-color 120ms ease",
    ":hover": {
      backgroundColor: tokens.colorNeutralBackground1Hover,
      ...shorthands.borderColor(tokens.colorBrandStroke1),
    },
    ":active": { backgroundColor: tokens.colorNeutralBackground1Pressed },
  },
  rank: {
    width: "22px",
    flexShrink: 0,
    textAlign: "center",
    color: tokens.colorNeutralForeground3,
    fontWeight: tokens.fontWeightSemibold,
  },
  info: { display: "flex", flexDirection: "column", minWidth: 0, flexGrow: 1 },
  label: { fontWeight: tokens.fontWeightSemibold },
  blurb: { color: tokens.colorNeutralForeground3 },
  votes: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    flexShrink: 0,
    minWidth: "52px",
  },
  voteCount: {
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase500,
    lineHeight: tokens.lineHeightBase500,
    color: tokens.colorBrandForeground1,
  },
  voteLabel: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase100 },
  footnote: {
    display: "flex",
    alignItems: "flex-start",
    gap: tokens.spacingHorizontalS,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  footIcon: { flexShrink: 0, display: "inline-flex", marginTop: "2px" },
});

export function ExperimentsDialog({
  open,
  setOpen,
}: {
  open: boolean;
  setOpen: (b: boolean) => void;
}) {
  const styles = useStyles();
  const [board, setBoard] = useState<LeaderboardEntry[]>([]);

  // Read the tally when the dialog opens, and again whenever a vote lands —
  // from a row here or from the "coming soon" buttons elsewhere in the app.
  useEffect(() => {
    if (!open) return;
    const refresh = () => setBoard(getLeaderboard());
    refresh();
    window.addEventListener(CHANGED_EVENT, refresh);
    return () => window.removeEventListener(CHANGED_EVENT, refresh);
  }, [open]);

  const vote = (id: string) => {
    recordInterest(id);
    setBoard(getLeaderboard()); // instant; the CHANGED_EVENT listener also fires
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Experiments</DialogTitle>
          <DialogContent>
            <div className={styles.content}>
              <Text className={styles.intro}>
                A peek at what&apos;s coming. Tap one to tell us you want it — the most-wanted
                rise to the top.
              </Text>
              <div className={styles.list}>
                {board.map((f, i) => (
                  <button
                    key={f.id}
                    type="button"
                    className={styles.row}
                    onClick={() => vote(f.id)}
                    aria-label={`${f.label} — ${f.count} ${f.count === 1 ? "vote" : "votes"}. Tap to add yours.`}
                  >
                    <span className={styles.rank} aria-hidden>
                      {i + 1}
                    </span>
                    <span className={styles.info}>
                      <Text className={styles.label}>{f.label}</Text>
                      <Text size={200} className={styles.blurb}>
                        {f.blurb}
                      </Text>
                    </span>
                    <span className={styles.votes} aria-hidden>
                      <span className={styles.voteCount}>{f.count}</span>
                      <span className={styles.voteLabel}>{f.count === 1 ? "vote" : "votes"}</span>
                    </span>
                  </button>
                ))}
              </div>
              <span className={styles.footnote}>
                <span className={styles.footIcon} aria-hidden>
                  <HandRightRegular />
                </span>
                <Text size={200}>
                  Your taps are counted on this device and sent as anonymous interest signals —
                  they help us decide what to build next.
                </Text>
              </span>
            </div>
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="primary">Done</Button>
            </DialogTrigger>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
