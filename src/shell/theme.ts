import {
  createDarkTheme,
  createLightTheme,
  type BrandVariants,
  type Theme,
} from "@fluentui/react-components";

/**
 * Lighthouse theme - a cool steel light palette (bright blue-grey neutrals)
 * with a Forerunner sea-sky blue as the primary brand (buttons, the beacon
 * lamp, links) and a subtle brass/gold as the secondary accent: the beacon's
 * luminous glint, highlights, and included-file marks. A matching dark-steel
 * variant (`darkLighthouseTheme`) mirrors the same character for dark mode;
 * app/providers.tsx picks between the two from the theme store.
 *
 * Aesthetic: Halo Forerunner architecture (bright silver-steel surfaces,
 * luminous blue lights, faint gold glints) crossed with a beach/lighthouse
 * palette (sea and sky blues, sand and brass golds). Reads as safe + high-tech.
 *
 * The shell team owns this file. Other features consume Fluent `tokens`
 * rather than hardcoding colors, so this stays the single source of truth.
 */

/** Lighthouse brand ramp - a Forerunner sea-sky blue (dark navy -> light sky). */
const forerunnerBlue: BrandVariants = {
  10: "#050F18",
  20: "#07203A",
  30: "#0A2E50",
  40: "#0D3D66",
  50: "#0F4A78",
  60: "#114F80",
  70: "#155E99",
  80: "#1A7AC0",
  90: "#2E8CCC",
  100: "#459CD6",
  110: "#63AFE0",
  120: "#84C2E8",
  130: "#A6D3F0",
  140: "#C7E2F5",
  150: "#E1EFFA",
  160: "#F3F9FD",
};

const base = createLightTheme(forerunnerBlue);

export const lighthouseTheme: Theme = {
  ...base,
  // Larger radii for a soft, rounded look.
  borderRadiusMedium: "8px",
  borderRadiusLarge: "12px",
  borderRadiusXLarge: "16px",
  // Cool steel neutrals (bright blue-grey). All contrast-checked against the
  // cool slate foregrounds below (see scripts/check-contrast.mjs).
  colorNeutralBackground1: "#EAEEF2", // app canvas (light steel)
  colorNeutralBackground1Hover: "#E1E7EE",
  colorNeutralBackground1Pressed: "#D7DFE8",
  colorNeutralBackground1Selected: "#DDE4EC",
  colorNeutralBackground2: "#DFE5EB", // sidebar / raised surfaces (steel)
  colorNeutralBackground2Hover: "#D6DDE5",
  colorNeutralBackground2Pressed: "#CCD5DF",
  colorNeutralBackground3: "#D2DAE2", // deeper steel (insets, code)
  colorNeutralBackground3Hover: "#C8D2DC",
  colorNeutralStroke1: "#B7C2CD",
  colorNeutralStroke2: "#CBD4DD",
  colorNeutralStroke3: "#E0E6EC",
  // Cool slate text (replaces Fluent's default near-blacks) - fits the steel
  // canvas and clears WCAG AAA on bg1 / AA on the deeper steels.
  colorNeutralForeground1: "#1A2531",
  colorNeutralForeground2: "#45566A",
  colorNeutralForeground3: "#5E6E80",
  // Links use an accessible sea-sky blue that clears WCAG AA as text on the
  // steel canvas.
  colorBrandForegroundLink: "#15639C",
  colorBrandForegroundLinkHover: "#114F80",
  colorBrandForegroundLinkPressed: "#0F4A78",
  colorBrandForegroundLinkSelected: "#114F80",
  // Primary-button blue, nudged one notch darker than the #1A7CC2 anchor so
  // white text clears AA with margin (4.59:1) - see scripts/check-contrast.mjs.
  colorBrandBackground: "#1A7AC0",
  colorBrandBackgroundHover: "#155E99",
  colorBrandBackgroundPressed: "#114F80",
  colorBrandBackgroundSelected: "#155E99",
};

const darkBase = createDarkTheme(forerunnerBlue);

/**
 * Dark Lighthouse - the same steel-and-beacon character on a night canvas:
 * dark blue-grey slate instead of Fluent's default warm greys, so surfaces
 * still read as Forerunner metal rather than generic dark mode.
 *
 * scripts/check-contrast.mjs is hardcoded to the light palette, so the dark
 * pairings were verified with the same WCAG math in a scratch run; the
 * resulting ratios are cited inline below. Keep them in sync if you retune.
 */
export const darkLighthouseTheme: Theme = {
  ...darkBase,
  // Same soft radii as the light theme.
  borderRadiusMedium: "8px",
  borderRadiusLarge: "12px",
  borderRadiusXLarge: "16px",
  // Dark steel slate (blue-grey nights). Mirrors the light ramp's structure:
  // bg1 canvas -> bg2 raised -> bg3 inset, but hover LIGHTENS and pressed
  // darkens (the Fluent dark convention - light rises toward the user).
  colorNeutralBackground1: "#151B22", // app canvas (night steel)
  colorNeutralBackground1Hover: "#1C242E",
  colorNeutralBackground1Pressed: "#101519",
  colorNeutralBackground1Selected: "#1A222B",
  colorNeutralBackground2: "#1B232C", // sidebar / raised surfaces
  colorNeutralBackground2Hover: "#222C37",
  colorNeutralBackground2Pressed: "#161C24",
  colorNeutralBackground3: "#222C37", // deeper inset (code, wells)
  colorNeutralBackground3Hover: "#2A3541",
  // Subtle-button states, re-tinted from Fluent's warm greys to the slate so
  // toolbar/icon-button hovers don't look brownish on the blue-grey canvas.
  colorSubtleBackgroundHover: "#28323E",
  colorSubtleBackgroundPressed: "#202933",
  colorSubtleBackgroundSelected: "#253040",
  // Strokes invert the light ramp: stroke1 is the strongest (lightest) line.
  colorNeutralStroke1: "#3D4A58",
  colorNeutralStroke2: "#303B47",
  colorNeutralStroke3: "#242E39",
  // Cool slate text, lightened for the night canvas. Ratios on bg1/bg2/bg3:
  // fg1 14.3/13.1/11.7 (AAA), fg2 8.6/7.9/7.0 (AAA), fg3 6.0/5.5 (AA+).
  colorNeutralForeground1: "#E4EAF1",
  colorNeutralForeground2: "#ABB8C6",
  colorNeutralForeground3: "#8B9AAB",
  // Links move up the brand ramp to the lighter sky blues so they clear WCAG
  // AA as text on the night steel: link 7.2/6.6/5.9 on bg1/bg2/bg3, hover
  // 9.0 on bg1, pressed 5.8/5.3 on bg1/bg2.
  colorBrandForegroundLink: "#63AFE0",
  colorBrandForegroundLinkHover: "#84C2E8",
  colorBrandForegroundLinkPressed: "#459CD6",
  colorBrandForegroundLinkSelected: "#84C2E8",
  // Primary buttons keep the light theme's blues: white text clears AA on all
  // of them here too (4.6 on rest, 6.8 hover, 8.6 pressed). Hover must stay
  // DARKER than rest - the lighter ramp step (#2E8CCC) drops white text to
  // 3.7, failing AA.
  colorBrandBackground: "#1A7AC0",
  colorBrandBackgroundHover: "#155E99",
  colorBrandBackgroundPressed: "#114F80",
  colorBrandBackgroundSelected: "#155E99",
};

/**
 * Lighthouse accent colors beyond the blue brand, for sparing use in features:
 * sea-sky blue (links, info, secondary text), brass/gold glints (the beacon
 * light, highlights, badges), and a soft white for cards on the steel. All
 * pairings are contrast-checked (WCAG AA) - see scripts/check-contrast.mjs.
 *
 * These are tuned for the LIGHT canvas. The brass glints (`beam`, `brass`)
 * also read well on the dark steel (9.0 and 5.8 on dark bg1), but `sky`,
 * `brandText`, and the pale fills do not - as dark-mode text they fall below
 * AA (e.g. sky is 2.7 on dark bg1). Prefer Fluent `tokens` (which the dark
 * theme remaps) over ACCENTS for anything that must survive both modes.
 */
export const ACCENTS = {
  // Sea-sky blue for links, info, and secondary text on the steel canvas.
  sky: "#15639C",
  skyFill: "#D4E6F4",
  // Brass/gold glints - the beacon's luminous glow and highlights.
  beam: "#E2B453", // bright brass glint (beacon glow)
  beamFill: "#F3E3BB", // soft gold fill (highlights, badges)
  brass: "#C28A2C", // deeper brass for icon / stroke accents (not body text)
  // Accessible deep-blue brand text for marks and labels on steel
  // (e.g. included-file marks).
  brandText: "#114F80",
  surface: "#FFFFFF",
} as const;

/** Layout constants shared across the shell. */
export const LAYOUT = {
  /** Width of the expanded file sidebar. */
  sidebarWidth: 360,
  /** Width of the collapsed sidebar (thin icon rail). */
  sidebarCollapsedWidth: 48,
  headerHeight: 56,
} as const;
