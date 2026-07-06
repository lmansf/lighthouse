/**
 * "Coming soon" features — teasers a user can register interest in before the
 * real thing ships. Registering interest does two things, always together:
 *
 *   1. logs a telemetry event ("coming_soon_interest", { feature }) through the
 *      normal pipeline (POST /api/event → the hosted `events` table), so the
 *      TRUE, cross-user ranking can be computed server-side later; and
 *   2. bumps a LOCAL, per-device tally in localStorage that powers the in-app
 *      Experiments leaderboard.
 *
 * Why the in-app board is local: the desktop app can't read the hosted events
 * table back, so the leaderboard it shows reflects THIS device's clicks — an
 * immediate, personal signal — while the logged events feed the real aggregate.
 * The two never diverge: every click does both. (To build the cross-user board
 * later, query the events table for name = "coming_soon_interest" grouped by
 * props.feature.)
 */
import { logEvent } from "@/lib/logEvent";

export interface ComingSoonFeature {
  /** Stable id — the telemetry `feature` prop and the localStorage tally key. */
  id: string;
  /** Human label shown in the menu badge and the leaderboard. */
  label: string;
  /** One-line pitch shown under the label on the leaderboard. */
  blurb: string;
}

/**
 * The teaser registry. Add an entry here to float a new "coming soon" feature;
 * it appears on the leaderboard immediately (at zero) and can be wired to any
 * button via {@link recordInterest}. SharePoint is first.
 */
export const COMING_SOON_FEATURES: ComingSoonFeature[] = [
  {
    id: "sharepoint",
    label: "SharePoint & OneDrive",
    blurb: "Pull in files from Microsoft 365 and search them alongside your vault.",
  },
];

/** The telemetry event name every interest click emits. */
export const INTEREST_EVENT = "coming_soon_interest";

/** localStorage key for the per-device interest tally ({ [featureId]: count }). */
const COUNTS_KEY = "lighthouse.comingSoon.counts";

/** Broadcast so an open leaderboard refreshes the instant a vote lands. */
export const CHANGED_EVENT = "lighthouse:coming-soon-changed";

export function featureById(id: string): ComingSoonFeature | undefined {
  return COMING_SOON_FEATURES.find((f) => f.id === id);
}

function readCounts(): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(COUNTS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      // Ignore anything that isn't a clean non-negative count (corrupt/foreign).
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = Math.floor(v);
    }
    return out;
  } catch {
    return {};
  }
}

function writeCounts(counts: Record<string, number>): void {
  try {
    window.localStorage.setItem(COUNTS_KEY, JSON.stringify(counts));
  } catch {
    /* private mode / storage full — the in-session tally still updates */
  }
}

/**
 * Register interest in a coming-soon feature: log the telemetry event (hosted
 * aggregate) and bump the local per-device tally (leaderboard). Returns the new
 * local count. Best-effort by design — never throws, so callers can wire it
 * straight to an onClick.
 */
export function recordInterest(id: string): number {
  logEvent(INTEREST_EVENT, { feature: id });
  const counts = readCounts();
  const next = (counts[id] ?? 0) + 1;
  counts[id] = next;
  writeCounts(counts);
  try {
    window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
  } catch {
    /* SSR / no window — nothing is listening anyway */
  }
  return next;
}

export interface LeaderboardEntry extends ComingSoonFeature {
  count: number;
}

/**
 * Every registered feature ranked by local interest, most-wanted first. Ties
 * keep registry order (JS sort is stable), and zero-count features still show —
 * so the board is populated and honest before the first click.
 */
export function getLeaderboard(): LeaderboardEntry[] {
  const counts = readCounts();
  return COMING_SOON_FEATURES.map((f) => ({ ...f, count: counts[f.id] ?? 0 })).sort(
    (a, b) => b.count - a.count,
  );
}
