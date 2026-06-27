"use client";

/**
 * [TEAM: explorer] PLACEHOLDER.
 *
 * This is a working stub so the app runs and the contract seam is exercised.
 * The explorer team replaces this with the full organic, oversized file grid.
 * Keep using `useRagStore` (do not import other features directly).
 */

import { useRef, useState } from "react";
import {
  Badge,
  Button,
  Switch,
  Text,
  Title3,
  makeStyles,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import {
  ArrowUploadRegular,
  DatabaseRegular,
  DocumentRegular,
  DocumentPdfRegular,
  FolderRegular,
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
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalM,
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
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
    gap: tokens.spacingHorizontalL,
  },
  // Oversized, organic tiles - deliberately larger than real File Explorer.
  tile: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: tokens.spacingVerticalS,
    ...shorthands.padding(tokens.spacingVerticalL, tokens.spacingHorizontalM),
    minHeight: "140px",
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground2,
    ...shorthands.border("2px", "solid", tokens.colorTransparentStroke),
    cursor: "pointer",
    transitionProperty: "transform, box-shadow, border-color, background-color",
    transitionDuration: tokens.durationFaster,
    ":hover": {
      transform: "translateY(-2px)",
      boxShadow: tokens.shadow16,
      backgroundColor: tokens.colorNeutralBackground2Hover,
    },
  },
  tileIncluded: {
    ...shorthands.borderColor(tokens.colorBrandStroke1),
    backgroundColor: tokens.colorBrandBackground2,
  },
  tileDimmed: {
    opacity: 0.45,
  },
  icon: {
    fontSize: "44px",
  },
  name: {
    textAlign: "center",
    wordBreak: "break-word",
  },
});

function fileIcon(node: FileNode, className: string) {
  if (node.kind === "database") return <DatabaseRegular className={className} />;
  if (node.kind === "folder") return <FolderRegular className={className} />;
  if (node.mimeType === "application/pdf")
    return <DocumentPdfRegular className={className} />;
  return <DocumentRegular className={className} />;
}

export function FileExplorer() {
  const styles = useStyles();
  const sources = useRagStore((s) => s.sources);
  const nodes = useRagStore((s) => s.nodes);
  const selectionMode = useRagStore((s) => s.selectionMode);
  const setSelectionMode = useRagStore((s) => s.setSelectionMode);
  const toggleIncluded = useRagStore((s) => s.toggleIncluded);
  const upload = useRagStore((s) => s.upload);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const includedCount = nodes.filter((n) => n.kind === "file" && n.ragIncluded).length;

  const sendFiles = (list: FileList | null) => {
    if (list && list.length) void upload(Array.from(list));
  };

  return (
    <section
      className={`${styles.panel}${dragging ? ` ${styles.panelDragging}` : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
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
          <Button
            icon={<ArrowUploadRegular />}
            appearance="primary"
            size="small"
            onClick={() => fileInputRef.current?.click()}
          >
            Add files
          </Button>
          <Switch
            checked={selectionMode}
            onChange={(_, d) => setSelectionMode(d.checked)}
            label="Selection mode"
          />
        </div>
      </div>

      <div className={styles.scroll}>
        {sources.map((source) => {
          const children = nodes.filter(
            (n) => n.sourceId === source.id && n.parentId !== null,
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
              <div className={styles.grid}>
                {children.map((node) => {
                  const tileClasses = [styles.tile];
                  if (node.ragIncluded) tileClasses.push(styles.tileIncluded);
                  if (!source.available) tileClasses.push(styles.tileDimmed);
                  return (
                    <div
                      key={node.id}
                      className={tileClasses.join(" ")}
                      onClick={() => void toggleIncluded(node.id)}
                      role="button"
                      tabIndex={0}
                    >
                      {fileIcon(node, styles.icon)}
                      <Text className={styles.name} size={300}>
                        {node.name}
                      </Text>
                      {node.ragIncluded && (
                        <Badge size="small" appearance="tint" color="brand">
                          included
                        </Badge>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
