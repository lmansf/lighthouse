"use client";

import {
  Button,
  Spinner,
  Text,
  Title2,
  makeStyles,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import { ArrowSyncRegular } from "@fluentui/react-icons";
import { useLicenseStore } from "@/stores/useLicenseStore";

const useStyles = makeStyles({
  root: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "100vh",
    width: "100vw",
    backgroundColor: tokens.colorNeutralBackground2,
  },
  card: {
    maxWidth: "440px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    textAlign: "center",
    gap: tokens.spacingVerticalL,
    ...shorthands.padding(tokens.spacingVerticalXXL, tokens.spacingHorizontalXXL),
    backgroundColor: tokens.colorNeutralBackground1,
    ...shorthands.borderRadius(tokens.borderRadiusXLarge),
    boxShadow: tokens.shadow28,
  },
  beacon: {
    width: "14px",
    height: "14px",
    borderRadius: "50%",
    backgroundColor: tokens.colorBrandBackground,
    boxShadow: `0 0 12px 2px ${tokens.colorBrandBackground}`,
  },
  body: { color: tokens.colorNeutralForeground2 },
});

/**
 * Trial gate. For an expired trial the vault has already been reset server-side;
 * for "none" (no readable license yet) nothing has been touched. Either way,
 * starting a trial mints a fresh 14-day key.
 */
export function TrialExpired({ status = "expired" }: { status?: "expired" | "none" }) {
  const styles = useStyles();
  const startTrial = useLicenseStore((s) => s.startTrial);
  const starting = useLicenseStore((s) => s.starting);

  const expired = status === "expired";

  return (
    <main className={styles.root}>
      <div className={styles.card}>
        <span className={styles.beacon} />
        <Title2>{expired ? "Your trial has ended" : "Start your trial"}</Title2>
        <Text className={styles.body}>
          {expired ? (
            <>
              Your 14-day trial is over, so your vault has been reset. Start a new
              trial to keep using Lighthouse — you&apos;ll begin with a fresh, empty
              vault. Files you linked in place are left on your disk untouched.
            </>
          ) : (
            <>
              Start a free 14-day trial to use Lighthouse. Your vault is untouched —
              nothing has been reset.
            </>
          )}
        </Text>
        <Button
          appearance="primary"
          size="large"
          icon={starting ? <Spinner size="tiny" /> : <ArrowSyncRegular />}
          disabled={starting}
          onClick={() => void startTrial()}
        >
          {starting ? "Starting…" : expired ? "Start new trial" : "Start trial"}
        </Button>
      </div>
    </main>
  );
}
