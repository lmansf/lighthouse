"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Text, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { LAYOUT } from "./theme";
import { usePaneLayout, type CompactTab } from "./paneLayout";
import {
  compactPageLayers,
  isCompactPageTab,
  PAGE_SLIDE_MS,
  PAGE_SLIDE_SLACK_MS,
  type CompactPageLayer,
} from "./compactTransition";
import { CompactTabBar, TAB_BAR_CONTENT_HEIGHT, TAB_BAR_FLOAT_GAP } from "./CompactTabBar";
import { publishShellUi, USER_ASK_EVENT } from "./shellSignals";
import { START_TOUR_EVENT } from "@/features/help/FirstRunTour";
import { anySheetOpen, useAnySheetOpen } from "./Sheet";
import { StartupPrompt } from "@/features/startup/StartupPrompt";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { ReportsHome } from "@/features/chat/ReportsHome";

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
  // --- fp3 §3 compact PAGE (mobile shells < 700px only — paneLayout) ---------
  // Reports and Settings are FULL-SCREEN pages that slide in over the chat —
  // no scrim, no partial overlay (the phone/compact-iPad has no room for one).
  // Same inset:0 safe-area primitive src/shell/Sheet.tsx uses.
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
  // §43 §3: the exit target — mirrors pageEntering. A page yielding to Chat is
  // at rest (translateX 0) and gets this on the switch, so it slides back out to
  // the left (reduced-motion: cross-fades out) revealing the Chat base beneath,
  // then unmounts once the slide ends.
  pageExiting: {
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
  // §31 §5: the Settings page floats its group cards on the grouped canvas.
  pageBodyGrouped: { backgroundColor: "var(--lh-bg-grouped)" },
  pageBody: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalS,
  },
});

interface AppShellProps {
  /** The primary workspace, front and center — the chat panel. */
  main: React.ReactNode;
}

/**
 * The application frame: one front-and-center workspace (chat), with Reports
 * and Settings as compact pages beside it. The collapsible, resizable file
 * sidebar it used to carry went with the vault in 0.15.0 — a conversation's
 * files are its attachments, and the composer's attachment bar shows them.
 */
export function AppShell({ main }: AppShellProps) {
  const styles = useStyles();
  // --- §5 compact layout (mobile shells < 700px — see paneLayout.ts) --------
  // On desktop `layout.compact` is false at every window width (the verdict's
  // structural pin), so everything below the drawer effects renders the exact
  // pre-§5 tree there.
  // fp4 §3: the compact bottom tab bar's selected destination is THE compact
  // nav state — "chat" (home / the ask surface), "reports", or "settings". The
  // "files" page went with the vault in 0.15.0: a conversation's files are its
  // attachments, shown in the composer's own attachment bar.
  const [compactTab, setCompactTab] = useState<CompactTab>("chat");
  const layout = usePaneLayout();
  // A Sheet (History, the investigation picker, …) is a modal over everything —
  // while one is open the tab bar slides away and the sheet's own X/Esc dismiss
  // it (returning to whichever page launched it). 0.13.10 §3: the signal is the
  // Sheet primitive's mount counter, not the retired flyout store.
  const sheetOpen = useAnySheetOpen();
  // Live mirror for the [] -mounted listeners below (shortcuts, reveal).
  const compactRef = useRef(layout.compact);
  compactRef.current = layout.compact;

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

  // §34 §1b: any compact page yields to Chat when the USER asks. The signal is
  // ChatPanel's explicit
  // ask-intent event, never an observation of the message list — so a
  // store-level append (hydration, background work, future features) can
  // never switch tabs out from under a reading user.
  useEffect(() => {
    const onUserAsk = () => {
      if (compactRef.current) setCompactTab("chat");
    };
    window.addEventListener(USER_ASK_EVENT, onUserAsk);
    return () => window.removeEventListener(USER_ASK_EVENT, onUserAsk);
  }, []);

  // §43 §3: the compact page transition. `compactTab` is the destination; the
  // OUTGOING page stays mounted for the slide so the Chat base never flashes
  // between two pages (Files→Settings shows Files beneath), and a page yielding
  // to Chat slides OUT instead of vanishing. compactPageLayers
  // (src/shell/compactTransition) is the pure verdict for WHAT mounts and HOW;
  // the state below wires it to React's frame timing:
  //   - `leavingTab` is the tab we're sliding away from (kept mounted), null
  //     once settled;
  //   - `prevTab` mirrors the destination so the transition begins DURING render
  //     (React's adjust-state-on-change pattern) — the outgoing page lands in
  //     the SAME commit as the switch and never blinks out first;
  //   - `pageEntered` releases the parked incoming page on the next frame so it
  //     eases in (the fp3 §3 mechanic, now shared by both pages).
  const settingsScrollRef = useRef<HTMLDivElement>(null);
  const reportsScrollRef = useRef<HTMLDivElement>(null);
  const [leavingTab, setLeavingTab] = useState<CompactTab | null>(null);
  const [prevTab, setPrevTab] = useState<CompactTab>(compactTab);
  const [pageEntered, setPageEntered] = useState(true);
  if (compactTab !== prevTab) {
    setPrevTab(compactTab);
    if (layout.compact) {
      setLeavingTab(prevTab);
      // Into a page → park it off-left (the release effect eases it in); into
      // chat → nothing to park, the outgoing page slides OUT instead.
      setPageEntered(!isCompactPageTab(compactTab));
    } else {
      // Desktop / iPad-regular has no compact pages — never animate.
      setLeavingTab(null);
      setPageEntered(true);
    }
  }
  // Release the parked incoming page one frame after it mounts so it slides in.
  useEffect(() => {
    if (pageEntered) return;
    const r = requestAnimationFrame(() => setPageEntered(true));
    return () => cancelAnimationFrame(r);
  }, [pageEntered]);
  // End the slide: transitionend on the animating page wins (onPageSettled
  // below); this timeout is the fallback so a dropped event can't strand the
  // outgoing page mounted forever.
  useEffect(() => {
    if (leavingTab === null) return;
    const t = setTimeout(() => setLeavingTab(null), PAGE_SLIDE_MS + PAGE_SLIDE_SLACK_MS);
    return () => clearTimeout(t);
  }, [leavingTab]);
  // The compact page layers to mount this frame (bottom-to-top), and the class
  // for each: an unreleased `enter` layer and every `exit` layer sit parked
  // off-left; a `rest` layer is at its home position.
  const pageLayers = layout.compact ? compactPageLayers(compactTab, leavingTab) : [];
  const reportsLayer = pageLayers.find((l) => l.tab === "reports");
  const settingsLayer = pageLayers.find((l) => l.tab === "settings");
  const pageClass = (layer: CompactPageLayer) =>
    mergeClasses(
      styles.page,
      layer.phase === "enter" && !pageEntered && styles.pageEntering,
      layer.phase === "exit" && styles.pageExiting,
    );
  // A page's own slide finishing ends the transition (drops the outgoing page).
  // Guard on the page element itself so a descendant's transition never fires it.
  const onPageSettled = (e: React.TransitionEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) setLeavingTab(null);
  };

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
    el.style.setProperty("--lh-tabbar-h", tabBarShown ? `${TAB_BAR_CONTENT_HEIGHT + TAB_BAR_FLOAT_GAP}px` : "0px");
    return () => el.style.setProperty("--lh-tabbar-h", "0px");
  }, [tabBarShown]);

  // §33 §1: publish the shell signals the calm-moment surfaces gate on (the
  // feedback nudge mounts outside this subtree — see shellSignals.ts).
  useEffect(() => {
    publishShellUi({
      compact: layout.compact,
      activeTab: compactTab,
      keyboardUp: keyboardInset > 0 || editableFocused,
      // §45: the numeric inset rides alongside the boolean so ChatPanel can
      // center the last answer + composer just above the keyboard.
      keyboardInset,
    });
  }, [layout.compact, compactTab, keyboardInset, editableFocused]);

  // §33 §3: "Take the tour" replay — on compact, land on the Chat tab FIRST so
  // the tour's anchors are the mounted, unoccluded ones (the settings page
  // unmounts with the switch; sheets close with their hosts). Desktop no-op.
  useEffect(() => {
    const onStartTour = () => {
      if (compactRef.current) setCompactTab("chat");
    };
    window.addEventListener(START_TOUR_EVENT, onStartTour);
    return () => window.removeEventListener(START_TOUR_EVENT, onStartTour);
  }, []);

  // fp4 §3: tapping the already-active tab scrolls that surface to top (the iOS
  // convention). Chat + the files explorer own their own scroll containers, so
  // they listen for a nudge event; the sections page scroll is owned here.
  const handleTabSelect = (tab: CompactTab) => {
    if (tab === compactTab) {
      if (tab === "chat") window.dispatchEvent(new CustomEvent("lighthouse:chat-scroll-top"));
      else if (tab === "reports") reportsScrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
      else settingsScrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
      return;
    }
    setCompactTab(tab);
  };

  // Global keyboard shortcuts (documented in the Quick start guide):
  // Ctrl/Cmd+N — new chat · Ctrl/Cmd+, — open Preferences. Features receive
  // them as CustomEvents so the shell stays decoupled from feature internals.
  // AppShell mounts only in the MAIN window, so neither fires in the widget.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      const fire = (name: string) => {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent(name));
      };
      if (e.key === "n" || e.key === "N") fire("lighthouse:new-chat");
      else if (e.key === ",") fire("lighthouse:open-preferences");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (layout.compact) {
    // fp3 §3 compact arrangement: the chat pane IS the screen, with Reports and
    // Settings as full-screen pages that slide in (no scrim, no overlay; they
    // are TAB roots — the tab bar navigates, Esc returns to Chat for hardware
    // keyboards, and any page yields to Chat when the user asks). This branch
    // is unreachable on the desktop platform at any width (paneLayout's
    // structural pin), so the return below stays the desktop tree.
    return (
      <main className={styles.root}>
        {/* §43 §3: the compact pages are z-21 layers over the always-mounted
            Chat base. compactPageLayers decides which mount and how — the
            OUTGOING page stays put beneath the incoming during a slide (Chat
            never flashes between two pages), and a page yielding to Chat slides
            OUT (pageExiting) rather than vanishing. Each page's transitionend
            (onPageSettled) ends the slide and drops the outgoing. */}
        {/* 0.13.10 §2: the Settings tab opens Settings as its own full page —
            the grouped reorganization of the desktop gear menu's content. */}
        {settingsLayer && (
          <div
            className={pageClass(settingsLayer)}
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
            style={{ zIndex: settingsLayer.z }}
            onTransitionEnd={onPageSettled}
          >
            <div className={styles.pagePane}>
              <div className={styles.pageHeader}>
                <Text weight="semibold">Settings</Text>
              </div>
              <div className={mergeClasses(styles.pageBody, styles.pageBodyGrouped)} ref={settingsScrollRef}>
                <SettingsPage />
              </div>
            </div>
          </div>
        )}
        {/* §49 §4: the Reports home as its own full page — a peer of the files
            and settings pages, the compact face of the desktop Reports dialog.
            A row tap opens the reader (a portal dialog over this page), so the
            page stays put and the library is there when the reader closes. */}
        {reportsLayer && (
          <div
            className={pageClass(reportsLayer)}
            role="dialog"
            aria-modal="true"
            aria-label="Reports"
            style={{ zIndex: reportsLayer.z }}
            onTransitionEnd={onPageSettled}
          >
            <div className={styles.pagePane}>
              <div className={styles.pageHeader}>
                <Text weight="semibold">Reports</Text>
              </div>
              <div className={mergeClasses(styles.pageBody, styles.pageBodyGrouped)} ref={reportsScrollRef}>
                <ReportsHome />
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
      <div className={styles.main}>{main}</div>
      <StartupPrompt />
    </main>
  );
}
