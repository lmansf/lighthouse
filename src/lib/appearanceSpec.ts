/**
 * Appearance customization whitelist + the ask-to-adjust directive (openspec:
 * add-usability-field-patch §3). This is the SINGLE source of truth for which
 * appearance keys exist and what values they may take — shared by the settings
 * validator (engine + twin), the Preferences UI, and the fenced directive the
 * model can emit to adjust the look on request.
 *
 * The boundary (recorded in design.md §3): only BOUNDED, enum/range-safe keys.
 * No free-form color (a picker can't be guaranteed AA), no custom CSS/theme
 * files (an injection + exfiltration surface), no per-surface images. The
 * directive is a SETTINGS PATCH by construction — it maps only onto these keys
 * and can emit no markup, CSS, or code. Mirrors src/lib/chartSpec.ts in shape
 * (parse → validate → strip); PARITY of the KEYS lives in settings.rs /
 * settings.ts. Pure + DOM-free (test/appearanceSpec.test.mjs runs it in node).
 */

/** Theme preset — the two AA-verified Beam themes, or follow the OS. */
export const THEME_PRESETS = ["beam-light", "beam-dark", "auto"] as const;
export type ThemePreset = (typeof THEME_PRESETS)[number];

/**
 * Curated accent enum. Each value maps to a brand ramp that passes
 * scripts/check-contrast.mjs on BOTH themes (amber is the Beam default). A
 * NAMED set, never free-form hex — see the design boundary above.
 */
export const ACCENTS = ["amber", "teal", "orchid"] as const;
export type Accent = (typeof ACCENTS)[number];

/** Row density — bounded, layout-safe, no contrast interaction. */
export const DENSITIES = ["comfortable", "compact"] as const;
export type Density = (typeof DENSITIES)[number];

/** Font scale — small / medium / large, bounded. */
export const FONT_SCALES = ["s", "m", "l"] as const;
export type FontScale = (typeof FONT_SCALES)[number];

/** The full appearance patch — every key optional. (backgroundImage is a
 *  documented §3 follow-on; it is deliberately NOT part of this whitelist yet.) */
export interface AppearancePatch {
  themePreset?: ThemePreset;
  accent?: Accent;
  density?: Density;
  fontScale?: FontScale;
}

export const isThemePreset = (v: unknown): v is ThemePreset =>
  typeof v === "string" && (THEME_PRESETS as readonly string[]).includes(v);
export const isAccent = (v: unknown): v is Accent =>
  typeof v === "string" && (ACCENTS as readonly string[]).includes(v);
export const isDensity = (v: unknown): v is Density =>
  typeof v === "string" && (DENSITIES as readonly string[]).includes(v);
export const isFontScale = (v: unknown): v is FontScale =>
  typeof v === "string" && (FONT_SCALES as readonly string[]).includes(v);

/**
 * Keep only whitelisted keys carrying a valid enum value; everything else
 * (unknown keys, out-of-vocabulary values, wrong types) is dropped. The engine
 * writer and the directive both funnel through this, so validation can never
 * drift between them. Returns a fresh object (never mutates the input).
 */
export function normalizeAppearance(input: unknown): AppearancePatch {
  const out: AppearancePatch = {};
  if (!input || typeof input !== "object") return out;
  const o = input as Record<string, unknown>;
  if (isThemePreset(o.themePreset)) out.themePreset = o.themePreset;
  if (isAccent(o.accent)) out.accent = o.accent;
  if (isDensity(o.density)) out.density = o.density;
  if (isFontScale(o.fontScale)) out.fontScale = o.fontScale;
  return out;
}

/** PARITY: settings.rs / analytics.rs appearance fence (design.md §3). */
export const APPEARANCE_DIRECTIVE_FENCE = "```lighthouse-appearance-request";

export interface AppearanceDirective {
  /** The valid, whitelisted keys to apply — empty when the block named none. */
  patch: AppearancePatch;
  /** True when a fence WAS present but carried no valid key: a polite refusal,
   *  never a partial apply. False when at least one key is applicable. */
  rejected: boolean;
}

/**
 * Parse the FIRST `lighthouse-appearance-request` fence out of an answer.
 * Returns null when there's no fence (a normal answer) or the block is
 * unparseable JSON. Otherwise returns the whitelisted patch; if the block
 * named ONLY unknown/invalid keys, `rejected` is true so the UI explains and
 * changes nothing. Only the four whitelisted keys are ever read — a fenced
 * block can express nothing else, by construction.
 */
export function parseAppearanceDirective(text: string): AppearanceDirective | null {
  const start = text.indexOf(APPEARANCE_DIRECTIVE_FENCE);
  if (start < 0) return null;
  const after = text.slice(start + APPEARANCE_DIRECTIVE_FENCE.length);
  const end = after.indexOf("```");
  if (end < 0) return null; // unterminated fence — treat as no directive
  let parsed: unknown;
  try {
    parsed = JSON.parse(after.slice(0, end).trim());
  } catch {
    return null;
  }
  const patch = normalizeAppearance(parsed);
  const named = parsed && typeof parsed === "object" ? Object.keys(parsed).length > 0 : false;
  return { patch, rejected: named && Object.keys(patch).length === 0 };
}

/**
 * Belt-and-braces display strip: remove any appearance-request fence (including
 * an unterminated tail) from prose, mirroring stripChartRequestFences. The
 * directive is applied from the raw answer; this only keeps the fence out of
 * what the user reads.
 */
export function stripAppearanceRequestFences(text: string): string {
  return text.replace(/```lighthouse-appearance-request[\s\S]*?(```|$)/g, "");
}
