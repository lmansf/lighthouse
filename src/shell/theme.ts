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
  // Sandy-beach neutrals (warm cream → sand). All contrast-checked against the
  // warm-brown foregrounds below (see scripts/check-contrast.mjs).
  colorNeutralBackground1: "#FBF5E9", // app canvas (cream)
  colorNeutralBackground1Hover: "#F5ECD9",
  colorNeutralBackground1Pressed: "#EFE3CC",
  colorNeutralBackground1Selected: "#F2E7D0",
  colorNeutralBackground2: "#F4E9D2", // sidebar / raised surfaces (sand)
  colorNeutralBackground2Hover: "#EFE3C8",
  colorNeutralBackground2Pressed: "#E9DBBC",
  colorNeutralBackground3: "#EADFC5", // deeper sand (insets, code)
  colorNeutralBackground3Hover: "#E4D7B8",
  colorNeutralStroke1: "#D8C3A0",
  colorNeutralStroke2: "#E4D6BB",
  colorNeutralStroke3: "#F0E7D4",
  // Warm-brown text (replaces Fluent's cool near-blacks) — fits the sand canvas
  // and clears WCAG AAA on bg1 (14.7:1) / AA on the sands.
  colorNeutralForeground1: "#2A2018",
  colorNeutralForeground2: "#6E5C44",
  colorNeutralForeground3: "#87745A",
  // Links use the lighthouse "sky" blue rather than the brand red, so the red
  // stays reserved for primary actions and the beacon.
  colorBrandForegroundLink: "#2C6BA6",
  colorBrandForegroundLinkHover: "#22557F",
  colorBrandForegroundLinkPressed: "#1B445F",
  colorBrandForegroundLinkSelected: "#22557F",
  // Deepen the primary-button red one ramp step so white text clears AA with a
  // comfortable margin (5.8:1 vs the default 4.6:1).
  colorBrandBackground: "#C02A20",
  colorBrandBackgroundHover: "#A4231B",
  colorBrandBackgroundPressed: "#891D17",
  colorBrandBackgroundSelected: "#A4231B",
};

/**
 * Lighthouse accent colors beyond the red brand, for sparing use in features:
 * sky blue (links, info, secondary actions), beacon amber (the light / warnings,
 * highlights), and a soft white for cards on the sand. All pairings are
 * contrast-checked (WCAG AA) — see scripts/check-contrast.mjs.
 */
export const ACCENTS = {
  sky: "#2C6BA6",
  skyFill: "#CFE2F2",
  beam: "#E0A019", // lighthouse light (amber)
  beamFill: "#FBE7AC",
  redText: "#9A2017", // red brand as accessible text on the sands
  surface: "#FFFFFF",
} as const;

/** Layout constants shared across the shell. */
export const LAYOUT = {
  /** Width of the expanded file sidebar. */
  sidebarWidth: 320,
  /** Width of the collapsed sidebar (thin icon rail). */
  sidebarCollapsedWidth: 48,
  headerHeight: 56,
} as const;
