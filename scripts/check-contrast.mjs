// WCAG contrast gate for the Beam identity - Paper (light) AND Ink (dark).
// Run: `node scripts/check-contrast.mjs`. Keep the palettes below in sync with
// src/shell/theme.ts; this is the guard that BOTH themes stay accessible.
// Exit code 1 on any failure - wired as a release gate, not advice.
//
// Minimums: 4.5 for text pairings (WCAG AA, body size - we don't grant
// ourselves the 3.0 large-text discount anywhere text is involved) and 3.0
// for non-text UI parts (WCAG 1.4.11: focus rings, active marks, checked
// control fills and their check glyphs).
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

// ---------------------------------------------------------------------------
// Paper (light) - mirrors lighthouseTheme in src/shell/theme.ts.
// brandTint/brandTintHover mirror the beamAmber ramp's 160/150 (Fluent maps
// colorBrandBackground2/Hover there); compound* mirror ramp 80/70/60.
// ---------------------------------------------------------------------------
const PAPER = {
  bg1: "#FAFAF8", bg2: "#F4F4F1", bg3: "#EDEDE9",
  fg1: "#1B1B1F", fg2: "#5A5A60", fg3: "#68686F",
  brand: "#E8A317", brandHover: "#DE9A11", brandPressed: "#C9880B",
  onBrand: "#1B1B1F",                       // colorNeutralForegroundOnBrand
  brandTint: "#FDF7E7", brandTintHover: "#FBEFD4", // colorBrandBackground2(+Hover)
  mark: "#A87107",                          // colorBrandForeground1 (icons/marks)
  brandText: "#8F6006",                     // colorBrandForeground2 (chip text)
  compound: "#BC7F09", compoundHover: "#A87107", compoundPressed: "#936608",
  checkFg: "#FFFFFF",                       // colorNeutralForegroundInverted
  focus: "#A87107",                         // colorStrokeFocus2
  link: "#46698C", linkHover: "#3A587A", linkPressed: "#2F4A68",
};

// ---------------------------------------------------------------------------
// Ink (dark) - mirrors darkLighthouseTheme. brandTint/Hover mirror ramp 20/40
// (Fluent's dark mapping); mark/brandText mirror the ramp-derived 100/110;
// compound* mirror ramp 100/110/90; checkFg is Fluent's dark grey[14].
// ---------------------------------------------------------------------------
const INK = {
  bg1: "#0E0F12", bg2: "#16181C", bg3: "#1E2126",
  fg1: "#ECECEA", fg2: "#A2A2A8", fg3: "#8A8A91",
  brand: "#FFC24D", brandHover: "#FFCE6E", brandPressed: "#F0B23A",
  onBrand: "#1B1B1F",
  brandTint: "#2C1F04", brandTintHover: "#664508",
  mark: "#E8A317",
  brandText: "#F5B83C",
  compound: "#E8A317", compoundHover: "#F5B83C", compoundPressed: "#D2920E",
  checkFg: "#242424",
  focus: "#FFC24D",
  link: "#8FB4D9", linkHover: "#A9C6E2", linkPressed: "#79A2C6",
};

const checksFor = (P) => [
  // Body text on the three neutral surfaces (fg1 on canvas held to AAA).
  ["fg1 on bg1 (body text)", P.fg1, P.bg1, 7],
  ["fg1 on bg2 (raised surfaces)", P.fg1, P.bg2, 4.5],
  ["fg1 on bg3 (insets/code)", P.fg1, P.bg3, 4.5],
  ["fg2 on bg1 (secondary)", P.fg2, P.bg1, 4.5],
  ["fg2 on bg2", P.fg2, P.bg2, 4.5],
  ["fg2 on bg3", P.fg2, P.bg3, 4.5],
  ["fg3 on bg1 (stamps/meta)", P.fg3, P.bg1, 4.5],
  ["fg3 on bg2", P.fg3, P.bg2, 4.5],
  ["fg3 on bg3", P.fg3, P.bg3, 4.5],
  // The amber action button: ink text on the fill, all three states.
  ["button text on brand fill", P.onBrand, P.brand, 4.5],
  ["button text on brand hover", P.onBrand, P.brandHover, 4.5],
  ["button text on brand pressed", P.onBrand, P.brandPressed, 4.5],
  // Brand-tinted surfaces (question bubble, pin banner, active history row,
  // citation chips): body + quiet + brand text on them.
  ["fg1 on brand tint", P.fg1, P.brandTint, 4.5],
  ["fg3 on brand tint (row meta)", P.fg3, P.brandTint, 4.5],
  ["brand text on brand tint (cite chip)", P.brandText, P.brandTint, 4.5],
  ["brand text on tint hover", P.brandText, P.brandTintHover, 4.5],
  ["brand text on bg1", P.brandText, P.bg1, 4.5],
  // Links (the quiet blue) as body-size text.
  ["link on bg1", P.link, P.bg1, 4.5],
  ["link on bg2", P.link, P.bg2, 4.5],
  ["link on bg3", P.link, P.bg3, 4.5],
  ["link hover on bg1", P.linkHover, P.bg1, 4.5],
  ["link pressed on bg1", P.linkPressed, P.bg1, 4.5],
  // Non-text UI (WCAG 1.4.11, 3.0): amber focus ring, active/included marks,
  // checked control fills and the glyph sitting on them.
  ["focus ring vs bg1", P.focus, P.bg1, 3],
  ["focus ring vs bg2", P.focus, P.bg2, 3],
  ["mark vs bg1 (active icons)", P.mark, P.bg1, 3],
  ["mark vs bg2", P.mark, P.bg2, 3],
  ["checked fill vs bg1", P.compound, P.bg1, 3],
  ["check glyph on checked fill", P.checkFg, P.compound, 3],
  ["check glyph on checked hover", P.checkFg, P.compoundHover, 3],
  ["check glyph on checked pressed", P.checkFg, P.compoundPressed, 3],
];

let allPass = true;
let total = 0;
for (const [name, P] of [["Paper (light)", PAPER], ["Ink (dark)", INK]]) {
  console.log(`\n== ${name} ==`);
  for (const [label, fg, bg, min] of checksFor(P)) {
    const r = ratio(fg, bg);
    const pass = r >= min;
    if (!pass) allPass = false;
    total += 1;
    console.log(`${pass ? "PASS" : "FAIL"}  ${r.toFixed(2).padStart(5)} (min ${min})  ${label}`);
  }
}
console.log(
  allPass
    ? `\nAll ${total} pairings meet WCAG AA in both themes.`
    : "\nSome pairings fail — adjust theme.ts (and keep this file in sync).",
);
process.exit(allPass ? 0 : 1);
