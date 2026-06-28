"use client";

import { useState } from "react";
import {
  Button,
  Divider,
  Input,
  Spinner,
  Text,
  Title2,
  makeStyles,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import { ArrowSyncRegular, KeyRegular } from "@fluentui/react-icons";
import { useLicenseStore, type LicenseStatus } from "@/stores/useLicenseStore";

const useStyles = makeStyles({
  overlay: {
    position: "fixed",
    inset: 0,
    zIndex: 1000,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    // Frosted backdrop so the greyed-out vault stays visible behind the gate.
    backgroundColor: "rgba(8, 12, 22, 0.55)",
    backdropFilter: "blur(2px)",
  },
  card: {
    width: "min(460px, calc(100vw - 48px))",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    textAlign: "center",
    gap: tokens.spacingVerticalL,
    ...shorthands.padding(tokens.spacingVerticalXXL, tokens.spacingHorizontalXXL),
    backgroundColor: tokens.colorNeutralBackground1,
    ...shorthands.borderRadius(tokens.borderRadiusXLarge),
    boxShadow: tokens.shadow64,
  },
  beacon: {
    width: "14px",
    height: "14px",
    borderRadius: "50%",
    backgroundColor: tokens.colorBrandBackground,
    boxShadow: `0 0 12px 2px ${tokens.colorBrandBackground}`,
  },
  body: { color: tokens.colorNeutralForeground2 },
  full: { width: "100%" },
  activate: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    width: "100%",
  },
  row: { display: "flex", gap: tokens.spacingHorizontalS, width: "100%" },
  error: { color: tokens.colorPaletteRedForeground1 },
  link: {
    background: "none",
    border: "none",
    padding: 0,
    cursor: "pointer",
    color: tokens.colorBrandForegroundLink,
    font: "inherit",
  },
});

const COPY: Record<"expired" | "locked" | "none", { title: string; body: string; cta: string }> = {
  expired: {
    title: "Your free trial has ended",
    body: "You've used all 14 days of your Lighthouse trial. Your files are safe and untouched — start a new trial or enter a license key to unlock them again.",
    cta: "Start a new trial",
  },
  locked: {
    title: "Your subscription has lapsed",
    body: "Your grace period is over, so Lighthouse is locked. Nothing has been deleted — renew with your license key to unlock your vault, or start a fresh trial.",
    cta: "Start a new trial",
  },
  none: {
    title: "Start your trial",
    body: "Start a free 14-day trial to use Lighthouse, or enter a license key if you have one. Your vault stays exactly as it is.",
    cta: "Start trial",
  },
};

/** Inline "I have a license key" activation form, shared by the gate + banner. */
export function ActivateKey({ compact = false }: { compact?: boolean }) {
  const styles = useStyles();
  const [key, setKey] = useState("");
  const activate = useLicenseStore((s) => s.activate);
  const activating = useLicenseStore((s) => s.activating);
  const activateError = useLicenseStore((s) => s.activateError);

  return (
    <div className={styles.activate}>
      <div className={styles.row}>
        <Input
          className={styles.full}
          value={key}
          placeholder="Paste your license key"
          contentBefore={<KeyRegular />}
          onChange={(_, d) => setKey(d.value)}
        />
        <Button
          appearance={compact ? "primary" : "secondary"}
          disabled={activating || !key.trim()}
          icon={activating ? <Spinner size="tiny" /> : undefined}
          onClick={() => void activate(key.trim())}
        >
          {activating ? "Checking…" : "Activate"}
        </Button>
      </div>
      {activateError && (
        <Text size={200} className={styles.error}>
          {activateError}
        </Text>
      )}
    </div>
  );
}

/**
 * Lock gate. Shown over a greyed-out vault when the license isn't valid. Nothing
 * has been deleted — the user starts a new trial or activates a key to return.
 */
export function LicenseGate({ status }: { status: LicenseStatus }) {
  const styles = useStyles();
  const startTrial = useLicenseStore((s) => s.startTrial);
  const starting = useLicenseStore((s) => s.starting);

  const key = status === "expired" || status === "locked" ? status : "none";
  const copy = COPY[key];

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true">
      <div className={styles.card}>
        <span className={styles.beacon} />
        <Title2>{copy.title}</Title2>
        <Text className={styles.body}>{copy.body}</Text>

        <Button
          className={styles.full}
          appearance="primary"
          size="large"
          icon={starting ? <Spinner size="tiny" /> : <ArrowSyncRegular />}
          disabled={starting}
          onClick={() => void startTrial()}
        >
          {starting ? "Starting…" : copy.cta}
        </Button>

        <Divider className={styles.full}>or</Divider>
        <ActivateKey />
      </div>
    </div>
  );
}

/**
 * Grace banner for a lapsed PAID subscription that's still usable. Counts down
 * to the lock date and offers renewal via a license key.
 */
export function GraceBanner({ graceUntil }: { graceUntil: string | null }) {
  const styles = useStyles();
  const days = graceUntil
    ? Math.max(0, Math.ceil((Date.parse(graceUntil) - Date.now()) / (24 * 60 * 60 * 1000)))
    : null;

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 16,
        padding: "10px 20px",
        backgroundColor: tokens.colorStatusWarningBackground2,
        color: tokens.colorStatusWarningForeground2,
        borderBottom: `1px solid ${tokens.colorStatusWarningBorder1}`,
      }}
    >
      <Text weight="semibold">
        Your subscription has ended.
        {days !== null
          ? ` You have ${days} day${days === 1 ? "" : "s"} to renew before your vault is locked.`
          : " Renew to keep access before your vault is locked."}
      </Text>
      <div style={{ marginLeft: "auto", minWidth: 280 }}>
        <ActivateKey compact />
      </div>
    </div>
  );
}
