"use client";

/**
 * [TEAM: widget] The floating desktop search pill (docs/widget-scope.md, W1).
 *
 * Rendered by app/widget/page.tsx inside the frameless, always-on-top
 * "widget" Tauri window: a single rounded pill (beacon · search input ·
 * pin/folder/dismiss), with a results dropdown that grows beneath it. Results
 * are two layers merged into one flat keyboard-navigable list: instant
 * client-side NAME matches over the cached tree (works from 1 char, covers
 * hidden files) and debounced CONTENT passages from the engine's search op,
 * capped by an "Ask Lighthouse →" hand-off row that raises the main window
 * with the query pre-seeded into chat.
 *
 * Shell commands ride the W1 frozen contract (`widget_hide`,
 * `widget_set_pin`, `widget_resize`, `show_main`, `open_vault_dir`) via
 * `invokeShell`, which no-ops outside the Tauri shell so the page still
 * renders (and is Playwright-testable) on plain web. Deliberately QUIET: no
 * usage capture, launch ping, telemetry, or nudges — this is a second webview
 * and would double-count them all (widget-scope §2.4).
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  Badge,
  Button,
  Input,
  Text,
  makeStyles,
  mergeClasses,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import {
  ChatSparkleRegular,
  CheckmarkRegular,
  CopyRegular,
  DismissRegular,
  DocumentPdfRegular,
  DocumentRegular,
  EyeOffRegular,
  EyeRegular,
  FolderOpenRegular,
  FolderRegular,
  OpenRegular,
  PinFilled,
  PinRegular,
  SquareRegular,
} from "@fluentui/react-icons";
import dynamic from "next/dynamic";
import type { ChatTurn, FileNode, RagReference } from "@/contracts";
import { chatService, ragService } from "@/contracts";
import { useRagStore } from "@/stores/useRagStore";
import { egressPillSummary } from "@/features/egress/EgressShield";
import { isDesktopShell } from "@/shell/desktopBridge";
import { useVaultTree } from "@/shell/useVaultTree";
import { ACCENTS } from "@/shell/theme";

// The markdown stack (~263 KB) only matters once an inline answer is on screen,
// never for the idle search pill — so the widget window loads it on demand
// instead of shipping it in its initial chunk. Warmed when an ask begins.
const MarkdownView = dynamic(() => import("@/shell/MarkdownView"), { ssr: false });

/** Collapsed window height — must match the Rust builder's 560×56 (contract). */
const PILL_HEIGHT = 56;
/** Hard cap for the grown window (shell clamps to the same value); results
 *  and the inline answer scroll internally beyond it. */
const MAX_WINDOW_HEIGHT = 520;
/** Client-side name matches shown at most (content passages layer under). */
const MAX_NAME_MATCHES = 6;
/** Debounce for the engine content search — fast enough to feel typeahead. */
const SEARCH_DEBOUNCE_MS = 150;
/** Conversation memory carried into follow-up asks (turns, user+assistant). */
const MAX_HISTORY_TURNS = 8;

/**
 * Invoke a shell (Rust) command from the widget page. Resolves undefined
 * outside the Tauri shell so plain-web rendering and Playwright runs of
 * /widget never throw; inside the shell a failed command is logged, never
 * fatal (a search bar must not crash over a window op).
 */
export async function invokeShell(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  if (!isDesktopShell()) return undefined;
  try {
    const core = await import("@tauri-apps/api/core");
    return await core.invoke(cmd, args);
  } catch (err) {
    console.error(`Widget shell command "${cmd}" failed`, err);
    return undefined;
  }
}

const useStyles = makeStyles({
  // The WINDOW is the pill: exactly 56px tall when collapsed, so the page
  // surface must be the pill surface — an opaque theme background rather than
  // transparency, which is compositor/MAS-hostile (widget-scope §2.3). Our own
  // shadow + radius live inside the frameless window.
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    width: "100vw",
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    boxShadow: tokens.shadow16,
    ...shorthands.borderRadius(tokens.borderRadiusXLarge),
    overflow: "hidden",
  },
  // A quick fade + scale-in replayed on every summon (window "focus"): a pure
  // flourish on top of the resting pill — it never gates the drag region or the
  // input, and the end state is the pill's normal state. transform-origin top so
  // it settles from the top edge down. Reduced motion keeps the fade, no move.
  rootEnter: {
    animationName: {
      from: { opacity: 0.6, transform: "translateY(-4px) scale(0.98)" },
      to: { opacity: 1, transform: "translateY(0) scale(1)" },
    },
    animationDuration: "140ms",
    animationTimingFunction: "ease-out",
    transformOrigin: "top center",
    "@media (prefers-reduced-motion: reduce)": {
      animationName: { from: { opacity: 0.6 }, to: { opacity: 1 } },
      transform: "none",
    },
  },
  pill: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    height: `${PILL_HEIGHT}px`,
    flexShrink: 0,
    ...shorthands.padding(0, tokens.spacingHorizontalM),
  },
  // The grip: the beacon plus breathing room, and the pill's one guaranteed
  // drag surface. The input greedily fills every free pixel of the bar, so
  // without a dedicated handle there is effectively nowhere to grab a
  // frameless window — this zone (plus any layout gaps, via the pill's
  // data-tauri-drag-region) is how the bar moves.
  grip: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "stretch",
    flexShrink: 0,
    width: "26px",
    cursor: "grab",
    ":active": { cursor: "grabbing" },
  },
  // The beacon: same blue lamp + warm gold glow as the sidebar brand — the
  // one bit of identity on an otherwise chromeless bar.
  beacon: {
    width: "10px",
    height: "10px",
    borderRadius: "50%",
    flexShrink: 0,
    backgroundColor: tokens.colorBrandBackground,
    boxShadow: `0 0 10px 2px ${ACCENTS.beam}`,
    pointerEvents: "none", // clicks land on the grip, not the dot
  },
  // Pinned-answer-changed notification dot beside the beacon; cleared when
  // the main window opens (where the full alert banner lives).
  pinAlertDot: {
    width: "7px",
    height: "7px",
    borderRadius: "50%",
    flexShrink: 0,
    backgroundColor: tokens.colorPaletteRedBackground3,
    pointerEvents: "none",
  },
  // The pill itself is the field: strip the Input's own box (border, fill,
  // focus underline) so typing feels like typing into the bar.
  input: {
    flexGrow: 1,
    minWidth: 0,
    backgroundColor: "transparent",
    "::after": { display: "none" },
  },
  iconBtn: { color: tokens.colorNeutralForeground3 },
  pinOn: { color: tokens.colorBrandForeground1 },
  dropdown: {
    ...shorthands.borderTop("1px", "solid", tokens.colorNeutralStroke2),
    overflowY: "auto",
    // Beyond the window cap the list scrolls internally instead of clipping.
    maxHeight: `${MAX_WINDOW_HEIGHT - PILL_HEIGHT}px`,
    ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalS),
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    minHeight: "34px",
    ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalS),
    borderRadius: tokens.borderRadiusMedium,
    cursor: "pointer",
  },
  rowSelected: { backgroundColor: tokens.colorNeutralBackground1Selected },
  rowIcon: { fontSize: "20px", flexShrink: 0, color: tokens.colorNeutralForeground2 },
  // Single-line labels: the window has a fixed width, so names/snippets
  // ellipsize rather than wrap (wrapping would fight the height contract).
  rowLabel: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  rowMeta: { display: "flex", flexDirection: "column", flexGrow: 1, minWidth: 0 },
  truncated: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  snippet: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: tokens.colorNeutralForeground3,
  },
  badge: { flexShrink: 0 },
  // Quick-actions on the selected result row: act without opening the window.
  rowActions: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXXS,
    flexShrink: 0,
  },
  actionBtn: { color: tokens.colorNeutralForeground3 },
  actionOn: { color: tokens.colorBrandForeground1 },
  // Trial-over note: replaces actionable results; the only affordance left is
  // raising the main window, where the lock gate lives.
  lockNote: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalS),
    color: tokens.colorNeutralForeground2,
  },
  lockText: { flexGrow: 1, minWidth: 0 },
  // Egress transparency footer (S3): a quiet one-liner at the bottom of the
  // expanded dropdown.
  egressFooter: {
    ...shorthands.borderTop("1px", "solid", tokens.colorNeutralStroke2),
    ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalS),
    color: tokens.colorNeutralForeground3,
    textAlign: "center",
  },
  // The inline answer: a compact chat turn living under the pill — the answer
  // "freezes" on the desktop (the shell holds blur-hide while it's open).
  answer: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
    ...shorthands.borderTop("1px", "solid", tokens.colorNeutralStroke2),
    ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalM),
  },
  answerHead: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
  },
  answerQ: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: tokens.colorNeutralForeground3,
  },
  answerBody: {
    overflowY: "auto",
    maxHeight: "330px",
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    wordBreak: "break-word",
    // Compact markdown: tame the default element margins for pill scale.
    "& p": { marginTop: 0, marginBottom: tokens.spacingVerticalS },
    "& p:last-child": { marginBottom: 0 },
    "& ul, & ol": { marginTop: 0, marginBottom: tokens.spacingVerticalS, paddingLeft: "20px" },
    "& pre": {
      overflowX: "auto",
      backgroundColor: tokens.colorNeutralBackground3,
      ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalS),
      borderRadius: tokens.borderRadiusMedium,
      fontSize: tokens.fontSizeBase200,
    },
    "& h1, & h2, & h3": {
      fontSize: tokens.fontSizeBase300,
      marginTop: tokens.spacingVerticalS,
      marginBottom: tokens.spacingVerticalXS,
    },
  },
  answerError: { color: tokens.colorPaletteRedForeground1 },
  refsRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalXS,
  },
});

/**
 * File-type icon for a result row — the file half of FileExplorer's fileIcon
 * (name matches are file-kind nodes only, so no folder/database branches).
 */
function rowIcon(node: FileNode, className: string) {
  if (node.mimeType === "application/pdf") return <DocumentPdfRegular className={className} />;
  return <DocumentRegular className={className} />;
}

/** One entry in the flat, keyboard-navigable results list. */
type WidgetRow =
  | { key: string; kind: "name"; node: FileNode }
  | { key: string; kind: "content"; ref: RagReference }
  | { key: string; kind: "ask" };

export function WidgetBar() {
  const styles = useStyles();
  // Same load/poll/push freshness as the main window — and nothing else from
  // AppShell (no usage capture, no shortcuts): see useVaultTree.
  useVaultTree();
  const nodes = useRagStore((s) => s.nodes);
  const toggleIncluded = useRagStore((s) => s.toggleIncluded);
  const desktop = useRagStore((s) => s.desktop);
  const egressSummary = egressPillSummary(useRagStore((s) => s.egress));
  // Look up a result's live node (for its current AI-visibility state).
  const nodesById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  // Lighthouse has no accounts or licensing — the vault is always available, so
  // the widget never locks. Kept as a const the guards below still read.
  const locked = false;

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [pinned, setPinned] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const answerElRef = useRef<HTMLDivElement>(null);

  // The inline answer — a compact chat turn that streams INSIDE the pill and
  // stays "frozen" on the desktop until cleared (Esc/✕) or replaced. The
  // shell's blur-hide is held open while one is on screen (widget_hold).
  type InlineAnswer = {
    question: string;
    content: string;
    refs: RagReference[];
    streaming: boolean;
    error: string | null;
    /** Engine stage note ("Reading q3.csv (2/5)…") shown until tokens arrive. */
    progress?: string | null;
  };
  const [answer, setAnswer] = useState<InlineAnswer | null>(null);
  const answerRef = useRef<InlineAnswer | null>(null);
  answerRef.current = answer;
  const abortRef = useRef<AbortController | null>(null);
  // Completed turns feed follow-up asks (capped so the pill never carries a
  // whole transcript); survives clears — the "conversation" outlives one card.
  const historyRef = useRef<ChatTurn[]>([]);
  const [copied, setCopied] = useState(false);
  // A file was just opened FROM the bar. Opening a file must never dismiss the
  // chat — clicking into the document you just opened is not "I'm done here" —
  // so the bar is held open across the ensuing focus-steal and stays put "in
  // the back" until you deliberately dismiss it (Esc/✕) or summon it again.
  // Cleared on the next focus so normal click-away dismissal resumes once you
  // return to the bar.
  const [openHold, setOpenHold] = useState(false);

  // A summon re-focuses the input and SELECTS the previous query (never
  // clears it): typing replaces the old search, but a bare Enter can reuse
  // it — and hands-free dictation replaces it without a click. The
  // visibilitychange leg is a belt for hidden→shown summons where Windows
  // delivers webview focus without a window `focus` event reaching the page.
  useEffect(() => {
    const armInput = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    const onFocus = () => {
      // Returning to the bar ends the just-opened-a-file hold, so a later
      // click-away dismisses normally again.
      setOpenHold(false);
      armInput();
    };
    const onVisible = () => {
      if (!document.hidden) armInput();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // Entry flourish: each summon focuses the window, so toggle a short-lived
  // animation class on the root to replay the fade/scale-in. The class only
  // re-arms on focus (cleared after the run), so steady-state renders — typing,
  // resizing — never restart it, and it never touches drag/focus behavior.
  const [entering, setEntering] = useState(false);
  const enterTimer = useRef<number | null>(null);
  useEffect(() => {
    const onFocus = () => {
      setEntering(true);
      if (enterTimer.current !== null) window.clearTimeout(enterTimer.current);
      enterTimer.current = window.setTimeout(() => setEntering(false), 220);
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      if (enterTimer.current !== null) window.clearTimeout(enterTimer.current);
    };
  }, []);

  // Escape works from anywhere in the window (focus may have left the input),
  // as a ladder: an open answer clears first; a second Esc hides the bar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (answerRef.current) {
          abortRef.current?.abort();
          setAnswer(null);
        } else {
          void invokeShell("widget_hide");
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The bar must survive losing focus while an answer is frozen on screen —
  // clicking back into your document to keep reading is the point — and equally
  // right after you open a file FROM the bar, so the chat persists in the back
  // beside the file instead of vanishing the instant the file steals focus.
  const held = answer !== null || openHold;
  useEffect(() => {
    void invokeShell("widget_hold", { hold: held });
  }, [held]);

  // Pin is purely the user's "keep above other windows" toggle now — widget
  // mode keeps the bar AROUND via shell-side residency without pinning it,
  // so nothing here derives pin from the interface mode. Live echoes still
  // sync the button if the shell ever re-applies pin semantics.
  useEffect(() => {
    const onPin = (e: Event) => {
      const detail = (e as CustomEvent<{ pinned?: boolean }>).detail;
      setPinned(detail?.pinned === true);
    };
    window.addEventListener("lighthouse:widget-pin", onPin);
    return () => window.removeEventListener("lighthouse:widget-pin", onPin);
  }, []);

  // A pinned ANSWER changed (watcher-driven recheck): show a quiet dot on the
  // pill; the full alert banner lives in the main window's chat.
  const [pinAlertDot, setPinAlertDot] = useState(false);
  useEffect(() => {
    const onChanged = () => setPinAlertDot(true);
    window.addEventListener("lighthouse:pins-changed", onChanged);
    return () => window.removeEventListener("lighthouse:pins-changed", onChanged);
  }, []);

  // Layer 1 — NAME matches: instant, client-side, case-insensitive substring
  // over file-kind nodes (the explorer's search-filter matching), so 1-char
  // queries and AI-hidden files still hit. Capped to keep the pill compact.
  const nameMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out: FileNode[] = [];
    for (const n of nodes) {
      if (n.kind !== "file" || !n.name.toLowerCase().includes(q)) continue;
      out.push(n);
      if (out.length >= MAX_NAME_MATCHES) break;
    }
    return out;
  }, [nodes, query]);

  // Layer 2 — CONTENT passages from the engine, debounced; the index only
  // covers files visible to AI, so scope to the included file ids.
  const includedFileIds = useMemo(
    () => nodes.filter((n) => n.kind === "file" && n.ragIncluded).map((n) => n.id),
    [nodes],
  );
  const [passages, setPassages] = useState<RagReference[]>([]);
  useEffect(() => {
    const q = query.trim();
    // Sub-3-char queries return nothing from the engine anyway, and a locked
    // license disables retrieval outright — name rows alone may still show.
    if (locked || q.length < 3) {
      setPassages([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      ragService
        .search(q, includedFileIds)
        .then((refs) => {
          if (!cancelled) setPassages(refs);
        })
        .catch((err) => {
          // Typeahead stays quiet on failure — name matches keep working.
          console.error("Widget content search failed", err);
          if (!cancelled) setPassages([]);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, includedFileIds, locked]);

  // The flat list: name rows, then content rows (minus files already named),
  // then the Ask hand-off — which never renders locked (asking is disabled).
  const rows = useMemo<WidgetRow[]>(() => {
    if (!query.trim()) return [];
    const out: WidgetRow[] = nameMatches.map((n) => ({
      key: `name-${n.id}`,
      kind: "name",
      node: n,
    }));
    if (!locked) {
      const named = new Set(nameMatches.map((n) => n.id));
      for (const r of passages) {
        if (!named.has(r.fileId)) out.push({ key: `content-${r.fileId}`, kind: "content", ref: r });
      }
      out.push({ key: "ask", kind: "ask" });
    }
    return out;
  }, [query, nameMatches, passages, locked]);
  // Clamp rather than reset when the list shrinks under the cursor (e.g.
  // passages settle); typing resets to the top explicitly in onChange.
  const sel = rows.length > 0 ? Math.min(selected, rows.length - 1) : 0;

  const showDropdown = rows.length > 0 || locked;

  // Drive the window height from what's actually rendered: measure the
  // dropdown and the answer panel and ask the shell to resize — but only when
  // the value changes, so steady-state renders (and every streamed delta once
  // at the cap) don't spam IPC. The shell clamps again anyway.
  const lastHeight = useRef(PILL_HEIGHT);
  useEffect(() => {
    const measure = (el: HTMLDivElement | null) =>
      el ? Math.ceil(el.getBoundingClientRect().height) : 0;
    const extra = measure(dropdownRef.current) + measure(answerElRef.current);
    const height = Math.min(PILL_HEIGHT + extra, MAX_WINDOW_HEIGHT);
    if (height === lastHeight.current) return;
    lastHeight.current = height;
    void invokeShell("widget_resize", { height });
  }, [rows, locked, answer, query]);

  const hide = () => void invokeShell("widget_hide");

  /** Open a file in its native app (same route the chat reference cards use).
   *  Opening a file never dismisses the bar: hold it open FIRST so the blur that
   *  follows the file grabbing focus is already suppressed, and leave it up "in
   *  the back" beside the document. You dismiss it deliberately (Esc/✕), or it
   *  steps aside on your next summon — it no longer vanishes the moment you open
   *  a file (which used to tear down even the resident widget). */
  const openNode = (nodeId: string) => {
    setOpenHold(true);
    void fetch("/api/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId }),
    }).catch(() => {});
  };

  // --- Row quick-actions: act on a result WITHOUT opening the explorer window
  // — the whole point of staying in the pill. The bar stays put (no hide) so
  // the toggle's effect is visible and you can keep curating.
  const revealNode = (nodeId: string) => {
    void fetch("/api/reveal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId }),
    }).catch(() => {});
  };
  const toggleVisibility = (fileId: string) => void toggleIncluded(fileId);

  /** Eye (AI-visibility) + reveal cluster, shown on the selected result row.
   *  onMouseDown preventDefault keeps focus in the input (like the rows do). */
  const rowActions = (fileId: string, included: boolean) => (
    <span className={styles.rowActions}>
      <Button
        size="small"
        appearance="subtle"
        className={included ? styles.actionOn : styles.actionBtn}
        icon={included ? <EyeRegular /> : <EyeOffRegular />}
        aria-label={included ? "Hide from AI" : "Show to AI"}
        aria-pressed={included}
        title={included ? "Visible to AI — click to hide" : "Hidden from AI — click to show"}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation();
          toggleVisibility(fileId);
        }}
      />
      {desktop && (
        <Button
          size="small"
          appearance="subtle"
          className={styles.actionBtn}
          icon={<FolderOpenRegular />}
          aria-label="Open containing folder"
          title="Open containing folder"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            revealNode(fileId);
          }}
        />
      )}
    </span>
  );

  /**
   * Ask INSIDE the widget: stream the answer into a compact panel under the
   * pill instead of raising the main window ("whisper to your file system",
   * answered where you whispered). Follow-ups carry capped history.
   */
  const askInline = (questionText?: string) => {
    const q = (questionText ?? query).trim();
    if (!q || locked || answerRef.current?.streaming) return;
    // Warm the split markdown chunk so it's ready as the answer streams in.
    void import("@/shell/MarkdownView");
    const controller = new AbortController();
    abortRef.current = controller;
    const history = historyRef.current;
    setAnswer({ question: q, content: "", refs: [], streaming: true, error: null });
    setQuery("");
    setSelected(0);
    setCopied(false);
    void (async () => {
      let content = "";
      let refs: RagReference[] = [];
      try {
        for await (const chunk of chatService.ask(
          q,
          includedFileIds,
          history,
          [],
          controller.signal,
        )) {
          if (controller.signal.aborted) break;
          if (chunk.progress) {
            const label = chunk.progress.label;
            setAnswer((a) => (a ? { ...a, progress: label } : a));
          }
          if (chunk.delta) {
            content += chunk.delta;
            const soFar = content;
            setAnswer((a) => (a ? { ...a, content: soFar, progress: null } : a));
          }
          if (chunk.references) refs = chunk.references;
        }
        setAnswer((a) => (a ? { ...a, refs, streaming: false } : a));
        if (content) {
          const turns: ChatTurn[] = [
            { role: "user", content: q },
            { role: "assistant", content },
          ];
          historyRef.current = [...historyRef.current, ...turns].slice(-MAX_HISTORY_TURNS);
        }
      } catch (err) {
        // Stop keeps the partial answer quietly; real failures say so inline.
        const aborted = controller.signal.aborted;
        const reason = err instanceof Error ? err.message : "something went wrong";
        setAnswer((a) =>
          a ? { ...a, streaming: false, error: aborted ? null : reason } : a,
        );
      }
    })();
  };

  /** Clear the frozen answer (the ✕ / first Esc). Stops a live stream. */
  const clearAnswer = () => {
    abortRef.current?.abort();
    setAnswer(null);
  };

  /** Escalate to the full app, re-asking there with the same question. */
  const continueInApp = () => {
    const q = answerRef.current?.question;
    abortRef.current?.abort();
    setAnswer(null);
    setPinAlertDot(false); // the main window's banner takes over
    void invokeShell("show_main", q ? { seedQuestion: q } : undefined);
    hide();
  };

  const copyAnswer = () => {
    const text = answerRef.current?.content ?? "";
    if (!text) return;
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  /** Raise the main window bare — where the lock gate / renewal flow lives. */
  const openLighthouse = () => {
    setPinAlertDot(false); // the main window's banner takes over
    void invokeShell("show_main");
    hide();
  };

  const activateRow = (row: WidgetRow) => {
    // Locked: rows are inert — the lock note under them is the only answer
    // (main-window parity: a locked vault is greyed out and inert).
    if (locked) return;
    if (row.kind === "ask") askInline();
    else if (row.kind === "name") openNode(row.node.id);
    else openNode(row.ref.fileId);
  };

  const moveSelection = (delta: number) => {
    if (rows.length === 0) return;
    setSelected((sel + delta + rows.length) % rows.length);
  };

  const onInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveSelection(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveSelection(-1);
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      // isComposing: an IME Enter commits the composition, not the search.
      e.preventDefault();
      // Ctrl/Cmd+Enter ALWAYS asks inline, whatever row is selected.
      if (e.ctrlKey || e.metaKey) {
        askInline();
        return;
      }
      const row = rows[sel];
      if (row) activateRow(row);
    }
  };

  const togglePin = () => {
    const next = !pinned;
    setPinned(next);
    void invokeShell("widget_set_pin", { pinned: next });
  };

  return (
    <div className={mergeClasses(styles.root, entering && styles.rootEnter)}>
      {/* "deep" drag region: any empty chrome in the pill drags the frameless
          window; Tauri's injected drag script exempts the input and buttons,
          so typing/clicking is never hijacked (widget-scope §1.1). */}
      <div className={styles.pill} data-tauri-drag-region>
        {/* Dedicated drag handle. startDragging is the ONLY real path: the
            data-tauri-drag-region attribute has no handler in Tauri v2's
            injected scripts (verified against the vendored crates — it's a
            silent no-op), which is why the bar "couldn't be moved" in the
            field. webviewWindow is the module the transport already loads,
            so the dynamic import is guaranteed present in the bundle. */}
        <div
          className={styles.grip}
          data-tauri-drag-region
          role="presentation"
          title="Drag to move"
          onPointerDown={(e) => {
            if (e.button !== 0 || !isDesktopShell()) return;
            void import("@tauri-apps/api/webviewWindow")
              .then((w) => w.getCurrentWebviewWindow().startDragging())
              .catch(() => {});
          }}
        >
          <span className={styles.beacon} />
          {pinAlertDot && (
            <span
              className={styles.pinAlertDot}
              role="status"
              title="A pinned answer changed — open Lighthouse to see it"
            />
          )}
        </div>
        <Input
          ref={inputRef}
          className={styles.input}
          appearance="filled-lighter"
          size="large"
          autoFocus
          value={query}
          placeholder={answer ? "Ask a follow-up or search…" : "Search your files…"}
          aria-label="Search your files"
          aria-activedescendant={rows.length > 0 ? `widget-row-${sel}` : undefined}
          onChange={(_, d) => {
            setQuery(d.value);
            setSelected(0); // a new query restarts selection at the top row
          }}
          onKeyDown={onInputKeyDown}
        />
        <Button
          className={mergeClasses(styles.iconBtn, pinned && styles.pinOn)}
          appearance="subtle"
          icon={pinned ? <PinFilled /> : <PinRegular />}
          aria-label={pinned ? "Unpin — normal stacking" : "Pin — keep above other windows"}
          aria-pressed={pinned}
          title={
            pinned
              ? "Unpin — other windows can cover the bar again"
              : "Pin — keep the bar above every window"
          }
          onClick={togglePin}
        />
        <Button
          className={styles.iconBtn}
          appearance="subtle"
          icon={<FolderRegular />}
          aria-label="Open vault explorer"
          title="Open vault explorer — see what's in your vault and what the AI can read"
          onClick={() => void invokeShell("open_explorer")}
        />
        <Button
          className={styles.iconBtn}
          appearance="subtle"
          icon={<DismissRegular />}
          aria-label="Hide (Esc)"
          title="Hide (Esc)"
          onClick={hide}
        />
      </div>

      {showDropdown && (
        <div ref={dropdownRef} className={styles.dropdown}>
          {rows.length > 0 && (
            <div role="listbox" aria-label="Search results">
              {rows.map((row, i) => (
                <div
                  key={row.key}
                  id={`widget-row-${i}`}
                  role="option"
                  aria-selected={i === sel}
                  className={mergeClasses(styles.row, i === sel && styles.rowSelected)}
                  onMouseEnter={() => setSelected(i)}
                  // Keep keyboard focus in the input while clicking rows.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => activateRow(row)}
                >
                  {row.kind === "name" && (
                    <>
                      {rowIcon(row.node, styles.rowIcon)}
                      <Text size={300} className={styles.rowLabel}>
                        {row.node.name}
                      </Text>
                      {/* Selected row: act on it in place (eye + reveal) instead
                          of the passive badge — the pill's answer to "found it,
                          can't touch it". Other rows keep the at-a-glance badge. */}
                      {i === sel ? (
                        rowActions(row.node.id, row.node.ragIncluded)
                      ) : (
                        !row.node.ragIncluded && (
                          <Badge
                            className={styles.badge}
                            size="small"
                            appearance="outline"
                            color="informative"
                          >
                            hidden from AI
                          </Badge>
                        )
                      )}
                    </>
                  )}
                  {row.kind === "content" && (
                    <>
                      <DocumentRegular className={styles.rowIcon} />
                      <div className={styles.rowMeta}>
                        <Text size={300} className={styles.truncated}>
                          {row.ref.name}
                        </Text>
                        <Text size={200} className={styles.snippet}>
                          {row.ref.snippet}
                        </Text>
                      </div>
                      {i === sel ? (
                        rowActions(row.ref.fileId, nodesById.get(row.ref.fileId)?.ragIncluded ?? true)
                      ) : (
                        /* Score badge, matching chat's reference cards. */
                        <Badge className={styles.badge} appearance="outline">
                          {Math.round(row.ref.score * 100)}%
                        </Badge>
                      )}
                    </>
                  )}
                  {row.kind === "ask" && (
                    <>
                      <ChatSparkleRegular className={styles.rowIcon} />
                      <Text size={300} className={styles.rowLabel}>
                        {`Ask Lighthouse → "${query.trim()}"`}
                      </Text>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
          {locked && (
            <div className={styles.lockNote}>
              <Text size={300} className={styles.lockText}>
                Your trial has ended — open Lighthouse to continue.
              </Text>
              <Button size="small" appearance="primary" onClick={openLighthouse}>
                Open Lighthouse
              </Button>
            </div>
          )}
          {/* Egress transparency (S3): the one-line "what left this machine"
              summary. The collapsed pill is a fixed-height window with no
              room, so it lives in the footer of the expanded dropdown. */}
          {egressSummary && (
            <div className={styles.egressFooter}>
              <Text size={100}>{egressSummary}</Text>
            </div>
          )}
        </div>
      )}

      {/* The frozen inline answer: shown while the search box is idle; typing
          brings results back on top (the answer returns when the box clears,
          and a new ask replaces it). */}
      {answer && !query.trim() && (
        <div ref={answerElRef} className={styles.answer} data-lh-widget-answer>
          <div className={styles.answerHead}>
            <ChatSparkleRegular className={styles.rowIcon} />
            <Text size={200} className={styles.answerQ} title={answer.question}>
              {answer.question}
            </Text>
            {answer.streaming ? (
              <Button
                size="small"
                appearance="subtle"
                icon={<SquareRegular />}
                aria-label="Stop answering"
                title="Stop answering"
                onClick={() => abortRef.current?.abort()}
              />
            ) : (
              <Button
                size="small"
                appearance="subtle"
                icon={copied ? <CheckmarkRegular /> : <CopyRegular />}
                aria-label="Copy answer"
                title="Copy answer"
                onClick={copyAnswer}
              />
            )}
            <Button
              size="small"
              appearance="subtle"
              icon={<OpenRegular />}
              aria-label="Continue in Lighthouse"
              title="Continue in Lighthouse — reopens this question in the full app"
              onClick={continueInApp}
            />
            <Button
              size="small"
              appearance="subtle"
              icon={<DismissRegular />}
              aria-label="Clear answer (Esc)"
              title="Clear answer (Esc)"
              onClick={clearAnswer}
            />
          </div>
          <div className={styles.answerBody}>
            {answer.content ? (
              // The pill is too small for the analytics charts the engine can
              // append (```lighthouse-chart fences) — strip them here; the
              // numbers are in the prose, and the main window draws the chart.
              <MarkdownView
                content={answer.content.replace(/```lighthouse-chart[\s\S]*?(```|$)/g, "")}
              />
            ) : answer.streaming ? (
              <Text size={200} className={styles.snippet}>
                {answer.progress || "Thinking…"}
              </Text>
            ) : null}
            {answer.error && (
              <Text size={200} className={styles.answerError}>
                Couldn&apos;t get an answer — {answer.error}
              </Text>
            )}
          </div>
          {answer.refs.length > 0 && (
            <div className={styles.refsRow}>
              {answer.refs.slice(0, 4).map((r) => (
                <Button
                  key={r.fileId}
                  size="small"
                  appearance="outline"
                  title={r.snippet}
                  onClick={() => openNode(r.fileId)}
                >
                  {r.name}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
