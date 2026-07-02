"use client";

/**
 * A subtle app-version label in the bottom-right, tucked just ABOVE the
 * bug-report FAB (the bottom-left corner holds the settings gear, so we avoid it).
 * Intentionally low-contrast and non-interactive — a quiet build marker, not a UI
 * control. The version is injected at build time from package.json via
 * next.config.mjs.
 */
import { makeStyles, tokens } from "@fluentui/react-components";

const useStyles = makeStyles({
  badge: {
    position: "fixed",
    right: tokens.spacingHorizontalL, // align with the bug FAB's right edge
    // Sit just above the bug FAB (which is a ~32px icon button at bottom: L),
    // so the version never overlaps the FAB or the bottom-left settings gear.
    bottom: `calc(${tokens.spacingVerticalL} + 42px)`,
    zIndex: 899, // just under the FAB
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
