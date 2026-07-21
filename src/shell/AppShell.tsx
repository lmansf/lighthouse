"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Text, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { ArrowLeftRegular } from "@fluentui/react-icons";
import { Sidebar } from "./Sidebar";
import { LAYOUT } from "./theme";
import { usePaneLayout, type CompactTab } from "./paneLayout";
import { CompactTabBar, TAB_BAR_CONTENT_HEIGHT } from "./CompactTabBar";
import { useVaultTree } from "./useVaultTree";
import { anySheetOpen, useAnySheetOpen } from "./Sheet";
import { useChatStore } from "@/stores/useChatStore";
import { INSPECT_FILE_EVENT } from "@/lib/citePreview";
import { StartupPrompt } from "@/features/startup/StartupPrompt";
import { SettingsPage } from "@/features/settings/SettingsPage";

const useStyles = makeStyles({
  root: {
    display: "flex",
    // 100dvh tracks the shrinking/growing mobile toolbar; 100vh is the desktop
    // fallback (array = both declarations, dvh wins where supported).
    height: ["100vh", "100dvh"],
    // width:100vw ignores the scrollbar/safe-area and overflows horizontally on
    // touch; 100% fills the flex/body box instead. Children own their widths.
    width: "100%",
    // Clear notches / the iPad home indicator. env() insets are 0 on desktop,
    // so this is a no-op there (vars defined in app/globals.css :root).
    paddingTop: "var(--lh-safe-top)",
    paddingRight: "var(--lh-safe-right)",
    paddingBottom: "var(--lh-safe-bottom)",
    paddingLeft: "var(--lh-safe-left)",
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
  },
  main: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  // The resize divider (openspec: add-usability-field-patch §1). It straddles
  // the sidebar/main seam via symmetric negative margins, so it takes no net
  // layout width — it's a grab strip sitting on the border, not a column. The
  // visible hairline is a centered ::after that lights up on hover/focus/drag.
  handle: {
    flexShrink: 0,
    alignSelf: "stretch",
    width: "8px",
    marginLeft: "-4px",
    marginRight: "-4px",
    position: "relative",
    zIndex: 2,
    cursor: "col-resize",
    // No default focus ring — the ::after hairline is the focus affordance.
    outlineStyle: "none",
    touchAction: "none", // pointer drag owns the gesture; don't scroll/zoom
    "::after": {
      content: '""',
      position: "absolute",
      top: 0,
      bottom: 0,
      left: "50%",
      width: "2px",
      transform: "translateX(-50%)",
      backgroundColor: "transparent",
      transitionProperty: "background-color",
      transitionDuration: tokens.durationFast,
      transitionTimingFunction: tokens.curveEasyEase,
      "@media (prefers-reduced-motion: reduce)": { transitionDuration: "0.01ms" },
    },
    ":hover::after": { backgroundColor: tokens.colorNeutralStroke1 },
    ":focus-visible::after": { backgroundColor: tokens.colorBrandStroke1 },
  },
  // While dragging, keep the hairline lit even as the cursor leaves the strip.
  handleActive: { "::after": { backgroundColor: tokens.colorBrandStroke1 } },
  // --- fp3 §3 compact files PAGE (mobile shells < 700px only — paneLayout) ---
  // The files sidebar is a FULL-SCREEN page that slides in from the left edge
  // over the chat — no scrim, no 85vw overlay (the phone/compact-iPad has no
  // room for a partial column). Same inset:0 safe-area sheet primitive the
  // Sheet primitive uses (src/shell/Sheet.tsx). The Sidebar inside reads
  // --sidebar-w:100% so it fills the page; its persisted desktop width is never
  // applied here (and, with no resize handle, never written).
  page: {
    position: "fixed",
    inset: 0,
    zIndex: 21,
    display: "flex",
    backgroundColor: tokens.colorNeutralBackground2,
    paddingTop: "var(--lh-safe-top)",
    // fp4 §3: reserve room for the fixed bottom tab bar (which sits above this
    // page at z 40) on top of the home-indicator inset, so the page's own footer
    // (settings gear / rail bottom) is never hidden behind it. --lh-tabbar-h is 0
    // whenever the bar is hidden (keyboard up) or absent, collapsing to just safe.
    paddingBottom: "calc(var(--lh-safe-bottom, 0px) + var(--lh-tabbar-h, 0px))",
    paddingLeft: "var(--lh-safe-left)",
    paddingRight: "var(--lh-safe-right)",
    // Slide-in from the left edge; prefers-reduced-motion falls back to a fade.
    transitionProperty: "transform, opacity",
    transitionDuration: tokens.durationSlow,
    transitionTimingFunction: tokens.curveEasyEase,
    "@media (prefers-reduced-motion: reduce)": {
      transitionProperty: "opacity",
      transitionDuration: "0.01ms",
    },
  },
  // Pre-entrance: parked one screen to the left (reduced-motion: just faded);
  // cleared on the next frame so the page eases in.
  pageEntering: {
    transform: "translateX(-100%)",
    opacity: 0,
    "@media (prefers-reduced-motion: reduce)": { transform: "none" },
  },
  // --- 0.13.10 §2 compact SETTINGS page (mobile shells only) ----------------
  // The Settings tab opens Settings as its own full-screen page (a peer of the
  // files page). Its chrome mirrors the files page: a header row with the title
  // + a 44pt Back-to-chat control, and a scrollable body holding the grouped
  // settings page (src/features/settings/SettingsPage).
  pagePane: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
  },
  pageHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalS,
    height: `${LAYOUT.headerHeight}px`,
    flexShrink: 0,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: tokens.colorNeutralStroke2,
  },
  pageBody: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalS,
  },
  // The page's 44pt Back control (mirrors the Sidebar's fp3 §3 backBtn).
  backBtn: { minWidth: "44px", minHeight: "44px" },
});

interface AppShellProps {
  /** The collapsible left sidebar — the file explorer. */
  sidebar: React.ReactNode;
  /** The primary workspace, front and center — the chat panel. */
  main: React.ReactNode;
}

/** Remembered across launches, like the theme — a rail user shouldn't have to
 *  re-collapse the sidebar every single time they open the app. */
const SIDEBAR_COLLAPSED_KEY = "lighthouse.sidebar.collapsed";

/**
 * The resizable-explorer width cache (openspec: add-usability-field-patch §1) —
 * a per-window-mode map `{window?, widget?}` mirroring the settings-file shape,
 * so a "window" width never clobbers a "widget" one. localStorage gives instant
 * hydration on reload (before the async /api/settings read resolves) and lets
 * the WEB build's E2E prove resize→reload persistence without the desktop-only
 * settings file. The engine remains the source of truth on desktop.
 */
const EXPLORER_WIDTH_KEY = "lighthouse.explorer.width";
type UiMode = "window" | "widget";

function readWidthCache(): { window?: number; widget?: number } {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(EXPLORER_WIDTH_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

const clampWidth = (w: number): number =>
  Math.min(LAYOUT.sidebarMaxWidth, Math.max(LAYOUT.sidebarMinWidth, Math.round(w)));

/**
 * The application frame: a collapsible file sidebar + a front-and-center
 * workspace (chat). Owned by the shell team. It also kicks the one-time RAG
 * data load so every feature sees populated stores on first paint.
 */
export function AppShell({ sidebar, main }: AppShellProps) {
  const styles = useStyles();
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });

  // --- §5 compact layout (mobile shells < 700px — see paneLayout.ts) --------
  // On desktop `layout.compact` is false at every window width (the verdict's
  // structural pin), so everything below the drawer effects renders the exact
  // pre-§5 tree there.
  // fp4 §3: the compact bottom tab bar's selected destination is THE compact nav
  // state — "chat" (home / the ask surface), "files" (the fp3 §3 files page), or
  // "sections" (the section rail as a full page). It subsumes the old boolean
  // drawerOpen: files-open === tab "files", so paneLayout's drawerVisible still
  // means "the files page is on screen".
  const [compactTab, setCompactTab] = useState<CompactTab>("chat");
  const layout = usePaneLayout(compactTab === "files");
  // A Sheet (History, the investigation picker, …) is a modal over everything —
  // while one is open the tab bar slides away and the sheet's own X/Esc dismiss
  // it (returning to whichever page launched it). 0.13.10 §3: the signal is the
  // Sheet primitive's mount counter, not the retired flyout store.
  const sheetOpen = useAnySheetOpen();
  // Live mirror for the [] -mounted listeners below (shortcuts, reveal).
  const compactRef = useRef(layout.compact);
  compactRef.current = layout.compact;

  // Open requests come from the Files tab (and the Ctrl/Cmd+B shortcut). The
  // lone chat-header "open files and sections" button is gone (fp4 §3) — the tab
  // bar is the way in now — but the event it dispatched is still honored.
  useEffect(() => {
    const onOpen = () => setCompactTab("files");
    window.addEventListener("lighthouse:open-drawer", onOpen);
    return () => window.removeEventListener("lighthouse:open-drawer", onOpen);
  }, []);

  // Esc backs a compact page (files or settings) out to chat — unless a Sheet
  // is up, which owns Esc first (its capture-phase handler closes it and this
  // bubbler only fires when no sheet consumed the key).
  useEffect(() => {
    if (!layout.compact || compactTab === "chat") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (anySheetOpen()) return;
      e.preventDefault();
      setCompactTab("chat");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [layout.compact, compactTab]);

  // Auto-return: the files page yields to chat the moment its action lands —
  // a file opened into the inspector, or an ask sent (any transcript growth) —
  // which now reselects the Chat tab (fp4 §3).
  useEffect(() => {
    if (!layout.drawerVisible) return;
    const close = () => setCompactTab("chat");
    window.addEventListener(INSPECT_FILE_EVENT, close);
    return () => window.removeEventListener(INSPECT_FILE_EVENT, close);
  }, [layout.drawerVisible]);
  const messageCount = useChatStore((s) => s.messages.length);
  const prevMessageCount = useRef(messageCount);
  useEffect(() => {
    // Any compact page yields to Chat when an ask lands — Settings included
    // (its inline ViewsNav/SemanticNav can fire asks that would otherwise
    // stream invisibly under the page).
    if (messageCount > prevMessageCount.current && layout.compact && compactTab !== "chat")
      setCompactTab("chat");
    prevMessageCount.current = messageCount;
  }, [messageCount, layout.compact, compactTab]);

  // fp3 §3: edge-swipe-RIGHT on the files page goes back to chat — the iOS
  // "back" gesture, the mirror of the old swipe-left drawer dismiss. Esc is the
  // other path (there is no scrim to tap now — the page is full-screen). A plain
  // horizontal-delta check, no gesture library.
  // Shared by both compact pages (files + sections): a rightward edge swipe is
  // the iOS "back" gesture → return to chat.
  const touchStartX = useRef<number | null>(null);
  const onDrawerTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0]?.clientX ?? null;
  };
  const onDrawerTouchEnd = (e: React.TouchEvent) => {
    const start = touchStartX.current;
    touchStartX.current = null;
    const end = e.changedTouches[0]?.clientX;
    if (start != null && typeof end === "number" && end - start > 40) setCompactTab("chat");
  };

  // fp3 §3: page-entrance animation — mount parked off-screen-left, then clear
  // on the next frame so it eases in (mirrors the Sheet primitive's entrance).
  const [pageEntered, setPageEntered] = useState(false);
  useEffect(() => {
    if (!layout.drawerVisible) {
      setPageEntered(false);
      return;
    }
    const r = requestAnimationFrame(() => setPageEntered(true));
    return () => cancelAnimationFrame(r);
  }, [layout.drawerVisible]);

  // 0.13.10 §2: the Settings page shares the files page's slide-in entrance.
  const settingsVisible = layout.compact && compactTab === "settings";
  const settingsScrollRef = useRef<HTMLDivElement>(null);
  const [settingsEntered, setSettingsEntered] = useState(false);
  useEffect(() => {
    if (!settingsVisible) {
      setSettingsEntered(false);
      return;
    }
    const r = requestAnimationFrame(() => setSettingsEntered(true));
    return () => cancelAnimationFrame(r);
  }, [settingsVisible]);

  // 0.13.10 §2: "open preferences" routes to the Settings PAGE on compact (the
  // desktop gear menu keeps opening its dialog — SettingsMenu listens there).
  useEffect(() => {
    const onPrefs = () => {
      if (compactRef.current) setCompactTab("settings");
    };
    window.addEventListener("lighthouse:open-preferences", onPrefs);
    return () => window.removeEventListener("lighthouse:open-preferences", onPrefs);
  }, []);

  // Ask box vs the on-screen keyboard: the OS keyboard overlays a WKWebView
  // rather than resizing it, so pad the main column by the covered height
  // (visualViewport). Compact-only; 0 on desktop and whenever it's closed.
  const [keyboardInset, setKeyboardInset] = useState(0);
  useEffect(() => {
    if (!layout.compact || typeof window === "undefined" || !window.visualViewport) return;
    const vv = window.visualViewport;
    const update = () =>
      setKeyboardInset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)));
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      setKeyboardInset(0);
    };
  }, [layout.compact]);

  // Tauri's iOS WKWebView RESIZES for the keyboard instead of overlaying it
  // (the Safari behavior the inset math above assumes): innerHeight shrinks
  // WITH the visual viewport, the inset computes 0, and the tab bar kept
  // floating mid-screen under the keyboard's accessory bar (0.13.9 field
  // screenshot). Editable focus is the resize-proof keyboard signal — on a
  // compact touch shell a focused text field means the keyboard owns the
  // bottom edge, in either webview mode.
  const [editableFocused, setEditableFocused] = useState(false);
  useEffect(() => {
    if (!layout.compact || typeof document === "undefined") return;
    const editable = (t: unknown): boolean =>
      t instanceof HTMLElement &&
      (t instanceof HTMLTextAreaElement ||
        (t instanceof HTMLInputElement &&
          !["button", "checkbox", "radio", "range", "submit", "reset", "file", "color"].includes(
            t.type,
          )) ||
        t.isContentEditable);
    const onFocusIn = (e: FocusEvent) => {
      if (editable(e.target)) setEditableFocused(true);
    };
    const onFocusOut = () => {
      // The next focus target isn't set yet during focusout; read it after
      // the move settles so field-to-field hops don't flicker the bar.
      requestAnimationFrame(() => setEditableFocused(editable(document.activeElement)));
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    setEditableFocused(editable(document.activeElement));
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      setEditableFocused(false);
    };
  }, [layout.compact]);

  // iOS also scroll-wedges the page to "reveal" the focused field: the
  // WKScrollView keeps a leftover offset afterwards and the whole fixed shell
  // renders shifted up under the status bar (the 0.13.9 crowding screenshot).
  // The compact shell never scrolls the document itself, so ANY document
  // scroll is the wedge — push it straight back.
  useEffect(() => {
    if (!layout.compact || typeof window === "undefined") return;
    const unwedge = () => {
      if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
    };
    window.addEventListener("scroll", unwedge, { passive: true });
    window.visualViewport?.addEventListener("resize", unwedge);
    unwedge();
    return () => {
      window.removeEventListener("scroll", unwedge);
      window.visualViewport?.removeEventListener("resize", unwedge);
    };
  }, [layout.compact]);

  // fp4 §3: the tab bar slides away while the keyboard is up (so it never floats
  // mid-screen) or while a modal section sheet covers the screen; it's on screen
  // exactly when compact, keyboard down, no sheet. The keyboard is "up" when
  // the overlay inset says so OR an editable element holds focus (the
  // resize-mode signal above).
  const tabBarHidden = keyboardInset > 0 || editableFocused || sheetOpen;
  const tabBarShown = layout.showTabBar && !tabBarHidden;
  // Reserve room above the bar for the composer, the files/sections pages, and
  // the bug FAB. --lh-tabbar-h is the bar's content height while it's shown, else
  // 0. It lives on the document root so it also cascades to the FAB, which mounts
  // as a sibling of AppShell (outside this subtree). Desktop never shows the bar,
  // so the var stays 0 there and every `var(--lh-tabbar-h, 0px)` consumer is a
  // no-op — the desktop tree is byte-for-byte unchanged.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const el = document.documentElement;
    el.style.setProperty("--lh-tabbar-h", tabBarShown ? `${TAB_BAR_CONTENT_HEIGHT}px` : "0px");
    return () => el.style.setProperty("--lh-tabbar-h", "0px");
  }, [tabBarShown]);

  // fp4 §3: tapping the already-active tab scrolls that surface to top (the iOS
  // convention). Chat + the files explorer own their own scroll containers, so
  // they listen for a nudge event; the sections page scroll is owned here.
  const handleTabSelect = (tab: CompactTab) => {
    if (tab === compactTab) {
      if (tab === "chat") window.dispatchEvent(new CustomEvent("lighthouse:chat-scroll-top"));
      else if (tab === "files") window.dispatchEvent(new CustomEvent("lighthouse:explorer-scroll-top"));
      else settingsScrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
      return;
    }
    setCompactTab(tab);
  };

  // Persist the collapsed choice so it survives a relaunch.
  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      /* storage blocked — the in-session state still works */
    }
  }, [collapsed]);

  // --- Resizable explorer (openspec: add-usability-field-patch §1) ---------
  // The uiMode keys persistence; it stays "window" on the web build and until
  // /api/settings answers on desktop. Width hydrates synchronously from the
  // "window" cache so first paint doesn't flash, then reconciles once the mode
  // + settings-file value are known.
  const [mode, setMode] = useState<UiMode>("window");
  const [width, setWidthState] = useState<number>(() => {
    const cached = readWidthCache().window;
    return clampWidth(typeof cached === "number" ? cached : LAYOUT.sidebarWidth);
  });
  const [resizing, setResizing] = useState(false);
  // widthRef mirrors width so pointer/keyboard handlers read the live value
  // without re-subscribing; setWidth keeps the two in lockstep.
  const widthRef = useRef(width);
  const setWidth = useCallback((w: number) => {
    const c = clampWidth(w);
    widthRef.current = c;
    setWidthState(c);
  }, []);

  // Persist a committed width: localStorage immediately (instant hydration +
  // web E2E), the settings file via /api/settings on a short debounce (a 400 on
  // the web build is expected and ignored). Keyed by the current mode.
  const postTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistWidth = useCallback(
    (w: number) => {
      const c = clampWidth(w);
      try {
        const cache = readWidthCache();
        cache[mode] = c;
        window.localStorage.setItem(EXPLORER_WIDTH_KEY, JSON.stringify(cache));
      } catch {
        /* storage blocked — the in-session width still works */
      }
      if (postTimer.current) clearTimeout(postTimer.current);
      postTimer.current = setTimeout(() => {
        void fetch("/api/settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ explorerWidth: { mode, width: c } }),
        }).catch(() => {
          /* desktop-only endpoint; the web build 400s — the cache is enough */
        });
      }, 400);
    },
    [mode],
  );

  // On mount, learn the real uiMode and the settings-file width (desktop). The
  // settings value wins over the local cache; both fall back to the default.
  useEffect(() => {
    let alive = true;
    void fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d) return;
        const m: UiMode = d.uiMode === "widget" ? "widget" : "window";
        setMode(m);
        const server = d?.explorerWidth?.[m];
        const cached = readWidthCache()[m];
        if (typeof server === "number") setWidth(server);
        else if (typeof cached === "number") setWidth(cached);
        else setWidth(LAYOUT.sidebarWidth);
        // (0.13.10 §3: the section-flyout hydrate is gone with the flyout —
        // the engine's flyoutWidth/openFlyout settings fields remain, simply
        // unread by this UI.)
      })
      .catch(() => {
        /* offline / web build — the synchronous cache hydration stands */
      });
    return () => {
      alive = false;
    };
  }, [setWidth]);

  // Pointer drag: capture the pointer on the handle so moves keep arriving even
  // as the cursor races past other elements; commit (persist) on release.
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const onHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (collapsed) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture unsupported — the move listener still tracks within the strip */
    }
    dragRef.current = { startX: e.clientX, startW: widthRef.current };
    setResizing(true);
  };
  const onHandlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    setWidth(d.startW + (e.clientX - d.startX));
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setResizing(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* nothing captured */
    }
    persistWidth(widthRef.current);
  };

  // Double-click the handle → auto-fit to the widest visible row name. The
  // explorer owns the measurement (canvas text metrics on its windowed rows);
  // it replies on the result event with an absolute width, which we clamp.
  const requestAutoFit = () => {
    if (collapsed) return;
    window.dispatchEvent(
      new CustomEvent("lighthouse:explorer-autofit", { detail: { width: widthRef.current } }),
    );
  };
  useEffect(() => {
    const onResult = (e: Event) => {
      const w = (e as CustomEvent<{ width?: number }>).detail?.width;
      if (typeof w === "number" && Number.isFinite(w)) {
        setWidth(w);
        persistWidth(widthRef.current);
      }
    };
    window.addEventListener("lighthouse:explorer-autofit-result", onResult);
    return () => window.removeEventListener("lighthouse:explorer-autofit-result", onResult);
  }, [setWidth, persistWidth]);

  // Keyboard resize when the handle is focused — the ARIA window-splitter
  // pattern: arrows nudge, Home/End jump to the bounds, Enter auto-fits.
  const onHandleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (collapsed) return;
    const STEP = 24;
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = widthRef.current - STEP;
    else if (e.key === "ArrowRight") next = widthRef.current + STEP;
    else if (e.key === "Home") next = LAYOUT.sidebarMinWidth;
    else if (e.key === "End") next = LAYOUT.sidebarMaxWidth;
    else if (e.key === "Enter") {
      e.preventDefault();
      requestAutoFit();
      return;
    }
    if (next !== null) {
      e.preventDefault();
      setWidth(next);
      persistWidth(widthRef.current);
    }
  };

  // One-time RAG data load + poll/push freshness (shared with the desktop
  // widget window via the hook — see src/shell/useVaultTree.ts).
  useVaultTree();

  // Global keyboard shortcuts (documented in the Quick start guide):
  // Ctrl/Cmd+N — new chat · Ctrl/Cmd+B — toggle the file sidebar ·
  // Ctrl/Cmd+P — quick-open a file · Ctrl/Cmd+, — open Preferences. Features
  // receive them as CustomEvents so the shell stays decoupled from feature
  // internals. AppShell mounts only in the MAIN window, so none of these fire
  // in the widget or standalone-explorer windows.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      const fire = (name: string) => {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent(name));
      };
      if (e.key === "n" || e.key === "N") fire("lighthouse:new-chat");
      else if (e.key === "b" || e.key === "B") {
        e.preventDefault();
        // §5/fp4 §3: in the compact arrangement B toggles the Files tab/page.
        if (compactRef.current) setCompactTab((t) => (t === "files" ? "chat" : "files"));
        else setCollapsed((c) => !c);
      } else if (e.key === "p" || e.key === "P") {
        // preventDefault deliberately shadows the browser's Print in the web
        // twin — inside the app, Ctrl/Cmd+P is the file finder.
        fire("lighthouse:quick-open");
      } else if (e.key === ",") fire("lighthouse:open-preferences");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Quick-open's Enter reveals a file in the sidebar explorer — make sure the
  // sidebar is actually open when that happens (a collapsed rail hides the
  // tree; the explorer itself stays mounted and handles the scroll + flash).
  useEffect(() => {
    const onReveal = () => {
      // §5/fp4 §3: compact has no collapsed rail — revealing selects the Files tab.
      if (compactRef.current) setCompactTab("files");
      else setCollapsed(false);
    };
    window.addEventListener("lighthouse:reveal-node", onReveal);
    return () => window.removeEventListener("lighthouse:reveal-node", onReveal);
  }, []);

  if (layout.compact) {
    // fp3 §3 compact arrangement: the chat pane IS the screen. The sidebar is a
    // full-screen PAGE that slides in from the left edge (no scrim, no overlay;
    // Esc / edge-swipe-right / the header Back control dismiss it; auto-closes
    // when a file opens or an ask is sent), sections are full-width sheets, and
    // none of the resize machinery exists — the persisted explorerWidth is
    // neither applied (the page is viewport-sized) nor ever written (no handle).
    // This branch is unreachable on the desktop platform at any width
    // (paneLayout's structural pin), so the return below stays the desktop tree.
    return (
      <main className={styles.root}>
        {layout.drawerVisible && (
          <div
            className={mergeClasses(styles.page, !pageEntered && styles.pageEntering)}
            role="dialog"
            aria-modal="true"
            aria-label="Files"
            // The Sidebar reads --sidebar-w for its width; 100% fills the page
            // instead of any remembered desktop width.
            style={{ "--sidebar-w": "100%" } as React.CSSProperties}
            onTouchStart={onDrawerTouchStart}
            onTouchEnd={onDrawerTouchEnd}
          >
            <Sidebar
              collapsed={false}
              // The header control is the page's 44pt Back-to-chat button (§3).
              backControl
              onToggleCollapsed={() => setCompactTab("chat")}
            >
              {sidebar}
            </Sidebar>
          </div>
        )}
        {/* 0.13.10 §2: the Settings tab opens Settings as its own full page —
            the grouped reorganization of the desktop gear menu's content. */}
        {settingsVisible && (
          <div
            className={mergeClasses(styles.page, !settingsEntered && styles.pageEntering)}
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
            onTouchStart={onDrawerTouchStart}
            onTouchEnd={onDrawerTouchEnd}
          >
            <div className={styles.pagePane}>
              <div className={styles.pageHeader}>
                <Text weight="semibold">Settings</Text>
                <Button
                  appearance="subtle"
                  className={styles.backBtn}
                  icon={<ArrowLeftRegular />}
                  aria-label="Back to chat"
                  onClick={() => setCompactTab("chat")}
                >
                  Back
                </Button>
              </div>
              <div className={styles.pageBody} ref={settingsScrollRef}>
                <SettingsPage />
              </div>
            </div>
          </div>
        )}
        <div
          className={styles.main}
          // Reflow above the fixed tab bar: reserve its height when the keyboard
          // is down; when the keyboard is up the bar hides, so pad by the covered
          // height instead (they're mutually exclusive).
          style={{ paddingBottom: keyboardInset ? `${keyboardInset}px` : "var(--lh-tabbar-h, 0px)" }}
        >
          {main}
        </div>
        {/* fp4 §3: THE compact navigation. Hidden while the keyboard is up or a
            modal section sheet is open; desktop/iPad-regular never reach here. */}
        <CompactTabBar active={compactTab} onSelect={handleTabSelect} hidden={tabBarHidden} />
        <StartupPrompt />
      </main>
    );
  }

  return (
    <main className={styles.root}>
      <Sidebar
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((c) => !c)}
        width={width}
        resizing={resizing}
      >
        {sidebar}
      </Sidebar>
      {/* The resize divider only exists while the sidebar is expanded — there's
          nothing to resize in the thin collapsed rail. */}
      {!collapsed && (
        <div
          className={mergeClasses(styles.handle, resizing && styles.handleActive)}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize file sidebar (drag, or use arrow keys)"
          aria-valuemin={LAYOUT.sidebarMinWidth}
          aria-valuemax={LAYOUT.sidebarMaxWidth}
          aria-valuenow={width}
          tabIndex={0}
          onPointerDown={onHandlePointerDown}
          onPointerMove={onHandlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={requestAutoFit}
          onKeyDown={onHandleKeyDown}
        />
      )}
      <div className={styles.main}>{main}</div>
      <StartupPrompt />
    </main>
  );
}
