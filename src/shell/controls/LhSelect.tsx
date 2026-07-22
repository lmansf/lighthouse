"use client";

/**
 * §31 §3: the select — replaces Fluent's Dropdown geometry. iOS-style: the
 * trigger is a quiet control showing the current value with the
 * chevron-up-down affordance; options open as a checkmark-marked menu on
 * desktop/iPad-regular and as a sheet list on compact (same branch rule as
 * LhMenu — compact, not pointer). Fluent's Menu machinery stays underneath
 * on desktop (positioning, typeahead, a11y); the sheet path reuses the §2
 * primitive. The selection haptic ticks on iOS.
 */
import { useState } from "react";
import {
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  makeStyles,
  mergeClasses,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import { IconCheck, IconChevronUpDown } from "@/shell/icons";
import { Sheet } from "../Sheet";
import { usePaneLayout } from "../paneLayout";
import { selectionChanged } from "../haptics";

const useStyles = makeStyles({
  trigger: {
    display: "inline-flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    minHeight: "32px",
    "@media (pointer: coarse)": { minHeight: "44px" },
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalS,
    ...shorthands.borderStyle("none"),
    ...shorthands.borderRadius("var(--lh-radius-control)"),
    backgroundColor: "var(--lh-fill-secondary)",
    color: tokens.colorNeutralForeground1,
    fontFamily: "inherit",
    fontSize: tokens.fontSizeBase300,
    cursor: "pointer",
    outlineStyle: "none",
    ":focus-visible": {
      outlineWidth: "2px",
      outlineStyle: "solid",
      outlineColor: tokens.colorStrokeFocus2,
      outlineOffset: "2px",
    },
  },
  triggerValue: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  triggerChevron: { display: "inline-flex", color: tokens.colorNeutralForeground3, fontSize: "16px" },
  popover: {
    ...shorthands.borderRadius("var(--lh-radius-card)"),
    boxShadow: "0 0 0 0.5px var(--lh-separator), var(--lh-shadow-card)",
    animationDuration: "0.01ms",
  },
  // Sheet rows: checkmark gutter + label, 44pt, hairline-inset (LhMenu kin).
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
  check: { display: "inline-flex", width: "20px", flexShrink: 0, color: tokens.colorBrandForeground1 },
  rowLabel: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
});

export interface LhSelectOption {
  value: string;
  label: string;
}

export interface LhSelectProps {
  options: readonly LhSelectOption[];
  value: string;
  onChange: (value: string) => void;
  "aria-label": string;
  className?: string;
  disabled?: boolean;
}

export function LhSelect({
  options,
  value,
  onChange,
  "aria-label": ariaLabel,
  className,
  disabled = false,
}: LhSelectProps) {
  const styles = useStyles();
  const compact = usePaneLayout(false).compact;
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);

  const pick = (v: string) => {
    if (v !== value) {
      selectionChanged();
      onChange(v);
    }
    setOpen(false);
  };

  const trigger = (
    <button
      type="button"
      className={mergeClasses(styles.trigger, className)}
      aria-label={ariaLabel}
      aria-haspopup="listbox"
      disabled={disabled}
      onClick={compact ? () => setOpen(true) : undefined}
    >
      <span className={styles.triggerValue}>{current?.label ?? ""}</span>
      <span className={styles.triggerChevron} aria-hidden>
        <IconChevronUpDown />
      </span>
    </button>
  );

  if (!compact) {
    return (
      <Menu>
        <MenuTrigger disableButtonEnhancement>{trigger}</MenuTrigger>
        <MenuPopover className={styles.popover}>
          <MenuList>
            {options.map((o) => (
              <MenuItem
                key={o.value}
                icon={o.value === value ? <IconCheck /> : <span style={{ width: 20 }} />}
                onClick={() => pick(o.value)}
              >
                {o.label}
              </MenuItem>
            ))}
          </MenuList>
        </MenuPopover>
      </Menu>
    );
  }

  return (
    <>
      {trigger}
      {open && (
        <Sheet title={ariaLabel} onClose={() => setOpen(false)} initialDetent="medium">
          <div className={styles.sheetList} role="listbox" aria-label={ariaLabel}>
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={o.value === value}
                className={mergeClasses("lh-press", styles.row)}
                onClick={() => pick(o.value)}
              >
                <span className={styles.check} aria-hidden>
                  {o.value === value ? <IconCheck /> : null}
                </span>
                <span className={styles.rowLabel}>{o.label}</span>
              </button>
            ))}
          </div>
        </Sheet>
      )}
    </>
  );
}
