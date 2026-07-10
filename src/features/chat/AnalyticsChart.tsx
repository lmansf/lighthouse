"use client";

import { useRef, useState } from "react";
import { Button, Text, Tooltip, makeStyles, tokens } from "@fluentui/react-components";
import { ArrowDownloadRegular, CheckmarkRegular } from "@fluentui/react-icons";
import { formatTick, niceTicks, scaleLinear, type ChartSpec } from "@/lib/chartSpec";

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
  svg: { width: "100%", height: "auto", display: "block" },
  // Hover-revealed download affordance, mirroring the tables' Copy CSV button.
  pngBtn: {
    position: "absolute",
    top: "0px",
    right: "0px",
    opacity: 0,
    transitionProperty: "opacity",
    transitionDuration: tokens.durationFaster,
    backgroundColor: tokens.colorNeutralBackground1,
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
});

/** Series palette from the theme; cycles if the engine ever sends more. */
const SERIES_FILLS = [
  tokens.colorBrandForeground1,
  tokens.colorPaletteBerryForeground2,
  tokens.colorPaletteMarigoldForeground2,
];

function truncateLabel(l: string): string {
  return l.length > 10 ? `${l.slice(0, 9)}…` : l;
}

/**
 * Rasterize the rendered SVG to a 2× PNG and trigger a download
 * (openspec: add-answer-artifacts). Two theme requirements: the chart's
 * colors are Fluent CSS variables that a standalone SVG document can't
 * resolve, so each element's computed fill/stroke is baked into the clone;
 * and the canvas is painted with the surface's background first so a
 * dark-mode chart never exports transparent-on-dark. Client-only.
 */
function downloadChartPng(svg: SVGSVGElement): void {
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
  // Nearest opaque ancestor background = the theme surface behind the chart.
  let bg = "#ffffff";
  for (let el: Element | null = svg; el; el = el.parentElement) {
    const c = window.getComputedStyle(el).backgroundColor;
    if (c && c !== "transparent" && !c.startsWith("rgba(0, 0, 0, 0)")) {
      bg = c;
      break;
    }
  }
  clone.setAttribute("width", String(W));
  clone.setAttribute("height", String(H));
  // The on-screen labels inherit the app font from CSS the standalone SVG
  // won't have — bake it in so the PNG doesn't rasterize in the UA serif.
  clone.style.fontFamily = window.getComputedStyle(svg).fontFamily;
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
  const inner = { w: W - MARGIN.left - MARGIN.right, h: H - MARGIN.top - MARGIN.bottom };

  const all = spec.series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  const ticks = niceTicks(Math.min(0, ...all), Math.max(0, ...all), 4);
  const y = scaleLinear(
    ticks[0],
    ticks[ticks.length - 1],
    MARGIN.top + inner.h,
    MARGIN.top,
  );
  const n = spec.x.length;
  const band = inner.w / n;
  const xCenter = (i: number) => MARGIN.left + band * i + band / 2;
  // Crowded axes: label every k-th category so text never overlaps.
  const labelEvery = n > 16 ? 3 : n > 8 ? 2 : 1;

  const aria = `${spec.kind} chart of ${spec.series.map((s) => s.name).join(", ")} across ${n} ${
    spec.kind === "line" ? "points" : "categories"
  }`;

  return (
    <figure className={styles.frame} aria-label={aria}>
      <Tooltip content="Download chart as PNG" relationship="label">
        <Button
          size="small"
          appearance="secondary"
          className={`${styles.pngBtn} lh-chart-png`}
          icon={exported ? <CheckmarkRegular /> : <ArrowDownloadRegular />}
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
        {/* x labels */}
        {spec.x.map((label, i) =>
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
              {truncateLabel(label)}
            </text>
          ) : null,
        )}
        {/* marks */}
        {spec.kind === "bar"
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
              return (
                <g key={`l${si}`}>
                  <polyline
                    points={pts.join(" ")}
                    fill="none"
                    stroke={SERIES_FILLS[si % SERIES_FILLS.length]}
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
