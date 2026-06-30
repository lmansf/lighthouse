// WCAG contrast check for the Lighthouse steel + Forerunner-accent palette.
// Run: `node scripts/check-contrast.mjs`. Keep the values below in sync with
// src/shell/theme.ts; this is the guard that the theme stays accessible.
const hex = (h) => {
  const n = parseInt(h.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const lin = (c) => {
  c /= 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const lum = (h) => {
  const [r, g, b] = hex(h);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const ratio = (a, b) => {
  const la = lum(a), lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

const P = {
  bg1: "#EAEEF2", bg2: "#DFE5EB", bg3: "#D2DAE2",
  fg1: "#1A2531", fg2: "#45566A", fg3: "#5E6E80",
  brand: "#1A7AC0", link: "#15639C", brandText: "#114F80",
  sky: "#15639C", skyFill: "#D4E6F4",
  beam: "#E2B453", beamFill: "#F3E3BB", brass: "#C28A2C",
  white: "#FFFFFF",
};

const checks = [
  ["fg1 on bg1 (body text)", P.fg1, P.bg1, 7],
  ["fg1 on bg2 (sidebar text)", P.fg1, P.bg2, 4.5],
  ["fg1 on bg3 (inset text)", P.fg1, P.bg3, 4.5],
  ["fg2 on bg1 (muted)", P.fg2, P.bg1, 4.5],
  ["fg2 on bg2 (muted on steel)", P.fg2, P.bg2, 4.5],
  ["white on brand blue (primary btn)", P.white, P.brand, 4.5],
  ["white on sky (secondary btn)", P.white, P.sky, 4.5],
  ["link on bg1", P.link, P.bg1, 4.5],
  ["link on bg2", P.link, P.bg2, 4.5],
  ["brandText on bg1 (marks)", P.brandText, P.bg1, 4.5],
  ["fg1 on beam glint", P.fg1, P.beam, 4.5],
  ["fg1 on beamFill badge", P.fg1, P.beamFill, 4.5],
  ["fg1 on skyFill badge", P.fg1, P.skyFill, 4.5],
];

let allPass = true;
for (const [label, fg, bg, min] of checks) {
  const r = ratio(fg, bg);
  const pass = r >= min;
  if (!pass) allPass = false;
  console.log(`${pass ? "PASS" : "FAIL"}  ${r.toFixed(2).padStart(5)} (min ${min})  ${label}`);
}
console.log(allPass ? "\nAll pairings meet WCAG AA." : "\nSome pairings fail — adjust theme.ts.");
process.exit(allPass ? 0 : 1);
