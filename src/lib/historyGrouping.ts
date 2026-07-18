/**
 * §22.2: date grouping for the History section — the ChatGPT-style Today /
 * Yesterday / This week / Earlier buckets over saved conversations.
 *
 * Pure and clock-injectable (like pruneByAge / askTypeahead): buckets are
 * LOCAL calendar days anchored on the injected `now`, so "Today" flips at the
 * user's midnight, not UTC's, and the unit tests pin exact boundaries without
 * waiting for one. Input order is preserved within each bucket — the caller
 * decides the row order (newest-first, current context first); this module
 * only slices time. Client-only by construction (chat history is UI state —
 * see useChatStore); there is no Rust twin.
 */

/** The fixed bucket ladder, rendered top-to-bottom in this order. */
export type HistoryGroupLabel = "Today" | "Yesterday" | "This week" | "Earlier";

export interface HistoryGroup<T> {
  label: HistoryGroupLabel;
  items: T[];
}

/** Local midnight of the day containing `ts` — the calendar-day anchor. */
function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Bucket items by how recently they were touched, judged by `updatedAt`
 * against the injected clock:
 *
 *  - Today:     the current local calendar day (future timestamps — clock
 *               skew — land here too rather than inventing a bucket);
 *  - Yesterday: the previous local calendar day;
 *  - This week: within the last 7 calendar days (before yesterday);
 *  - Earlier:   everything older.
 *
 * Buckets always come back in that fixed order; empty buckets are omitted.
 * Within a bucket the input order is preserved.
 */
export function groupByRecency<T extends { updatedAt: number }>(
  items: readonly T[],
  now: number = Date.now(),
): HistoryGroup<T>[] {
  const today = startOfDay(now);
  // Calendar-day arithmetic via Date so a DST shift can't misplace a boundary.
  const daysAgo = (n: number): number => {
    const d = new Date(today);
    d.setDate(d.getDate() - n);
    return d.getTime();
  };
  const yesterday = daysAgo(1);
  const weekAgo = daysAgo(6);

  const buckets: Record<HistoryGroupLabel, T[]> = {
    Today: [],
    Yesterday: [],
    "This week": [],
    Earlier: [],
  };
  for (const item of items) {
    const ts = item.updatedAt;
    if (ts >= today) buckets.Today.push(item);
    else if (ts >= yesterday) buckets.Yesterday.push(item);
    else if (ts >= weekAgo) buckets["This week"].push(item);
    else buckets.Earlier.push(item);
  }
  const order: HistoryGroupLabel[] = ["Today", "Yesterday", "This week", "Earlier"];
  return order
    .filter((label) => buckets[label].length > 0)
    .map((label) => ({ label, items: buckets[label] }));
}

/**
 * Compact "how long ago" for a history row ("just now", "3m ago", "2h ago",
 * "4d ago", then a short date). The clock is injectable for tests; the
 * fall-through date uses the runtime locale like the rest of the UI.
 */
export function relativeTimeLabel(ts: number, now: number = Date.now()): string {
  const min = Math.round((now - ts) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
