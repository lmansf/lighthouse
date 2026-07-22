"use client";

import { useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Button, Text, Tooltip, makeStyles, tokens } from "@fluentui/react-components";
import { IconCheck, IconDownload } from "@/shell/icons";
import {
  detectGranularity,
  formatTick,
  formatXTick,
  niceTicks,
  scaleLinear,
  type ChartSpec,
} from "@/lib/chartSpec";

/**
 * Theme-aware SVG chart for analytics answers (Phase C). The spec arrives in a
 * ```lighthouse-chart fence rendered by the engine from the VERIFIED query
 * result — this component only draws; it never derives numbers. Colors ride
 * Fluent design tokens so light/dark theming is automatic.
 */

const W = 520;
const H = 220;
const MARGIN = { top: 12, right: 12, bottom: 34, left: 48 };

const useStyles = makeStyles({
  frame: {
    position: "relative",
    marginTop: tokens.spacingVerticalS,
    marginBottom: tokens.spacingVerticalS,
    maxWidth: `${W}px`,
    ":hover .lh-chart-png": { opacity: 1 },
    ":focus-within .lh-chart-png": { opacity: 1 },
  },
  svg: {
    width: "100%",
    height: "auto",
    display: "block",
    // Axis tick labels are number surfaces: lining digits keep ticks aligned.
    "& text": { fontVariantNumeric: "tabular-nums" },
  },
  // Hover-revealed download affordance, mirroring the tables' Copy CSV button.
  pngBtn: {
    position: "absolute",
    top: "0px",
    right: "0px",
    opacity: 0,
    // Touch can't hover to reveal the PNG-export button; show it on no-hover.
    "@media (hover: none)": { opacity: 1 },
    transitionProperty: "opacity",
    transitionDuration: tokens.durationFast, // 150ms ease-out (Beam standard)
    transitionTimingFunction: tokens.curveDecelerateMid,
    backgroundColor: tokens.colorNeutralBackground1,
    "@media (prefers-reduced-motion: reduce)": { transitionDuration: "0.01ms" },
  },
  legend: {
    display: "flex",
    gap: tokens.spacingHorizontalM,
    flexWrap: "wrap",
    marginTop: tokens.spacingVerticalXXS,
  },
  legendItem: {
    display: "inline-flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  swatch: { width: "10px", height: "10px", borderRadius: "2px", display: "inline-block" },
  // Directed-chart heading (chart-directive): small, quiet, above the plot.
  title: {
    display: "block",
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    marginBottom: tokens.spacingVerticalXXS,
  },
  // Bucketing disclosure (charts by default): quieter than the title —
  // muted small text under the title slot, existing tokens only.
  subtitle: {
    display: "block",
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    marginBottom: tokens.spacingVerticalXXS,
  },
});

/**
 * Series palette from the theme — the Beam amber leads; the two companions
 * are quiet by design (the slate link hue and the secondary ink), so a chart
 * carries one accent, not three. All ride tokens (auto light/dark) and clear
 * WCAG 1.4.11's 3:1 non-text bar against the answer-card surface in BOTH
 * themes: light 3.99 / 5.49 / 6.55, dark 8.84 / 8.85 / 7.55 vs bg1 — gated by
 * the "chart series" rows in scripts/check-contrast.mjs. Cycles if the engine
 * ever sends more series.
 */
const SERIES_FILLS = [
  tokens.colorBrandForeground1,
  tokens.colorBrandForegroundLink,
  tokens.colorNeutralForeground2,
];

function truncateLabel(l: string): string {
  return l.length > 10 ? `${l.slice(0, 9)}…` : l;
}

/**
 * Clone the rendered chart SVG with its theme resolved for standalone use:
 * the chart's colors are Fluent CSS variables that a detached SVG document
 * can't resolve, so each element's computed fill/stroke is baked into the
 * clone, along with explicit dimensions and the app font. Shared by the PNG
 * download and the evidence pack's inline-SVG capture. Client-only.
 */
function bakeStandaloneSvg(svg: SVGSVGElement): SVGSVGElement {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const orig = svg.querySelectorAll<SVGElement>("*");
  const copies = clone.querySelectorAll<SVGElement>("*");
  orig.forEach((el, i) => {
    const cs = window.getComputedStyle(el);
    const copy = copies[i];
    if (!copy) return;
    if (el.hasAttribute("fill") || el instanceof SVGTextElement) {
      copy.setAttribute("fill", cs.fill);
    }
    if (el.hasAttribute("stroke")) copy.setAttribute("stroke", cs.stroke);
  });
  clone.setAttribute("width", String(W));
  clone.setAttribute("height", String(H));
  // The on-screen labels inherit the app font from CSS the standalone SVG
  // won't have — bake it in so it doesn't render in the UA serif.
  clone.style.fontFamily = window.getComputedStyle(svg).fontFamily;
  return clone;
}

/** Nearest opaque ancestor background = the theme surface behind the chart. */
function surfaceColorBehind(svg: SVGSVGElement): string {
  for (let el: Element | null = svg; el; el = el.parentElement) {
    const c = window.getComputedStyle(el).backgroundColor;
    if (c && c !== "transparent" && !c.startsWith("rgba(0, 0, 0, 0)")) {
      return c;
    }
  }
  return "#ffffff";
}

/**
 * Serialize the rendered chart as a fully self-contained SVG string for the
 * evidence pack (openspec Beam §2): theme colors + font baked in, plus the
 * surface background painted as a backing rect — so a chart captured from a
 * dark-themed app stays legible on the pack's page (mirrors the PNG path's
 * canvas fill). No external references of any kind ride along.
 */
export function standaloneChartSvg(svg: SVGSVGElement): string {
  const clone = bakeStandaloneSvg(svg);
  const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rect.setAttribute("x", "0");
  rect.setAttribute("y", "0");
  rect.setAttribute("width", String(W));
  rect.setAttribute("height", String(H));
  rect.setAttribute("fill", surfaceColorBehind(svg));
  clone.insertBefore(rect, clone.firstChild);
  return new XMLSerializer().serializeToString(clone);
}

/**
 * Rasterize the rendered SVG to a 2× PNG and trigger a download
 * (openspec: add-answer-artifacts). The clone rides `bakeStandaloneSvg` and
 * the canvas is painted with the surface's background first so a dark-mode
 * chart never exports transparent-on-dark. Client-only.
 */
function downloadChartPng(svg: SVGSVGElement): void {
  const clone = bakeStandaloneSvg(svg);
  const bg = surfaceColorBehind(svg);
  const xml = new XMLSerializer().serializeToString(clone);
  const svgUrl = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml;charset=utf-8" }));
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(svgUrl);
    const canvas = document.createElement("canvas");
    canvas.width = W * 2;
    canvas.height = H * 2;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "lighthouse-chart.png";
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }, "image/png");
  };
  img.onerror = () => URL.revokeObjectURL(svgUrl);
  img.src = svgUrl;
}

export function AnalyticsChart({ spec }: { spec: ChartSpec }) {
  const styles = useStyles();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [exported, setExported] = useState(false);
  // fp3 §2: tap-to-reveal a datapoint tooltip on touch. Native SVG <title> only
  // shows on hover / long-press, so a plain tap on a phone/iPad reveals nothing.
  // ONE delegated handler reads whichever datapoint (circle/rect) was tapped —
  // reusing its existing <title> text — and toggles an overlay label; hover
  // (mouse / iPad trackpad) keeps the native <title>, untouched. Tapping the
  // same point again, or the chart background, dismisses it.
  const [tap, setTap] = useState<{ tx: number; ty: number; text: string } | null>(null);
  const onChartTap = (e: ReactMouseEvent<SVGSVGElement>) => {
    const shape = (e.target as Element).closest("circle, rect") as SVGElement | null;
    const text = shape?.querySelector("title")?.textContent ?? "";
    if (!shape || !text) {
      setTap(null);
      return;
    }
    const cx = shape.getAttribute("cx");
    const cy = shape.getAttribute("cy");
    let tx: number;
    let ty: number;
    if (cx !== null && cy !== null) {
      tx = Number(cx);
      ty = Number(cy);
    } else {
      // a bar rect: anchor at the top-center of the bar
      tx = Number(shape.getAttribute("x") ?? 0) + Number(shape.getAttribute("width") ?? 0) / 2;
      ty = Number(shape.getAttribute("y") ?? 0);
    }
    setTap((prev) => (prev && prev.text === text ? null : { tx, ty, text }));
  };
  const inner = { w: W - MARGIN.left - MARGIN.right, h: H - MARGIN.top - MARGIN.bottom };

  const isStacked = spec.kind === "bar" && spec.stacked === true;
  const isScatter = spec.kind === "scatter";
  const isBand = spec.kind === "band";
  // A band's shaded interval must fit the axis, so its lower/upper bounds extend
  // the Y domain alongside the line's values (add-quant-depth).
  const bandBounds = isBand
    ? spec.series.flatMap((s) => [...(s.lower ?? []), ...(s.upper ?? [])])
    : [];
  const all = [...spec.series.flatMap((s) => s.values), ...bandBounds].filter(
    (v): v is number => v !== null,
  );
  // Per-category stack sums (only meaningful when stacked; parts are ≥0 by the
  // engine's is_stackable proof, so the sum is the true top of the bar).
  const stackSums = isStacked
    ? spec.x.map((_, i) => spec.series.reduce((acc, s) => acc + (s.values[i] ?? 0), 0))
    : [];
  // Y domain is KIND-AWARE: stacked → [0, max stack]; bar/area keep the forced-
  // zero baseline; line/scatter fit the data (a scatter near 50k shouldn't
  // waste the axis on an unused zero).
  const [yMin, yMax] = isStacked
    ? [0, Math.max(0, ...stackSums)]
    : spec.kind === "line" || isScatter || isBand
      ? [Math.min(...all), Math.max(...all)]
      : [Math.min(0, ...all), Math.max(0, ...all)];
  const ticks = niceTicks(yMin, yMax, 4);
  const y = scaleLinear(ticks[0], ticks[ticks.length - 1], MARGIN.top + inner.h, MARGIN.top);
  const n = spec.x.length;
  const band = inner.w / n;
  const xCenter = (i: number) => MARGIN.left + band * i + band / 2;
  // Crowded axes: label every k-th category so text never overlaps.
  const labelEvery = n > 16 ? 3 : n > 8 ? 2 : 1;
  // Temporal labels get granularity-aware formatting (e.g. "2024-07" → "Jul").
  const granularity = isScatter ? "numeric" : detectGranularity(spec.x);

  // Scatter uses a NUMERIC x-scale over its own niced domain + bottom ticks.
  const xv = spec.xValues ?? [];
  const finiteXv = xv.filter((v) => Number.isFinite(v));
  const xTicks = isScatter ? niceTicks(Math.min(...finiteXv), Math.max(...finiteXv), 4) : [];
  const xScale = isScatter
    ? scaleLinear(xTicks[0], xTicks[xTicks.length - 1], MARGIN.left, W - MARGIN.right)
    : null;

  const aria = `${spec.kind} chart of ${spec.series.map((s) => s.name).join(", ")} across ${n} ${
    isScatter ? "points" : spec.kind === "bar" ? "categories" : "points"
  }`;

  return (
    <figure className={styles.frame} aria-label={aria}>
      {/* Engine-capped display copy from a chart directive — never data. */}
      {spec.title && (
        <Text as="span" className={styles.title}>
          {spec.title}
        </Text>
      )}
      {/* Emitter-computed bucketing disclosure (top-N + “Other”) — never data. */}
      {spec.subtitle && (
        <Text as="span" className={styles.subtitle}>
          {spec.subtitle}
        </Text>
      )}
      <Tooltip content="Download chart as PNG" relationship="label">
        <Button
          size="small"
          appearance="secondary"
          className={`${styles.pngBtn} lh-chart-png`}
          icon={exported ? <IconCheck /> : <IconDownload />}
          aria-label="Download chart as PNG"
          onClick={() => {
            if (!svgRef.current) return;
            downloadChartPng(svgRef.current);
            setExported(true);
            window.setTimeout(() => setExported(false), 1600);
          }}
        />
      </Tooltip>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-hidden="false"
        className={styles.svg}
        style={{ touchAction: "manipulation" }}
        onClick={onChartTap}
      >
        <title>{aria}</title>
        {/* horizontal gridlines + tick labels */}
        {ticks.map((t) => (
          <g key={`t${t}`}>
            <line
              x1={MARGIN.left}
              x2={W - MARGIN.right}
              y1={y(t)}
              y2={y(t)}
              stroke={tokens.colorNeutralStroke2}
              strokeWidth={t === 0 ? 1.4 : 0.6}
            />
            <text
              x={MARGIN.left - 6}
              y={y(t) + 3.5}
              textAnchor="end"
              fontSize="10"
              fill={tokens.colorNeutralForeground3}
            >
              {formatTick(t)}
            </text>
          </g>
        ))}
        {/* x labels: numeric ticks for scatter, else per-category (temporal-formatted) */}
        {isScatter && xScale
          ? xTicks.map((t) => (
              <text
                key={`xt${t}`}
                x={xScale(t)}
                y={H - MARGIN.bottom + 16}
                textAnchor="middle"
                fontSize="10"
                fill={tokens.colorNeutralForeground3}
              >
                {formatTick(t)}
              </text>
            ))
          : spec.x.map((label, i) =>
              i % labelEvery === 0 ? (
                <text
                  key={`x${i}`}
                  x={xCenter(i)}
                  y={H - MARGIN.bottom + 16}
                  textAnchor="middle"
                  fontSize="10"
                  fill={tokens.colorNeutralForeground3}
                >
                  <title>{label}</title>
                  {truncateLabel(formatXTick(label, granularity))}
                </text>
              ) : null,
            )}
        {/* marks */}
        {isScatter && xScale
          ? // Scatter: (x, y) circles, no connecting line.
            spec.series[0].values.map((v, i) => {
              const xvi = xv[i];
              if (v === null || !Number.isFinite(xvi)) return null;
              return (
                <circle
                  key={`s${i}`}
                  cx={xScale(xvi)}
                  cy={y(v)}
                  r={3}
                  fill={SERIES_FILLS[0]}
                  fillOpacity={0.85}
                >
                  <title>{`${spec.series[0].name}: (${spec.x[i]}, ${v})`}</title>
                </circle>
              );
            })
          : isStacked
            ? // Stacked bar: one full-width bar per category, segments from the
              // baseline up. NO total label — the renderer never states the sum.
              spec.x.map((_, i) => {
                const bw = band * 0.72;
                const x0 = MARGIN.left + band * i + (band - bw) / 2;
                let running = 0;
                return (
                  <g key={`sb${i}`}>
                    {spec.series.map((s, si) => {
                      const v = s.values[i];
                      if (v === null) return null;
                      const yBot = y(running);
                      running += v;
                      const yTop = y(running);
                      return (
                        <rect
                          key={`sb${i}-${si}`}
                          x={x0}
                          y={yTop}
                          width={Math.max(1, bw)}
                          height={Math.max(1, Math.abs(yBot - yTop))}
                          fill={SERIES_FILLS[si % SERIES_FILLS.length]}
                        >
                          <title>{`${spec.x[i]} — ${s.name}: ${v}`}</title>
                        </rect>
                      );
                    })}
                  </g>
                );
              })
            : spec.kind === "bar"
              ? spec.series.map((s, si) => {
                  const group = band * 0.72;
                  const bw = group / spec.series.length;
                  return s.values.map((v, i) => {
                    if (v === null) return null;
                    const x0 = MARGIN.left + band * i + (band - group) / 2 + bw * si;
                    const y0 = Math.min(y(0), y(v));
                    const h = Math.abs(y(v) - y(0));
                    return (
                      <rect
                        key={`b${si}-${i}`}
                        x={x0}
                        y={y0}
                        width={Math.max(1, bw - 2)}
                        height={Math.max(1, h)}
                        rx={1.5}
                        fill={SERIES_FILLS[si % SERIES_FILLS.length]}
                      >
                        <title>{`${spec.x[i]} — ${s.name}: ${v}`}</title>
                      </rect>
                    );
                  });
                })
              : spec.series.map((s, si) => {
              const pts = s.values
                .map((v, i) => (v === null ? null : `${xCenter(i)},${y(v)}`))
                .filter((p): p is string => p !== null);
              const stroke = SERIES_FILLS[si % SERIES_FILLS.length];
              // Area = the line plus a translucent fill down to the baseline.
              // Only single-series time-series arrive as "area" (the engine's
              // choice), so overlapping fills aren't a concern; the low opacity
              // keeps a stray multi-series area legible regardless.
              const baseY = MARGIN.top + inner.h;
              const areaPts =
                spec.kind === "area" && pts.length >= 2
                  ? `${pts[0].split(",")[0]},${baseY} ${pts.join(" ")} ${
                      pts[pts.length - 1].split(",")[0]
                    },${baseY}`
                  : null;
              // Band interval (add-quant-depth): a shaded region between the
              // lower and upper bounds, over the contiguous run of points that
              // carry BOTH (the forecast tail; historical rows have null bounds).
              // Upper edge forward + lower edge back = a closed cone.
              const bandPts = (() => {
                if (!isBand || !s.lower || !s.upper) return null;
                const idx = s.values
                  .map((_, i) => i)
                  .filter((i) => s.lower![i] != null && s.upper![i] != null);
                if (idx.length < 2) return null;
                const up = idx.map((i) => `${xCenter(i)},${y(s.upper![i] as number)}`);
                const down = idx
                  .slice()
                  .reverse()
                  .map((i) => `${xCenter(i)},${y(s.lower![i] as number)}`);
                return [...up, ...down].join(" ");
              })();
              return (
                <g key={`l${si}`}>
                  {areaPts && (
                    <polygon points={areaPts} fill={stroke} fillOpacity={0.14} stroke="none" />
                  )}
                  {bandPts && (
                    <polygon points={bandPts} fill={stroke} fillOpacity={0.16} stroke="none" />
                  )}
                  <polyline
                    points={pts.join(" ")}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                  {s.values.map((v, i) =>
                    v === null ? null : (
                      <circle
                        key={`p${si}-${i}`}
                        cx={xCenter(i)}
                        cy={y(v)}
                        r={2.5}
                        fill={SERIES_FILLS[si % SERIES_FILLS.length]}
                      >
                        <title>{`${spec.x[i]} — ${s.name}: ${v}`}</title>
                      </circle>
                    ),
                  )}
                </g>
              );
            })}
        {/* fp3 §2: the tapped-datapoint tooltip. A rounded label above the
            point, clamped inside the viewBox; pointer-events off so the next
            tap reaches the shape/background underneath (toggle + dismiss). */}
        {tap &&
          (() => {
            const pad = 5;
            const charW = 6.1;
            const wBox = Math.min(W - 8, tap.text.length * charW + pad * 2);
            const hBox = 20;
            const bx = Math.max(4, Math.min(W - wBox - 4, tap.tx - wBox / 2));
            const by = Math.max(4, tap.ty - hBox - 8);
            return (
              <g style={{ pointerEvents: "none" }}>
                <rect
                  x={bx}
                  y={by}
                  width={wBox}
                  height={hBox}
                  rx={5}
                  fill={tokens.colorNeutralBackgroundInverted}
                  opacity={0.95}
                />
                <text
                  x={bx + wBox / 2}
                  y={by + hBox / 2 + 3.5}
                  textAnchor="middle"
                  fontSize="10.5"
                  fill={tokens.colorNeutralForegroundInverted}
                >
                  {tap.text}
                </text>
              </g>
            );
          })()}
      </svg>
      {spec.series.length > 1 && (
        <figcaption className={styles.legend}>
          {spec.series.map((s, si) => (
            <Text key={s.name} as="span" className={styles.legendItem}>
              <span
                className={styles.swatch}
                style={{ backgroundColor: SERIES_FILLS[si % SERIES_FILLS.length] }}
              />
              {s.name}
            </Text>
          ))}
        </figcaption>
      )}
    </figure>
  );
}
