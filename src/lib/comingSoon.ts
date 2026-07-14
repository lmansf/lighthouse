/**
 * "Coming soon" features — teasers a user can register interest in before the
 * real thing ships. Registering interest bumps a LOCAL, per-device tally in
 * localStorage that powers the in-app Experiments leaderboard. This is
 * local-only: the tally never leaves localStorage, and nothing is transmitted.
 */

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
 * Register interest in a coming-soon feature: bump the local per-device tally
 * (leaderboard) and return the new count. Local-only — nothing leaves the
 * machine. Best-effort by design — never throws, so callers can wire it
 * straight to an onClick.
 */
export function recordInterest(id: string): number {
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
