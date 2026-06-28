"use client";

import {
  Button,
  Text,
  Tooltip,
  makeStyles,
  mergeClasses,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import { PanelLeftContractRegular, PanelLeftExpandRegular } from "@fluentui/react-icons";
import { LAYOUT, ACCENTS } from "./theme";
import { SettingsMenu } from "@/features/license/LicenseGate";

const useStyles = makeStyles({
  sidebar: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    width: `${LAYOUT.sidebarWidth}px`,
    flexShrink: 0,
    backgroundColor: tokens.colorNeutralBackground2,
    ...shorthands.borderRight("1px", "solid", tokens.colorNeutralStroke2),
    overflow: "hidden",
  },
  collapsed: { width: `${LAYOUT.sidebarCollapsedWidth}px` },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalS,
    height: `${LAYOUT.headerHeight}px`,
    flexShrink: 0,
    ...shorthands.padding(0, tokens.spacingHorizontalM),
    ...shorthands.borderBottom("1px", "solid", tokens.colorNeutralStroke2),
  },
  headerCollapsed: { justifyContent: "center", ...shorthands.padding(0) },
  brand: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    fontWeight: tokens.fontWeightSemibold,
    minWidth: 0,
  },
  // The beacon: a red lamp throwing a warm amber glow — the lighthouse light.
  beacon: {
    width: "10px",
    height: "10px",
    borderRadius: "50%",
    flexShrink: 0,
    backgroundColor: tokens.colorBrandBackground,
    boxShadow: `0 0 10px 2px ${ACCENTS.beam}`,
  },
  body: { flex: 1, minHeight: 0, overflowY: "auto" },
  bodyHidden: { display: "none" },
  footer: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    flexShrink: 0,
    ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalM),
    ...shorthands.borderTop("1px", "solid", tokens.colorNeutralStroke2),
  },
  footerCollapsed: { justifyContent: "center", ...shorthands.padding(tokens.spacingVerticalS, 0) },
  footerLabel: { color: tokens.colorNeutralForeground3 },
});

interface SidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** The sidebar body — the file explorer. Hidden while collapsed. */
  children: React.ReactNode;
}

/**
 * Collapsible left sidebar (Databricks/Genie style): brand + collapse toggle on
 * top, the file explorer in the middle, and the settings gear pinned bottom-left.
 * Collapsed, it shrinks to a thin icon rail that still exposes expand + settings.
 */
export function Sidebar({ collapsed, onToggleCollapsed, children }: SidebarProps) {
  const styles = useStyles();

  return (
    <div className={mergeClasses(styles.sidebar, collapsed && styles.collapsed)}>
      <div className={mergeClasses(styles.header, collapsed && styles.headerCollapsed)}>
        {collapsed ? (
          <Tooltip content="Expand files" relationship="label">
            <Button
              appearance="subtle"
              size="small"
              icon={<PanelLeftExpandRegular />}
              aria-label="Expand sidebar"
              onClick={onToggleCollapsed}
            />
          </Tooltip>
        ) : (
          <>
            <span className={styles.brand}>
              <span className={styles.beacon} />
              <Text weight="semibold">Lighthouse</Text>
            </span>
            <Tooltip content="Collapse files" relationship="label">
              <Button
                appearance="subtle"
                size="small"
                icon={<PanelLeftContractRegular />}
                aria-label="Collapse sidebar"
                onClick={onToggleCollapsed}
              />
            </Tooltip>
          </>
        )}
      </div>
      <div className={mergeClasses(styles.body, collapsed && styles.bodyHidden)}>{children}</div>
      <div className={mergeClasses(styles.footer, collapsed && styles.footerCollapsed)}>
        <SettingsMenu />
        {!collapsed && (
          <Text size={200} className={styles.footerLabel}>
            Settings
          </Text>
        )}
      </div>
    </div>
  );
}
