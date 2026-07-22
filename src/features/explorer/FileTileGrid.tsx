"use client";

/**
 * 0.13.10 §4: the compact Files page as a TILE GRID — the iOS Files idiom,
 * replacing the desktop tree presentation on compact shells only
 * (FilesSurface below branches on paneLayout; desktop keeps FileExplorer
 * byte-for-byte).
 *
 * The grid's contract:
 *  - each FILE is a tile: type icon, name, size line, and the two state
 *    badges visible AT REST — in-the-beam (ragIncluded, amber eye) and
 *    private (localOnly, lock);
 *  - TAP selects/deselects (direct multi-select, checkmark badge ≥28pt) —
 *    a tap NEVER silently changes ragIncluded; visibility changes only via
 *    the action row (the stray-tap invariant, now with fewer surfaces);
 *  - the bottom ACTION ROW slides up when ≥1 tile is selected: Visible to
 *    AI on/off · Private on/off · Add to investigation scope · Remove
 *    (inline confirm) · Clear — the SAME batch ops as the desktop bar
 *    (applySelection / applyLocalOnly / removeFromVault), and the selection
 *    lives in the SAME store (selectionMode + selectedIds) so the
 *    investigation scope-from-selection keeps reading it;
 *  - LONG-PRESS a file tile opens the inspector ("what the AI sees",
 *    INSPECT_FILE_EVENT) where per-file eye/lock/rename/remove live;
 *  - FOLDERS tap-OPEN (drill in; the header becomes a back-able breadcrumb)
 *    and their tiles show aggregate state; no chevron tree on compact;
 *  - search is the iOS pull-down-to-reveal field over the grid (parked
 *    above the fold at rest); the Add control stays prominent top-right.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  SearchBox,
  Text,
  makeStyles,
  mergeClasses,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import {
  AddRegular,
  ArrowLeftRegular,
  CheckmarkCircleFilled,
  DatabaseRegular,
  DocumentPdfRegular,
  DocumentRegular,
  DocumentTextRegular,
  EyeRegular,
  FolderRegular,
  ImageRegular,
  LockClosedRegular,
  TableRegular,
} from "@fluentui/react-icons";
import type { FileNode } from "@/contracts";
import { useRagStore } from "@/stores/useRagStore";
import { usePaneLayout } from "@/shell/paneLayout";
import { LhSwitch } from "@/shell/controls";
import { INSPECT_FILE_EVENT } from "@/lib/citePreview";
import { FileExplorer } from "./FileExplorer";

/** Long-press threshold (ms) before a touch opens the inspector. */
const LONG_PRESS_MS = 500;

/** Grid-only icon metaphors — richer than the tree's (csv/xlsx/parquet get a
 *  table, markdown/txt a text page, rasters an image). The desktop tree's own
 *  fileIcon is deliberately untouched (its render is pinned byte-identical). */
function tileIcon(node: FileNode, className: string) {
  if (node.kind === "database") return <DatabaseRegular className={className} />;
  if (node.kind === "folder") return <FolderRegular className={className} />;
  const ext = (node.name.split(".").pop() ?? "").toLowerCase();
  if (node.mimeType === "application/pdf" || ext === "pdf")
    return <DocumentPdfRegular className={className} />;
  if (["csv", "tsv", "xlsx", "xls", "parquet"].includes(ext))
    return <TableRegular className={className} />;
  if (["md", "txt"].includes(ext)) return <DocumentTextRegular className={className} />;
  if (["png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "tif", "tiff"].includes(ext))
    return <ImageRegular className={className} />;
  return <DocumentRegular className={className} />;
}

/** The tree's size formatting, duplicated verbatim (the tree file is pinned). */
function formatSize(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 },
  topBar: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    ...shorthands.padding(tokens.spacingVerticalS, 0),
  },
  crumbBtn: { minWidth: "44px", minHeight: "44px" },
  crumbName: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // The scrollable region: the search row is its FIRST child and the mount
  // effect scrolls past it, so pulling down reveals it (the iOS idiom).
  scroller: { flex: 1, minHeight: 0, overflowY: "auto" },
  searchRow: { ...shorthands.padding(0, 0, tokens.spacingVerticalS) },
  search: { width: "100%" },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(148px, 1fr))",
    gap: tokens.spacingHorizontalM,
    ...shorthands.padding(0, 0, tokens.spacingVerticalXXL),
  },
  tile: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: tokens.spacingVerticalXS,
    minHeight: "112px",
    ...shorthands.padding(tokens.spacingVerticalM, tokens.spacingHorizontalM),
    ...shorthands.borderRadius(tokens.borderRadiusLarge),
    ...shorthands.border("1px", "solid", tokens.colorNeutralStroke2),
    backgroundColor: tokens.colorNeutralBackground1,
    cursor: "pointer",
    textAlign: "left",
    fontFamily: "inherit",
    color: "inherit",
    touchAction: "manipulation",
    // Long-press must not open the OS text-selection/callout UI.
    WebkitUserSelect: "none",
    userSelect: "none",
    WebkitTouchCallout: "none",
  },
  tileSelected: {
    ...shorthands.border("2px", "solid", tokens.colorBrandStroke1),
    backgroundColor: tokens.colorBrandBackground2,
  },
  tileTop: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    width: "100%",
  },
  icon: { fontSize: "28px", color: tokens.colorNeutralForeground2 },
  badgeSpacer: { flex: 1 },
  // The two at-rest state badges: in-the-beam (amber eye) and private (lock).
  beamBadge: { fontSize: "16px", color: tokens.colorBrandForeground1 },
  // A folder whose files are only PARTLY in the beam shows the eye dimmed.
  beamBadgePartial: { fontSize: "16px", color: tokens.colorNeutralForeground3 },
  lockBadge: { fontSize: "16px", color: tokens.colorNeutralForeground2 },
  // The ≥28pt selection checkmark (the iOS Files idiom), floating top-left.
  check: {
    position: "absolute",
    top: "-8px",
    left: "-8px",
    fontSize: "28px",
    color: tokens.colorBrandForeground1,
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: "50%",
  },
  name: {
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
    wordBreak: "break-word",
    lineHeight: tokens.lineHeightBase200,
  },
  meta: { color: tokens.colorNeutralForeground3 },
  empty: {
    color: tokens.colorNeutralForeground3,
    textAlign: "center",
    ...shorthands.padding(tokens.spacingVerticalXXL, tokens.spacingHorizontalL),
  },
  // The selection action row: slides up over the tab bar's reserve when ≥1
  // tile is selected. Same batch ops as the desktop bar.
  actionRow: {
    position: "fixed",
    left: 0,
    right: 0,
    bottom: "calc(var(--lh-safe-bottom, 0px) + var(--lh-tabbar-h, 0px))",
    zIndex: 35,
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalS,
    ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalM),
    backgroundColor: tokens.colorNeutralBackground1,
    ...shorthands.borderTop("1px", "solid", tokens.colorNeutralStroke2),
    boxShadow: tokens.shadow8,
  },
  actionCount: { fontWeight: tokens.fontWeightSemibold },
});

/** Aggregate beam/private state over a folder's descendant FILES. */
function folderAggregate(
  folderId: string,
  childrenOf: Map<string | null, FileNode[]>,
): { all: boolean; some: boolean; allLocal: boolean } {
  let total = 0;
  let included = 0;
  let local = 0;
  const walk = (id: string) => {
    for (const child of childrenOf.get(id) ?? []) {
      if (child.kind === "folder") walk(child.id);
      else {
        total += 1;
        if (child.ragIncluded) included += 1;
        if (child.localOnly) local += 1;
      }
    }
  };
  walk(folderId);
  return {
    all: total > 0 && included === total,
    some: included > 0,
    allLocal: total > 0 && local === total,
  };
}

export function FileTileGrid() {
  const styles = useStyles();
  const nodes = useRagStore((s) => s.nodes);
  const upload = useRagStore((s) => s.upload);
  const applySelection = useRagStore((s) => s.applySelection);
  const applyLocalOnly = useRagStore((s) => s.applyLocalOnly);
  const removeFromVault = useRagStore((s) => s.removeFromVault);
  const selectedIds = useRagStore((s) => s.selectedIds);
  const setSelectionMode = useRagStore((s) => s.setSelectionMode);
  const toggleSelected = useRagStore((s) => s.toggleSelected);
  const clearSelection = useRagStore((s) => s.clearSelection);

  const [folderId, setFolderId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // The egress shield's "hidden from cloud" reveal (lighthouse:filter-local-only)
  // narrows the grid to private files until dismissed.
  const [localOnlyFilter, setLocalOnlyFilter] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const searchRowRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pressTimer = useRef<number | null>(null);
  // True only when a long-press actually FIRED the inspector — the browser
  // still synthesizes a click after touchend, and that click must be
  // swallowed. A null timer can NOT stand in for this (the timer is also
  // null when cancelled by touchend/move and when never started at all —
  // conflating those swallowed every normal tap and mouse click).
  const pressFired = useRef(false);

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const childrenOf = useMemo(() => {
    const m = new Map<string | null, FileNode[]>();
    for (const n of nodes) {
      const key = n.parentId ?? null;
      const list = m.get(key);
      if (list) list.push(n);
      else m.set(key, [n]);
    }
    for (const list of m.values())
      list.sort((a, b) =>
        a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "folder" ? -1 : 1,
      );
    return m;
  }, [nodes]);

  const current = folderId ? (nodeById.get(folderId) ?? null) : null;
  const tiles = useMemo(() => {
    let listed = childrenOf.get(folderId ?? null) ?? [];
    if (localOnlyFilter)
      listed = listed.filter((n) => (n.kind === "folder" ? true : Boolean(n.localOnly)));
    const q = query.trim().toLowerCase();
    return q ? listed.filter((n) => n.name.toLowerCase().includes(q)) : listed;
  }, [childrenOf, folderId, query, localOnlyFilter]);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const allIncluded =
    selectedIds.length > 0 && selectedIds.every((id) => nodeById.get(id)?.ragIncluded);
  const allLocalOnly =
    selectedIds.length > 0 && selectedIds.every((id) => nodeById.get(id)?.localOnly);

  // Park the search field above the fold: revealed by pulling down (the iOS
  // idiom). Once per FOLDER VISIT, and only after content exists — parking on
  // an empty async-loading grid clamps to 0 and silently fails, and parking
  // on query transitions would yank the focused field off-screen mid-typing.
  const parkedFor = useRef<string | null>(null);
  useEffect(() => {
    if (tiles.length === 0) return;
    const key = folderId ?? "__root__";
    if (parkedFor.current === key) return;
    const el = scrollerRef.current;
    const row = searchRowRef.current;
    if (el && row) {
      el.scrollTop = row.offsetHeight;
      parkedFor.current = key;
    }
  }, [folderId, tiles.length]);

  // The window events the tree explorer honors work here too (the compact
  // surface must not orphan them): active-tab retap scrolls to top, quick-open
  // reveal navigates to the node's folder, the egress shield's reveal filters
  // to private files, and browse-files opens the picker.
  useEffect(() => {
    const onScrollTop = () => scrollerRef.current?.scrollTo({ top: 0, behavior: "auto" });
    const onReveal = (e: Event) => {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id;
      const node = id ? useRagStore.getState().nodes.find((n) => n.id === id) : undefined;
      if (!node) return;
      setFolderId(node.kind === "folder" ? node.id : (node.parentId ?? null));
      setQuery("");
      setLocalOnlyFilter(false);
    };
    const onFilterLocalOnly = () => setLocalOnlyFilter(true);
    const onBrowse = () => fileInputRef.current?.click();
    window.addEventListener("lighthouse:explorer-scroll-top", onScrollTop);
    window.addEventListener("lighthouse:reveal-node", onReveal);
    window.addEventListener("lighthouse:filter-local-only", onFilterLocalOnly);
    window.addEventListener("lighthouse:browse-files", onBrowse);
    return () => {
      window.removeEventListener("lighthouse:explorer-scroll-top", onScrollTop);
      window.removeEventListener("lighthouse:reveal-node", onReveal);
      window.removeEventListener("lighthouse:filter-local-only", onFilterLocalOnly);
      window.removeEventListener("lighthouse:browse-files", onBrowse);
    };
  }, []);

  // Arming a remove and then changing the selection would confirm the WRONG
  // set — disarm on any selection change.
  useEffect(() => {
    setConfirmRemove(false);
  }, [selectedIds]);

  const startPress = (node: FileNode) => {
    cancelPress();
    if (node.kind === "folder") return;
    pressFired.current = false;
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null;
      pressFired.current = true;
      window.dispatchEvent(new CustomEvent(INSPECT_FILE_EVENT, { detail: { id: node.id } }));
    }, LONG_PRESS_MS);
  };
  const cancelPress = () => {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };
  // A pending press must not outlive the grid (folder auto-close, tab switch).
  useEffect(() => cancelPress, []);

  const tapTile = (node: FileNode) => {
    if (node.kind === "folder") {
      setFolderId(node.id);
      setQuery("");
      return;
    }
    // Direct multi-select — the store's selectionMode stays on while a
    // selection exists so the investigation scope keeps reading it.
    setSelectionMode(true);
    toggleSelected(node.id);
  };

  const clearAll = () => {
    clearSelection();
    setSelectionMode(false);
  };

  return (
    <div className={styles.root} data-tour="explorer">
      <div className={styles.topBar}>
        {current && (
          <Button
            appearance="subtle"
            className={styles.crumbBtn}
            icon={<ArrowLeftRegular />}
            aria-label="Back to the enclosing folder"
            onClick={() => {
              setFolderId(current.parentId ?? null);
              setQuery("");
            }}
          />
        )}
        <Text weight="semibold" className={styles.crumbName}>
          {current ? current.name : "Files"}
        </Text>
        {/* §26: the add control stays prominent — top-right. */}
        <Button
          appearance="primary"
          icon={<AddRegular />}
          onClick={() => fileInputRef.current?.click()}
        >
          Add
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length) void upload(files);
            e.target.value = "";
          }}
        />
      </div>
      <div className={styles.scroller} ref={scrollerRef}>
        <div className={styles.searchRow} ref={searchRowRef}>
          <SearchBox
            className={styles.search}
            placeholder="Search files…"
            value={query}
            onChange={(_, d) => setQuery(d.value)}
          />
        </div>
        {localOnlyFilter && (
          <Button size="small" appearance="secondary" onClick={() => setLocalOnlyFilter(false)}>
            Showing private files only — clear
          </Button>
        )}
        {tiles.length === 0 ? (
          <Text className={styles.empty}>
            {query ? "No files match your search." : "Nothing here yet — tap Add."}
          </Text>
        ) : (
          <div className={styles.grid} role="grid" aria-label="Files">
            {tiles.map((node) => {
              const selected = node.kind !== "folder" && selectedSet.has(node.id);
              const agg =
                node.kind === "folder" ? folderAggregate(node.id, childrenOf) : null;
              const beam = agg ? agg.some : node.ragIncluded;
              const beamPartial = agg ? agg.some && !agg.all : false;
              const locked = agg ? agg.allLocal : Boolean(node.localOnly);
              const count =
                node.kind === "folder" ? (childrenOf.get(node.id)?.length ?? 0) : null;
              return (
                <button
                  key={node.id}
                  type="button"
                  role="gridcell"
                  aria-selected={selected || undefined}
                  className={mergeClasses(styles.tile, selected && styles.tileSelected)}
                  onClick={() => {
                    cancelPress();
                    // Swallow ONLY the click synthesized after a fired
                    // long-press — every other click/tap selects or opens.
                    if (pressFired.current) {
                      pressFired.current = false;
                      return;
                    }
                    tapTile(node);
                  }}
                  onTouchStart={() => startPress(node)}
                  onTouchEnd={cancelPress}
                  onTouchMove={cancelPress}
                  onTouchCancel={cancelPress}
                  onContextMenu={(e) => {
                    // Right-click / OS long-press: the inspector, same as the
                    // touch long-press.
                    if (node.kind === "folder") return;
                    e.preventDefault();
                    window.dispatchEvent(
                      new CustomEvent(INSPECT_FILE_EVENT, { detail: { id: node.id } }),
                    );
                  }}
                >
                  {selected && <CheckmarkCircleFilled className={styles.check} aria-hidden />}
                  <span className={styles.tileTop}>
                    {tileIcon(node, styles.icon)}
                    <span className={styles.badgeSpacer} />
                    {beam && (
                      <EyeRegular
                        className={beamPartial ? styles.beamBadgePartial : styles.beamBadge}
                        aria-label={beamPartial ? "Partly visible to AI" : "Visible to AI"}
                      />
                    )}
                    {locked && (
                      <LockClosedRegular className={styles.lockBadge} aria-label="Private — never leaves this device" />
                    )}
                  </span>
                  <Text size={300} className={styles.name}>
                    {node.name}
                  </Text>
                  <Text size={200} className={styles.meta}>
                    {node.kind === "folder"
                      ? `${count} ${count === 1 ? "item" : "items"}`
                      : formatSize(node.size)}
                  </Text>
                </button>
              );
            })}
          </div>
        )}
      </div>
      {selectedIds.length > 0 && (
        <div className={styles.actionRow} role="toolbar" aria-label="Selection actions">
          <Text size={200} className={styles.actionCount}>
            {selectedIds.length} selected
          </Text>
          <LhSwitch
            checked={allIncluded}
            onChange={(_, d) => void applySelection(Boolean(d.checked))}
            label="Visible to AI"
          />
          <LhSwitch
            checked={allLocalOnly}
            onChange={(_, d) => void applyLocalOnly(Boolean(d.checked))}
            label="Private"
          />
          <Button
            size="small"
            appearance="secondary"
            onClick={() =>
              // The picker's scope-from-selection reads this same selection.
              window.dispatchEvent(new CustomEvent("lighthouse:open-investigations"))
            }
          >
            Add to investigation scope
          </Button>
          {confirmRemove ? (
            <Button
              size="small"
              appearance="primary"
              onClick={() => {
                const ids = [...selectedIds];
                void removeFromVault(ids).then(clearAll, clearAll);
                setConfirmRemove(false);
              }}
            >
              Really remove {selectedIds.length}? They go to the vault trash.
            </Button>
          ) : (
            <Button size="small" appearance="secondary" onClick={() => setConfirmRemove(true)}>
              Remove
            </Button>
          )}
          <Button size="small" appearance="subtle" onClick={clearAll}>
            Clear
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * The Files surface — paneLayout decides the presentation. Compact gets the
 * tile grid; desktop (and iPad-regular) keeps the tree explorer verbatim.
 * Branching HERE (not inside FileExplorer) keeps the desktop component's
 * hook order and render untouched — the byte-identical structural pin.
 */
export function FilesSurface() {
  const compact = usePaneLayout(false).compact;
  return compact ? <FileTileGrid /> : <FileExplorer />;
}
