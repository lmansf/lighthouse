import {
  createDarkTheme,
  createLightTheme,
  type BrandVariants,
  type Theme,
} from "@fluentui/react-components";

/**
 * The Beam identity (0.12.0) - Lighthouse's visual language, in two themes:
 *
 *  - "Paper" (light): a warm paper canvas (#FAFAF8) with ink text (#1B1B1F),
 *    quiet hairlines, and a single warm-amber accent - the lighthouse beam.
 *  - "Ink" (dark): the same relationships on a night-ink canvas (#0E0F12),
 *    with the amber pitched brighter (#FFC24D) so it reads as the lit lamp.
 *
 * Principles: clarity (content first, one accent hue plus the unchanged
 * destructive red), deference (neutral surfaces, hairline strokes, two soft
 * elevation levels), depth (the beam-sweep gradient reserved for hero
 * moments). Amber carries primary actions, focus, and included/active marks;
 * links stay a quiet blue because amber cannot clear WCAG AA as small text on
 * the paper canvas (2.1:1 - see scripts/check-contrast.mjs, which now gates
 * EVERY pairing in BOTH themes).
 *
 * The shell team owns this file. Other features consume Fluent `tokens`
 * rather than hardcoding colors, so this stays the single source of truth.
 * app/providers.tsx picks between the two themes from the theme store.
 */

/**
 * The Beam brand ramp - warm amber, near-black ember (10) to pale parchment
 * (160). Anchors: 100 = #E8A317 (the light theme's action amber) and
 * 120 = #FFC24D (the dark theme's). The low steps (20/40) double as the dark
 * theme's brand-tinted surfaces and were deepened until quiet text passes AA
 * on them; the 60-80 band supplies ambers dark enough to act as foregrounds
 * on paper (the anchor amber itself is fill-only in light - as small text or
 * thin strokes on paper it fails AA/1.4.11).
 */
const beamAmber: BrandVariants = {
  10: "#211703",
  20: "#2C1F04",
  30: "#553B08",
  40: "#664508",
  50: "#7D5707",
  60: "#936608",
  70: "#A87107",
  80: "#BC7F09",
  90: "#D2920E",
  100: "#E8A317",
  110: "#F5B83C",
  120: "#FFC24D",
  130: "#FFCF70",
  140: "#FFDD9B",
  150: "#FBEFD4",
  160: "#FDF7E7",
};

/**
 * Platform-native UI text: whatever the OS renders its own chrome with
 * (San Francisco on macOS via -apple-system, Segoe UI Variable/Segoe UI on
 * Windows, the system default elsewhere). Mirrored by app/globals.css for the
 * pre-hydration frame; keep the two lists identical.
 */
const FONT_STACK = '-apple-system, "Segoe UI Variable", "Segoe UI", system-ui, sans-serif';

/**
 * Exactly two elevation levels: a hairline ring (the border and the shadow
 * are one thing) plus a soft ambient shade. "Rest" for cards and inline
 * surfaces, "raised" for anything floating (menus, popovers, dialogs, the
 * jump pill). Every Fluent shadow token collapses onto these two.
 */
const PAPER_SHADOW_REST =
  "0 0 0 1px rgba(27, 27, 31, 0.05), 0 1px 2px rgba(27, 27, 31, 0.06)";
const PAPER_SHADOW_RAISED =
  "0 0 0 1px rgba(27, 27, 31, 0.05), 0 8px 24px rgba(27, 27, 31, 0.12)";
const INK_SHADOW_REST =
  "0 0 0 1px rgba(236, 236, 234, 0.06), 0 1px 2px rgba(0, 0, 0, 0.40)";
const INK_SHADOW_RAISED =
  "0 0 0 1px rgba(236, 236, 234, 0.07), 0 12px 32px rgba(0, 0, 0, 0.55)";

/** Beam radii: large surfaces 12, cards 10, controls 8 (the 8px grid's kin). */
const RADII = {
  borderRadiusMedium: "8px",
  borderRadiusLarge: "10px",
  borderRadiusXLarge: "12px",
} as const;

const base = createLightTheme(beamAmber);

/**
 * Paper (light). All pairings below are AA-gated by scripts/check-contrast.mjs
 * (`node scripts/check-contrast.mjs` - checks BOTH themes); keep that script's
 * palette in sync when retuning here.
 */
export const lighthouseTheme: Theme = {
  ...base,
  fontFamilyBase: FONT_STACK,
  ...RADII,
  shadow2: PAPER_SHADOW_REST,
  shadow4: PAPER_SHADOW_REST,
  shadow8: PAPER_SHADOW_RAISED,
  shadow16: PAPER_SHADOW_RAISED,
  shadow28: PAPER_SHADOW_RAISED,
  shadow64: PAPER_SHADOW_RAISED,
  // Warm paper neutrals: canvas -> raised -> inset, hover/pressed/selected
  // stepping slightly darker (the light-theme convention the steel palette
  // also followed).
  colorNeutralBackground1: "#FAFAF8", // app canvas (paper)
  colorNeutralBackground1Hover: "#F2F2EF",
  colorNeutralBackground1Pressed: "#E9E9E5",
  colorNeutralBackground1Selected: "#EFEFEB",
  colorNeutralBackground2: "#F4F4F1", // sidebar / raised surfaces
  colorNeutralBackground2Hover: "#ECECE8",
  colorNeutralBackground2Pressed: "#E3E3DE",
  colorNeutralBackground3: "#EDEDE9", // insets, code wells
  colorNeutralBackground3Hover: "#E4E4E0",
  // Subtle-button states, re-tinted from Fluent's pure greys to the paper
  // family so icon-button hovers don't read cold on the warm canvas.
  colorSubtleBackgroundHover: "#F0F0EC",
  colorSubtleBackgroundPressed: "#E7E7E2",
  colorSubtleBackgroundSelected: "#ECECE7",
  colorNeutralStroke1: "#D6D6D0",
  colorNeutralStroke2: "#E7E7E2", // the hairline
  colorNeutralStroke3: "#F0F0EC",
  // Ink text: fg1 16.4:1 (AAA) on canvas; fg2 6.6/6.2/5.8 and fg3
  // 5.3/5.0/4.7 on bg1/bg2/bg3 - all AA+.
  colorNeutralForeground1: "#1B1B1F",
  colorNeutralForeground2: "#5A5A60",
  colorNeutralForeground3: "#68686F",
  // Primary actions: the anchor amber as a FILL with ink text on it (7.9:1;
  // white text would sit at 2.2 and fail). Hover/pressed darken the fill and
  // keep ink text at 7.1/5.7.
  colorBrandBackground: "#E8A317",
  colorBrandBackgroundHover: "#DE9A11",
  colorBrandBackgroundPressed: "#C9880B",
  colorBrandBackgroundSelected: "#DE9A11",
  colorNeutralForegroundOnBrand: "#1B1B1F",
  // Amber as a foreground must come from further down the ramp: the anchor
  // #E8A317 is only 2.1:1 on paper. fg1 (active icons/marks, 4.0:1) and fg2
  // (brand text on tints, 5.2:1 on canvas / 5.1 on the tint) both clear the
  // gate; the ramp's own 80/70 defaults sat at 3.3/3.9 - too thin for text.
  colorBrandForeground1: "#A87107",
  colorBrandForeground2: "#8F6006",
  // Links: a quiet slate blue (5.5/5.2/4.9 on bg1/bg2/bg3) - the one deliberate
  // second hue, because amber small text cannot pass on paper (see above).
  colorBrandForegroundLink: "#46698C",
  colorBrandForegroundLinkHover: "#3A587A",
  colorBrandForegroundLinkPressed: "#2F4A68",
  colorBrandForegroundLinkSelected: "#3A587A",
  // Focus is amber too - the deep foreground amber (4.0:1 vs canvas, 3.8 vs
  // raised surfaces; 1.4.11 needs 3.0).
  colorStrokeFocus2: "#A87107",
};

const darkBase = createDarkTheme(beamAmber);

/**
 * Ink (dark) - the same Beam relationships on a night canvas: bg1 canvas ->
 * bg2 raised -> bg3 inset, but hover LIGHTENS and pressed darkens (the Fluent
 * dark convention - light rises toward the user). Gated by the same script,
 * dark section.
 */
export const darkLighthouseTheme: Theme = {
  ...darkBase,
  fontFamilyBase: FONT_STACK,
  ...RADII,
  shadow2: INK_SHADOW_REST,
  shadow4: INK_SHADOW_REST,
  shadow8: INK_SHADOW_RAISED,
  shadow16: INK_SHADOW_RAISED,
  shadow28: INK_SHADOW_RAISED,
  shadow64: INK_SHADOW_RAISED,
  colorNeutralBackground1: "#0E0F12", // app canvas (ink)
  colorNeutralBackground1Hover: "#15171B",
  colorNeutralBackground1Pressed: "#0A0B0E",
  colorNeutralBackground1Selected: "#14161B",
  colorNeutralBackground2: "#16181C", // sidebar / raised surfaces
  colorNeutralBackground2Hover: "#1D2025",
  colorNeutralBackground2Pressed: "#101215",
  colorNeutralBackground3: "#1E2126", // deeper inset (code, wells)
  colorNeutralBackground3Hover: "#262A30",
  // Subtle-button states, re-tinted from Fluent's warm greys to the ink
  // family so toolbar hovers don't look brownish on the night canvas.
  colorSubtleBackgroundHover: "#22252B",
  colorSubtleBackgroundPressed: "#1A1D22",
  colorSubtleBackgroundSelected: "#202329",
  // Strokes invert the light ramp: stroke1 is the strongest (lightest) line.
  colorNeutralStroke1: "#34383F",
  colorNeutralStroke2: "#26282E", // the hairline
  colorNeutralStroke3: "#1F2126",
  // Night text: fg1 16.2/15.0/13.7 (AAA) on bg1/bg2/bg3; fg2 7.6/7.0/6.4;
  // fg3 5.6/5.2/4.7 - all AA+.
  colorNeutralForeground1: "#ECECEA",
  colorNeutralForeground2: "#A2A2A8",
  colorNeutralForeground3: "#8A8A91",
  // Primary actions: the brighter night amber, still with ink text ON the
  // fill (10.7:1 rest, 11.7 hover, 9.1 pressed). Hover lightens - with dark
  // text on the fill, lighter is MORE contrast, so the dark convention holds.
  colorBrandBackground: "#FFC24D",
  colorBrandBackgroundHover: "#FFCE6E",
  colorBrandBackgroundPressed: "#F0B23A",
  colorBrandBackgroundSelected: "#FFCE6E",
  colorNeutralForegroundOnBrand: "#1B1B1F",
  // colorBrandForeground1/2 stay ramp-derived (100 = #E8A317 at 8.8:1 and
  // 110 = #F5B83C on the night canvas) - amber works as a foreground here.
  // Links: the same quiet blue family, lifted for the night canvas
  // (8.9/8.2/7.5 on bg1/bg2/bg3).
  colorBrandForegroundLink: "#8FB4D9",
  colorBrandForegroundLinkHover: "#A9C6E2",
  colorBrandForegroundLinkPressed: "#79A2C6",
  colorBrandForegroundLinkSelected: "#A9C6E2",
  // Amber focus reads at 11.9:1 against the ink canvas.
  colorStrokeFocus2: "#FFC24D",
};

/**
 * The beam sweep - Beam's one signature gradient: dark ink warming through
 * ember into the lit amber head. Reserved for HERO moments only (onboarding
 * and tour headers, empty states, About, the hero beacon) and never placed
 * behind body content, tables, or text. Pick the variant for the resolved
 * theme (`light` on Paper, `dark` on Ink).
 */
export const BEAM_SWEEP = {
  light: "linear-gradient(120deg, #1B1B1F 0%, #664508 55%, #E8A317 100%)",
  dark: "linear-gradient(120deg, #16181C 0%, #7D5707 55%, #FFC24D 100%)",
} as const;

/**
 * Accents beyond the Fluent tokens, for sparing decorative use. Everything
 * text-bearing must ride theme tokens (which both themes remap and the
 * contrast gate covers); ACCENTS is for glows only. The steel-era members
 * (sky, fills, brass, brandText, surface) were dead code and are gone.
 */
export const ACCENTS = {
  /** The beacon's warm halo (box-shadow glow behind brand dots). Never text. */
  beam: "#E8A317",
} as const;

/** Layout constants shared across the shell. */
export const LAYOUT = {
  /** Width of the expanded file sidebar. */
  sidebarWidth: 360,
  /** Width of the collapsed sidebar (thin icon rail). */
  sidebarCollapsedWidth: 48,
  headerHeight: 56,
} as const;
