"use client";

/**
 * §31 §3: the adaptive menu — one of the five replaced controls. The BRANCH
 * IS COMPACT, not pointer: an iPad at regular width keeps a popover menu (the
 * HIG idiom there — §5 acceptance), a phone gets an action SHEET.
 *
 *  - compact: the §2 Sheet (medium detent) as an action sheet — 44pt rows,
 *    icon + label, destructive rows in the palette red, submenus push a
 *    second page inside the same sheet (Back returns).
 *  - regular/desktop: Fluent's Menu stays as the headless machinery under a
 *    quiet token skin — 12-radius surface, hairline ring, ambient shadow,
 *    and NO Fluent open animation (menus appear, they don't perform).
 *
 * The declarative item list (not Fluent's JSX composition) is what makes the
 * same menu render both ways; call sites describe WHAT the menu is once.
 */
import { useState } from "react";
import {
  Menu,
  MenuDivider,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  makeStyles,
  mergeClasses,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import { IconBack, IconChevronRight } from "@/shell/icons";
import { Sheet } from "../Sheet";
import { usePaneLayout } from "../paneLayout";

const useStyles = makeStyles({
  // The desktop skin: quiet geometry, no entrance choreography.
  popover: {
    ...shorthands.borderRadius("var(--lh-radius-card)"),
    boxShadow: "0 0 0 0.5px var(--lh-separator), var(--lh-shadow-card)",
    animationDuration: "0.01ms",
    paddingTop: "4px",
    paddingBottom: "4px",
  },
  // Action-sheet rows (compact): thumb-sized, icon + label, hairline-inset.
  sheetList: { display: "flex", flexDirection: "column", paddingTop: "4px", paddingBottom: "8px" },
  row: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalM,
    minHeight: "44px",
    paddingLeft: "4px",
    paddingRight: "4px",
    ...shorthands.borderStyle("none"),
    backgroundColor: "transparent",
    color: tokens.colorNeutralForeground1,
    fontFamily: "inherit",
    fontSize: tokens.fontSizeBase300,
    textAlign: "left",
    cursor: "pointer",
    ...shorthands.borderRadius("var(--lh-radius-control)"),
    boxShadow: "inset 0 calc(-1 * var(--lh-hairline)) 0 var(--lh-separator)",
    ":last-child": { boxShadow: "none" },
    outlineStyle: "none",
    ":focus-visible": {
      outlineWidth: "2px",
      outlineStyle: "solid",
      outlineColor: tokens.colorStrokeFocus2,
      outlineOffset: "-2px",
    },
  },
  rowDanger: { color: tokens.colorPaletteRedForeground1 },
  rowDisabled: { color: tokens.colorNeutralForegroundDisabled, cursor: "default" },
  rowIcon: { display: "inline-flex", fontSize: "20px", flexShrink: 0 },
  rowLabel: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  rowChevron: { display: "inline-flex", color: tokens.colorNeutralForeground3 },
});

export interface LhMenuItem {
  key: string;
  label: string;
  /** ReactElement (not node) — it feeds Fluent's icon slot on desktop. */
  icon?: React.ReactElement;
  /** Destructive rows render in the palette red on both hosts. */
  danger?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  /** Nested items: a Fluent submenu on desktop, a pushed page in the sheet. */
  submenu?: LhMenuItem[];
}

export interface LhMenuProps {
  /** The trigger element (a Button, an icon button, a row) — cloned by Fluent
   *  on desktop, wrapped with an onClick on compact. */
  trigger: React.ReactElement;
  items: readonly LhMenuItem[];
  /** The sheet title on compact; also the menu's accessible name. */
  "aria-label": string;
}

function DesktopItems({ items }: { items: readonly LhMenuItem[] }) {
  return (
    <>
      {items.map((it) =>
        it.submenu ? (
          <Menu key={it.key}>
            <MenuTrigger disableButtonEnhancement>
              <MenuItem icon={it.icon}>{it.label}</MenuItem>
            </MenuTrigger>
            <LhMenuPopoverList items={it.submenu} />
          </Menu>
        ) : it.key.startsWith("--") ? (
          <MenuDivider key={it.key} />
        ) : (
          <MenuItem key={it.key} icon={it.icon} disabled={it.disabled} onClick={it.onClick}>
            {it.label}
          </MenuItem>
        ),
      )}
    </>
  );
}

function LhMenuPopoverList({ items }: { items: readonly LhMenuItem[] }) {
  return (
    <LhMenuPopover>
      <MenuList>
        <DesktopItems items={items} />
      </MenuList>
    </LhMenuPopover>
  );
}

/**
 * The quiet-skin MenuPopover on its own — for menus whose Fluent composition
 * must stay (MenuItemRadio/checkbox pickers, grouped headers): swap
 * `MenuPopover` for this and keep everything inside byte-identical. Simple
 * action menus should use `LhMenu` instead, which also buys the compact
 * action sheet.
 */
export function LhMenuPopover({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const styles = useStyles();
  return <MenuPopover className={mergeClasses(styles.popover, className)}>{children}</MenuPopover>;
}

export function LhMenu({ trigger, items, "aria-label": ariaLabel }: LhMenuProps) {
  const styles = useStyles();
  const compact = usePaneLayout(false).compact;
  const [open, setOpen] = useState(false);
  // The sheet's page stack: null = the root list, else the pushed submenu.
  const [page, setPage] = useState<{ title: string; items: readonly LhMenuItem[] } | null>(null);

  if (!compact) {
    return (
      <Menu>
        <MenuTrigger disableButtonEnhancement>{trigger}</MenuTrigger>
        <LhMenuPopoverList items={items} />
      </Menu>
    );
  }

  const rows = page?.items ?? items;
  const closeAll = () => {
    setOpen(false);
    setPage(null);
  };
  const sheetRow = (it: LhMenuItem) => {
    if (it.key.startsWith("--")) return null; // dividers ride the row hairlines
    return (
      <button
        key={it.key}
        type="button"
        className={mergeClasses(
          "lh-press",
          styles.row,
          it.danger && styles.rowDanger,
          it.disabled && styles.rowDisabled,
        )}
        disabled={it.disabled}
        onClick={() => {
          if (it.submenu) {
            setPage({ title: it.label, items: it.submenu });
            return;
          }
          closeAll();
          it.onClick?.();
        }}
      >
        {it.icon && (
          <span className={styles.rowIcon} aria-hidden>
            {it.icon}
          </span>
        )}
        <span className={styles.rowLabel}>{it.label}</span>
        {it.submenu && (
          <span className={styles.rowChevron} aria-hidden>
            <IconChevronRight />
          </span>
        )}
      </button>
    );
  };

  return (
    <>
      {/* The same trigger element, opening the action sheet instead. */}
      <span onClick={() => setOpen(true)} style={{ display: "contents" }}>
        {trigger}
      </span>
      {open && (
        <Sheet title={page?.title ?? ariaLabel} onClose={closeAll} initialDetent="medium">
          <div className={styles.sheetList} role="menu" aria-label={page?.title ?? ariaLabel}>
            {page && (
              <button type="button" className={mergeClasses("lh-press", styles.row)} onClick={() => setPage(null)}>
                <span className={styles.rowIcon} aria-hidden>
                  <IconBack />
                </span>
                <span className={styles.rowLabel}>Back</span>
              </button>
            )}
            {rows.map(sheetRow)}
          </div>
        </Sheet>
      )}
    </>
  );
}
