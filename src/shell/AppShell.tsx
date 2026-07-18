"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { Sidebar } from "./Sidebar";
import { LAYOUT } from "./theme";
import { useVaultTree } from "./useVaultTree";
import { StartupPrompt } from "@/features/startup/StartupPrompt";

const useStyles = makeStyles({
  root: {
    display: "flex",
    height: "100vh",
    width: "100vw",
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
        setCollapsed((c) => !c);
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
    const onReveal = () => setCollapsed(false);
    window.addEventListener("lighthouse:reveal-node", onReveal);
    return () => window.removeEventListener("lighthouse:reveal-node", onReveal);
  }, []);

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
