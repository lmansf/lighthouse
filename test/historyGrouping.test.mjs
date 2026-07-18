// §22.2 History date grouping — the pure, clock-injectable bucketing behind
// the sidebar History section (src/lib/historyGrouping.ts): Today / Yesterday /
// This week / Earlier over LOCAL calendar days, order preserved within a
// bucket, empty buckets omitted. The relative-time row label is covered too.
// The JSX consumer (HistoryNav) is asserted structurally in
// test/historyNavUi.test.mjs; this file exercises the math for real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { groupByRecency, relativeTimeLabel } = await import("../src/lib/historyGrouping.ts");

// A fixed local clock: July 15, 2026, 14:30 local time. Built from Date
// components (never a UTC string) so every assertion is timezone-independent.
const NOW = new Date(2026, 6, 15, 14, 30).getTime();
const local = (...args) => new Date(...args).getTime();
const item = (id, updatedAt) => ({ id, updatedAt });

test("buckets split on LOCAL calendar days: today, yesterday, this week, earlier", () => {
  const groups = groupByRecency(
    [
      item("a", local(2026, 6, 15, 9, 0)), // this morning → Today
      item("b", local(2026, 6, 14, 23, 59)), // last night → Yesterday
      item("c", local(2026, 6, 13, 12, 0)), // two days ago → This week
      item("d", local(2026, 6, 9, 0, 0)), // exactly the 7-day boundary → This week
      item("e", local(2026, 6, 8, 23, 59)), // just past it → Earlier
      item("f", local(2026, 5, 1)), // long ago → Earlier
    ],
    NOW,
  );
  assert.deepEqual(
    groups.map((g) => [g.label, g.items.map((i) => i.id)]),
    [
      ["Today", ["a"]],
      ["Yesterday", ["b"]],
      ["This week", ["c", "d"]],
      ["Earlier", ["e", "f"]],
    ],
  );
});

test("boundaries are midnight-exact: 00:00 today is Today, 23:59 yesterday is Yesterday", () => {
  const groups = groupByRecency(
    [item("midnight", local(2026, 6, 15, 0, 0, 0)), item("lateYesterday", local(2026, 6, 14, 23, 59, 59))],
    NOW,
  );
  assert.deepEqual(
    groups.map((g) => [g.label, g.items.map((i) => i.id)]),
    [
      ["Today", ["midnight"]],
      ["Yesterday", ["lateYesterday"]],
    ],
  );
});

test("empty buckets are omitted and the ladder keeps its fixed order", () => {
  const groups = groupByRecency(
    [item("old", local(2026, 3, 1)), item("fresh", NOW - 60_000)],
    NOW,
  );
  // Only two buckets, and Today still leads Earlier despite input order.
  assert.deepEqual(groups.map((g) => g.label), ["Today", "Earlier"]);
});

test("input order is preserved within a bucket (the caller owns row order)", () => {
  const groups = groupByRecency(
    [item("first", NOW - 3_000), item("second", NOW - 2_000), item("third", NOW - 1_000)],
    NOW,
  );
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].items.map((i) => i.id), ["first", "second", "third"]);
});

test("a future timestamp (clock skew) lands in Today, never an invented bucket", () => {
  const groups = groupByRecency([item("skewed", NOW + 5 * 60_000)], NOW);
  assert.deepEqual(groups.map((g) => g.label), ["Today"]);
});

test("empty input → no groups", () => {
  assert.deepEqual(groupByRecency([], NOW), []);
});

test("relativeTimeLabel: the minutes/hours/days ladder, then a short date", () => {
  assert.equal(relativeTimeLabel(NOW - 20_000, NOW), "just now");
  assert.equal(relativeTimeLabel(NOW - 5 * 60_000, NOW), "5m ago");
  assert.equal(relativeTimeLabel(NOW - 2 * 60 * 60_000, NOW), "2h ago");
  assert.equal(relativeTimeLabel(NOW - 3 * 24 * 60 * 60_000, NOW), "3d ago");
  // Past a week it falls through to the locale's short date, not "Nd ago".
  const old = NOW - 30 * 24 * 60 * 60_000;
  assert.equal(
    relativeTimeLabel(old, NOW),
    new Date(old).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
  );
  assert.doesNotMatch(relativeTimeLabel(old, NOW), /ago/);
});
