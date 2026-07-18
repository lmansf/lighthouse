"use client";

import { Text, makeStyles, shorthands, tokens } from "@fluentui/react-components";
import type { StatSpec } from "@/lib/statSpec";

/**
 * Inline stat tile for a single engine-verified number (openspec:
 * field-patch-0.12.5 §2). The value arrives in a ```lighthouse-stat fence the
 * engine emits from a verified count / single-value result — this component only
 * displays it; it never derives a number. Mirrors the boards stat-tile treatment
 * (BoardCard's statValue/statMeta): a large tabular numeral over a quiet caption,
 * tokens only so light/dark theming is automatic.
 */

const useStyles = makeStyles({
  tile: {
    display: "inline-flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
    marginTop: tokens.spacingVerticalS,
    marginBottom: tokens.spacingVerticalS,
    ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalL),
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow2,
    backgroundColor: tokens.colorNeutralBackground1,
    minWidth: 0,
  },
  // The one number, large — tabular numerals are the Beam number surface.
  value: {
    fontSize: tokens.fontSizeHero800,
    lineHeight: tokens.lineHeightHero800,
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: "tabular-nums",
    color: tokens.colorNeutralForeground1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  caption: { color: tokens.colorNeutralForeground3 },
});

export function StatTile({ spec }: { spec: StatSpec }) {
  const styles = useStyles();
  const aria = spec.label ? `${spec.raw} ${spec.label}` : spec.raw;
  return (
    <div className={styles.tile} role="img" aria-label={aria}>
      <span className={styles.value} title={spec.raw}>
        {spec.raw}
      </span>
      {spec.label && (
        <Text size={200} className={styles.caption}>
          {spec.label}
        </Text>
      )}
    </div>
  );
}
