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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  Input,
  Menu,
  MenuDivider,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  SearchBox,
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
  ArrowDownloadRegular,
  ArrowSyncRegular,
  CheckmarkCircleFilled,
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
  FolderArrowRightRegular,
  FolderRegular,
  FolderAddRegular,
  FolderOpenRegular,
  LinkRegular,
  OpenRegular,
  RenameRegular,
  ShieldKeyholeRegular,
  SparkleFilled,
} from "@fluentui/react-icons";
import type { FileNode } from "@/contracts";
import { useRagStore } from "@/stores/useRagStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { logEvent } from "@/lib/logEvent";
import { recordInterest } from "@/lib/comingSoon";
import { FILE_DRAG_MIME, parseDraggedFiles, serializeDraggedFiles } from "@/shell/dnd";
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
    backgroundColor: tokens.colorNeutralBackgroundAlpha2,
    backdropFilter: "blur(3px)",
    ...shorthands.borderRadius(tokens.borderRadiusLarge),
  },
  // A calm, self-contained progress card — a determinate bar that eases as it
  // fills, so a big add reads as steady motion, not a spinning "is it stuck?".
  progressCard: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: tokens.spacingVerticalS,
    width: "min(300px, 78%)",
    ...shorthands.padding(tokens.spacingVerticalL, tokens.spacingHorizontalL),
    backgroundColor: tokens.colorNeutralBackground1,
    ...shorthands.borderRadius(tokens.borderRadiusXLarge),
    boxShadow: tokens.shadow28,
  },
  progressIcon: {
    fontSize: "26px",
    color: tokens.colorBrandForeground1,
    animationName: { "0%,100%": { transform: "translateY(0)" }, "50%": { transform: "translateY(-3px)" } },
    animationDuration: "1.5s",
    animationIterationCount: "infinite",
    animationTimingFunction: "ease-in-out",
    "@media (prefers-reduced-motion: reduce)": { animationName: "none" },
  },
  progressTrack: {
    width: "100%",
    height: "7px",
    ...shorthands.borderRadius("100px"),
    backgroundColor: tokens.colorNeutralBackground4,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    ...shorthands.borderRadius("100px"),
    background: `linear-gradient(90deg, ${tokens.colorBrandBackground}, ${tokens.colorBrandBackgroundHover})`,
    // The buttery part: width changes glide instead of snapping per batch.
    transitionProperty: "width",
    transitionDuration: tokens.durationSlow,
    transitionTimingFunction: tokens.curveEasyEase,
    minWidth: "7px",
    "@media (prefers-reduced-motion: reduce)": { transitionDuration: "1ms" },
  },
  progressCount: { fontVariantNumeric: "tabular-nums" },
  // The drop invitation: a full-panel, unmistakable target the moment a file
  // is dragged over — the #1 action, so it gets the drama.
  dropOverlay: {
    position: "absolute",
    inset: 0,
    zIndex: 12,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    ...shorthands.padding(tokens.spacingHorizontalL),
    backgroundColor: tokens.colorBrandBackground2,
    backdropFilter: "blur(2px)",
    ...shorthands.borderRadius(tokens.borderRadiusLarge),
    pointerEvents: "none", // the panel underneath owns the real drop events
    animationName: { from: { opacity: 0 }, to: { opacity: 1 } },
    animationDuration: tokens.durationFast,
  },
  dropRing: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: tokens.spacingVerticalS,
    textAlign: "center",
    width: "100%",
    height: "100%",
    ...shorthands.padding(tokens.spacingVerticalXL),
    ...shorthands.border("2px", "dashed", tokens.colorBrandStroke1),
    ...shorthands.borderRadius(tokens.borderRadiusXLarge),
    justifyContent: "center",
    color: tokens.colorBrandForeground1,
  },
  dropIcon: {
    fontSize: "44px",
    animationName: { "0%,100%": { transform: "translateY(0)" }, "50%": { transform: "translateY(-6px)" } },
    animationDuration: "1.4s",
    animationIterationCount: "infinite",
    animationTimingFunction: "ease-in-out",
    "@media (prefers-reduced-motion: reduce)": { animationName: "none" },
  },
  dropHint: { color: tokens.colorNeutralForeground3 },
  // The payoff: a brief "added ✓" that slides in and auto-retires.
  addFlash: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalM),
    marginBottom: tokens.spacingVerticalM,
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    backgroundColor: tokens.colorStatusSuccessBackground1,
    color: tokens.colorStatusSuccessForeground1,
    ...shorthands.border("1px", "solid", tokens.colorStatusSuccessBorder1),
    animationName: {
      from: { opacity: 0, transform: "translateY(-6px)" },
      to: { opacity: 1, transform: "translateY(0)" },
    },
    animationDuration: tokens.durationNormal,
    animationTimingFunction: tokens.curveDecelerateMid,
    "@media (prefers-reduced-motion: reduce)": { animationName: "none" },
  },
  addFlashIcon: { fontSize: "18px", color: tokens.colorStatusSuccessForeground1, flexShrink: 0 },
  // A menu label that carries a small status badge ("Coming soon") beside it.
  comingSoonItem: { display: "inline-flex", alignItems: "center", gap: tokens.spacingHorizontalS },
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
  // Freshly-added rows slide in and glow, then settle — so a completed add
  // has a visible landing spot instead of files silently appearing.
  rowJustAdded: {
    animationName: {
      from: { opacity: 0, transform: "translateY(-5px)", backgroundColor: tokens.colorBrandBackground2 },
      "60%": { backgroundColor: tokens.colorBrandBackground2 },
      to: { opacity: 1, transform: "translateY(0)", backgroundColor: "transparent" },
    },
    animationDuration: "1.4s",
    animationTimingFunction: tokens.curveDecelerateMid,
    "@media (prefers-reduced-motion: reduce)": { animationName: "none" },
  },
  // A folder lights up as a "move into here" target while a file row is dragged
  // over it — the reparent gesture that surfaces the engine's op:move.
  rowDropInto: {
    backgroundColor: tokens.colorBrandBackground2,
    ...shorthands.outline("2px", "solid", tokens.colorBrandStroke1),
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

/** Cloud-connector nodes carry ids namespaced `${sourceId}::…` and live off-disk. */
function isRemoteId(node: FileNode): boolean {
  return node.id.startsWith(`${node.sourceId}::`);
}

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
  /** True in the desktop shell, where opening/revealing real files works. */
  desktop: boolean;
  /** Open a file in its native application. */
  onOpen: (id: string) => void;
  /** Reveal a node in the OS file manager (selecting it in its folder). */
  onReveal: (id: string) => void;
  /** Reparent a node under a folder (or the vault root, null). */
  onMove: (fromId: string, toParentId: string | null) => void;
  /** Open the rename dialog for a node (local vault nodes only). */
  onRename: (id: string, currentName: string) => void;
  /** Create a new folder inside this folder. */
  onNewFolderInside: (parentId: string) => void;
  /**
   * Valid move destinations for this node — the vault root plus every folder
   * except the node itself and its own descendants — or [] when it can't move
   * (a linked, cloud, or database node). Drives the "Move to…" submenu.
   */
  moveTargetsFor: (node: FileNode) => { id: string | null; name: string }[];
  /**
   * Ids the active search/filter keeps, or null when no filter is active.
   * Children outside the set are not rendered.
   */
  visibleIds: Set<string> | null;
  /** True while a search query is active: matched ancestors stay expanded. */
  forceExpand: boolean;
  /** Ids added in the last few seconds — these rows play the enter animation. */
  justAdded: Set<string>;
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
  desktop,
  onOpen,
  onReveal,
  onMove,
  onRename,
  onNewFolderInside,
  moveTargetsFor,
  visibleIds,
  forceExpand,
  justAdded,
}: TreeRowProps) {
  const styles = useStyles();
  const [open, setOpen] = useState(depth < 1); // top-level folders open by default
  // A folder highlights while a dragged file row hovers it (internal move).
  const [dropInto, setDropInto] = useState(false);
  // A search must reveal matches nested in collapsed folders, so it wins over
  // the user's manual open/closed state while the query is active.
  const expanded = forceExpand || open;
  const kids = node.kind === "folder" ? childrenOf(node.id) : [];
  const shownKids = visibleIds ? kids.filter((k) => visibleIds.has(k.id)) : kids;
  const selected = selectionMode && isSelected(node.id);
  // Cloud-connector nodes carry namespaced ids and live remotely, not on the
  // local disk — so open / reveal / move (all real-path operations) don't apply.
  const isRemote = node.id.startsWith(`${node.sourceId}::`);
  // Only local-vault files can be attached to a chat question.
  const attachable = node.kind === "file" && !isRemote;
  // Open natively (files), reveal in the OS file manager (files or folders),
  // and reparent (op:move) — all desktop-only, local-only.
  const openable = desktop && node.kind === "file" && !isRemote;
  const revealable = desktop && !isRemote;
  const moveTargets = moveTargetsFor(node);
  const movable = moveTargets.length > 0;
  // Rename + "new folder inside" apply to any local vault node (a linked, cloud,
  // or database node can't be renamed and doesn't hold vault children).
  const editable = !node.external && !isRemote && node.kind !== "database";
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
        }${justAdded.has(node.id) ? ` ${styles.rowJustAdded}` : ""}${
          dropInto ? ` ${styles.rowDropInto}` : ""
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
        // Double-click opens the file in its native app (desktop-only). Folders
        // keep their single-click expand; a stray double-click there is a no-op.
        onDoubleClick={() => {
          if (openable) onOpen(node.id);
        }}
        // A folder is a drop target for an internal MOVE: dragging a file row
        // (which carries FILE_DRAG_MIME) onto it reparents the file. OS file
        // drops carry "Files" instead and are handled by the section; internal
        // drags never do, so the two paths never cross.
        onDragOver={
          node.kind === "folder"
            ? (e) => {
                if (!e.dataTransfer.types.includes(FILE_DRAG_MIME)) return;
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = "move";
                if (!dropInto) setDropInto(true);
              }
            : undefined
        }
        onDragLeave={
          node.kind === "folder" ? () => dropInto && setDropInto(false) : undefined
        }
        onDrop={
          node.kind === "folder"
            ? (e) => {
                const dragged = parseDraggedFiles(e.dataTransfer);
                if (dragged.length === 0) return;
                e.preventDefault();
                e.stopPropagation();
                setDropInto(false);
                // Move every dragged file into this folder, skipping a no-op
                // drop onto the file's own parent; the engine rejects invalid
                // moves (into itself / a name clash) and the store surfaces it.
                for (const f of dragged) {
                  if (f.id !== node.id) onMove(f.id, node.id);
                }
              }
            : undefined
        }
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
          // copyMove: a drop on the chat pane attaches (copy); a drop on a
          // folder row reparents (move). Both effects must be allowed here.
          e.dataTransfer.effectAllowed = "copyMove";
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
            {openable && (
              <MenuItem icon={<OpenRegular />} onClick={() => onOpen(node.id)}>
                Open
              </MenuItem>
            )}
            {revealable && (
              <MenuItem icon={<FolderOpenRegular />} onClick={() => onReveal(node.id)}>
                Open containing folder
              </MenuItem>
            )}
            {movable && (
              <Menu>
                <MenuTrigger disableButtonEnhancement>
                  <MenuItem icon={<FolderArrowRightRegular />}>Move to…</MenuItem>
                </MenuTrigger>
                <MenuPopover>
                  <MenuList>
                    {moveTargets.map((t) => (
                      <MenuItem
                        key={t.id ?? "__root__"}
                        icon={<FolderRegular />}
                        onClick={() => onMove(node.id, t.id)}
                      >
                        {t.name}
                      </MenuItem>
                    ))}
                  </MenuList>
                </MenuPopover>
              </Menu>
            )}
            {editable && (
              <MenuItem icon={<RenameRegular />} onClick={() => onRename(node.id, node.name)}>
                Rename…
              </MenuItem>
            )}
            {editable && node.kind === "folder" && (
              <MenuItem icon={<FolderAddRegular />} onClick={() => onNewFolderInside(node.id)}>
                New folder inside…
              </MenuItem>
            )}
            {(openable || revealable || movable || editable) && <MenuDivider />}
            <MenuItem
              icon={node.ragIncluded ? <EyeOffRegular /> : <EyeRegular />}
              onClick={toggleVisibility}
            >
              {node.ragIncluded ? "Hide from AI" : "Visible to AI"}
            </MenuItem>
            {node.external && node.parentId === null && (
              <MenuItem icon={<DismissRegular />} onClick={() => onUnlink(node.id)}>
                Unlink (leave files in place)
              </MenuItem>
            )}
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
              desktop={desktop}
              onOpen={onOpen}
              onReveal={onReveal}
              onMove={onMove}
              onRename={onRename}
              onNewFolderInside={onNewFolderInside}
              moveTargetsFor={moveTargetsFor}
              visibleIds={visibleIds}
              forceExpand={forceExpand}
              justAdded={justAdded}
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
  const restoreLast = useRagStore((s) => s.restoreLast);
  const moveNode = useRagStore((s) => s.moveNode);
  const renameNode = useRagStore((s) => s.renameNode);
  const createFolder = useRagStore((s) => s.createFolder);
  const refresh = useRagStore((s) => s.load);
  const upload = useRagStore((s) => s.upload);
  const linkPaths = useRagStore((s) => s.linkPaths);
  const processing = useRagStore((s) => s.processing);
  const desktop = useRagStore((s) => s.desktop);
  const lastError = useRagStore((s) => s.lastError);
  const clearLastError = useRagStore((s) => s.clearLastError);
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
  // The completion payoff: `justAdded` drives the row-enter animation, and
  // `addFlash` shows the transient "added N ✓" banner. Both clear together
  // after a beat so they don't linger on a settled list.
  const [justAdded, setJustAdded] = useState<Set<string>>(() => new Set());
  const [addFlash, setAddFlash] = useState<number | null>(null);
  const flashTimer = useRef<number | null>(null);
  // A "coming soon" teaser thanks the user with a brief green note — the same
  // slide-in payoff as the add flash, its own copy and timer.
  const [interestNote, setInterestNote] = useState<string | null>(null);
  const interestTimer = useRef<number | null>(null);
  // "Removed N — Undo": a transient banner that restores the last removal in one
  // click, so no one has to hand-dig `.rag-vault/trash`. Auto-retires.
  const [removedCount, setRemovedCount] = useState<number | null>(null);
  const undoTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (flashTimer.current) window.clearTimeout(flashTimer.current);
      if (interestTimer.current) window.clearTimeout(interestTimer.current);
      if (undoTimer.current) window.clearTimeout(undoTimer.current);
    },
    [],
  );
  const showUndo = (count: number) => {
    if (count <= 0) return;
    setRemovedCount(count);
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => setRemovedCount(null), 8000);
  };
  const undoRemove = () => {
    setRemovedCount(null);
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
    void restoreLast();
  };
  const celebrate = (ids: string[]) => {
    if (ids.length === 0) return;
    setJustAdded(new Set(ids));
    setAddFlash(ids.length);
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => {
      setAddFlash(null);
      setJustAdded(new Set());
    }, 3800);
  };
  // Register interest in a not-yet-shipped feature: log it (telemetry event +
  // the local tally behind the Experiments leaderboard) and thank the user,
  // without running any real connector flow.
  const registerInterest = (id: string, thanks: string) => {
    recordInterest(id);
    setInterestNote(thanks);
    if (interestTimer.current) window.clearTimeout(interestTimer.current);
    interestTimer.current = window.setTimeout(() => setInterestNote(null), 4200);
  };

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

  // --- Desktop file actions: open natively, reveal in the OS file manager, and
  // reparent (op:move). Failures surface in the notice banner, never silently.
  const notifyIfError = async (res: Response, fallback: string) => {
    if (res.ok) return;
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    setAddNotice(data.error || fallback);
  };
  const openNode = (nodeId: string) => {
    void fetch("/api/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId }),
    })
      .then((res) => notifyIfError(res, "Couldn't open the file."))
      .catch(() => setAddNotice("Couldn't open the file."));
  };
  // A blank node id opens the vault folder itself (the toolbar button).
  const revealNode = (nodeId: string) => {
    void fetch("/api/reveal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(nodeId ? { nodeId } : {}),
    })
      .then((res) => notifyIfError(res, "Couldn't open the folder."))
      .catch(() => setAddNotice("Couldn't open the folder."));
  };
  const handleMove = (fromId: string, toParentId: string | null) => {
    void moveNode(fromId, toParentId).catch((err) =>
      setAddNotice(err instanceof Error ? err.message : "Move failed."),
    );
  };

  // Rename and "new folder" share one small name dialog: `mode` picks the copy
  // and which store action runs; `targetId` is the node to rename or the parent
  // to create in (null = vault root for a new folder).
  const [namePrompt, setNamePrompt] = useState<
    { mode: "rename" | "newFolder"; targetId: string | null; initial: string } | null
  >(null);
  const [nameValue, setNameValue] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const openRename = (id: string, current: string) => {
    setNamePrompt({ mode: "rename", targetId: id, initial: current });
    setNameValue(current);
    setNameError(null);
  };
  const openNewFolder = (parentId: string | null) => {
    setNamePrompt({ mode: "newFolder", targetId: parentId, initial: "" });
    setNameValue("");
    setNameError(null);
  };
  const submitName = () => {
    if (!namePrompt) return;
    const name = nameValue.trim();
    if (!name) {
      setNameError("Enter a name.");
      return;
    }
    const action =
      namePrompt.mode === "rename"
        ? renameNode(namePrompt.targetId as string, name)
        : createFolder(namePrompt.targetId, name);
    void action.then(
      () => setNamePrompt(null),
      (err) => setNameError(err instanceof Error ? err.message : "Something went wrong."),
    );
  };

  // Every local vault folder with a shallow "a / b / c" path label so same-named
  // folders in the Move-to menu are distinguishable. Computed once per tree.
  const folderTargets = useMemo(() => {
    const pathName = (n: FileNode): string => {
      const parts: string[] = [];
      let cur: FileNode | undefined = n;
      while (cur) {
        parts.unshift(cur.name);
        cur = cur.parentId === null ? undefined : nodeById.get(cur.parentId);
      }
      return parts.join(" / ");
    };
    return nodes
      .filter((n) => n.kind === "folder" && !n.external && !isRemoteId(n))
      .map((n) => ({ id: n.id, name: pathName(n), sourceId: n.sourceId, parentId: n.parentId }));
  }, [nodes, nodeById]);

  // Valid move destinations for a node: the vault root plus every folder in the
  // same source, minus the node itself, its descendants, and its current parent
  // (a no-op). Empty when the node can't move (linked, cloud, or a database).
  const moveTargetsFor = useCallback(
    (node: FileNode): { id: string | null; name: string }[] => {
      if (node.external || isRemoteId(node) || node.kind === "database") return [];
      const blocked = new Set<string>([node.id]);
      const stack = [node.id];
      while (stack.length) {
        const id = stack.pop()!;
        for (const c of childrenByParent.get(id) ?? []) {
          if (c.kind === "folder" && !blocked.has(c.id)) {
            blocked.add(c.id);
            stack.push(c.id);
          }
        }
      }
      const targets: { id: string | null; name: string }[] = [];
      if (node.parentId !== null) targets.push({ id: null, name: "Vault root" });
      for (const f of folderTargets) {
        if (f.sourceId === node.sourceId && !blocked.has(f.id) && f.id !== node.parentId) {
          targets.push({ id: f.id, name: f.name });
        }
      }
      return targets;
    },
    [folderTargets, childrenByParent],
  );

  /** Link paths in place, returning the new ids and any per-path failures. */
  const linkResult = async (paths: string[]) => {
    const { linked, failed } = await linkPaths(paths);
    return {
      addedIds: linked.map((l) => l.id),
      problems: failed.map((f) => ({ name: f.path, reason: f.reason })),
    };
  };

  /** Link paths in place, then celebrate what landed and surface failures. */
  const linkAndReport = async (paths: string[]) => {
    const { addedIds, problems } = await linkResult(paths);
    celebrate(addedIds);
    reportSkipped(problems);
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
          const { addedIds, problems } = await linkResult(paths);
          if (unresolved.length > 0) {
            const { addedIds: upIds, skipped } = await upload(unresolved);
            addedIds.push(...upIds);
            problems.push(...skipped);
          }
          celebrate(addedIds);
          reportSkipped(problems);
        })();
        return;
      }
    }
    void upload(files).then(({ addedIds, skipped }) => {
      celebrate(addedIds);
      reportSkipped(skipped);
    });
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
                  onClick={() =>
                    registerInterest(
                      "sharepoint",
                      "Thanks for your interest! We'll let you know the moment SharePoint is ready.",
                    )
                  }
                >
                  <span className={styles.comingSoonItem}>
                    SharePoint
                    <Badge appearance="tint" color="brand" size="small">
                      Coming soon
                    </Badge>
                  </span>
                </MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
          <Tooltip content="Create a new folder in the vault" relationship="label">
            <Button
              icon={<FolderAddRegular />}
              size="small"
              appearance="subtle"
              aria-label="New folder"
              onClick={() => openNewFolder(null)}
            />
          </Tooltip>
          {desktop && (
            <Tooltip content="Open the vault folder in your file manager" relationship="label">
              <Button
                icon={<FolderOpenRegular />}
                size="small"
                appearance="subtle"
                aria-label="Open vault folder"
                onClick={() => revealNode("")}
              />
            </Tooltip>
          )}
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

      {/* Drag invitation — the whole panel becomes an unmistakable target. */}
      {dragging && (
        <div className={styles.dropOverlay} aria-hidden>
          <div className={styles.dropRing}>
            <ArrowDownloadRegular className={styles.dropIcon} />
            <Text size={500} weight="semibold">
              Drop to add
            </Text>
            <Text size={300} className={styles.dropHint}>
              {desktop
                ? "Linked in place — your files aren't copied"
                : "They stay on your machine"}
            </Text>
          </div>
        </div>
      )}

      {addFlash !== null && (
        <div className={styles.addFlash} role="status" aria-live="polite">
          <CheckmarkCircleFilled className={styles.addFlashIcon} />
          <Text size={300} weight="semibold">
            Added {addFlash} {addFlash === 1 ? "file" : "files"}
          </Text>
        </div>
      )}

      {removedCount !== null && (
        <div className={styles.controlNote} role="status" aria-live="polite">
          <DeleteRegular fontSize={18} className={styles.controlNoteIcon} />
          <Text size={200}>
            Removed {removedCount} {removedCount === 1 ? "item" : "items"} — moved to the
            vault&apos;s trash.
          </Text>
          <span className={styles.spacer} />
          <Button size="small" appearance="primary" onClick={undoRemove}>
            Undo
          </Button>
        </div>
      )}

      {interestNote && (
        <div className={styles.addFlash} role="status" aria-live="polite">
          <SparkleFilled className={styles.addFlashIcon} />
          <Text size={300} weight="semibold">
            {interestNote}
          </Text>
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
          <div className={styles.progressCard}>
            <ArrowDownloadRegular className={styles.progressIcon} />
            <Text size={400} weight="semibold" className={styles.progressCount}>
              {processing.label} {Math.min(processing.done + 1, processing.total)} of {processing.total}
            </Text>
            <div
              className={styles.progressTrack}
              role="progressbar"
              aria-valuenow={processing.done}
              aria-valuemin={0}
              aria-valuemax={processing.total}
            >
              <div
                className={styles.progressFill}
                style={{
                  width: `${Math.round((processing.done / Math.max(1, processing.total)) * 100)}%`,
                }}
              />
            </div>
            <Text size={200} className={styles.dropHint}>
              {processing.label === "Linking"
                ? "Referenced in place — nothing is copied."
                : "Copying files into your vault."}
            </Text>
          </div>
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
                  {source.kind === "database" ? <DatabaseRegular /> : <FolderRegular />}
                  <Text weight="semibold">{source.name}</Text>
                  {!source.available && (
                    <Badge appearance="outline" color="danger">
                      unavailable
                    </Badge>
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
                        desktop={desktop}
                        onOpen={openNode}
                        onReveal={revealNode}
                        onMove={handleMove}
                        onRename={openRename}
                        onNewFolderInside={(pid) => openNewFolder(pid)}
                        moveTargetsFor={moveTargetsFor}
                        visibleIds={visibleIds}
                        forceExpand={filterActive}
                        justAdded={justAdded}
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
                ? "This item will be moved to the vault's trash and dropped from the index. Linked items are only unlinked — your real files stay where they are. You can Undo right after, or restore later from .rag-vault/trash."
                : `These ${pendingRemove?.length ?? 0} items will be moved to the vault's trash and dropped from the index. Linked items are only unlinked. You can Undo right after, or restore later from .rag-vault/trash.`}
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
                  const count = ids.length;
                  void removeFromVault(ids).then(
                    () => {
                      setPendingRemove(null);
                      showUndo(count);
                    },
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

      {/* Shared Rename / New-folder name dialog. */}
      <Dialog
        open={namePrompt !== null}
        onOpenChange={(_, d) => {
          if (!d.open) setNamePrompt(null);
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{namePrompt?.mode === "rename" ? "Rename" : "New folder"}</DialogTitle>
            <DialogContent>
              <Input
                value={nameValue}
                onChange={(_, d) => setNameValue(d.value)}
                placeholder={namePrompt?.mode === "rename" ? "New name" : "Folder name"}
                aria-label={namePrompt?.mode === "rename" ? "New name" : "Folder name"}
                autoFocus
                style={{ width: "100%" }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitName();
                  }
                }}
              />
              {nameError && (
                <Text as="p" className={styles.removeError}>
                  {nameError}
                </Text>
              )}
            </DialogContent>
            <DialogActions>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="secondary">Cancel</Button>
              </DialogTrigger>
              <Button appearance="primary" onClick={submitName}>
                {namePrompt?.mode === "rename" ? "Rename" : "Create"}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </section>
  );
}
