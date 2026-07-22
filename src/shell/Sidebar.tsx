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
import { IconSearch, IconSidebarCollapse, IconSidebarExpand } from "@/shell/icons";
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
  // Trailing header controls kept grouped on the right so the brand stays left
  // even when the touch-only quick-open button is present.
  headerActions: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalXS },
  // Quick-open / command search. Ctrl/Cmd+P covers desktop, so this button only
  // appears on coarse (touch) pointers, where the finder is otherwise
  // unreachable. Kept a 44px tap target. Desktop is pixel-unchanged.
  quickOpenBtn: {
    display: "none",
    "@media (pointer: coarse)": {
      display: "inline-flex",
      minWidth: "44px",
      minHeight: "44px",
    },
  },
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
  /** The sidebar body — the file explorer (the top anchor). Hidden while collapsed. */
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
  /**
   * fp3 §3 → §34: this sidebar is the compact Files PAGE — a tab root. Set by
   * AppShell only in that branch; it drops the desktop collapse chevron (the
   * tab bar is the navigation; the old page "Back" button is gone with it) and
   * the footer Settings gear (Settings is its own tab there). Desktop/widget/
   * explorer callers omit it and keep both byte-for-byte.
   */
  compactPage?: boolean;
}

/**
 * Collapsible left sidebar: brand + collapse toggle on top, the file explorer
 * in the middle, and the settings gear pinned bottom-left — Files + Settings
 * only (0.13.10 §3: the section rail is retired; its capabilities live on the
 * chat header, in Settings, and as chat chips).
 * Collapsed, it shrinks to a thin icon rail that still exposes expand + settings.
 */
export function Sidebar({
  collapsed,
  onToggleCollapsed,
  children,
  width,
  resizing,
  compactPage,
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
              icon={<IconSidebarExpand />}
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
            <span className={styles.headerActions}>
              {/* 0.13.10 §5: the compact files PAGE (compactPage set) uses the
                  tile grid's pull-down search instead — one finder per surface.
                  The launcher stays for iPad-regular / desktop-touch, where the
                  tree has no pull-down field. */}
              {!compactPage && (
                <Tooltip content="Quick open a file" relationship="label">
                  <Button
                    appearance="subtle"
                    className={styles.quickOpenBtn}
                    icon={<IconSearch />}
                    aria-label="Quick open a file"
                    // Reuses the exact event the Ctrl/Cmd+P shortcut dispatches,
                    // so the fuzzy finder is reachable without a keyboard.
                    onClick={() =>
                      window.dispatchEvent(new CustomEvent("lighthouse:quick-open"))
                    }
                  />
                </Tooltip>
              )}
              {/* §34: a tab root gets NO trailing control — the tab bar is
                  the navigation; desktop keeps its collapse chevron. */}
              {!compactPage && (
                <Tooltip content={`Collapse files ${toggleHint}`} relationship="label">
                  <Button
                    appearance="subtle"
                    size="small"
                    icon={<IconSidebarCollapse />}
                    aria-label="Collapse sidebar"
                    onClick={onToggleCollapsed}
                  />
                </Tooltip>
              )}
            </span>
          </>
        )}
      </div>
      <div className={mergeClasses(styles.body, collapsed && styles.bodyHidden)}>{children}</div>
      {/* Above Settings: the one-line "new version" nudge (desktop only), a
          compact dot in the collapsed rail so it isn't hidden just because the
          sidebar is thin. */}
      {collapsed ? <UpdateNotice collapsed /> : <UpdateNotice />}
      {/* §34 §3: the compact Files page carries no footer gear — Settings is
          its own tab there. Desktop keeps its ONE Settings entry byte-for-byte. */}
      {!compactPage && (
        <div className={mergeClasses(styles.footer, collapsed && styles.footerCollapsed)}>
          <SettingsMenu />
          {!collapsed && (
            <Text size={200} className={styles.footerLabel}>
              Settings
            </Text>
          )}
        </div>
      )}
    </div>
  );
}
