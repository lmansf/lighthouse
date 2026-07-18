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
import { SettingsMenu } from "@/features/settings/SettingsMenu";
import { UpdateNotice } from "@/features/update/UpdateNotice";
import { modKey } from "@/features/onboarding/ModeChooser";

const useStyles = makeStyles({
  sidebar: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    // The expanded width rides an inline CSS var (openspec:
    // add-usability-field-patch §1) so the drag handle can size it live —
    // Griffel makeStyles is build-time atomic, so a dynamic width can't live
    // here. The fallback is the layout default until the user drags. The
    // `collapsed` class overrides this to the thin rail (last-wins in the
    // merge), and the inline var is simply ignored while collapsed.
    width: `var(--sidebar-w, ${LAYOUT.sidebarWidth}px)`,
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
  // The beacon: the amber lamp and its warm halo - the lighthouse light.
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
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    ...shorthands.padding(0, tokens.spacingHorizontalM),
  },
  bodyHidden: { display: "none" },
  footer: {
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
});

interface SidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** The sidebar body — the file explorer. Hidden while collapsed. */
  children: React.ReactNode;
  /**
   * Expanded width in px (openspec: add-usability-field-patch §1). Applied as
   * the `--sidebar-w` inline var; ignored while collapsed. Undefined ⇒ the
   * makeStyles default.
   */
  width?: number;
  /** True while a live drag is resizing the sidebar — suppresses the width
   *  transition so the edge tracks the cursor instead of easing behind it. */
  resizing?: boolean;
}

/**
 * Collapsible left sidebar: brand + collapse toggle on
 * top, the file explorer in the middle, and the settings gear pinned
 * bottom-left.
 * Collapsed, it shrinks to a thin icon rail that still exposes expand + settings.
 */
export function Sidebar({
  collapsed,
  onToggleCollapsed,
  children,
  width,
  resizing,
}: SidebarProps) {
  const styles = useStyles();

  const toggleHint = `(${modKey()}+B)`;

  return (
    <div
      className={mergeClasses(styles.sidebar, collapsed && styles.collapsed)}
      style={
        collapsed
          ? undefined
          : // The live width (openspec §1). Inline style wins over the atomic
            // class, so suppressing the transition here keeps the edge glued to
            // the cursor mid-drag; off-drag it falls back to the eased makeStyles
            // transition (collapse animation intact).
            ({
              ...(width ? { "--sidebar-w": `${width}px` } : {}),
              ...(resizing ? { transitionProperty: "none" } : {}),
            } as React.CSSProperties)
      }
    >
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
      {/* Above Settings: the one-line "new version" nudge (desktop only), a
          compact dot in the collapsed rail so it isn't hidden just because the
          sidebar is thin. */}
      {collapsed ? <UpdateNotice collapsed /> : <UpdateNotice />}
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
