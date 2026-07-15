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
import { SidebarWater } from "./SidebarWater";
import { SettingsMenu, TrialBadge } from "@/features/license/LicenseGate";
import { UpdateNotice } from "@/features/update/UpdateNotice";
import { modKey } from "@/features/onboarding/ModeChooser";

const useStyles = makeStyles({
  sidebar: {
    position: "relative", // anchors the water backdrop behind the content
    display: "flex",
    flexDirection: "column",
    height: "100%",
    width: `${LAYOUT.sidebarWidth}px`,
    flexShrink: 0,
    backgroundColor: tokens.colorNeutralBackground2,
    ...shorthands.borderRight("1px", "solid", tokens.colorNeutralStroke2),
    overflow: "hidden",
    // Glide between widths instead of snapping; honored off for reduced motion.
    transitionProperty: "width",
    transitionDuration: tokens.durationSlow,
    transitionTimingFunction: tokens.curveEasyEase,
    "@media (prefers-reduced-motion: reduce)": { transitionDuration: "0.01ms" },
  },
  collapsed: { width: `${LAYOUT.sidebarCollapsedWidth}px` },
  // The water backdrop stays mounted and fades with the collapse so it no
  // longer blinks in/out as the rail toggles.
  waterWrap: {
    position: "absolute",
    inset: 0,
    zIndex: 0,
    opacity: 1,
    transitionProperty: "opacity",
    transitionDuration: tokens.durationSlow,
    transitionTimingFunction: tokens.curveEasyEase,
    "@media (prefers-reduced-motion: reduce)": { transitionDuration: "0.01ms" },
  },
  waterWrapHidden: { opacity: 0 },
  // Compact affordances for the collapsed rail (update + trial dots), stacked
  // and centered above the settings gear.
  railAffordances: {
    position: "relative",
    zIndex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: tokens.spacingVerticalXS,
    marginBottom: tokens.spacingVerticalXS,
  },
  header: {
    position: "relative",
    zIndex: 1,
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
  // The beacon: a blue lamp throwing a warm gold glow - the lighthouse light.
  beacon: {
    width: "10px",
    height: "10px",
    borderRadius: "50%",
    flexShrink: 0,
    backgroundColor: tokens.colorBrandBackground,
    boxShadow: `0 0 10px 2px ${ACCENTS.beam}`,
  },
  // Inset the explorer from the sidebar edges so its rows and controls aren't
  // cramped against the left border / right scrollbar. Aligns with the header
  // and footer's horizontal padding.
  body: {
    position: "relative",
    zIndex: 1,
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    ...shorthands.padding(0, tokens.spacingHorizontalM),
  },
  bodyHidden: { display: "none" },
  footer: {
    position: "relative",
    zIndex: 1,
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    flexShrink: 0,
    marginTop: "auto",
    ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalM),
    ...shorthands.borderTop("1px", "solid", tokens.colorNeutralStroke2),
  },
  footerCollapsed: { justifyContent: "center", ...shorthands.padding(tokens.spacingVerticalS, 0) },
  footerLabel: { color: tokens.colorNeutralForeground3 },
  // Pushes the trial countdown to the footer's right edge, away from the gear.
  footerTrial: { marginLeft: "auto", minWidth: 0, display: "inline-flex" },
});

interface SidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** The sidebar body — the file explorer. Hidden while collapsed. */
  children: React.ReactNode;
}

/**
 * Collapsible left sidebar: brand + collapse toggle on
 * top, the file explorer in the middle, and the settings gear (plus the trial
 * countdown, when a trial is running) pinned bottom-left.
 * Collapsed, it shrinks to a thin icon rail that still exposes expand + settings.
 */
export function Sidebar({ collapsed, onToggleCollapsed, children }: SidebarProps) {
  const styles = useStyles();

  const toggleHint = `(${modKey()}+B)`;

  return (
    <div className={mergeClasses(styles.sidebar, collapsed && styles.collapsed)}>
      <div className={mergeClasses(styles.waterWrap, collapsed && styles.waterWrapHidden)} aria-hidden>
        <SidebarWater />
      </div>
      <div className={mergeClasses(styles.header, collapsed && styles.headerCollapsed)}>
        {collapsed ? (
          <Tooltip content={`Expand files ${toggleHint}`} relationship="label">
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
            <Tooltip content={`Collapse files ${toggleHint}`} relationship="label">
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
      {/* Above Settings: the one-line "new version" nudge (desktop only). In the
          collapsed rail the update and trial countdown each become a compact dot
          so neither is hidden just because the sidebar is thin. */}
      {collapsed ? (
        <div className={styles.railAffordances}>
          <UpdateNotice collapsed />
          <TrialBadge collapsed />
        </div>
      ) : (
        <UpdateNotice />
      )}
      <div className={mergeClasses(styles.footer, collapsed && styles.footerCollapsed)}>
        <SettingsMenu />
        {!collapsed && (
          <>
            <Text size={200} className={styles.footerLabel}>
              Settings
            </Text>
            <span className={styles.footerTrial}>
              <TrialBadge />
            </span>
          </>
        )}
      </div>
    </div>
  );
}
