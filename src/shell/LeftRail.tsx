"use client";

import {
  Button,
  Text,
  Tooltip,
  makeStyles,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import {
  PanelLeftContract24Regular,
  PanelLeftExpand24Regular,
} from "@fluentui/react-icons";
import { LAYOUT } from "./theme";

const useStyles = makeStyles({
  rail: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    backgroundColor: tokens.colorNeutralBackground2,
    ...shorthands.borderRight("1px", "solid", tokens.colorNeutralStroke2),
    transitionProperty: "width",
    transitionDuration: tokens.durationNormal,
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    height: `${LAYOUT.headerHeight}px`,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalS,
    ...shorthands.borderBottom("1px", "solid", tokens.colorNeutralStroke2),
  },
  brand: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    fontWeight: tokens.fontWeightSemibold,
  },
  dot: {
    width: "10px",
    height: "10px",
    borderRadius: "50%",
    backgroundColor: tokens.colorBrandBackground,
  },
  body: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
  },
});

interface LeftRailProps {
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

/**
 * Collapsible left rail. Hosts the onboarding flow first, then app navigation.
 * Owned by the shell team; features render inside `children`.
 */
export function LeftRail({ collapsed, onToggle, children }: LeftRailProps) {
  const styles = useStyles();
  return (
    <div
      className={styles.rail}
      style={{ width: collapsed ? LAYOUT.railCollapsedWidth : LAYOUT.railWidth }}
    >
      <div className={styles.header}>
        {!collapsed && (
          <span className={styles.brand}>
            <span className={styles.dot} />
            <Text weight="semibold">RAG Vault</Text>
          </span>
        )}
        <Tooltip content={collapsed ? "Expand" : "Collapse"} relationship="label">
          <Button
            appearance="subtle"
            icon={
              collapsed ? <PanelLeftExpand24Regular /> : <PanelLeftContract24Regular />
            }
            onClick={onToggle}
          />
        </Tooltip>
      </div>
      {!collapsed && <div className={styles.body}>{children}</div>}
    </div>
  );
}
