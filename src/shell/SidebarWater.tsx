"use client";

import { useEffect, useState } from "react";
import { makeStyles, mergeClasses, shorthands } from "@fluentui/react-components";
import { useThemeStore } from "@/stores/useThemeStore";

/**
 * A gentle water backdrop for the left sidebar: a cool sea-sky "waterline" that
 * swells at the foot of the panel with slow foamy rings rippling across it - the
 * water around the base of the lighthouse, in the Forerunner palette (see
 * theme.ts). It sits BEHIND the file list (absolute, pointer-events: none) and
 * is concentrated in the lower third so the rows above stay perfectly legible.
 *
 * The wash is translucent rgba over the theme canvas; Fluent tokens carry no
 * alpha variants, so the tints are hardcoded here mirroring the Forerunner
 * ramp in theme.ts, with a dark variant swapped in off the resolved theme
 * (moonlit sky blues at lower opacity, so it stays a whisper at night).
 *
 * Motion is slow and low-contrast, and fully disabled under
 * `prefers-reduced-motion: reduce`.
 */
const useStyles = makeStyles({
  root: {
    position: "absolute",
    inset: 0,
    overflow: "hidden",
    pointerEvents: "none",
    zIndex: 0,
  },
  // The water itself: a cool blue wash rising from the bottom, fading out before
  // it reaches the file list. A slow vertical swell gives it life.
  water: {
    position: "absolute",
    left: "-10%",
    right: "-10%",
    bottom: 0,
    height: "46%",
    background:
      "linear-gradient(to top, rgba(26,122,192,0.20) 0%, rgba(21,99,156,0.09) 45%, rgba(21,99,156,0.02) 80%, transparent 100%)",
    animationName: {
      "0%, 100%": { transform: "translateY(0)" },
      "50%": { transform: "translateY(-6px)" },
    },
    animationDuration: "9s",
    animationTimingFunction: "ease-in-out",
    animationIterationCount: "infinite",
    "@media (prefers-reduced-motion: reduce)": { animationName: "none" },
  },
  // Dark-mode water: same shape, tinted with the lighter sky blues from the
  // dark ramp (brand 110, #63AFE0) at lower opacity - moonlight on the water
  // rather than a daytime wash, so the night-steel canvas stays calm.
  waterDark: {
    background:
      "linear-gradient(to top, rgba(99,175,224,0.12) 0%, rgba(99,175,224,0.05) 45%, rgba(99,175,224,0.015) 80%, transparent 100%)",
  },
  // Foamy white rings expanding and fading on the surface.
  ring: {
    position: "absolute",
    width: "120px",
    height: "40px",
    borderRadius: "50%",
    border: "1.5px solid rgba(255,255,255,0.55)",
    opacity: 0,
    animationName: {
      "0%": { transform: "scale(0.4)", opacity: 0 },
      "25%": { opacity: 0.5 },
      "100%": { transform: "scale(1.4)", opacity: 0 },
    },
    animationDuration: "8s",
    animationTimingFunction: "ease-out",
    animationIterationCount: "infinite",
    "@media (prefers-reduced-motion: reduce)": { animationName: "none", opacity: 0.18 },
  },
  // Dark-mode foam: pale sky blue (brand 130, #A6D3F0) instead of white, and
  // dimmer both animated and static - full-strength white rings would glare
  // against the dark steel.
  ringDark: {
    ...shorthands.borderColor("rgba(166,211,240,0.28)"),
    "@media (prefers-reduced-motion: reduce)": { opacity: 0.1 },
  },
  ring1: { left: "12%", bottom: "12%" },
  ring2: { left: "52%", bottom: "20%", width: "90px", height: "30px", animationDuration: "11s", animationDelay: "2.5s" },
  ring3: { left: "30%", bottom: "6%", width: "70px", height: "24px", animationDuration: "9.5s", animationDelay: "5s" },
  // Freeze every ripple while the window is in the background — decorative
  // compositor work shouldn't run when the app isn't even on screen.
  paused: { animationPlayState: "paused" },
});

export function SidebarWater() {
  const styles = useStyles();
  const dark = useThemeStore((s) => s.resolved) === "dark";
  // Pause the ripples when the window is blurred / hidden, so the three infinite
  // animations don't keep the compositor busy while the app is in the
  // background (they resume the moment it's focused again).
  const [animate, setAnimate] = useState(true);
  useEffect(() => {
    const sync = () => setAnimate(!document.hidden && document.hasFocus());
    sync();
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);
  const paused = !animate && styles.paused;
  // mergeClasses (not string concat) so the dark overrides reliably win the
  // Griffel property conflicts against the base water/ring styles.
  return (
    <div className={styles.root} aria-hidden>
      <div className={mergeClasses(styles.water, dark && styles.waterDark, paused)} />
      <div className={mergeClasses(styles.ring, styles.ring1, dark && styles.ringDark, paused)} />
      <div className={mergeClasses(styles.ring, styles.ring2, dark && styles.ringDark, paused)} />
      <div className={mergeClasses(styles.ring, styles.ring3, dark && styles.ringDark, paused)} />
    </div>
  );
}
