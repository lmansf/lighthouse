import { create } from "zustand";
import {
  isAccent,
  isDensity,
  isFontScale,
  type Accent,
  type Density,
  type FontScale,
} from "@/lib/appearanceSpec";

/**
 * Appearance customization (openspec: add-usability-field-patch §3): the curated
 * accent, row density, and font scale. The THEME preset (light/dark/auto) is the
 * separate useThemeStore `mode`. app/providers.tsx reads these + the resolved
 * mode and hands them to `themeFor` (src/shell/theme.ts); the Fluent theme it
 * returns is AA-validated for every accent and never scales a color.
 *
 * Persistence mirrors the §1 explorer width: localStorage for instant, SSR-safe
 * hydration, and the engine settings file (via /api/settings) for durability +
 * so the ask-to-adjust directive's change survives. The engine validates and is
 * the source of truth; the cache just makes first paint correct.
 */
interface Appearance {
  accent: Accent;
  density: Density;
  fontScale: FontScale;
  /**
   * §31 glass intensity, 0 (solid) … 1 (full). CLIENT-side only, like the
   * theme mode: it styles two chrome surfaces and never rides the engine
   * settings file or the appearance directive — the engine/twin whitelist is
   * deliberately untouched (the fence can't express it, by construction).
   * providers.tsx stamps it as --lh-glass-level; the OS Reduce Transparency
   * attribute overrides it to solid regardless.
   */
  glass: number;
}

const DEFAULTS: Appearance = { accent: "amber", density: "comfortable", fontScale: "m", glass: 1 };
const KEY = "lighthouse.appearance";

/** Clamp to the 0..1 slider range; anything non-numeric falls to the default. */
const normGlass = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : DEFAULTS.glass;

function load(): Appearance {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const o = JSON.parse(window.localStorage.getItem(KEY) || "{}") as Record<string, unknown>;
    return {
      accent: isAccent(o.accent) ? o.accent : DEFAULTS.accent,
      density: isDensity(o.density) ? o.density : DEFAULTS.density,
      fontScale: isFontScale(o.fontScale) ? o.fontScale : DEFAULTS.fontScale,
      glass: normGlass(o.glass),
    };
  } catch {
    return DEFAULTS;
  }
}

function save(a: Appearance): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(a));
  } catch {
    /* storage blocked — the in-session choice still applies */
  }
}

interface AppearanceStore extends Appearance {
  /** Merge valid keys, persist to the cache + the settings file, apply live. */
  set: (patch: Partial<Appearance>) => void;
}

export const useAppearanceStore = create<AppearanceStore>((zset, get) => ({
  // SSR-safe initial state (the server renders the amber defaults); the bootstrap
  // below adopts the stored/engine values right after init — see useThemeStore
  // for why the snapshot must match the server render.
  ...DEFAULTS,
  set: (patch) => {
    const cur = get();
    const next: Appearance = {
      accent: isAccent(patch.accent) ? patch.accent : cur.accent,
      density: isDensity(patch.density) ? patch.density : cur.density,
      fontScale: isFontScale(patch.fontScale) ? patch.fontScale : cur.fontScale,
      glass: patch.glass !== undefined ? normGlass(patch.glass) : cur.glass,
    };
    save(next);
    zset(next);
    // Durable persist (desktop settings file) of the ENGINE-whitelisted keys.
    // `glass` stays client-side by design (§31) — the engine whitelist is
    // untouched, so it is not sent rather than sent-and-dropped.
    void fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        appearance: { accent: next.accent, density: next.density, fontScale: next.fontScale },
      }),
    }).catch(() => {
      /* web build / offline — the cache is enough */
    });
  },
}));

// Client bootstrap: adopt the cached values immediately (post-hydration), then
// reconcile with the settings file (the engine's stored, validated value wins).
if (typeof window !== "undefined") {
  useAppearanceStore.setState(load());
  void fetch("/api/settings")
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      const srv = d?.appearance;
      if (!srv || typeof srv !== "object") return;
      const patch: Partial<Appearance> = {};
      if (isAccent(srv.accent)) patch.accent = srv.accent;
      if (isDensity(srv.density)) patch.density = srv.density;
      if (isFontScale(srv.fontScale)) patch.fontScale = srv.fontScale;
      if (Object.keys(patch).length > 0) useAppearanceStore.setState(patch);
    })
    .catch(() => {
      /* offline / web — the cache stands */
    });
}
