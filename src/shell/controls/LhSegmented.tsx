"use client";

/**
 * §31 §3: the segmented control — the NEW primitive for the app's 2-4-option
 * choice rows (sentiment, view modes, theme pickers) that previously rendered
 * as Fluent Radio rows or ToggleButton pairs. iOS geometry on the token
 * layer: a rounded-9 fill track, equal-width segments, and a sliding
 * elevated "paddle" behind the selection that moves on the §1 spring; the
 * selection haptic ticks on iOS.
 *
 * Semantics: role="radiogroup" of role="radio" buttons — arrow keys move the
 * selection (the iOS pattern maps cleanly onto the radio idiom), the §1
 * focus ring shows on :focus-visible, and every target is ≥44pt tall on
 * coarse pointers via the shared touch sizing.
 */
import { makeStyles, mergeClasses, shorthands, tokens } from "@fluentui/react-components";
import { useRef } from "react";
import { selectionChanged } from "../haptics";

const useStyles = makeStyles({
  track: {
    position: "relative",
    display: "grid",
    gridAutoFlow: "column",
    gridAutoColumns: "1fr",
    alignItems: "stretch",
    ...shorthands.padding("2px"),
    ...shorthands.borderRadius("9px"),
    backgroundColor: "var(--lh-fill)",
    // The concentric rule: segments sit 2px inside the 9px track.
    "--lh-parent-radius": "9px",
    "--lh-gap": "2px",
  },
  paddle: {
    position: "absolute",
    top: "2px",
    bottom: "2px",
    left: "2px",
    ...shorthands.borderRadius("var(--lh-radius-concentric)"),
    backgroundColor: "var(--lh-bg-elevated)",
    boxShadow: "0 0 0 0.5px rgba(0, 0, 0, 0.04), 0 3px 8px rgba(0, 0, 0, 0.12)",
    transitionProperty: "transform",
    transitionDuration: "var(--lh-dur-fast)",
    transitionTimingFunction: "var(--lh-spring)",
    pointerEvents: "none",
  },
  segment: {
    position: "relative",
    zIndex: 1,
    minHeight: "28px",
    "@media (pointer: coarse)": { minHeight: "44px" },
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    ...shorthands.borderStyle("none"),
    ...shorthands.borderRadius("var(--lh-radius-concentric)"),
    backgroundColor: "transparent",
    color: tokens.colorNeutralForeground2,
    fontFamily: "inherit",
    fontSize: "var(--lh-type-subhead)",
    lineHeight: "var(--lh-type-subhead-lh)",
    cursor: "pointer",
    whiteSpace: "nowrap",
    outlineStyle: "none",
    ":focus-visible": {
      outlineWidth: "2px",
      outlineStyle: "solid",
      outlineColor: tokens.colorStrokeFocus2,
      outlineOffset: "-2px",
    },
  },
  segmentActive: {
    color: tokens.colorNeutralForeground1,
    fontWeight: tokens.fontWeightSemibold,
  },
});

export interface LhSegmentedOption {
  value: string;
  label: string;
}

export interface LhSegmentedProps {
  options: readonly LhSegmentedOption[];
  value: string;
  onChange: (value: string) => void;
  "aria-label": string;
  className?: string;
}

export function LhSegmented({
  options,
  value,
  onChange,
  "aria-label": ariaLabel,
  className,
}: LhSegmentedProps) {
  const styles = useStyles();
  const trackRef = useRef<HTMLDivElement | null>(null);
  const index = Math.max(0, options.findIndex((o) => o.value === value));

  const select = (v: string) => {
    if (v === value) return;
    selectionChanged();
    onChange(v);
  };

  // Roving arrows — the radio-group keyboard contract.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const dir =
      e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const next = options[(index + dir + options.length) % options.length];
    select(next.value);
    const btn = trackRef.current?.querySelectorAll("button")[
      (index + dir + options.length) % options.length
    ] as HTMLButtonElement | undefined;
    btn?.focus();
  };

  return (
    <div
      ref={trackRef}
      role="radiogroup"
      aria-label={ariaLabel}
      className={mergeClasses(styles.track, className)}
      onKeyDown={onKeyDown}
    >
      <span
        className={styles.paddle}
        aria-hidden
        style={{
          width: `calc((100% - 4px) / ${options.length})`,
          transform: `translateX(${index * 100}%)`,
        }}
      />
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            className={mergeClasses(styles.segment, active && styles.segmentActive)}
            onClick={() => select(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
