"use client";

/**
 * [TEAM: quickopen]
 *
 * Quick-open (time-savers): the Ctrl/Cmd+P palette — a fuzzy finder over the
 * vault tree the RAG store already holds. Entirely local: it ranks names and
 * paths the walker already produced (src/lib/quickOpen.ts) and never touches
 * the network or the engine.
 *
 * Opened by the shell shortcut's "lighthouse:quick-open" event (AppShell owns
 * the keydown, so this only ever fires in the MAIN window). Enter reveals the
 * highlighted file in the sidebar explorer ("lighthouse:reveal-node");
 * Ctrl/Cmd+Enter attaches it to the chat ("lighthouse:attach-file") — both
 * plain window events, so this feature stays decoupled from explorer and chat
 * internals. Each row shows the file's AI-visibility (eye) and "this device
 * only" (lock) state at a glance, straight off the node — the same
 * ragIncluded/localOnly the explorer's controls render.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogSurface,
  Input,
  Text,
  makeStyles,
  mergeClasses,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import {
  DatabaseRegular,
  DocumentPdfRegular,
  DocumentRegular,
  EyeOffRegular,
  EyeRegular,
  LockClosedRegular,
  SearchRegular,
} from "@fluentui/react-icons";
import { useRagStore } from "@/stores/useRagStore";
import { quickOpenMatches, type QuickOpenCandidate } from "@/lib/quickOpen";
import { modKey } from "@/features/onboarding/ModeChooser";

const useStyles = makeStyles({
  // A palette, not a modal form: pinned near the top (command-palette
  // convention — results grow downward without recentering), fixed width,
  // its own padding.
  surface: {
    position: "fixed",
    top: "12vh",
    bottom: "auto",
    width: "min(620px, 94vw)",
    maxWidth: "94vw",
    ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalS),
  },
  box: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
  },
  input: { width: "100%" },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: "1px",
    maxHeight: "min(48vh, 420px)",
    overflowY: "auto",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalS),
    borderRadius: tokens.borderRadiusMedium,
    cursor: "pointer",
    ":hover": { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
  rowActive: { backgroundColor: tokens.colorNeutralBackground1Selected },
  rowIcon: { fontSize: "18px", flexShrink: 0, color: tokens.colorNeutralForeground3 },
  rowName: {
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    flexShrink: 0,
    maxWidth: "55%",
  },
  // Matched characters get weight, not color — legible emphasis in both themes.
  hit: { fontWeight: tokens.fontWeightSemibold },
  rowPath: {
    color: tokens.colorNeutralForeground3,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    flexGrow: 1,
    minWidth: 0,
  },
  // The glance cluster, right-aligned: eye (AI visibility) + lock (local-only),
  // mirroring the explorer's colors so the states read identically everywhere.
  rowState: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    marginLeft: "auto",
    flexShrink: 0,
    fontSize: "16px",
  },
  eyeOn: { color: tokens.colorBrandForeground1 },
  eyeOff: { color: tokens.colorNeutralForeground4 },
  lockOn: { color: tokens.colorPaletteRedForeground1 },
  // Quiet single-line states (empty query / no matches) and the key hints.
  quiet: {
    color: tokens.colorNeutralForeground3,
    ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalS),
  },
  hints: {
    display: "flex",
    justifyContent: "flex-end",
    color: tokens.colorNeutralForeground3,
    ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalS),
    ...shorthands.borderTop("1px", "solid", tokens.colorNeutralStroke2),
  },
});

/** Row icon by kind (files only reach here; databases are the tree's leaves). */
function rowIcon(c: QuickOpenCandidate, className: string) {
  if (c.kind === "database") return <DatabaseRegular className={className} />;
  if (c.mimeType === "application/pdf") return <DocumentPdfRegular className={className} />;
  return <DocumentRegular className={className} />;
}

/** Name with the matched characters subtly emphasized (indices from the
 *  ranker's greedy scan — contiguous runs render as single spans). */
/** Wrap the matched query characters of `name` (indices in `hits`) in
 *  `hitClass` spans for subtle emphasis. Exported so the composer's @-mention
 *  picker (openspec §2) highlights hits the same way quick-open does. */
export function emphasize(name: string, hits: number[], hitClass: string): React.ReactNode {
  if (hits.length === 0) return name;
  const hitSet = new Set(hits);
  const out: React.ReactNode[] = [];
  let run = "";
  let runIsHit = hitSet.has(0);
  const flush = (endIdx: number) => {
    if (!run) return;
    out.push(runIsHit ? <span key={endIdx} className={hitClass}>{run}</span> : run);
  };
  for (let i = 0; i < name.length; i += 1) {
    const isHit = hitSet.has(i);
    if (isHit !== runIsHit) {
      flush(i);
      run = "";
      runIsHit = isHit;
    }
    run += name[i];
  }
  flush(name.length);
  return out;
}

export function QuickOpen() {
  const styles = useStyles();
  const nodes = useRagStore((s) => s.nodes);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Opened by the shell's Ctrl/Cmd+P (AppShell dispatches; see the shortcut
  // block there). Always reopens fresh — a finder starts from the query.
  useEffect(() => {
    const onOpen = () => {
      setQuery("");
      setSel(0);
      setOpen(true);
    };
    window.addEventListener("lighthouse:quick-open", onOpen);
    return () => window.removeEventListener("lighthouse:quick-open", onOpen);
  }, []);

  const matches = useMemo(
    () => (open ? quickOpenMatches(query, nodes) : []),
    [open, query, nodes],
  );
  // Clamp the highlight when the list shrinks under it (typing re-filters).
  const selIndex = matches.length === 0 ? -1 : Math.min(sel, matches.length - 1);

  // Keep the keyboard highlight in view as Down/Up walk past the fold.
  useEffect(() => {
    if (selIndex < 0) return;
    listRef.current
      ?.querySelector(`[data-qo-row="${selIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selIndex]);

  /**
   * Act on a row and close. Enter reveals in the explorer; Ctrl/Cmd+Enter
   * attaches to the chat — but only local vault FILES are attachable (the
   * explorer's own rule: connector items live remotely, database leaves
   * aren't files), so a non-attachable row falls back to reveal.
   */
  const act = (c: QuickOpenCandidate, wantAttach: boolean) => {
    setOpen(false);
    const node = nodes.find((n) => n.id === c.id);
    const attachable =
      !!node && node.kind === "file" && !node.id.startsWith(`${node.sourceId}::`);
    if (wantAttach && attachable) {
      window.dispatchEvent(
        new CustomEvent("lighthouse:attach-file", { detail: { id: c.id, name: c.name } }),
      );
      return;
    }
    window.dispatchEvent(
      new CustomEvent("lighthouse:reveal-node", { detail: { id: c.id } }),
    );
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (matches.length) setSel((selIndex + 1) % matches.length);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (matches.length) setSel(selIndex <= 0 ? matches.length - 1 : selIndex - 1);
      return;
    }
    // Esc is the Dialog's own dismiss; Tab stays inside its focus trap.
    if (e.key === "Enter" && !e.nativeEvent.isComposing && selIndex >= 0) {
      e.preventDefault();
      act(matches[selIndex], e.ctrlKey || e.metaKey);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
      <DialogSurface className={styles.surface} aria-label="Quick open — find a file">
        <div className={styles.box}>
          <Input
            className={styles.input}
            autoFocus
            contentBefore={<SearchRegular />}
            placeholder="Find a file by name or path…"
            aria-label="Find a file by name or path"
            value={query}
            onChange={(_, d) => {
              setQuery(d.value);
              setSel(0); // a new query restarts the walk at the best match
            }}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded={matches.length > 0}
            aria-controls="quick-open-listbox"
            aria-activedescendant={selIndex >= 0 ? `quick-open-row-${selIndex}` : undefined}
          />
          {query.trim() === "" ? (
            <Text size={200} className={styles.quiet}>
              Type to search your files — matches rank by name, then path.
            </Text>
          ) : matches.length === 0 ? (
            <Text size={200} className={styles.quiet}>
              No matching files.
            </Text>
          ) : (
            <div
              ref={listRef}
              role="listbox"
              id="quick-open-listbox"
              aria-label="Matching files"
              className={styles.list}
            >
              {matches.map((m, i) => (
                <div
                  key={m.id}
                  id={`quick-open-row-${i}`}
                  data-qo-row={i}
                  role="option"
                  aria-selected={i === selIndex}
                  className={mergeClasses(styles.row, i === selIndex && styles.rowActive)}
                  // Keep keyboard focus in the search box while clicking rows.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => act(m, e.ctrlKey || e.metaKey)}
                >
                  {rowIcon(m, styles.rowIcon)}
                  <Text
                    className={styles.rowName}
                    size={300}
                    title={m.dir ? `${m.dir}/${m.name}` : m.name}
                  >
                    {emphasize(m.name, m.nameHits, styles.hit)}
                  </Text>
                  <Text size={200} className={styles.rowPath}>
                    {m.dir}
                  </Text>
                  <span className={styles.rowState}>
                    <span title={m.ragIncluded ? "Visible to AI" : "Hidden from AI"}>
                      {m.ragIncluded ? (
                        <EyeRegular className={styles.eyeOn} />
                      ) : (
                        <EyeOffRegular className={styles.eyeOff} />
                      )}
                    </span>
                    {m.localOnly && (
                      <span title="Private — this device only">
                        <LockClosedRegular className={styles.lockOn} />
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className={styles.hints}>
            <Text size={200}>
              ↵ Reveal in files · {modKey()}+↵ Attach to chat · Esc Close
            </Text>
          </div>
        </div>
      </DialogSurface>
    </Dialog>
  );
}
