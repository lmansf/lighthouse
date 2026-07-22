"use client";

/**
 * §31 §3: the iOS switch — one of the five replaced controls (Fluent's pill
 * geometry is what still read Windows). Hand-rolled on the token layer: a
 * 51×31 capsule track that tints when on, a sliding white thumb on the §1
 * spring, and the selection haptic tick on iOS. Drop-in for Fluent's
 * `<Switch>`: the onChange signature is `(ev, { checked })` byte-for-byte so
 * call sites (and their test pins) migrate by import swap alone.
 *
 * Semantics: a real <button role="switch" aria-checked> — Space/Enter toggle
 * natively, the §1 focus ring shows on :focus-visible, and the label is a
 * <label>-equivalent click target. The tint rides colorBrandBackground so
 * accents (amber/teal/orchid) carry through automatically.
 */
import { makeStyles, mergeClasses, shorthands, tokens } from "@fluentui/react-components";
import { useId } from "react";
import { selectionChanged } from "../haptics";

const TRACK_W = 51;
const TRACK_H = 31;
const THUMB = 27;
const PAD = 2;

const useStyles = makeStyles({
  root: {
    display: "inline-flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
  },
  track: {
    position: "relative",
    width: `${TRACK_W}px`,
    height: `${TRACK_H}px`,
    flexShrink: 0,
    ...shorthands.borderRadius("var(--lh-capsule)"),
    ...shorthands.borderStyle("none"),
    ...shorthands.padding(0),
    backgroundColor: "var(--lh-fill)",
    cursor: "pointer",
    // Track color cross-fades; the thumb slides on the spring.
    transitionProperty: "background-color",
    transitionDuration: "var(--lh-dur-fast)",
    transitionTimingFunction: "linear",
    outlineStyle: "none",
    ":focus-visible": {
      outlineWidth: "2px",
      outlineStyle: "solid",
      outlineColor: tokens.colorStrokeFocus2,
      outlineOffset: "2px",
    },
  },
  trackOn: { backgroundColor: tokens.colorBrandBackground },
  thumb: {
    position: "absolute",
    top: `${PAD}px`,
    left: `${PAD}px`,
    width: `${THUMB}px`,
    height: `${THUMB}px`,
    ...shorthands.borderRadius("50%"),
    backgroundColor: "#FFFFFF",
    boxShadow: "0 0 0 0.5px rgba(0, 0, 0, 0.04), 0 3px 8px rgba(0, 0, 0, 0.15), 0 1px 1px rgba(0, 0, 0, 0.06)",
    transitionProperty: "transform",
    transitionDuration: "var(--lh-dur-fast)",
    transitionTimingFunction: "var(--lh-spring)",
  },
  thumbOn: { transform: `translateX(${TRACK_W - THUMB - 2 * PAD}px)` },
  disabled: { opacity: 0.4, cursor: "default" },
  label: {
    cursor: "pointer",
    userSelect: "none",
  },
  labelDisabled: { cursor: "default" },
});

export interface LhSwitchProps {
  checked: boolean;
  /** Fluent-shaped: `(ev, { checked })` — call sites migrate by import swap. */
  onChange?: (
    ev: React.MouseEvent<HTMLButtonElement>,
    data: { checked: boolean },
  ) => void;
  label?: React.ReactNode;
  /** Label side (Fluent parity); default after. */
  labelPosition?: "before" | "after";
  disabled?: boolean;
  "aria-label"?: string;
  className?: string;
}

export function LhSwitch({
  checked,
  onChange,
  label,
  labelPosition = "after",
  disabled = false,
  "aria-label": ariaLabel,
  className,
}: LhSwitchProps) {
  const styles = useStyles();
  const labelId = useId();

  const toggle = (ev: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled) return;
    selectionChanged();
    onChange?.(ev, { checked: !checked });
  };

  const labelEl = label != null && (
    <span
      id={labelId}
      className={mergeClasses(styles.label, disabled && styles.labelDisabled)}
      onClick={(ev) => {
        // The label is part of the tap target, iOS-style. Re-dispatch through
        // the same toggle path (typed as the button's event — same shape).
        toggle(ev as unknown as React.MouseEvent<HTMLButtonElement>);
      }}
    >
      {label}
    </span>
  );

  return (
    <span className={mergeClasses(styles.root, className)}>
      {labelPosition === "before" && labelEl}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel}
        aria-labelledby={label != null && !ariaLabel ? labelId : undefined}
        disabled={disabled}
        className={mergeClasses(styles.track, checked && styles.trackOn, disabled && styles.disabled)}
        onClick={toggle}
      >
        <span className={mergeClasses(styles.thumb, checked && styles.thumbOn)} aria-hidden />
      </button>
      {labelPosition === "after" && labelEl}
    </span>
  );
}
