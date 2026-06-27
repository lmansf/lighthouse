"use client";

import { Text, makeStyles, shorthands, tokens } from "@fluentui/react-components";
import { LAYOUT } from "./theme";

const useStyles = makeStyles({
  rail: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    width: `${LAYOUT.railWidth}px`,
    flexShrink: 0,
    backgroundColor: tokens.colorNeutralBackground2,
    ...shorthands.borderRight("1px", "solid", tokens.colorNeutralStroke2),
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    height: `${LAYOUT.headerHeight}px`,
    ...shorthands.padding(0, tokens.spacingHorizontalM),
    ...shorthands.borderBottom("1px", "solid", tokens.colorNeutralStroke2),
  },
  brand: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    fontWeight: tokens.fontWeightSemibold,
  },
  // The beacon: the one place red shows by default.
  beacon: {
    width: "10px",
    height: "10px",
    borderRadius: "50%",
    backgroundColor: tokens.colorBrandBackground,
    boxShadow: `0 0 8px 1px ${tokens.colorBrandBackground}`,
  },
  body: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
  },
});

interface LeftRailProps {
  children: React.ReactNode;
}

/**
 * Fixed (non-collapsible) left rail. Hosts the onboarding flow first, then the
 * Ask panel. Owned by the shell team; features render inside `children`.
 */
export function LeftRail({ children }: LeftRailProps) {
  const styles = useStyles();
  return (
    <div className={styles.rail}>
      <div className={styles.header}>
        <span className={styles.brand}>
          <span className={styles.beacon} />
          <Text weight="semibold">Lighthouse</Text>
        </span>
      </div>
      <div className={styles.body}>{children}</div>
    </div>
  );
}
