import {
  createLightTheme,
  type BrandVariants,
  type Theme,
} from "@fluentui/react-components";

/**
 * Lighthouse theme — a sandy-beach light palette (warm cream/sand neutrals)
 * with a signal-red brand used sparingly as an accent: primary actions, the
 * beacon mark, and included-file highlights.
 *
 * The shell team owns this file. Other features consume Fluent `tokens`
 * rather than hardcoding colors, so this stays the single source of truth.
 */

/** Lighthouse brand ramp — a warm signal red. */
const lighthouseRed: BrandVariants = {
  10: "#1F0503",
  20: "#3B0D09",
  30: "#551310",
  40: "#6E1814",
  50: "#891D17",
  60: "#A4231B",
  70: "#C02A20",
  80: "#D83A2F",
  90: "#E5564B",
  100: "#EE6E63",
  110: "#F4857B",
  120: "#F89C93",
  130: "#FBB2AB",
  140: "#FDC8C3",
  150: "#FEDDD9",
  160: "#FFF0EE",
};

const base = createLightTheme(lighthouseRed);

export const lighthouseTheme: Theme = {
  ...base,
  // Larger radii for a soft, rounded, beachy look.
  borderRadiusMedium: "8px",
  borderRadiusLarge: "12px",
  borderRadiusXLarge: "16px",
  // Sandy-beach neutrals (warm cream → sand).
  colorNeutralBackground1: "#FBF5E9",
  colorNeutralBackground1Hover: "#F5ECD9",
  colorNeutralBackground1Pressed: "#EFE3CC",
  colorNeutralBackground1Selected: "#F2E7D0",
  colorNeutralBackground2: "#F4E9D2",
  colorNeutralBackground2Hover: "#EFE3C8",
  colorNeutralBackground2Pressed: "#E9DBBC",
  colorNeutralBackground3: "#ECE0C4",
  colorNeutralBackground3Hover: "#E7D9B8",
  colorNeutralStroke1: "#DECBA6",
  colorNeutralStroke2: "#E8DCC4",
  colorNeutralStroke3: "#F0E7D4",
};

/** Layout constants shared across the shell. The rail is fixed (non-collapsible). */
export const LAYOUT = {
  railWidth: 380,
  headerHeight: 56,
} as const;
