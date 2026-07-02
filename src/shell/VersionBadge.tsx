"use client";

/**
 * A subtle app-version label parked in the bottom-left corner (opposite the
 * bug-report FAB in the bottom-right). Intentionally low-contrast and
 * non-interactive — a quiet build marker, not a UI control. The version is
 * injected at build time from package.json via next.config.mjs.
 */
import { makeStyles, tokens } from "@fluentui/react-components";

const useStyles = makeStyles({
  badge: {
    position: "fixed",
    left: tokens.spacingHorizontalL,
    bottom: tokens.spacingVerticalL,
    zIndex: 900,
    color: tokens.colorNeutralForeground4,
    fontSize: tokens.fontSizeBase100,
    letterSpacing: "0.02em",
    userSelect: "none",
    pointerEvents: "none", // never intercept clicks
    opacity: 0.55,
  },
});

export function VersionBadge() {
  const styles = useStyles();
  const version = process.env.NEXT_PUBLIC_APP_VERSION;
  if (!version) return null;
  return <span className={styles.badge}>v{version}</span>;
}
