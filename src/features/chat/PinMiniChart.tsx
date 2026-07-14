"use client";

import { tokens } from "@fluentui/react-components";
import { formatTick } from "@/lib/chartSpec";
import type { PinChartData } from "@/lib/pinChart";

/**
 * A glanceable before→after mini-chart for the changed-pin alert banner
 * (Phase 2 richer results). It draws ONLY numbers the engine already computed
 * from the verified query result (parsed in src/lib/pinChart.ts), so it never
 * introduces a figure the pin's summary didn't already show. Kept tiny — one
 * faint "before" bar and one solid "after" bar per category, sharing a zero
 * baseline so the change in height is the story. Theme-aware via Fluent tokens.
 */

const BAR_H = 26;
const BAR_W = 6;
const PAIR_GAP = 2;
const GROUP_GAP = 9;
const PAD_X = 2;

export function PinMiniChart({ data }: { data: PinChartData }) {
  const hasBefore = data.before !== null;
  const groupW = hasBefore ? BAR_W * 2 + PAIR_GAP : BAR_W;
  const width = PAD_X * 2 + data.labels.length * groupW + (data.labels.length - 1) * GROUP_GAP;

  // Shared zero-baselined scale across both series so the bars are comparable.
  const values = hasBefore ? [...data.after, ...(data.before ?? [])] : data.after;
  const max = Math.max(1, ...values.map((v) => Math.abs(v)));
  const barH = (v: number) => Math.max(1, (Math.abs(v) / max) * BAR_H);

  const aria = data.labels
    .map((l, i) =>
      hasBefore
        ? `${l}: ${formatTick(data.before?.[i] ?? 0)} to ${formatTick(data.after[i])}`
        : `${l}: ${formatTick(data.after[i])}`,
    )
    .join("; ");

  return (
    <svg
      width={width}
      height={BAR_H + 2}
      viewBox={`0 0 ${width} ${BAR_H + 2}`}
      role="img"
      aria-label={`Before and after: ${aria}`}
      style={{ display: "block", overflow: "visible" }}
    >
      {data.labels.map((label, i) => {
        const gx = PAD_X + i * (groupW + GROUP_GAP);
        const baseline = BAR_H + 1;
        return (
          <g key={`${label}-${i}`}>
            {hasBefore && data.before && (
              <rect
                x={gx}
                y={baseline - barH(data.before[i])}
                width={BAR_W}
                height={barH(data.before[i])}
                rx={1}
                fill={tokens.colorNeutralForeground3}
                fillOpacity={0.35}
              >
                <title>{`${label} — was ${formatTick(data.before[i])}`}</title>
              </rect>
            )}
            <rect
              x={gx + (hasBefore ? BAR_W + PAIR_GAP : 0)}
              y={baseline - barH(data.after[i])}
              width={BAR_W}
              height={barH(data.after[i])}
              rx={1}
              fill={tokens.colorBrandForeground1}
            >
              <title>{`${label} — now ${formatTick(data.after[i])}`}</title>
            </rect>
          </g>
        );
      })}
    </svg>
  );
}
