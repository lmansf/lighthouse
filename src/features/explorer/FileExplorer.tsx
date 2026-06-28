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
  ArrowUploadRegular,
  ChevronDownRegular,
  ChevronRightRegular,
  DatabaseRegular,
  DismissRegular,
  DocumentRegular,
  DocumentPdfRegular,
  FolderRegular,
  FolderAddRegular,
  LinkRegular,
} from "@fluentui/react-icons";
import type { FileNode } from "@/contracts";
import { useRagStore } from "@/stores/useRagStore";

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
  onToggle: (id: string) => void;
  onUnlink: (id: string) => void;
}

function TreeRow({ node, depth, childrenOf, onToggle, onUnlink }: TreeRowProps) {
  const styles = useStyles();
  const [open, setOpen] = useState(depth < 1); // top-level folders open by default
  const kids = node.kind === "folder" ? childrenOf(node.id) : [];

  return (
    <div>
      <div
        className={`${styles.row}${node.ragIncluded ? ` ${styles.rowIncluded}` : ""}`}
        style={{ paddingLeft: `${depth * 18 + 4}px` }}
        role="button"
        tabIndex={0}
        onClick={() => onToggle(node.id)}
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
      {node.kind === "folder" && open && (
        <div>
          {kids.map((k) => (
            <TreeRow
              key={k.id}
              node={k}
              depth={depth + 1}
              childrenOf={childrenOf}
              onToggle={onToggle}
              onUnlink={onUnlink}
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
  const toggleIncluded = useRagStore((s) => s.toggleIncluded);
  const removeReference = useRagStore((s) => s.removeReference);
  const refresh = useRagStore((s) => s.load);
  const upload = useRagStore((s) => s.upload);

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
    void upload(Array.from(list)).then((skipped) => {
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
      onDragEnter={() => {
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(e) => {
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
          <Button
            icon={<ArrowUploadRegular />}
            appearance="primary"
            size="small"
            onClick={() => fileInputRef.current?.click()}
          >
            Add files
          </Button>
          <Button
            icon={<FolderAddRegular />}
            size="small"
            onClick={() => folderInputRef.current?.click()}
          >
            Add folder
          </Button>
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

      <div className={styles.scroll}>
        {sources.map((source) => {
          const roots = nodes.filter(
            (n) => n.sourceId === source.id && n.parentId === null,
          );
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
                    No files yet. Use <b>Add files</b> or <b>Add folder</b>, or drag items here.
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
                      onToggle={(id) => void toggleIncluded(id)}
                      onUnlink={(id) => void removeReference(id)}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
