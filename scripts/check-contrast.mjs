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
  // Beam chart series (AnalyticsChart SERIES_FILLS ride exactly these
  // tokens: colorBrandForeground1, colorBrandForegroundLink,
  // colorNeutralForeground2): each series mark against the answer-card /
  // canvas surface it draws on (non-text, 1.4.11).
  ["chart series 1 (amber) vs bg1", P.mark, P.bg1, 3],
  ["chart series 2 (slate) vs bg1", P.link, P.bg1, 3],
  ["chart series 3 (neutral ink) vs bg1", P.fg2, P.bg1, 3],
];

// ---------------------------------------------------------------------------
// Curated accents (openspec: add-usability-field-patch §3) — the alternative
// brand hues. Each is the brand-token SET only; it inherits the shared neutrals
// + link, so the SAME pairings amber clears are re-checked with the accent's
// values. Mirrors ACCENT_THEMES in src/shell/theme.ts — keep the two in sync.
// (amber is the base themes above, already checked.)
// ---------------------------------------------------------------------------
const ACCENTS = {
  teal: {
    paper: { brand: "#12A594", brandHover: "#17B8A6", brandPressed: "#14AE9E", brandTint: "#E8F7F4",
      brandTintHover: "#D3F0EB", mark: "#0B7A6F", brandText: "#0A6A60", compound: "#0E9184",
      compoundHover: "#0B7A6F", compoundPressed: "#095F57", focus: "#0B7A6F" },
    ink: { brand: "#2CD4C0", brandHover: "#53E0D0", brandPressed: "#24B4A3", brandTint: "#08211E",
      brandTintHover: "#0B4A43", mark: "#2CD4C0", brandText: "#53E0D0", compound: "#2CD4C0",
      compoundHover: "#53E0D0", compoundPressed: "#22B0A0", focus: "#2CD4C0" },
  },
  orchid: {
    paper: { brand: "#C264C6", brandHover: "#CE7BD2", brandPressed: "#C972CD", brandTint: "#F9ECFA",
      brandTintHover: "#F1D9F2", mark: "#943F98", brandText: "#833A87", compound: "#B453B8",
      compoundHover: "#9C3FA0", compoundPressed: "#823585", focus: "#943F98" },
    ink: { brand: "#E29BE6", brandHover: "#ECB6EF", brandPressed: "#D486D8", brandTint: "#241026",
      brandTintHover: "#4A2A4D", mark: "#E29BE6", brandText: "#ECB6EF", compound: "#E29BE6",
      compoundHover: "#ECB6EF", compoundPressed: "#D07FD4", focus: "#E29BE6" },
  },
};

let allPass = true;
let total = 0;
const runChecks = (heading, P) => {
  console.log(`\n== ${heading} ==`);
  for (const [label, fg, bg, min] of checksFor(P)) {
    const r = ratio(fg, bg);
    const pass = r >= min;
    if (!pass) allPass = false;
    total += 1;
    console.log(`${pass ? "PASS" : "FAIL"}  ${r.toFixed(2).padStart(5)} (min ${min})  ${label}`);
  }
};
runChecks("Paper (light)", PAPER);
runChecks("Ink (dark)", INK);
for (const [name, v] of Object.entries(ACCENTS)) {
  runChecks(`${name} accent · Paper`, { ...PAPER, ...v.paper });
  runChecks(`${name} accent · Ink`, { ...INK, ...v.ink });
}
// ---------------------------------------------------------------------------
// §31 §7: contrast ON GLASS. The two glass surfaces (compact tab bar, Sheet)
// composite their translucent surface over BLURRED app content; text on them
// must clear 4.5:1 at EVERY intensity step, both themes. Model (documented in
// docs/design-language.md):
//   backdrop  = the theme canvas carrying a DENSE transcript — 30% fg1 glyph
//               coverage blur-averaged into bg1 (worse than real transcripts);
//   composite = alpha·surface + (1−alpha)·backdrop, per sRGB channel;
//   tab bar   alpha = 1 − 0.38·level over bg2 (labels: fg2 rest, mark active);
//   sheet     alpha = 1 − mix·level over elevated, mix = 0.10 light / 0.03
//             dark (--lh-glass-sheet-mix — dark materials run near-opaque, as
//             Apple's do, so interior fg3 metadata stays readable).
// Keep the vars in app/globals.css and the mixes in CompactTabBar/Sheet in
// sync with these numbers.
// ---------------------------------------------------------------------------
const mixc = (a, b, t) => {
  const [ar, ag, ab_] = hex(a), [br, bg_, bb] = hex(b);
  const ch = (x, y) => Math.round(x * t + y * (1 - t));
  return (
    "#" + [ch(ar, br), ch(ag, bg_), ch(ab_, bb)].map((v) => v.toString(16).padStart(2, "0")).join("")
  );
};
const GLASS_SURFACES = (P, ink) => {
  const backdrop = mixc(P.fg1, P.bg1, 0.3); // dense-transcript blur average
  const elevated = ink ? "#1E2126" : "#FFFFFF";
  const sheetMix = ink ? 0.03 : 0.10;
  const out = [];
  for (const level of [0, 0.5, 1]) {
    const barAlpha = 1 - 0.38 * level;
    const bar = mixc(P.bg2, backdrop, barAlpha);
    out.push([`tab bar label (fg2) @ glass ${level}`, P.fg2, bar, 4.5]);
    out.push([`tab bar active mark @ glass ${level}`, P.mark, bar, 3]);
    const sheetAlpha = 1 - sheetMix * level;
    const sheet = mixc(elevated, backdrop, sheetAlpha);
    out.push([`sheet body (fg1) @ glass ${level}`, P.fg1, sheet, 4.5]);
    out.push([`sheet secondary (fg2) @ glass ${level}`, P.fg2, sheet, 4.5]);
    out.push([`sheet metadata (fg3) @ glass ${level}`, P.fg3, sheet, 4.5]);
  }
  return out;
};
const runGlass = (heading, P, ink) => {
  console.log(`\n== ${heading} ==`);
  for (const [label, fg, bg, min] of GLASS_SURFACES(P, ink)) {
    const r = ratio(fg, bg);
    const pass = r >= min;
    if (!pass) allPass = false;
    total += 1;
    console.log(`${pass ? "PASS" : "FAIL"}  ${r.toFixed(2).padStart(5)} (min ${min})  ${label}`);
  }
};
runGlass("glass · Paper", PAPER, false);
runGlass("glass · Ink", INK, true);

console.log(
  allPass
    ? `\nAll ${total} pairings meet WCAG AA in both themes.`
    : "\nSome pairings fail — adjust theme.ts (and keep this file in sync).",
);
process.exit(allPass ? 0 : 1);
