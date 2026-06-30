"use client";

import { makeStyles, tokens } from "@fluentui/react-components";

/**
 * A gentle water backdrop for the left sidebar: a cool sea-sky "waterline" that
 * swells at the foot of the panel with slow foamy rings rippling across it - the
 * water around the base of the lighthouse, in the Forerunner palette (see
 * theme.ts). It sits BEHIND the file list (absolute, pointer-events: none) and
 * is concentrated in the lower third so the rows above stay perfectly legible.
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
  // A faint brass-lit sheen drifting sideways across the surface - the beacon's
  // reflection on the water.
  sheen: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: "18%",
    height: "90px",
    background:
      "linear-gradient(90deg, transparent 0%, rgba(226,180,83,0.10) 45%, rgba(255,255,255,0.10) 50%, rgba(226,180,83,0.10) 55%, transparent 100%)",
    animationName: {
      from: { transform: "translateX(-30%)" },
      to: { transform: "translateX(30%)" },
    },
    animationDuration: "13s",
    animationTimingFunction: "ease-in-out",
    animationIterationCount: "infinite",
    animationDirection: "alternate",
    "@media (prefers-reduced-motion: reduce)": { animationName: "none" },
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
  ring1: { left: "12%", bottom: "12%" },
  ring2: { left: "52%", bottom: "20%", width: "90px", height: "30px", animationDuration: "11s", animationDelay: "2.5s" },
  ring3: { left: "30%", bottom: "6%", width: "70px", height: "24px", animationDuration: "9.5s", animationDelay: "5s" },
});

export function SidebarWater() {
  const styles = useStyles();
  // tokens import kept for palette alignment if this is themed further; the
  // gradients above mirror the Forerunner blue/brass values from theme.ts.
  void tokens;
  return (
    <div className={styles.root} aria-hidden>
      <div className={styles.water} />
      <div className={styles.sheen} />
      <div className={`${styles.ring} ${styles.ring1}`} />
      <div className={`${styles.ring} ${styles.ring2}`} />
      <div className={`${styles.ring} ${styles.ring3}`} />
    </div>
  );
}
