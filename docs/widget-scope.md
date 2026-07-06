# Desktop Widget — Scoping Document

**Feature**: a lone floating search bar over the vault — draggable, pinnable,
summonable by a global hotkey — with one extra affordance: a folder button that
opens a standalone vault-explorer window showing what's active / in the vault.

**Verdict: fully feasible on all three OSes with the stack we already ship.**
Every windowing capability below was verified against the *installed* Tauri
2.11.5 / wry 0.55.1 / tao 0.35.3 sources, and the search backend already exists
in both engines. The one genuinely hard part is the exact hotkey requested —
**Ctrl + Super + Shift is a modifier-only chord**, which no standard global-
shortcut API can register. It is still deliverable (Wispr Flow ships exactly
this pattern on Windows), but it needs a per-OS low-level listener and must be
an *opt-in tier* on top of a guaranteed keyed default. Details in §4.

---

## 1. UX specification

### 1.1 The widget
A frameless, rounded pill (~560×56 logical px): search input, three quiet
icon buttons (📌 pin · 📁 vault · ✕ hide), and a results dropdown that grows
beneath it (window auto-resizes up to ~560×420 while results show).

| Interaction | Behavior |
|---|---|
| **Summon** (hotkey / tray / dock) | Show + focus the input. Re-center if the saved position is off-screen (monitor unplugged). |
| **Type** | Instant results: file-name matches from the cached tree (client-side, works from 1 char) + content passages (engine `search`, debounced ~150 ms, ≥3 chars). Each row: file icon · name · snippet · a small "hidden from AI" badge when applicable. |
| **Enter** | Open the selected file in its native app (existing `open_node`). |
| **Ctrl/Cmd+Enter** or the "Ask Lighthouse →" row | Raise the main window with the query pre-seeded into chat — *this* is the "whisper to your file system" moment. |
| **Esc / click-away** | Hide (unless pinned). `Focused(false)` window event → hide is the standard spotlight-bar pattern. |
| **Drag** | Anywhere on the pill chrome via `data-tauri-drag-region="deep"` — Tauri's injected drag script automatically exempts the `<input>` and buttons, so typing is never hijacked (verified in `window/scripts/drag.js`). |
| **Pin 📌** | Toggles always-on-top + stay-visible-on-blur. Runtime `set_always_on_top(bool)` (verified). Position persists via the window-state plugin we already ship (per-label — verified). |
| **Folder 📁** | Opens the vault-explorer window (§1.2). Right-click: "Open vault folder" (1-line wrapper over the existing `open_with_os(vault_dir)` menu handler). |

### 1.2 The vault-explorer window
A standalone, normal-decorations window (~420×640) rendering the **existing
`FileExplorer` component** — tree, eye toggles, search/filter, add/drag-drop
all come for free. This is the "editor-style modal": what's in the vault,
what's visible to AI, toggle from the widget without opening the full app.

### 1.3 Modes of presence
- **Widget-only mode**: main window closed to tray, widget summonable — the
  app's background presence *is* the widget. Pairs naturally with
  launch-at-login (consent-gated as of 0.3.3).
- The tray menu gains "Show search bar"; a second app launch
  (single-instance plugin, already shipped) summons the widget instead of
  just raising the main window.

---

## 2. Technical architecture (all items source-verified)

### 2.1 Windows & routing
- **Second/third windows**: `WebviewWindowBuilder` at runtime (or declared in
  `tauri.conf.json` with `visible:false`). Builder knobs confirmed present in
  tauri 2.11.5: `.decorations(false)`, `.always_on_top()`, `.skip_taskbar()`,
  `.resizable(false)`, `.transparent()`, `.visible_on_all_workspaces()`,
  `.focused()`, plus runtime mutators for all of them.
- **One SPA bundle, three windows**: Next's static export emits a real second
  entry for `app/widget/page.tsx` → `widget/index.html`, and Tauri's embedded
  asset resolver falls back `/widget → widget.html → widget/index.html →
  index.html` (verified in `manager/mod.rs:384-433`). Same for `/explorer`.
  No hash-routing hacks needed.
- **Providers come free**: `app/layout.tsx` wraps *every* route in
  `Providers`, which installs the IPC fetch interceptor, Fluent + theme
  (light/dark follows the same persisted store — localStorage is shared
  across windows of one app). A widget page needs zero provider wiring.

### 2.2 Capabilities (the silent-failure trap)
`capabilities/default.json` currently scopes `windows:["main"]`. Verified:
- App commands (`rag_list`, `rag_op`, `open_node`, …) are **not** ACL-gated
  for local webviews (we define no app ACL manifest) — the widget can invoke
  them with no change.
- But **core/plugin** surface is gated per label: event `listen`
  (vault-changed refresh), dialogs, and window ops silently fail for an
  unlisted window. Also `core:window:default` is read-only — frameless drag
  needs `core:window:allow-start-dragging`, the pin needs
  `allow-set-always-on-top`.
- **Action**: add `capabilities/widget.json` → `windows:["widget","explorer"]`
  with `core:default`, `core:window:allow-show/hide/set-focus/start-dragging/
  set-always-on-top`, `dialog:default` (explorer pickers).

### 2.3 Transparency & chrome, per platform
| | Windows | macOS | Linux |
|---|---|---|---|
| Transparent bg | ✅ (verified in wry; not Win 7) | ⚠️ needs `macOSPrivateApi:true` — **blocks Mac App Store** | ⚠️ compositor-dependent (X11 w/o compositor = opaque) |
| `skip_taskbar` | ✅ | ❌ no-op (unsupported) | ✅ |
| `visible_on_all_workspaces` | ❌ unsupported | ✅ | ✅ |
| Frameless shadow | 1 px border artifact on undecorated | ✅ | ❌ unsupported |

**Decision**: design the widget as an *opaque rounded pill* (theme surface
color + our own CSS shadow inside a tiny transparent margin only where free).
It looks identical everywhere, and we don't burn the Mac App Store option or
depend on the user's Linux compositor. Revisit true transparency later.

### 2.4 State across windows
- `app.emit("vault-changed")` broadcasts to **all** webviews (verified,
  `EventTarget::Any`) and our transport already re-broadcasts it as a DOM
  event — adds/removes push instantly to every window.
- Gap found: **eye-toggles don't push** (the FS watcher deliberately ignores
  `.rag-vault` state churn), so window B would lag a toggle in window A by up
  to the 15 s poll. Fix: one `app.emit("vault-changed", ())` inside `rag_op`'s
  include/source ops. 1 line.
- Extract the vault load/poll/refresh effect out of `AppShell` into a shared
  `useVaultTree()` hook so widget + explorer windows reuse it **without**
  also mounting `useUsageCapture`, the launch ping, or the global shortcuts
  (double-telemetry / double-count hazards found in the audit).
- Zustand stores are per-window; the engine (Rust, process-global) is the
  single source of truth. Chat transcript (sessionStorage) is untouched.
- The global close-to-tray handler currently hides **any** window — add a
  label check (widget: hide; explorer: close for real).
- License: the widget must read `useLicenseStore` itself and show the lock
  state — mounting search bare would silently bypass the trial gate.

### 2.5 New Rust surface (all small)
| Command | Size | Purpose |
|---|---|---|
| `widget_toggle` / summon | ~10 lines | show+focus / hide the widget window (hotkey + tray target) |
| `show_main { seedQuestion? }` | ~10 lines | raise main window; optional query handoff for "Ask Lighthouse" (emit an event the chat page consumes) |
| `open_vault_dir` | 1 line | reuse existing `open_with_os(vault_dir_setting)` |
| `rag_op` emit on include ops | 1 line | instant cross-window sync (§2.4) |
| Lazy `WebviewWindowBuilder` for widget/explorer | ~40 lines | in `setup()` / on demand |

### 2.6 Search backend — what exists, what to harden
Both engines already expose `op:"search"` → `references[{fileId, name,
snippet ≤240 chars, score 0-1}]` over the persistent TF-IDF index (warm
queries are in-memory; first query after boot pays one parallel index load).
Known limits for a typeahead use:
- `k` is hardcoded to 5 in the desktop command; queries under ~3-4 chars
  return nothing; results cover only files *visible to AI*; there's a nice
  bonus: catalog intents ("list my pdfs") return enumerations.
- The widget therefore does **name matching client-side** over the cached
  tree (the exact logic the explorer's search box ships today — covers hidden
  files, 1-char queries, instant), with content passages layered under it
  from `op:"search"`.
- Optional engine hardening (~20 lines/engine): a `k` parameter and a
  dedicated name-search op. Nice-to-have, not a blocker.

---

## 3. The hotkey — honest per-OS scoping

**The request**: default summon on **Ctrl + Super + Shift**, a *modifier-only
chord*, so Wispr-style users feel at home.

**Hard fact (verified in crate sources)**: `tauri-plugin-global-shortcut`
wraps `global_hotkey::HotKey { mods, key: Code }` — a non-modifier key is
mandatory; `"Shift+Ctrl"` is a parse error by explicit test. No mainstream
global-shortcut API (RegisterHotKey, Carbon RegisterEventHotKey, XGrabKey)
can express modifier-only. Wispr Flow does it with a low-level keyboard
listener — and that's the same path open to us.

### Two-tier strategy

**Tier 1 — keyed chord, guaranteed, the default** (`tauri-plugin-global-shortcut`, new dep):
- Windows / Linux-X11: **`Ctrl+Super+Shift+Space`** (keeps the requested
  modifiers; avoids Alt+Space window menu and Win+Space layout switch).
- macOS: **⌃⇧⌘Space** (same string — SUPER≡Cmd; avoids ⌘Space Spotlight,
  ⌥Space Raycast). No permission prompt on any OS.
- Linux-Wayland: the plugin is X11-only (verified). Use the
  `xdg-desktop-portal` **GlobalShortcuts** interface via the `ashpd` crate —
  shipped on KDE, Hyprland, GNOME 48+; absent on wlroots/sway → fall back to
  tray-click summon + second-launch-summons-widget (both already possible
  with shipped plugins).
- Rebindable in Preferences (shortcut-recorder field, live re-register,
  revert on failure; render per-OS glyphs — "Super" reads as ⌘ on Mac).

**Tier 2 — "Whisper mode" (hold Ctrl+Super+Shift), opt-in per OS**:
| OS | Mechanism | Friction |
|---|---|---|
| Windows | `WH_KEYBOARD_LL` hook on a dedicated thread (what Wispr/PowerToys-class tools use) | Keyboard hook + unsigned exe = classic AV keylogger heuristic → **code signing is effectively a prerequisite**. Hook callback must stay fast or Windows silently unhooks it. |
| macOS | Prototype `NSEvent` global monitor for `.flagsChanged` first (may need no permission); else listen-only `CGEventTap` behind an **Input Monitoring** consent flow (pre-prompt sheet → System Settings → relaunch) | Fine as a power-user opt-in; poison as a default. MAS-compatible but scrutinized. |
| Linux X11 | `rdev`/XRecord listener, no root | Vendor or pin the crate (lightly maintained). |
| Linux Wayland | **Not possible** without `/dev/input` privileges — hide the option | — |

**Chord state machine** (all platforms, protects against real collisions):
arm when Ctrl+Super+Shift are down *and nothing else*; fire on ~200 ms hold
or clean release; **abort instantly if any non-modifier key arrives** —
Ctrl+Super+Shift is a strict prefix of **Win+Ctrl+Shift+B** (Windows graphics
driver restart) and **⌃⇧⌘3/4** (macOS screenshot-to-clipboard), and a naive
"all three down" trigger would fire on every one of those. Debounce
autorepeat; suppress while the widget already has focus; document the
interaction with Sticky Keys / remappers (Karabiner, PowerToys) and always
keep the keyed chord working alongside.

### Marketing note
Tier 2 is the story: *"Hold Ctrl + Super + Shift — whisper to your file
system."* Same muscle memory as Wispr's push-to-talk; the widget appears
under your fingers, you type (or later, dictate) and your own documents
answer. Tier 1 makes sure every user has a working summon key on day one;
Tier 2 makes it feel magic where the OS allows.

---

## 4. Phased delivery plan

| Phase | Scope | Estimate |
|---|---|---|
| **W1 — Widget MVP** | `app/widget/page.tsx` (search bar UI, name+content results, open/Ask actions, pin, Esc/blur hide) · widget window plumbing + capability file · `useVaultTree` extraction · Tier-1 hotkey (plugin, Win/mac/X11) · tray "Show search bar" + second-launch summon · license gating · static-export second entry | **2–4 days** |
| **W2 — Vault explorer window** | `app/explorer/page.tsx` mounting `FileExplorer` · lazy window creation from the 📁 button · label-aware close handling · cross-window include-toggle emit · `open_vault_dir` | **1–2 days** |
| **W3 — Whisper mode** | Chord state machine + per-OS listeners, shipped in order: Windows → macOS (flagsChanged prototype, then TCC flow) → X11 · Wayland portal (ashpd) for the keyed chord · Preferences: shortcut recorder + "hold-modifiers summon" toggle | **3–5 days, stageable** |
| **W4 — Polish & launch** | Summon animation, off-screen re-position, multi-monitor placement, first-run hint ("press ⌃⇧⌘Space anywhere"), website/marketing copy | **1–2 days** |

W1+W2 alone deliver the full user-visible feature with a reliable hotkey;
W3 adds the Wispr-style chord where each OS permits.

## 5. Risk register
| Risk | Severity | Mitigation |
|---|---|---|
| AV false-positives on the Windows keyboard hook | High (unsigned) | Code-sign installers before shipping Whisper mode; Tier 1 needs no hook. |
| Wayland can't do global keys outside the portal | Medium | Portal on KDE/GNOME 48+/Hyprland; tray + relaunch summon elsewhere; hide Whisper mode. |
| macOS transparency requires private API (MAS ban) | Low | Ship opaque pill (design decision above). |
| Widget bypasses trial lock | Medium | Widget reads license store; locked = search disabled with unlock link. |
| Double telemetry from a second webview | Low | `useVaultTree` extraction; widget mounts no usage-capture/launch-ping. |
| Chord collides with OS prefixes (Win+Ctrl+Shift+B, ⌃⇧⌘3/4) | Medium | Abort-on-any-key state machine (§3). |
| window-state restores widget to a dead monitor | Low | Re-center on summon when off-screen. |

## 6. Out of scope (this feature)
Voice input (the literal "wyspering" — natural follow-up once the widget
exists), inline AI answers in the dropdown (start with hand-off to main chat;
an inline mini-answer is a W5 candidate), Linux tray parity quirks, signing
infrastructure (tracked separately; prerequisite only for W3-Windows).

---

## 7. Execution status

This section is the durable record of the build — update it as phases land.

| Phase | Status | Notes |
|---|---|---|
| **W1 — Widget MVP** | ✅ done — **released in 0.3.4** | shell + UI landed; static export emits `widget.html` (resolver's first fallback). |
| **W1.5 — Interface mode choice** | ✅ done — released in 0.3.4 | `uiMode` setting ("window" \| "widget", null = unasked): first-run chooser dialog (widget carries an **Experimental** badge; Esc = keep window) + Preferences "Interface" radio; both hotkeys work in both modes. Widget-mode boot: main stays in tray, widget shows pinned, no focus steal on `--autostarted` launches; mode-aware single-instance raise (fixes the W4 note). Widget denylisted from window-state plugin (its restore would re-show/resize the bar); VISIBLE flag dropped app-wide (launch surface is now uiMode's call); widget position hand-persisted (`widgetPos`). |
| **W2 — Vault-explorer window** | ✅ done | `app/explorer/page.tsx` mounts the shared FileExplorer (license-gated, focus re-check) in a lazily-created decorated `explorer` window that REALLY closes (label-aware CloseRequested); widget 📁 rewired from open-folder to `open_explorer`; `ServerPort` state lets no-bundle dev mode build the window's loopback URL; capability `default` covers main+explorer; static export emits `explorer.html`. |
| **Windows summon fix** | ✅ done | 0.3.4's bar self-dismissed on Windows: wry hands focus to the WebView2 child on activation → parent `WM_KILLFOCUS` → tao `Focused(false)` → literal hide-on-blur killed the summon. Now `WidgetFocusEpoch` defers the hide 150 ms and any focus edge (incl. the runtime-synthesized webview `Focused(true)`) cancels it. Toggling also minimizes a visible main window first — the bar replaces the window as the surface in charge. |
| **W2.5 — Inline answers** | ✅ done | The ask row / Ctrl+Enter now streams the answer INSIDE the pill: compact markdown panel + citation chips + Stop/copy, follow-ups carry capped history, "Continue in Lighthouse" escalates to the full app (the old hand-off). `widget_hold` keeps blur from dismissing an open answer (the "frozen on the desktop" behavior — Esc ladder: clear answer → hide bar); window clamp 56–520. |
| **W3 — Whisper mode (tap Ctrl+Super+Shift)** | ✅ done (all backends) | `whisper.rs`, one TAP state machine on three backends: Windows WH_KEYBOARD_LL hook, macOS NSEvent global monitor + Accessibility consent (`AXIsProcessTrustedWithOptions` prompt, poll-until-granted, `whisperPermission` surfaced to Preferences), X11 passive XInput2 raw events (Wayland refused, keyed chord remains). Dirty-chord suppression so the keyed shortcut and OS combos never double-fire. Opt-in `whisperMode`, live start/stop. Custom keyed **summon-shortcut recorder** in Preferences: `summonShortcut` setting, validated shell-side (parse before persist) and re-registered live via `register_summon_shortcut`; `summonHotkeyOk` drives honest copy. macOS + X11 legs cross-checked against their targets. |
| **W4 — Polish & launch** | ✅ done | Cursor-monitor summon placement (bar appears on the screen the pointer is on when its saved spot is elsewhere); per-summon entry animation (reduced-motion aware); one-time "press {hotkey} anywhere" first-run hint; the first-run chooser now carries the launch-at-login consent checkbox (resolves the unreachable-StartupPrompt review finding); `docs/launch-copy.md` marketing draft. Remaining nit: the dev-only no-bundle explorer URL/token path (harmless in shipped IPC builds). |

### W1 task breakdown
1. **Rust shell** — hidden `widget` window created at setup
   (`WebviewWindowBuilder`, decorations off, always-on-top, skip-taskbar,
   560×56, `WebviewUrl::App("widget")`); label-aware `CloseRequested`
   (widget hides) and `Focused(false)` → hide-unless-pinned; summon re-centers
   when off-screen; tray gains "Show search bar".
2. **Rust commands** (app commands need no ACL — verified):
   `widget_hide`, `widget_set_pin{pinned}` (stores pin in managed state +
   `set_always_on_top`), `widget_resize{height}` (dropdown growth without
   window-API permissions), `show_main{seedQuestion?}` (raise main + emit
   `ask-question` to the main webview), `open_vault_dir` (W1 placeholder for
   the 📁 button; W2 rewires it to the explorer window).
3. **Hotkey Tier 1** — new dep `tauri-plugin-global-shortcut`, register
   `Ctrl+Super+Shift+Space` at setup (SUPER≡Cmd on macOS → ⌃⇧⌘Space);
   handler toggles the widget; registration failure logged, never fatal
   (Wayland = expected no-op; tray summon is the fallback).
4. **Capabilities** — `capabilities/widget.json`: `windows:["widget"]`,
   `core:default` (event listen) + `core:window:allow-start-dragging`
   (frameless drag). Everything else rides app commands.
5. **UI** — `app/widget/page.tsx` (static export emits `widget/index.html`;
   providers/theme/IPC free via root layout): opaque rounded pill, input +
   📌/📁/✕, results = client-side name matches over the cached tree
   (1-char instant, "hidden from AI" badge) + debounced `op:"search"`
   passages; ↑/↓/Enter keyboard nav; Enter opens file (`/api/open`);
   Ctrl/Cmd+Enter or "Ask Lighthouse →" row = `show_main` with the query;
   Esc hides; license-locked state disables search with an unlock link.
6. **Shared hook** — extract AppShell's load/poll/`lighthouse:vault-changed`
   effect into `src/shell/useVaultTree.ts`; widget mounts it WITHOUT
   usage-capture/launch-ping/global-shortcut singletons.
7. **Chat seed** — transport re-broadcasts the `ask-question` event as
   `lighthouse:ask-question`; ChatPanel listener fills the composer and
   auto-asks (prefills only if a stream is already running).
8. **Verify** — tsc/lint/tests; static export contains `widget/index.html`;
   Playwright over the exported widget page (search, keyboard nav, locked
   state, ask hand-off event); `cargo check` + suites.

### W1 frozen contract (UI ↔ shell)
- Commands: `widget_hide()`, `widget_set_pin{pinned:bool}`,
  `widget_resize{height:f64}`, `show_main{seedQuestion?:string}`,
  `open_vault_dir()`.
- Events: Rust emits `ask-question {question}` to the main window; the
  transport re-broadcasts DOM `lighthouse:ask-question`; widget listens to
  the existing `lighthouse:vault-changed` for freshness.
- Widget window label: `widget`; route `/widget`; logical size 560×56
  collapsed, height driven by `widget_resize` up to 420.
