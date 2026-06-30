"use client";

/**
 * [TEAM: explorer]
 *
 * File tree for the local vault. Renders the real node tree (top-level items and
 * nested folders), lets you toggle items in/out of the RAG index, add files or
 * whole folders (copied into the vault), and shows items *linked* in place
 * (added by reference, not copied).
 *
 * Keep using `useRagStore` (do not import other features directly).
 */

import { useMemo, useRef, useState } from "react";
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
  Spinner,
  Switch,
  Text,
  Title3,
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

const useStyles = makeStyles({
  panel: {
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    height: "100%",
    ...shorthands.borderRadius(tokens.borderRadiusLarge),
    ...shorthands.border("2px", "dashed", "transparent"),
    transitionProperty: "border-color, background-color",
    transitionDuration: tokens.durationFaster,
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
}: TreeRowProps) {
  const styles = useStyles();
  const [open, setOpen] = useState(depth < 1); // top-level folders open by default
  const kids = node.kind === "folder" ? childrenOf(node.id) : [];
  const selected = selectionMode && isSelected(node.id);
  // Cloud-connector files (namespaced ids) live remotely, not in the local vault
  // that attachment retrieval walks, so only local-vault files can be attached.
  const attachable = node.kind === "file" && !node.id.startsWith(`${node.sourceId}::`);
  // In selection mode a click picks the row; otherwise it toggles RAG inclusion.
  const activate = () => {
    if (selectionMode) {
      onSelect(node.id);
      return;
    }
    // Privacy-safe availability telemetry: count THIS click (not the folder's
    // cascade of descendants); the row's current state decides the direction and
    // `scope` is a coarse kind only - never a name, id, or path.
    logEvent(node.ragIncluded ? "file_made_unavailable" : "file_made_available", {
      scope: node.kind === "folder" ? "folder" : "file",
    });
    onToggle(node.id);
  };

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
        // Usage logging: a folder/file row, labelled by its name (names only).
        data-log-type={node.kind === "folder" ? "folder" : "file"}
        data-log={node.name}
        onClick={activate}
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
            open ? <ChevronDownRegular /> : <ChevronRightRegular />
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
        {node.ragIncluded && (
          <Badge size="small" appearance="tint" color="brand">
            included
          </Badge>
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
      </div>
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            <MenuItem icon={<DeleteRegular />} onClick={() => onRemove(node.id)}>
              Remove from vault
            </MenuItem>
          </MenuList>
        </MenuPopover>
      </Menu>
      {node.kind === "folder" && open && (
        <div>
          {kids.map((k) => (
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
  const clearSelection = useRagStore((s) => s.clearSelection);
  const applySelection = useRagStore((s) => s.applySelection);
  const toggleIncluded = useRagStore((s) => s.toggleIncluded);
  const removeReference = useRagStore((s) => s.removeReference);
  const removeFromVault = useRagStore((s) => s.removeFromVault);
  const refresh = useRagStore((s) => s.load);
  const upload = useRagStore((s) => s.upload);
  const sharepoint = useRagStore((s) => s.sharepoint);
  const connectSharePoint = useRagStore((s) => s.connectSharePoint);
  const closeSharePointDialog = useRagStore((s) => s.closeSharePointDialog);
  const disconnectSharePoint = useRagStore((s) => s.disconnectSharePoint);
  // default-inclusion A/B: opt_out includes everything by default, so it carries
  // a prominent "you control what AI sees" reassurance.
  const optOut = useAuthStore((s) => s.onboarding.defaultInclusionVariant) === "opt_out";

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

  const includedCount = nodes.filter((n) => n.kind === "file" && n.ragIncluded).length;
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

  const sendFiles = (list: FileList | null) => {
    if (!list || !list.length) return;
    void upload(Array.from(list)).then(({ skipped }) => {
      if (skipped.length) {
        console.warn(
          `Skipped ${skipped.length} file(s): ` +
            skipped.map((s) => `${s.name} (${s.reason})`).join(", "),
        );
      }
    });
  };

  return (
    <section
      className={`${styles.panel}${dragging ? ` ${styles.panelDragging}` : ""}`}
      onDragEnter={(e) => {
        // Only react to OS file drops — ignore internal drags (e.g. dragging a
        // row out to the chat panel), which don't carry "Files".
        if (!e.dataTransfer.types.includes("Files")) return;
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
      }}
      onDragLeave={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
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
            {includedCount} in RAG
          </Badge>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              sendFiles(e.target.files);
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
              sendFiles(e.target.files);
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
                <MenuItem
                  icon={<DocumentRegular />}
                  onClick={() => fileInputRef.current?.click()}
                >
                  Files…
                </MenuItem>
                <MenuItem
                  icon={<FolderAddRegular />}
                  onClick={() => folderInputRef.current?.click()}
                >
                  Folder…
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

      {optOut && (
        <div className={styles.controlNote}>
          <ShieldKeyholeRegular fontSize={20} className={styles.controlNoteIcon} />
          <Text size={200}>
            Your files are visible to AI by default - <b>you control what it sees</b>.
            Click any file, folder, or source to take it out.
          </Text>
        </div>
      )}

      {selectionMode && (
        <div className={styles.actionBar}>
          <Text size={300} weight="semibold">
            {selectedIds.length} selected
          </Text>
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

      <div className={styles.scroll}>
        {sources.map((source) => {
          const roots = nodes.filter(
            (n) => n.sourceId === source.id && n.parentId === null,
          );
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
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
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
