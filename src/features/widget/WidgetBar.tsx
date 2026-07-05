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
  DismissRegular,
  DocumentPdfRegular,
  DocumentRegular,
  FolderRegular,
  PinFilled,
  PinRegular,
} from "@fluentui/react-icons";
import type { FileNode, RagReference } from "@/contracts";
import { ragService } from "@/contracts";
import { useRagStore } from "@/stores/useRagStore";
import { useLicenseStore, isLocked } from "@/stores/useLicenseStore";
import { isDesktopShell } from "@/shell/desktopBridge";
import { useVaultTree } from "@/shell/useVaultTree";
import { ACCENTS } from "@/shell/theme";

/** Collapsed window height — must match the Rust builder's 560×56 (contract). */
const PILL_HEIGHT = 56;
/** Hard cap for the grown window; the dropdown scrolls internally beyond it. */
const MAX_WINDOW_HEIGHT = 420;
/** Client-side name matches shown at most (content passages layer under). */
const MAX_NAME_MATCHES = 6;
/** Debounce for the engine content search — fast enough to feel typeahead. */
const SEARCH_DEBOUNCE_MS = 150;

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
  pill: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    height: `${PILL_HEIGHT}px`,
    flexShrink: 0,
    ...shorthands.padding(0, tokens.spacingHorizontalM),
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

  // License: the widget reads the lock state itself — mounting search bare
  // would silently bypass the trial gate (widget-scope §2.4). Re-check on
  // every summon (window focus): the trial can expire while the bar idles.
  const status = useLicenseStore((s) => s.status);
  const check = useLicenseStore((s) => s.check);
  useEffect(() => {
    void check();
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [check]);
  const locked = isLocked(status);

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [pinned, setPinned] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // A summon re-focuses the input and SELECTS the previous query (never
  // clears it): typing replaces the old search, but a bare Enter can reuse it.
  useEffect(() => {
    const onFocus = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Escape hides from anywhere in the window (focus may have left the input).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void invokeShell("widget_hide");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // In widget mode the shell boots the bar pinned (it IS the app's resting
  // presence, so blur must not dismiss it) — reflect that in the pin button.
  // One read at mount, then live echoes whenever the shell re-applies pin
  // semantics (the user switching interface mode at runtime).
  useEffect(() => {
    let alive = true;
    void fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && d?.uiMode === "widget") setPinned(true);
      })
      .catch(() => {});
    const onPin = (e: Event) => {
      const detail = (e as CustomEvent<{ pinned?: boolean }>).detail;
      setPinned(detail?.pinned === true);
    };
    window.addEventListener("lighthouse:widget-pin", onPin);
    return () => {
      alive = false;
      window.removeEventListener("lighthouse:widget-pin", onPin);
    };
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
  // dropdown and ask the shell to resize — but only when the value changes,
  // so steady-state renders don't spam IPC. The shell clamps again anyway.
  const lastHeight = useRef(PILL_HEIGHT);
  useEffect(() => {
    const extra = dropdownRef.current
      ? Math.ceil(dropdownRef.current.getBoundingClientRect().height)
      : 0;
    const height = Math.min(PILL_HEIGHT + extra, MAX_WINDOW_HEIGHT);
    if (height === lastHeight.current) return;
    lastHeight.current = height;
    void invokeShell("widget_resize", { height });
  }, [rows, locked]);

  const hide = () => void invokeShell("widget_hide");

  /** Open a file in its native app (same route the chat reference cards use), then get out of the way. */
  const openNode = (nodeId: string) => {
    void fetch("/api/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId }),
    }).catch(() => {});
    hide();
  };

  /** Hand the query to the main window's chat ("whisper to your file system"). */
  const askLighthouse = () => {
    const q = query.trim();
    if (!q || locked) return;
    void invokeShell("show_main", { seedQuestion: q });
    hide();
  };

  /** Raise the main window bare — where the lock gate / renewal flow lives. */
  const openLighthouse = () => {
    void invokeShell("show_main");
    hide();
  };

  const activateRow = (row: WidgetRow) => {
    // Locked: rows are inert — the lock note under them is the only answer
    // (main-window parity: a locked vault is greyed out and inert).
    if (locked) return;
    if (row.kind === "ask") askLighthouse();
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
      // Ctrl/Cmd+Enter is ALWAYS the ask hand-off, whatever row is selected.
      if (e.ctrlKey || e.metaKey) {
        askLighthouse();
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
    <div className={styles.root}>
      {/* "deep" drag region: any empty chrome in the pill drags the frameless
          window; Tauri's injected drag script exempts the input and buttons,
          so typing/clicking is never hijacked (widget-scope §1.1). */}
      <div className={styles.pill} data-tauri-drag-region="deep">
        <span className={styles.beacon} />
        <Input
          ref={inputRef}
          className={styles.input}
          appearance="filled-lighter"
          size="large"
          autoFocus
          value={query}
          placeholder="Search your files…"
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
          aria-label={pinned ? "Unpin — hide when focus leaves" : "Pin — keep on top"}
          aria-pressed={pinned}
          title={pinned ? "Unpin — hide when focus leaves" : "Pin — keep on top"}
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
                      {!row.node.ragIncluded && (
                        <Badge
                          className={styles.badge}
                          size="small"
                          appearance="outline"
                          color="informative"
                        >
                          hidden from AI
                        </Badge>
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
                      {/* Score badge, matching chat's reference cards. */}
                      <Badge className={styles.badge} appearance="outline">
                        {Math.round(row.ref.score * 100)}%
                      </Badge>
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
        </div>
      )}
    </div>
  );
}
