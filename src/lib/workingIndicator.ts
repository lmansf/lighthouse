"use client";

/**
 * §52: subtle, honest "working…" feedback primitives — a delay-before-show (so a
 * fast load never flashes a spinner), a JS-side reduced-motion read (the label
 * ROTATION must not animate under it; the Fluent Spinner already respects it in
 * CSS), and the report-generate staged labels (the §22.4 warming-label idiom,
 * client-side). Every label is TRUE — the rotation only signals liveness during
 * a multi-call wait; it is NEVER a fake progress bar. Pure UI; no engine calls.
 */
import { useEffect, useRef, useState } from "react";

/**
 * §52 §3: whether the viewer prefers reduced motion, read on the JS side so the
 * label rotation can freeze (the spinner's own animation is handled in CSS).
 * SSR renders the no-reduction default; the client corrects on mount and tracks
 * live changes.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return reduced;
}

/**
 * §52 §1/§3: true only after `active` has held continuously for `delayMs` (~200ms
 * by default). The delay-before-show avoids a spinner-flash on a fast load — a
 * flash on a 50ms wait is worse than none. Resets the moment `active` clears.
 */
export function useDelayedFlag(active: boolean, delayMs = 200): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    const t = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(t);
  }, [active, delayMs]);
  return shown;
}

/**
 * §52 §2: the report-generate staged labels — honest liveness copy for the long,
 * multi-call wait, byte-pinned. First while the analysis runs, then while the
 * report composes, then the tail. Every string is TRUE of that phase.
 */
export const REPORT_STAGE_LABELS = [
  "Running the analysis…",
  "Composing the report…",
  "Almost ready…",
] as const;

/**
 * §52 §2: the stage label for `elapsedMs` — the §22.4 warming-label idiom
 * (index staged copy by elapsed time). The thresholds are liveness cues for a
 * multi-second wait, NOT a progress bar; the numbers computed by the engine are
 * untouched.
 */
export function reportStageLabel(elapsedMs: number): string {
  if (elapsedMs < 6000) return REPORT_STAGE_LABELS[0];
  if (elapsedMs < 14000) return REPORT_STAGE_LABELS[1];
  return REPORT_STAGE_LABELS[2];
}

/**
 * §52 §2/§3: the live Generate label. While `active`, it rotates through the
 * honest stages as time passes; under reduced motion it holds the FIRST stage
 * statically (no rotation). Idle → the first stage, so a resting button reads
 * honestly. The rotation is a 1s tick — cheap, and cleared on settle.
 */
export function useReportStageLabel(active: boolean): string {
  const reduced = usePrefersReducedMotion();
  const [label, setLabel] = useState<string>(REPORT_STAGE_LABELS[0]);
  const startRef = useRef(0);
  useEffect(() => {
    // Under reduced motion (or idle) the label is the first honest stage, static.
    if (!active || reduced) {
      setLabel(REPORT_STAGE_LABELS[0]);
      return;
    }
    startRef.current = Date.now();
    setLabel(reportStageLabel(0));
    const id = setInterval(() => {
      setLabel(reportStageLabel(Date.now() - startRef.current));
    }, 1000);
    return () => clearInterval(id);
  }, [active, reduced]);
  return label;
}
