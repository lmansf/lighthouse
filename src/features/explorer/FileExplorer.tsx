"use client";

/**
 * [TEAM: explorer]
 *
 * File tree for the local vault. Renders the real node tree (top-level items
 * and nested folders) and adds files or whole folders. Navigation and AI
 * visibility are deliberately SEPARATE gestures: clicking a folder row only
 * expands/collapses it, and what the AI can see changes only through the
 * explicit per-row eye toggle (or the right-click menu / bulk selection bar) —
 * a stray click must never silently change visibility. On the desktop, adds
 * are LINK-FIRST: dropped or picked items are referenced in place (no copy);
 * copying into the vault is the explicit secondary option. In a plain browser,
 * adds upload bytes.
 *
 * Keep using `useRagStore` (do not import other features directly).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  Link,
  Menu,
  MenuDivider,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  SearchBox,
  Spinner,
  Switch,
  Text,
  Title3,
  ToggleButton,
  Tooltip,
  makeStyles,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import {
  ArrowSyncRegular,
  ChevronDownRegular,
  ChevronRightRegular,
  CloudArrowUpRegular,
  DatabaseRegular,
  DeleteRegular,
  DismissRegular,
  DocumentRegular,
  DocumentPdfRegular,
  EyeOffRegular,
  EyeRegular,
  FolderRegular,
  FolderAddRegular,
  FolderOpenRegular,
  LinkRegular,
  PlugDisconnectedRegular,
  ShieldKeyholeRegular,
} from "@fluentui/react-icons";
import type { FileNode } from "@/contracts";
import { useRagStore } from "@/stores/useRagStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { logEvent } from "@/lib/logEvent";
import { FILE_DRAG_MIME, serializeDraggedFiles } from "@/shell/dnd";
import { desktopBridge, isDesktopShell, pathsForFiles } from "@/shell/desktopBridge";

/** Persists dismissal of the include-by-default note so it isn't permanent noise. */
const CONTROL_NOTE_DISMISSED_KEY = "lighthouse.controlNote.dismissed";

const useStyles = makeStyles({
  panel: {
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    height: "100%",
    position: "relative", // anchors the processing overlay
    ...shorthands.borderRadius(tokens.borderRadiusLarge),
    ...shorthands.border("2px", "dashed", "transparent"),
    transitionProperty: "border-color, background-color",
    transitionDuration: tokens.durationFaster,
  },
  processingOverlay: {
    position: "absolute",
    inset: 0,
    zIndex: 10,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackgroundAlpha2,
    backdropFilter: "blur(2px)",
    ...shorthands.borderRadius(tokens.borderRadiusLarge),
  },
  addNotice: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    marginBottom: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorStatusWarningBackground1,
    color: tokens.colorStatusWarningForeground1,
  },
  panelDragging: {
    ...shorthands.borderColor(tokens.colorBrandStroke1),
    backgroundColor: tokens.colorBrandBackground2,
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: tokens.spacingVerticalM,
    gap: tokens.spacingHorizontalM,
    flexWrap: "wrap",
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
  },
  controlNote: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    marginBottom: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground2,
  },
  controlNoteIcon: { color: tokens.colorBrandForeground1, flexShrink: 0 },
  filterBar: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    marginBottom: tokens.spacingVerticalS,
  },
  search: { flex: 1, minWidth: "120px" },
  scroll: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    paddingRight: tokens.spacingHorizontalS,
  },
  sourceLabel: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalL,
    marginBottom: tokens.spacingVerticalS,
  },
  connectBody: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
    alignItems: "flex-start",
  },
  deviceCode: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeHero800,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: "0.15em",
    ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalM),
    backgroundColor: tokens.colorNeutralBackground3,
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    userSelect: "all",
  },
  waitingRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
  },
  empty: {
    ...shorthands.padding(tokens.spacingVerticalXL, tokens.spacingHorizontalL),
    textAlign: "center",
    color: tokens.colorNeutralForeground3,
  },
  // First-run card shown when the vault has no files at all - a real call to
  // action instead of the terse per-source one-liner.
  emptyState: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: tokens.spacingVerticalM,
    ...shorthands.padding(tokens.spacingVerticalXXL, tokens.spacingHorizontalL),
    marginTop: tokens.spacingVerticalL,
    textAlign: "center",
    ...shorthands.borderRadius(tokens.borderRadiusLarge),
    ...shorthands.border("1px", "dashed", tokens.colorNeutralStroke1),
  },
  emptyStateIcon: { fontSize: "40px", color: tokens.colorBrandForeground1 },
  emptyStatePrivacy: { color: tokens.colorNeutralForeground3 },
  removeError: {
    marginTop: tokens.spacingVerticalS,
    color: tokens.colorPaletteRedForeground1,
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalS),
    borderRadius: tokens.borderRadiusMedium,
    cursor: "pointer",
    minHeight: "34px",
    ":hover": { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
  rowIncluded: {
    backgroundColor: tokens.colorBrandBackground2,
  },
  rowSelected: {
    backgroundColor: tokens.colorNeutralBackground1Selected,
    ...shorthands.outline("1px", "solid", tokens.colorBrandStroke1),
  },
  actionBar: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
    ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalS),
    marginBottom: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  check: { flexShrink: 0 },
  // The eye reads as part of the row until you need it; brand color marks the
  // "visible to AI" state so scanning the tree shows what the AI can see.
  eyeOn: { color: tokens.colorBrandForeground1 },
  chevron: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "20px",
    flexShrink: 0,
    color: tokens.colorNeutralForeground3,
  },
  icon: { fontSize: "20px", flexShrink: 0 },
  name: { flex: 1, minWidth: 0, wordBreak: "break-word" },
  spacer: { flex: 1 },
  dimmed: { opacity: 0.45 },
});

function fileIcon(node: FileNode, className: string) {
  if (node.kind === "database") return <DatabaseRegular className={className} />;
  if (node.kind === "folder") return <FolderRegular className={className} />;
  if (node.mimeType === "application/pdf")
    return <DocumentPdfRegular className={className} />;
  return <DocumentRegular className={className} />;
}

interface TreeRowProps {
  node: FileNode;
  depth: number;
  childrenOf: (id: string) => FileNode[];
  selectionMode: boolean;
  isSelected: (id: string) => boolean;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  onUnlink: (id: string) => void;
  onRemove: (id: string) => void;
  /**
   * Ids the active search/filter keeps, or null when no filter is active.
   * Children outside the set are not rendered.
   */
  visibleIds: Set<string> | null;
  /** True while a search query is active: matched ancestors stay expanded. */
  forceExpand: boolean;
}

function TreeRow({
  node,
  depth,
  childrenOf,
  selectionMode,
  isSelected,
  onToggle,
  onSelect,
  onUnlink,
  onRemove,
  visibleIds,
  forceExpand,
}: TreeRowProps) {
  const styles = useStyles();
  const [open, setOpen] = useState(depth < 1); // top-level folders open by default
  // A search must reveal matches nested in collapsed folders, so it wins over
  // the user's manual open/closed state while the query is active.
  const expanded = forceExpand || open;
  const kids = node.kind === "folder" ? childrenOf(node.id) : [];
  const shownKids = visibleIds ? kids.filter((k) => visibleIds.has(k.id)) : kids;
  const selected = selectionMode && isSelected(node.id);
  // Cloud-connector files (namespaced ids) live remotely, not in the local vault
  // that attachment retrieval walks, so only local-vault files can be attached.
  const attachable = node.kind === "file" && !node.id.startsWith(`${node.sourceId}::`);
  // Row clicks NAVIGATE only. Visibility lives exclusively on the explicit eye
  // toggle (and the context menu) so a misclick can never silently change what
  // the AI sees — especially a folder click, which cascades server-side.
  const activate = () => {
    if (selectionMode) {
      onSelect(node.id);
      return;
    }
    if (node.kind === "folder") setOpen((o) => !o);
  };
  const toggleVisibility = () => {
    // Privacy-safe availability telemetry: count THIS toggle (not the folder's
    // cascade of descendants); the row's current state decides the direction and
    // `scope` is a coarse kind only - never a name, id, or path.
    logEvent(node.ragIncluded ? "file_made_unavailable" : "file_made_available", {
      scope: node.kind === "folder" ? "folder" : "file",
    });
    onToggle(node.id);
  };
  const eyeLabel = node.ragIncluded
    ? "Visible to AI — click to hide"
    : "Hidden from AI — click to show";

  return (
    <div>
      <Menu openOnContext>
        <MenuTrigger disableButtonEnhancement>
      <div
        className={`${styles.row}${node.ragIncluded ? ` ${styles.rowIncluded}` : ""}${
          selected ? ` ${styles.rowSelected}` : ""
        }`}
        style={{ paddingLeft: `${depth * 18 + 4}px` }}
        role="button"
        tabIndex={0}
        aria-expanded={node.kind === "folder" ? expanded : undefined}
        // Usage logging: record only the COARSE kind (folder vs file), never the
        // node's name. Private document/folder names are PII and must not leave
        // the machine — the global click-capture ships data-log labels to the
        // hosted usage endpoint keyed to the user's email/contact id.
        data-log-type={node.kind === "folder" ? "folder" : "file"}
        data-log={node.kind === "folder" ? "folder" : "file"}
        onClick={activate}
        onKeyDown={(e) => {
          // Keys on inner controls (the eye, unlink, checkbox) bubble up here;
          // only handle keys aimed at the row itself.
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault(); // Space must not scroll the tree
            activate();
          } else if (node.kind === "folder" && e.key === "ArrowRight") {
            e.preventDefault();
            setOpen(true);
          } else if (node.kind === "folder" && e.key === "ArrowLeft") {
            e.preventDefault();
            setOpen(false);
          }
        }}
        // Drag a file out to the chat panel to ask about just that file.
        draggable={attachable}
        onDragStart={(e) => {
          if (!attachable) return;
          e.dataTransfer.setData(
            FILE_DRAG_MIME,
            serializeDraggedFiles([{ id: node.id, name: node.name }]),
          );
          e.dataTransfer.effectAllowed = "copy";
        }}
      >
        <span
          className={styles.chevron}
          onClick={(e) => {
            if (node.kind !== "folder") return;
            e.stopPropagation();
            setOpen((o) => !o);
          }}
        >
          {node.kind === "folder" ? (
            expanded ? <ChevronDownRegular /> : <ChevronRightRegular />
          ) : null}
        </span>
        {selectionMode && (
          <Checkbox
            className={styles.check}
            checked={selected}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(node.id);
            }}
            aria-label={`Select ${node.name}`}
          />
        )}
        {fileIcon(node, styles.icon)}
        <Text className={styles.name} size={300}>
          {node.name}
        </Text>
        {node.external && (
          <Tooltip content="Linked in place (not copied)" relationship="label">
            <Badge size="small" appearance="outline" icon={<LinkRegular />}>
              linked
            </Badge>
          </Tooltip>
        )}
        {node.external && node.parentId === null && (
          <Tooltip content="Unlink (leaves the real files in place)" relationship="label">
            <Button
              appearance="subtle"
              size="small"
              icon={<DismissRegular />}
              aria-label="Unlink"
              onClick={(e) => {
                e.stopPropagation();
                onUnlink(node.id);
              }}
            />
          </Tooltip>
        )}
        <Tooltip content={eyeLabel} relationship="label">
          <Button
            appearance="subtle"
            size="small"
            className={node.ragIncluded ? styles.eyeOn : undefined}
            icon={node.ragIncluded ? <EyeRegular /> : <EyeOffRegular />}
            aria-label={eyeLabel}
            aria-pressed={node.ragIncluded}
            onClick={(e) => {
              e.stopPropagation();
              toggleVisibility();
            }}
          />
        </Tooltip>
      </div>
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            <MenuItem
              icon={node.ragIncluded ? <EyeOffRegular /> : <EyeRegular />}
              onClick={toggleVisibility}
            >
              {node.ragIncluded ? "Hide from AI" : "Visible to AI"}
            </MenuItem>
            <MenuItem icon={<DeleteRegular />} onClick={() => onRemove(node.id)}>
              Remove from vault
            </MenuItem>
          </MenuList>
        </MenuPopover>
      </Menu>
      {node.kind === "folder" && expanded && (
        <div>
          {shownKids.map((k) => (
            <TreeRow
              key={k.id}
              node={k}
              depth={depth + 1}
              childrenOf={childrenOf}
              selectionMode={selectionMode}
              isSelected={isSelected}
              onToggle={onToggle}
              onSelect={onSelect}
              onUnlink={onUnlink}
              onRemove={onRemove}
              visibleIds={visibleIds}
              forceExpand={forceExpand}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileExplorer() {
  const styles = useStyles();
  const sources = useRagStore((s) => s.sources);
  const nodes = useRagStore((s) => s.nodes);
  const selectionMode = useRagStore((s) => s.selectionMode);
  const setSelectionMode = useRagStore((s) => s.setSelectionMode);
  const selectedIds = useRagStore((s) => s.selectedIds);
  const toggleSelected = useRagStore((s) => s.toggleSelected);
  const selectAll = useRagStore((s) => s.selectAll);
  const clearSelection = useRagStore((s) => s.clearSelection);
  const applySelection = useRagStore((s) => s.applySelection);
  const toggleIncluded = useRagStore((s) => s.toggleIncluded);
  const removeReference = useRagStore((s) => s.removeReference);
  const removeFromVault = useRagStore((s) => s.removeFromVault);
  const refresh = useRagStore((s) => s.load);
  const upload = useRagStore((s) => s.upload);
  const linkPaths = useRagStore((s) => s.linkPaths);
  const processing = useRagStore((s) => s.processing);
  const desktop = useRagStore((s) => s.desktop);
  const lastError = useRagStore((s) => s.lastError);
  const clearLastError = useRagStore((s) => s.clearLastError);
  const sharepoint = useRagStore((s) => s.sharepoint);
  const connectSharePoint = useRagStore((s) => s.connectSharePoint);
  const closeSharePointDialog = useRagStore((s) => s.closeSharePointDialog);
  const disconnectSharePoint = useRagStore((s) => s.disconnectSharePoint);
  // The user's effective default-inclusion behavior (explicit onboarding choice,
  // else the assigned A/B variant). "include" carries a prominent "you control
  // what AI sees" reassurance since files are searchable the moment they're added.
  const defaultInclusion = useAuthStore(
    (s) => s.onboarding.defaultInclusion ??
      (s.onboarding.defaultInclusionVariant === "opt_out" ? "include" : undefined),
  );
  const includeByDefault = defaultInclusion === "include";

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const isSelected = (id: string) => selectedSet.has(id);
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  // The visibility switch reflects (and sets) the whole selection at once.
  const allSelectedVisible =
    selectedIds.length > 0 && selectedIds.every((id) => nodeById.get(id)?.ragIncluded);

  // Ids queued for a "Remove from vault" confirmation (single via right-click, or
  // the whole selection via the bulk action).
  const [pendingRemove, setPendingRemove] = useState<string[] | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);

  // Search + "Only visible to AI" filter over the tree.
  const [query, setQuery] = useState("");
  const [onlyVisible, setOnlyVisible] = useState(false);

  // The include-by-default note is reassurance, not a control - once read it
  // can be dismissed for good (persisted so it doesn't return every launch).
  const [controlNoteDismissed, setControlNoteDismissed] = useState(false);
  useEffect(() => {
    try {
      if (window.localStorage.getItem(CONTROL_NOTE_DISMISSED_KEY) === "1") {
        setControlNoteDismissed(true);
      }
    } catch {
      /* private mode / storage full - the note simply shows again */
    }
  }, []);
  const dismissControlNote = () => {
    setControlNoteDismissed(true);
    try {
      window.localStorage.setItem(CONTROL_NOTE_DISMISSED_KEY, "1");
    } catch {
      /* private mode / storage full - dismissal lasts for this session only */
    }
  };

  const includedCount = nodes.filter((n) => n.kind === "file" && n.ragIncluded).length;
  const fileCount = nodes.filter((n) => n.kind === "file").length;
  // Index children by parent once so recursive tree rendering is O(n), not O(n^2).
  const childrenByParent = useMemo(() => {
    const map = new Map<string | null, FileNode[]>();
    for (const n of nodes) {
      const arr = map.get(n.parentId);
      if (arr) arr.push(n);
      else map.set(n.parentId, [n]);
    }
    return map;
  }, [nodes]);
  const childrenOf = (id: string | null) => childrenByParent.get(id) ?? [];

  const trimmedQuery = query.trim().toLowerCase();
  const filterActive = trimmedQuery !== "" || onlyVisible;
  // Rows the active search/filter keeps: direct matches plus every ancestor,
  // so a match nested inside collapsed folders stays reachable. null means no
  // filter - render everything. One pass over `nodes` keeps this cheap.
  const visibleIds = useMemo(() => {
    if (!filterActive) return null;
    const set = new Set<string>();
    for (const n of nodes) {
      const matches =
        (trimmedQuery === "" || n.name.toLowerCase().includes(trimmedQuery)) &&
        (!onlyVisible || n.ragIncluded);
      if (!matches) continue;
      let cur: FileNode | undefined = n;
      while (cur && !set.has(cur.id)) {
        set.add(cur.id);
        cur = cur.parentId === null ? undefined : nodeById.get(cur.parentId);
      }
    }
    return set;
  }, [filterActive, nodes, trimmedQuery, onlyVisible, nodeById]);

  // Outcome of the last add (link or upload) worth telling the user about -
  // rendered as a dismissible banner instead of a silent console.warn.
  const [addNotice, setAddNotice] = useState<string | null>(null);

  // Optimistic visibility toggles reconcile in the store; when a POST fails the
  // store reloads and reports here, and the same notice banner surfaces it.
  useEffect(() => {
    if (!lastError) return;
    setAddNotice(lastError);
    clearLastError();
  }, [lastError, clearLastError]);

  const reportSkipped = (skipped: { name: string; reason: string }[]) => {
    if (skipped.length === 0) return;
    const shown = skipped.slice(0, 3).map((s) => `${s.name} (${s.reason})`).join(", ");
    setAddNotice(
      `${skipped.length} item${skipped.length > 1 ? "s" : ""} could not be added: ` +
        shown +
        (skipped.length > 3 ? `, and ${skipped.length - 3} more` : ""),
    );
  };

  /** Link paths in place, returning any per-path failures as skip records. */
  const linkFailures = async (paths: string[]) => {
    const { failed } = await linkPaths(paths);
    return failed.map((f) => ({ name: f.path, reason: f.reason }));
  };

  /** Link paths in place and surface any per-path failures. */
  const linkAndReport = async (paths: string[]) => {
    reportSkipped(await linkFailures(paths));
  };

  /**
   * Add files coming from an OS drop or a picker. On the desktop, dropped items
   * resolve to their real paths and are LINKED in place - no copy is made, and
   * whole folders work (a browser FileList cannot read a directory's bytes).
   * Anything without a path (e.g. an image dragged out of a web page) falls
   * back to a byte upload into the vault.
   */
  const sendFiles = (list: FileList | null, opts: { preferLink?: boolean } = {}) => {
    if (!list || !list.length) return;
    const files = Array.from(list);
    if (opts.preferLink !== false) {
      const { paths, unresolved } = pathsForFiles(files);
      if (paths.length > 0) {
        void (async () => {
          const problems = await linkFailures(paths);
          if (unresolved.length > 0) {
            const { skipped } = await upload(unresolved);
            problems.push(...skipped);
          }
          reportSkipped(problems);
        })();
        return;
      }
    }
    void upload(files).then(({ skipped }) => reportSkipped(skipped));
  };

  /**
   * The single "add files" entry point shared by the toolbar's Browse menu,
   * the first-run empty state, and the app-wide "lighthouse:browse-files"
   * event: on the desktop the native link-in-place picker (link-first, no
   * copy), on the web the hidden file input.
   */
  const browseForFiles = () => {
    if (desktop) {
      void desktopBridge()?.linkDialog(false).then((paths) => {
        if (paths.length) void linkAndReport(paths);
      });
      return;
    }
    fileInputRef.current?.click();
  };
  // Latest-closure ref so the mount-once window listener below never goes
  // stale (same pattern as chat's readAloudRef).
  const browseRef = useRef(browseForFiles);
  browseRef.current = browseForFiles;
  useEffect(() => {
    const onBrowse = () => browseRef.current();
    window.addEventListener("lighthouse:browse-files", onBrowse);
    return () => window.removeEventListener("lighthouse:browse-files", onBrowse);
  }, []);

  // Native OS drag-drop (desktop shell). The DOM "Files" events below never
  // fire on Windows (WebView2 suppresses them while Tauri's native handler is
  // active) and would double-handle drops on macOS — so inside the shell, the
  // native events (rebroadcast as lighthouse:os-* CustomEvents, carrying real
  // paths and folder support) are the only OS-drop path. The explorer claims
  // every drop that isn't over the chat pane: adding to the vault is the
  // primary intent, and it must work even where this sidebar isn't the exact
  // drop point. Ignored while the vault is locked (the section sits inert).
  const sectionRef = useRef<HTMLElement>(null);
  const linkAndReportRef = useRef(linkAndReport);
  linkAndReportRef.current = linkAndReport;
  useEffect(() => {
    if (!isDesktopShell()) return;
    const overChat = (x: number, y: number) =>
      Boolean(document.elementFromPoint(x, y)?.closest('[data-lh-pane="chat"]'));
    const locked = () => Boolean(sectionRef.current?.closest("[inert]"));
    const onDrag = (e: Event) => {
      const { x, y } = (e as CustomEvent<{ x: number; y: number }>).detail ?? { x: -1, y: -1 };
      setDragging(!locked() && !overChat(x, y));
    };
    const onLeave = () => setDragging(false);
    const onDrop = (e: Event) => {
      const detail = (e as CustomEvent<{ paths?: string[]; x: number; y: number }>).detail;
      setDragging(false);
      if (!detail?.paths?.length || locked() || overChat(detail.x, detail.y)) return;
      void linkAndReportRef.current(detail.paths);
    };
    window.addEventListener("lighthouse:os-drag", onDrag);
    window.addEventListener("lighthouse:os-drag-leave", onLeave);
    window.addEventListener("lighthouse:os-drop", onDrop);
    return () => {
      window.removeEventListener("lighthouse:os-drag", onDrag);
      window.removeEventListener("lighthouse:os-drag-leave", onLeave);
      window.removeEventListener("lighthouse:os-drop", onDrop);
    };
  }, []);

  // DOM drag handlers: the OS-drop path for the WEB build only — inside the
  // desktop shell the native events above own OS drops (see isDesktopShell).
  const domOsDrag = (e: React.DragEvent) =>
    !isDesktopShell() && e.dataTransfer.types.includes("Files");

  return (
    <section
      ref={sectionRef}
      className={`${styles.panel}${dragging ? ` ${styles.panelDragging}` : ""}`}
      onDragEnter={(e) => {
        // Only react to OS file drops — ignore internal drags (e.g. dragging a
        // row out to the chat panel), which don't carry "Files".
        if (!domOsDrag(e)) return;
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (!domOsDrag(e)) return;
        e.preventDefault();
      }}
      onDragLeave={(e) => {
        if (!domOsDrag(e)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(e) => {
        if (!domOsDrag(e)) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        sendFiles(e.dataTransfer.files);
      }}
    >
      <div className={styles.header}>
        <Title3>Files</Title3>
        <div className={styles.toolbar}>
          <Badge appearance="tint" color="brand">
            {includedCount} of {fileCount} visible to AI
          </Badge>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              sendFiles(e.target.files, { preferLink: false }); // explicit copy
              e.target.value = "";
            }}
          />
          {/* webkitdirectory enables folder selection; set imperatively since
              it isn't a typed React prop. */}
          <input
            ref={(el) => {
              folderInputRef.current = el;
              if (el) {
                el.setAttribute("webkitdirectory", "");
                el.setAttribute("directory", "");
              }
            }}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              sendFiles(e.target.files, { preferLink: false }); // explicit copy
              e.target.value = "";
            }}
          />
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Button icon={<FolderOpenRegular />} appearance="primary" size="small">
                Browse…
              </Button>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                {/* Link-first on the desktop: files stay where they are and are
                    read in place - no duplicate copy is made. Copying in stays
                    available below as the explicit secondary option. */}
                {desktop && (
                  <>
                    <MenuItem icon={<LinkRegular />} onClick={browseForFiles}>
                      Files… (linked in place)
                    </MenuItem>
                    <MenuItem
                      icon={<LinkRegular />}
                      onClick={() => {
                        void desktopBridge()?.linkDialog(true).then((paths) => {
                          if (paths.length) void linkAndReport(paths);
                        });
                      }}
                    >
                      Folder… (linked in place)
                    </MenuItem>
                    <MenuDivider />
                  </>
                )}
                <MenuItem
                  icon={<DocumentRegular />}
                  onClick={() => fileInputRef.current?.click()}
                >
                  {desktop ? "Copy files in…" : "Files…"}
                </MenuItem>
                <MenuItem
                  icon={<FolderAddRegular />}
                  onClick={() => folderInputRef.current?.click()}
                >
                  {desktop ? "Copy folder in…" : "Folder…"}
                </MenuItem>
                <MenuDivider />
                <MenuItem
                  icon={<CloudArrowUpRegular />}
                  onClick={() => void connectSharePoint()}
                >
                  Connect SharePoint…
                </MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
          <Tooltip content="Re-scan the vault for new files" relationship="label">
            <Button
              icon={<ArrowSyncRegular />}
              size="small"
              appearance="subtle"
              aria-label="Refresh"
              onClick={() => void refresh()}
            />
          </Tooltip>
          <Switch
            checked={selectionMode}
            onChange={(_, d) => setSelectionMode(d.checked)}
            label="Selection mode"
          />
        </div>
      </div>

      {includeByDefault && !controlNoteDismissed && (
        <div className={styles.controlNote}>
          <ShieldKeyholeRegular fontSize={20} className={styles.controlNoteIcon} />
          <Text size={200}>
            Your files are visible to AI by default - <b>you control what it sees</b>.
            Use the eye on any file or folder to hide it.
          </Text>
          <span className={styles.spacer} />
          <Button
            icon={<DismissRegular />}
            size="small"
            appearance="subtle"
            aria-label="Dismiss"
            onClick={dismissControlNote}
          />
        </div>
      )}

      {addNotice && (
        <div className={styles.addNotice}>
          <Text size={200}>{addNotice}</Text>
          <span className={styles.spacer} />
          <Button
            icon={<DismissRegular />}
            size="small"
            appearance="subtle"
            aria-label="Dismiss"
            onClick={() => setAddNotice(null)}
          />
        </div>
      )}

      {processing && (
        <div className={styles.processingOverlay} role="status" aria-live="polite">
          <Spinner size="large" />
          <Text size={400} weight="semibold">
            {processing.label} {Math.min(processing.done + 1, processing.total)} of {processing.total}…
          </Text>
          <Text size={200}>
            {processing.label === "Linking"
              ? "Files are referenced in place - nothing is copied."
              : "Copying files into your vault."}
          </Text>
        </div>
      )}

      {selectionMode && (
        <div className={styles.actionBar}>
          <Text size={300} weight="semibold">
            {selectedIds.length} selected
          </Text>
          <Button
            appearance="subtle"
            size="small"
            onClick={() => {
              // Every file the current search/filter shows — with no filter
              // active, that is genuinely the whole vault in one click.
              const all = nodes
                .filter((n) => n.kind === "file" && (!visibleIds || visibleIds.has(n.id)))
                .map((n) => n.id);
              selectAll(all);
            }}
            title={
              filterActive
                ? "Select every file the current filter shows"
                : "Select every file in the vault"
            }
          >
            Select all
          </Button>
          <span className={styles.spacer} />
          <Switch
            checked={Boolean(allSelectedVisible)}
            disabled={selectedIds.length === 0}
            onChange={(_, d) => void applySelection(d.checked)}
            label="Visible to AI"
          />
          <Button
            icon={<DeleteRegular />}
            size="small"
            disabled={selectedIds.length === 0}
            onClick={() => setPendingRemove(selectedIds)}
          >
            Remove from vault
          </Button>
          <Button
            appearance="subtle"
            size="small"
            disabled={selectedIds.length === 0}
            onClick={() => clearSelection()}
          >
            Clear
          </Button>
        </div>
      )}

      {nodes.length > 0 && (
        <div className={styles.filterBar}>
          <SearchBox
            className={styles.search}
            size="small"
            placeholder="Search files"
            value={query}
            onChange={(_, d) => setQuery(d.value)}
          />
          <ToggleButton
            size="small"
            appearance="subtle"
            icon={<EyeRegular />}
            checked={onlyVisible}
            onClick={() => setOnlyVisible((v) => !v)}
          >
            Only visible to AI
          </ToggleButton>
        </div>
      )}

      <div className={styles.scroll}>
        {nodes.length === 0 && sources.length <= 1 ? (
          // First-run: nothing added yet across any source, so the per-source
          // one-liners would just repeat themselves - show one real call to
          // action instead. Drag-drop onto the whole panel still works.
          <div className={styles.emptyState}>
            <FolderAddRegular className={styles.emptyStateIcon} />
            <Text size={400} weight="semibold">
              Add your first files
            </Text>
            <Text size={300}>
              Drag files or folders here, or browse — they stay on your machine.
            </Text>
            <Button appearance="primary" icon={<FolderOpenRegular />} onClick={browseForFiles}>
              Browse…
            </Button>
            <Text size={200} className={styles.emptyStatePrivacy}>
              Files never leave your computer unless you choose a cloud AI model.
            </Text>
          </div>
        ) : visibleIds && visibleIds.size === 0 ? (
          <div className={styles.empty}>
            <Text size={300}>No matches</Text>
          </div>
        ) : (
          sources.map((source) => {
            const roots = nodes.filter(
              (n) =>
                n.sourceId === source.id &&
                n.parentId === null &&
                (!visibleIds || visibleIds.has(n.id)),
            );
            // While filtering, drop whole sources with no matches instead of
            // rendering an orphaned header.
            if (filterActive && roots.length === 0) return null;
            return (
              <div key={source.id}>
                <div className={styles.sourceLabel}>
                  {/* "sharepoint" is the cloud connector's source id (see config). */}
                  {source.id === "sharepoint" ? (
                    <CloudArrowUpRegular />
                  ) : source.kind === "database" ? (
                    <DatabaseRegular />
                  ) : (
                    <FolderRegular />
                  )}
                  <Text weight="semibold">{source.name}</Text>
                  {!source.available && (
                    <Badge appearance="outline" color="danger">
                      unavailable
                    </Badge>
                  )}
                  {source.id === "sharepoint" && (
                    <>
                      <span className={styles.spacer} />
                      <Tooltip content="Disconnect SharePoint" relationship="label">
                        <Button
                          icon={<PlugDisconnectedRegular />}
                          size="small"
                          appearance="subtle"
                          aria-label="Disconnect SharePoint"
                          onClick={() => void disconnectSharePoint()}
                        />
                      </Tooltip>
                    </>
                  )}
                </div>
                {roots.length === 0 ? (
                  <div className={styles.empty}>
                    <Text size={300}>
                      No files yet. Use <b>Browse…</b>, or drag items here.
                    </Text>
                  </div>
                ) : (
                  <div className={source.available ? undefined : styles.dimmed}>
                    {roots.map((node) => (
                      <TreeRow
                        key={node.id}
                        node={node}
                        depth={0}
                        childrenOf={childrenOf}
                        selectionMode={selectionMode}
                        isSelected={isSelected}
                        onToggle={(id) => void toggleIncluded(id)}
                        onSelect={(id) => toggleSelected(id)}
                        onUnlink={(id) => void removeReference(id)}
                        onRemove={(id) => setPendingRemove([id])}
                        visibleIds={visibleIds}
                        forceExpand={filterActive}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <Dialog
        open={pendingRemove !== null}
        onOpenChange={(_, d) => {
          if (!d.open) {
            setPendingRemove(null);
            setRemoveError(null);
          }
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Remove from vault?</DialogTitle>
            <DialogContent>
              {pendingRemove?.length === 1
                ? "This item will be moved to the vault's trash and dropped from the index. Linked items are only unlinked — your real files stay where they are. You can restore from .rag-vault/trash."
                : `These ${pendingRemove?.length ?? 0} items will be moved to the vault's trash and dropped from the index. Linked items are only unlinked. You can restore from .rag-vault/trash.`}
              {removeError && (
                <Text as="p" className={styles.removeError}>
                  {removeError}
                </Text>
              )}
            </DialogContent>
            <DialogActions>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="secondary">Cancel</Button>
              </DialogTrigger>
              <Button
                appearance="primary"
                onClick={() => {
                  const ids = pendingRemove;
                  if (!ids) return;
                  setRemoveError(null);
                  void removeFromVault(ids).then(
                    () => setPendingRemove(null),
                    (err) =>
                      setRemoveError(
                        err instanceof Error ? err.message : "Removal failed",
                      ),
                  );
                }}
              >
                Remove
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* SharePoint device-code sign-in. */}
      <Dialog
        open={sharepoint.open}
        onOpenChange={(_, d) => {
          if (!d.open) closeSharePointDialog();
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Connect SharePoint</DialogTitle>
            <DialogContent className={styles.connectBody}>
              {sharepoint.phase === "starting" && (
                <div className={styles.waitingRow}>
                  <Spinner size="tiny" />
                  <Text>Starting sign-in…</Text>
                </div>
              )}

              {sharepoint.phase === "waiting" && (
                <>
                  <Text>
                    1. Open{" "}
                    <Link href={sharepoint.verificationUri} target="_blank" rel="noreferrer">
                      {sharepoint.verificationUri?.replace(/^https?:\/\//, "")}
                    </Link>{" "}
                    and enter this code:
                  </Text>
                  <span className={styles.deviceCode}>{sharepoint.userCode}</span>
                  <Text size={300}>
                    2. Sign in with your work or school account and approve access.
                  </Text>
                  <div className={styles.waitingRow}>
                    <Spinner size="tiny" />
                    <Text size={300}>Waiting for you to finish in the browser…</Text>
                  </div>
                </>
              )}

              {sharepoint.phase === "connected" && (
                <Text>✅ Connected. Your SharePoint files now appear in the list.</Text>
              )}

              {sharepoint.phase === "expired" && (
                <Text>The code expired before sign-in completed. Please try again.</Text>
              )}

              {sharepoint.phase === "error" && (
                <Text>Could not connect: {sharepoint.error}</Text>
              )}
            </DialogContent>
            <DialogActions>
              {(sharepoint.phase === "expired" || sharepoint.phase === "error") && (
                <Button appearance="primary" onClick={() => void connectSharePoint()}>
                  Try again
                </Button>
              )}
              <Button appearance="secondary" onClick={() => closeSharePointDialog()}>
                {sharepoint.phase === "connected" ? "Done" : "Cancel"}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </section>
  );
}
