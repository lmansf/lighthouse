# Lighthouse design language (0.14.0, the Apple-feel pass)

The Beam identity — amber tint, warm paper/ink neutrals, the beacon — spoken
with an Apple accent on every platform. One design language, three platforms,
no platform cosplay: macOS renders SF and feels native; Windows/Linux render
Segoe/Roboto BY DESIGN and share the calm, the scale, and the tint. This
document is the contract future sessions inherit; the §31 test suites
(appleTokens / appleGlass / appleControls / appleIcons) pin the load-bearing
parts.

## 1 · Tokens (src/shell/theme.ts + app/globals.css — one place)

**Type.** Stack: `-apple-system, system-ui, "Segoe UI", Roboto,
"Helvetica Neue", sans-serif` — SF must win on Apple platforms. The HIG scale
rides REM over the Dynamic Type root (`font: -apple-system-body` on `:root`
behind `@supports`, 106.25% ≈ 17px elsewhere; **never put a px font-size on
the root** — it severs the Dynamic Type link):

| Fluent slot | Role | Size/Leading (pt) |
|---|---|---|
| Base100 | Caption | 12/16 |
| Base200 | Footnote | 13/18 |
| Base300 | **Body** | **17/22** |
| Base400 | Title3 | 20/25 |
| Base500 | Title2 | 22/28 |
| Base600 | Title1 | 28/34 |
| Hero700 | Large Title | 34/41 |
| — (`--lh-type-subhead`) | Subhead | 15/20 |

Weights: regular/medium/semibold/bold only; nothing renders under 11pt.
`fontScale`/`density` settings still work — `scaleTheme` scales rem too.

**Color.** One tint (`--lh-tint`, accent-aware through the Fluent brand
tokens). Semantic pairs per theme in globals.css: `--lh-bg/-secondary/
-grouped/-elevated`, the 4-step label ramp (`--lh-label…-quaternary` —
quaternary is decorative-only, never text), `--lh-separator`, `--lh-fill(-secondary)`.
Dark is base-vs-elevated (layered surfaces get LIGHTER), never inverted
light. `color-scheme: light dark` keeps native controls/scrollbars in theme.
Every text pairing is gated by `scripts/check-contrast.mjs` (228 pairings,
both themes, accents included) — a release gate, not advice.

**Shape.** Radii 8 (controls) / 12 (cards) / 16 (floating surfaces) / 26
(sheet tops) / capsule(999). Concentric rule: child = parent − gap
(`--lh-radius-concentric`). `corner-shape: squircle` is a gated opt-in
(`.lh-squircle`, Chromium-only today) so Apple platforms match their OS.

**Hairlines & depth.** 0.5px separators (1px at 1x density), inset to the
text edge in lists. Two shadows: `--lh-shadow-card` (0 8px 24px @ .08) and
`--lh-shadow-sheet` — depth comes from layering and hairline rings, never
dark smears.

**Motion.** Springs as `linear()` curves sampled from the damped oscillator:
`--lh-spring` (ζ=1 settle) and `--lh-spring-bounce` (ζ=0.72, one ~3%
overshoot — detent snaps, tab-bar return). Durations 150/250/400ms.
`prefers-reduced-motion` collapses movement to 0.01ms while
`--lh-dur-fade` stays — fades ARE the reduced-motion vocabulary. Scrolling
is always native; momentum is never emulated.

**Touch feel.** `-webkit-tap-highlight-color: transparent`; `touch-action:
manipulation` on controls; `.lh-press` (`:active` scale 0.97, behind
`hover: none`) is THE press feedback. Haptics via the shell's haptics plugin
(iOS only, no-op elsewhere): `selectionChanged()` on switch/segment/select
changes, `impactLight()` on sheet detent snaps.

## 2 · Glass (the budget is law)

Exactly TWO glass surfaces: the compact tab bar and the Sheet. Recipe:
translucent `color-mix` surface + `backdrop-filter: blur(≤16px on mobile)
saturate(≤180%)` + 0.5px inner highlight (`--lh-glass-highlight`) + hairline
ring + ambient shadow. Never glass on the content layer (pinned: the repo
contains `backdrop-filter` in exactly those two files). Solid fallback is
total: intensity 0 (the in-app slider, `--lh-glass-level`) or the OS Reduce
Transparency setting (read natively by the shell, stamped as
`data-reduce-transparency`) zeroes the mix, the blur, and the saturate.

**Contrast on glass** (the §7 gate): text on a glass surface must clear
4.5:1 composited over a worst-case backdrop (theme canvas carrying a dense
transcript — 30% fg1 coverage blur-averaged into bg1) at every intensity
step, both themes. Two design rules exist BECAUSE of that math:
- tab-bar inactive labels are **fg2**, never fg3 (fg3 bottoms out ~3.2);
- the Sheet's translucency floor is theme-aware (`--lh-glass-sheet-mix`:
  10% light / **3% dark** — dark materials run near-opaque, as Apple's do).

Tab bar: floating capsule (12px edge inset, 8px above the safe area, 420px
cap), minimizes on scroll-down / restores on scroll-up or top. Sheet: 36×5
grabber, medium (55%) + large detents, drag on the grabber/header only (the
body keeps native scrolling, overscroll contained), flick-to-dismiss, 26pt
top radius, plain 20% scrim, animated exit.

## 3 · Controls: replaced vs re-skinned

**Replaced** (geometry read Windows; hand-rolled or Fluent-as-headless under
the token skin — `src/shell/controls/`):

| Primitive | Geometry | Notes |
|---|---|---|
| LhSwitch | 51×31 capsule, sliding thumb | Fluent-shaped onChange; selection haptic |
| LhSegmented | rounded-9 track, sliding paddle | radiogroup semantics, roving arrows |
| LhDialogSurface | desktop 16-radius card / compact sheet | Fluent Dialog machinery underneath |
| LhMenu | compact action sheet / desktop quiet popover | submenus push a sheet page; `LhMenuPopover` = skin-only path for radio/checkbox menus |
| LhSelect | chevron-up-down trigger, checkmark options | sheet list on compact |

The menu/dialog/select **branch is compact, not pointer** — an iPad at
regular width keeps popovers (HIG). Documented keeps: the tooltip-anchored
bulk-Private switch stays Fluent (ref cloning); independent boolean filters
are toggles, not segments; vertical descriptive radio lists are list idiom.

**Re-skinned, still Fluent**: Button, Field, Input, Textarea, Badge,
Spinner, desktop Tooltip, Checkbox, SearchBox — the §1 tokens (radius, type,
shadows, focus) re-dress them; no per-feature style edits.

## 4 · Icons (one module, one metaphor set)

`src/shell/icons.tsx` is THE registry: semantic names (IconClose, IconTrash,
IconSettings/‑Filled, IconAI, …) over glyph outlines vendored from
**Framework7 Icons v5 (MIT)** — generated by `scripts/gen-glyphs.mjs`,
committed, reproducible, 1em/currentColor. Active/rest pairs survive for the
tab bar. Deliberate metaphor merges: edit/rename → pencil; the AI marks →
sparkles; folder open/closed → folder (the chevron carries disclosure);
stop/square → stop.

**Licensing rail:** NO Apple SF Symbols and NO SF font files may ever be
embedded in this repository — they are licensed for Apple platforms only and
this bundle ships to Windows/Linux. Framework7's set is the lawful
SF-flavored stand-in. Pinned by a repo-wide asset scan in
test/appleIcons.test.mjs.

## 5 · Surface idioms

Settings is inset-grouped: group cards (12 radius, elevated surface,
hairline ring) on the grouped canvas, 44pt rows with an icon gutter and
chevron disclosure, separators inset to the label edge, footnote footers
where context earns its place. The compact Files page is a tile grid with
28pt circular tint check badges and footnote metadata. The chat composer is
the capsule field (22px radius — a true pill at one line, calm when grown).
Pickers open sheets at the medium detent; reading surfaces (History) open
large.

## 6 · Desktop posture

Sleek, not glassy: no glass on desktop; SF type on macOS, Segoe/Roboto
elsewhere by design; the 2px tint focus ring draws on `:focus-visible` only;
scrollbars stay quiet via `color-scheme`; affordances rest at 0.55 opacity
and reach full strength on hover (never invisible-until-hover).

## 7 · Verification

`node scripts/check-contrast.mjs` (228 pairings incl. glass composites);
`node --test test/*.test.mjs` (the §31 suites pin tokens, glass budget,
controls, icons); Dynamic Type: all type is rem on the hooked root, so a
+2-step text size scales text without severing layout — containers use
min-heights and rem paddings, never fixed text-box heights. Visual
verification on Apple hardware/simulator per release (screenshots in the
0.14.0 PR).
