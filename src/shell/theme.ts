import {
  createDarkTheme,
  createLightTheme,
  type BrandVariants,
  type Theme,
} from "@fluentui/react-components";
import type { Accent, Density, FontScale } from "@/lib/appearanceSpec";

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
 * Platform-native UI text: San Francisco FIRST on Apple platforms
 * (-apple-system must outrank any named family or WebKit falls back), then the
 * honest platform defaults — system-ui, Segoe UI on Windows, Roboto on
 * Linux/Android. §31 dropped "Segoe UI Variable" from the front so SF wins on
 * every Apple build; Windows/Linux keep their native faces BY DESIGN (one calm
 * product, no platform cosplay). Mirrored by app/globals.css for the
 * pre-hydration frame; keep the two lists identical.
 */
const FONT_STACK =
  '-apple-system, system-ui, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';

/**
 * The HIG type scale (§31), mapped monotonically onto Fluent's size slots and
 * expressed in REM so every size rides the root font-size. app/globals.css
 * hooks the root to `font: -apple-system-body` where WebKit supports it (iOS
 * Dynamic Type — the user's text-size setting scales the whole app) and to
 * 106.25% (17px) elsewhere, so 1rem = the 17pt HIG Body everywhere and an
 * explicit px never severs the Dynamic Type link. Fluent's own px defaults are
 * fully overridden — every consumer of the type tokens lands on this scale:
 *
 *   Base200 → Footnote 13/18  ·  Base300 → Body 17/22 (THE body)
 *   Base400 → Title3 20/25    ·  Base500 → Title2 22/28
 *   Base600 → Title1 28/34    ·  Hero700 → Large Title 34/41
 *   Base100 → Caption 12/16 (nothing renders under 11pt)
 *
 * Subhead 15/20 has no Fluent slot; it lives as --lh-type-subhead in
 * globals.css for hand-rolled styles. Weights stay regular/medium/semibold/
 * bold — Fluent's 400/500/600/700 already match the HIG set.
 */
const rem = (px: number) => `${Math.round((px / 17) * 10000) / 10000}rem`;
const TYPE_TOKENS = {
  fontSizeBase100: rem(12),
  fontSizeBase200: rem(13),
  fontSizeBase300: rem(17),
  fontSizeBase400: rem(20),
  fontSizeBase500: rem(22),
  fontSizeBase600: rem(28),
  fontSizeHero700: rem(34),
  fontSizeHero800: rem(40),
  fontSizeHero900: rem(48),
  fontSizeHero1000: rem(68),
  lineHeightBase100: rem(16),
  lineHeightBase200: rem(18),
  lineHeightBase300: rem(22),
  lineHeightBase400: rem(25),
  lineHeightBase500: rem(28),
  lineHeightBase600: rem(34),
  lineHeightHero700: rem(41),
  lineHeightHero800: rem(48),
  lineHeightHero900: rem(58),
  lineHeightHero1000: rem(82),
} as const;

/**
 * §31 shadows: depth comes from layering and hairline rings, not dark smears.
 * "Rest" is a hairline ring + a whisper of ambient; "raised" adds the
 * near-invisible 8/24 ambient (sheets/menus float a touch stronger on Ink,
 * where the elevated surface color itself carries most of the depth).
 */
const PAPER_SHADOW_REST =
  "0 0 0 0.5px rgba(27, 27, 31, 0.06), 0 1px 2px rgba(27, 27, 31, 0.04)";
const PAPER_SHADOW_RAISED =
  "0 0 0 0.5px rgba(27, 27, 31, 0.05), 0 8px 24px rgba(27, 27, 31, 0.08)";
const INK_SHADOW_REST =
  "0 0 0 0.5px rgba(236, 236, 234, 0.07), 0 1px 2px rgba(0, 0, 0, 0.30)";
const INK_SHADOW_RAISED =
  "0 0 0 0.5px rgba(236, 236, 234, 0.08), 0 8px 24px rgba(0, 0, 0, 0.45)";

/**
 * §31 radius scale: controls 8, cards 12, floating surfaces 16 (sheets ride
 * the 26pt top radius + capsule(999) via the --lh-radius-* vars in
 * app/globals.css — Fluent has no slots for those two). The concentric rule
 * (child = parent − gap) is the --lh-radius-concentric helper there.
 */
const RADII = {
  borderRadiusMedium: "8px",
  borderRadiusLarge: "12px",
  borderRadiusXLarge: "16px",
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
  ...TYPE_TOKENS,
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
  ...TYPE_TOKENS,
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
 * Curated accents (openspec: add-usability-field-patch §3). Amber is the Beam
 * default (the themes above); teal and orchid are alternative brand hues, each
 * a full set of brand-token overrides whose values PASS scripts/check-contrast
 * on BOTH themes (the same pairings amber clears — button text on fill, brand
 * text on tint, marks/focus vs canvas). NO free-form color: the enum is the
 * whole surface (src/lib/appearanceSpec.ts). Hover/pressed LIGHTEN on the paper
 * fills (dark ink text needs more luminance, not less — the amber theme has the
 * headroom to darken; these hues do not).
 */
type BrandTokens = {
  colorBrandBackground: string;
  colorBrandBackgroundHover: string;
  colorBrandBackgroundPressed: string;
  colorBrandBackgroundSelected: string;
  colorBrandBackground2: string;
  colorBrandBackground2Hover: string;
  colorBrandForeground1: string;
  colorBrandForeground2: string;
  colorBrandStroke1: string;
  colorCompoundBrandBackground: string;
  colorCompoundBrandBackgroundHover: string;
  colorCompoundBrandBackgroundPressed: string;
  colorCompoundBrandForeground1: string;
  colorCompoundBrandStroke: string;
  colorStrokeFocus2: string;
};
const brandTokens = (a: {
  brand: string;
  brandHover: string;
  brandPressed: string;
  mark: string;
  brandText: string;
  brandTint: string;
  brandTintHover: string;
  compound: string;
  compoundHover: string;
  compoundPressed: string;
  focus: string;
}): BrandTokens => ({
  colorBrandBackground: a.brand,
  colorBrandBackgroundHover: a.brandHover,
  colorBrandBackgroundPressed: a.brandPressed,
  colorBrandBackgroundSelected: a.brandHover,
  colorBrandBackground2: a.brandTint,
  colorBrandBackground2Hover: a.brandTintHover,
  colorBrandForeground1: a.mark,
  colorBrandForeground2: a.brandText,
  colorBrandStroke1: a.mark,
  colorCompoundBrandBackground: a.compound,
  colorCompoundBrandBackgroundHover: a.compoundHover,
  colorCompoundBrandBackgroundPressed: a.compoundPressed,
  colorCompoundBrandForeground1: a.mark,
  colorCompoundBrandStroke: a.mark,
  colorStrokeFocus2: a.focus,
});

// Validated by scripts/check-contrast.mjs (accent section). Keep the two in sync.
const ACCENT_THEMES: Record<Exclude<Accent, "amber">, { light: BrandTokens; dark: BrandTokens }> = {
  teal: {
    light: brandTokens({
      brand: "#12A594", brandHover: "#17B8A6", brandPressed: "#14AE9E", mark: "#0B7A6F",
      brandText: "#0A6A60", brandTint: "#E8F7F4", brandTintHover: "#D3F0EB", compound: "#0E9184",
      compoundHover: "#0B7A6F", compoundPressed: "#095F57", focus: "#0B7A6F",
    }),
    dark: brandTokens({
      brand: "#2CD4C0", brandHover: "#53E0D0", brandPressed: "#24B4A3", mark: "#2CD4C0",
      brandText: "#53E0D0", brandTint: "#08211E", brandTintHover: "#0B4A43", compound: "#2CD4C0",
      compoundHover: "#53E0D0", compoundPressed: "#22B0A0", focus: "#2CD4C0",
    }),
  },
  orchid: {
    light: brandTokens({
      brand: "#C264C6", brandHover: "#CE7BD2", brandPressed: "#C972CD", mark: "#943F98",
      brandText: "#833A87", brandTint: "#F9ECFA", brandTintHover: "#F1D9F2", compound: "#B453B8",
      compoundHover: "#9C3FA0", compoundPressed: "#823585", focus: "#943F98",
    }),
    dark: brandTokens({
      brand: "#E29BE6", brandHover: "#ECB6EF", brandPressed: "#D486D8", mark: "#E29BE6",
      brandText: "#ECB6EF", brandTint: "#241026", brandTintHover: "#4A2A4D", compound: "#E29BE6",
      compoundHover: "#ECB6EF", compoundPressed: "#D07FD4", focus: "#E29BE6",
    }),
  },
};

/** Scale a theme's text (font size + line height) and/or vertical spacing tokens
 *  by a factor — the mechanism behind fontScale (openspec §3) and density.
 *  Type tokens are rem (§31 — they ride the Dynamic-Type root) and spacing is
 *  px; both units scale, everything else passes through untouched. The two
 *  factors COMPOSE with Dynamic Type: rem × root size × fontScale. */
function scaleTheme(theme: Theme, fontFactor: number, spaceFactor: number): Theme {
  if (fontFactor === 1 && spaceFactor === 1) return theme;
  const next: Record<string, string> = { ...(theme as unknown as Record<string, string>) };
  const scaleLength = (v: string, f: number): string => {
    if (typeof v !== "string") return v;
    const unit = v.endsWith("rem") ? "rem" : v.endsWith("px") ? "px" : null;
    if (!unit) return v;
    const n = parseFloat(v);
    if (!Number.isFinite(n) || n === 0) return v;
    return `${Math.round(n * f * 10000) / 10000}${unit}`;
  };
  for (const key of Object.keys(next)) {
    if (/^(fontSizeBase|fontSizeHero|lineHeight)/.test(key)) next[key] = scaleLength(next[key], fontFactor);
    else if (/^spacingVertical/.test(key)) next[key] = scaleLength(next[key], spaceFactor);
  }
  return next as unknown as Theme;
}

const FONT_FACTOR: Record<FontScale, number> = { s: 0.92, m: 1, l: 1.12 };
const SPACE_FACTOR: Record<Density, number> = { comfortable: 1, compact: 0.82 };

/**
 * The Fluent theme for a resolved light/dark mode plus the user's appearance
 * choices (openspec §3). Accent swaps the brand tokens (amber = the base
 * themes); fontScale/density scale the text + spacing tokens. Every result
 * still clears the contrast gate — accents are AA-validated and scaling never
 * touches a color. app/providers.tsx calls this.
 */
export function themeFor(
  resolved: "light" | "dark",
  accent: Accent = "amber",
  density: Density = "comfortable",
  fontScale: FontScale = "m",
): Theme {
  const base = resolved === "dark" ? darkLighthouseTheme : lighthouseTheme;
  const withAccent =
    accent === "amber" ? base : { ...base, ...ACCENT_THEMES[accent][resolved] };
  return scaleTheme(withAccent, FONT_FACTOR[fontScale], SPACE_FACTOR[density]);
}

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
  /** Width of the expanded file sidebar (the default until the user drags it). */
  sidebarWidth: 360,
  /** Width of the collapsed sidebar (thin icon rail). */
  sidebarCollapsedWidth: 48,
  headerHeight: 56,
  /**
   * Resizable-explorer drag bounds (openspec: add-usability-field-patch §1).
   * A client-safe mirror of the engine's clamp — the authoritative copy lives
   * in `src/server/settings.ts` (EXPLORER_WIDTH_MIN/MAX) and `settings.rs`, but
   * those pull `node:fs`, so a "use client" surface can't import them. Keep the
   * three in sync. PARITY: EXPLORER_WIDTH_MIN / EXPLORER_WIDTH_MAX.
   */
  sidebarMinWidth: 200,
  sidebarMaxWidth: 720,
} as const;
