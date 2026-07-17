"use client";

/**
 * [TEAM: views] The sidebar's Library section (openspec: add-shaped-views §4-§5)
 * — saved shaped views, the InvestigationsNav sibling. One row per view;
 * clicking it opens the read-only view inspector (via the
 * `lighthouse:inspect-view` seam this nav both dispatches and owns, the
 * FileInspectorHost idiom), and a per-row overflow menu carries Inspect,
 * Rename, "Ask about this view" (the existing `lighthouse:ask-question` seam),
 * and Delete. "New view" opens the already-built ShapeViewDialog.
 *
 * The ENGINE owns every rule — the nav only renders the shared session cache
 * (useViewsStore) and calls the RagService view methods, surfacing their
 * refusals VERBATIM:
 *  - Rename is refused while dependents exist, the engine's message naming them.
 *  - Delete is a two-step lifecycle: viewDependents() first, then a plain
 *    confirm (no transitive dependents) OR an explicit cascade confirmation that
 *    SHOWS the full transitive list. No path ever writes to a source file.
 *
 * Local-only propagates as a per-row lock badge, hydrated lazily from
 * inspectView (the store's localOnlyById cache); the inspector is the
 * authoritative surface. Beam treatment: Fluent tokens only, both themes free.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Input,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Text,
  makeStyles,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import {
  AddRegular,
  ChatRegular,
  DeleteRegular,
  EyeRegular,
  LockClosedRegular,
  MoreHorizontalRegular,
  RenameRegular,
} from "@fluentui/react-icons";
import type { View } from "@/contracts";
import { ragService } from "@/contracts";
import { useViewsStore } from "@/stores/useViewsStore";
import { useRagStore } from "@/stores/useRagStore";
import { ShapeViewDialog } from "@/features/views/ShapeViewDialog";
import {
  INSPECT_VIEW_EVENT,
  ViewInspector,
  requestViewInspect,
  type InspectViewDetail,
} from "@/features/views/ViewInspector";

const useStyles = makeStyles({
  // A quiet section mirroring InvestigationsNav: hairline below, breathing room.
  section: {
    display: "flex",
    flexDirection: "column",
    gap: "1px",
    paddingTop: tokens.spacingVerticalM,
    paddingBottom: tokens.spacingVerticalS,
    marginBottom: tokens.spacingVerticalS,
    ...shorthands.borderBottom("1px", "solid", tokens.colorNeutralStroke2),
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalS,
    marginBottom: tokens.spacingVerticalXXS,
  },
  headerLabel: { color: tokens.colorNeutralForeground3 },
  // The row is a flex container so the inspect button and the overflow menu are
  // siblings — never a button nested in a button.
  row: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXXS,
    width: "100%",
    borderRadius: tokens.borderRadiusMedium,
    minHeight: "32px",
    ":hover": { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
  rowButton: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    flex: 1,
    minWidth: 0,
    textAlign: "left",
    ...shorthands.border("none"),
    backgroundColor: "transparent",
    color: "inherit",
    ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalS),
    cursor: "pointer",
  },
  rowName: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  // The local-only mark — the SAME lock the file inspector uses, no new colors.
  lock: { color: tokens.colorNeutralForeground3, flexShrink: 0 },
  rowMenuBtn: { flexShrink: 0 },
  note: {
    color: tokens.colorNeutralForeground3,
    ...shorthands.padding("2px", tokens.spacingHorizontalS),
  },
  errorNote: {
    color: tokens.colorStatusDangerForeground1,
    ...shorthands.padding("2px", tokens.spacingHorizontalS),
  },
  newButton: { alignSelf: "flex-start", marginTop: tokens.spacingVerticalXXS },
  dialogSurface: { maxWidth: "480px", width: "92vw" },
  dialogContent: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
  },
  dialogHint: { color: tokens.colorNeutralForeground3 },
});

// Best-effort tabular detection for the shaping source picker. The web twin's
// shapeView returns {available:false} (PARITY) and desktop resolves sources by
// the engine's own registered table names, so this only needs to offer sensible
// picks — exactness is the engine's job.
const TABULAR_EXT = /\.(csv|tsv|xlsx|xls|parquet)$/i;
function isTabular(name: string): boolean {
  return TABULAR_EXT.test(name);
}
/** A file name reduced to the engines' table-name shape (display-only here). */
function tableNameFor(name: string): string {
  const base = name.replace(/\.[^.]+$/, "");
  let t = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (/^[0-9]/.test(t)) t = `t_${t}`;
  return t.slice(0, 64).replace(/_+$/, "");
}

/** Tell every Library nav (and future view surfaces) to re-read the store. */
function broadcastViewsChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("lighthouse:views-changed"));
  }
}

/** Ask about a view through the existing ask seam (boards/widget hand-off). */
function askAbout(v: View): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("lighthouse:ask-question", { detail: { question: `Show me the ${v.name} view.` } }),
  );
}

interface RenameState {
  id: string;
  name: string;
  busy: boolean;
  error: string | null;
}

interface DeleteState {
  id: string;
  name: string;
  /** Transitive dependent NAMES — non-empty ⇒ the cascade confirmation. */
  transitive: string[];
  busy: boolean;
  error: string | null;
}

export function ViewsNav() {
  const styles = useStyles();
  const views = useViewsStore((s) => s.views);
  const loaded = useViewsStore((s) => s.loaded);
  const localOnlyById = useViewsStore((s) => s.localOnlyById);
  const refresh = useViewsStore((s) => s.refresh);
  const ensureLoaded = useViewsStore((s) => s.ensureLoaded);
  const hydrateLocalOnly = useViewsStore((s) => s.hydrateLocalOnly);
  // Live vault nodes feed the shaping source picker (tabular files + views).
  const nodes = useRagStore((s) => s.nodes);

  const [inspectId, setInspectId] = useState<string | null>(null);
  const [shapeOpen, setShapeOpen] = useState(false);
  const [navError, setNavError] = useState<string | null>(null);
  const [rename, setRename] = useState<RenameState | null>(null);
  const [del, setDel] = useState<DeleteState | null>(null);

  useEffect(() => {
    ensureLoaded();
  }, [ensureLoaded]);

  // Hydrate the per-row local-only badge lazily (one inspectView per new id).
  useEffect(() => {
    hydrateLocalOnly(views.map((v) => v.id));
  }, [views, hydrateLocalOnly]);

  // Own the single inspector instance: the rows/menu dispatch inspect-view and
  // this listener drives `inspectId` (so delete can also close it by id).
  useEffect(() => {
    const onInspect = (e: Event) => {
      const id = (e as CustomEvent<Partial<InspectViewDetail>>).detail?.viewId;
      if (typeof id === "string" && id) setInspectId(id);
    };
    window.addEventListener(INSPECT_VIEW_EVENT, onInspect);
    return () => window.removeEventListener(INSPECT_VIEW_EVENT, onInspect);
  }, []);

  // A view saved/renamed/deleted anywhere re-reads the shared cache.
  useEffect(() => {
    const onChanged = () => void refresh();
    window.addEventListener("lighthouse:views-changed", onChanged);
    return () => window.removeEventListener("lighthouse:views-changed", onChanged);
  }, [refresh]);

  const tabularFiles = useMemo(
    () => nodes.filter((n) => n.kind === "file" && isTabular(n.name)),
    [nodes],
  );
  const shapeSources = useMemo(() => {
    const names = new Set<string>();
    for (const v of views) names.add(v.name);
    for (const f of tabularFiles) {
      const t = tableNameFor(f.name);
      if (t) names.add(t);
    }
    return [...names];
  }, [views, tabularFiles]);
  const shapeFileIds = useMemo(() => tabularFiles.map((f) => f.id), [tabularFiles]);

  function openRename(v: View) {
    setNavError(null);
    setRename({ id: v.id, name: v.name, busy: false, error: null });
  }

  async function commitRename() {
    if (!rename) return;
    const name = rename.name.trim();
    if (!name || rename.busy) return;
    setRename({ ...rename, busy: true, error: null });
    try {
      await ragService.renameView(rename.id, name);
      setRename(null);
      await refresh();
      broadcastViewsChanged();
    } catch (err) {
      // The engine refuses a rename while dependents exist, naming them — show
      // that message verbatim and keep the dialog open to correct or cancel.
      setRename(
        (r) =>
          r && {
            ...r,
            busy: false,
            error: err instanceof Error ? err.message : "the view could not be renamed",
          },
      );
    }
  }

  async function openDelete(v: View) {
    setNavError(null);
    try {
      // Step one: ask the engine what depends on it — the transitive list
      // decides a plain confirm vs an explicit cascade.
      const { transitive } = await ragService.viewDependents(v.id);
      setDel({ id: v.id, name: v.name, transitive, busy: false, error: null });
    } catch (err) {
      setNavError(
        err instanceof Error ? err.message : "could not check what depends on this view",
      );
    }
  }

  async function confirmDelete() {
    if (!del || del.busy) return;
    // Cascade ONLY when the confirmation showed a transitive list.
    const cascade = del.transitive.length > 0;
    setDel({ ...del, busy: true, error: null });
    try {
      const deleted = await ragService.deleteView(del.id, cascade);
      const deletedSet = new Set(deleted);
      setDel(null);
      // Close the inspector if it was open on any now-deleted view.
      if (inspectId && deletedSet.has(inspectId)) setInspectId(null);
      await refresh();
      broadcastViewsChanged();
    } catch (err) {
      setDel(
        (d) =>
          d && {
            ...d,
            busy: false,
            error: err instanceof Error ? err.message : "the view could not be deleted",
          },
      );
    }
  }

  const cascade = (del?.transitive.length ?? 0) > 0;

  return (
    <nav aria-label="Library" className={styles.section}>
      <div className={styles.header}>
        <Text size={200} weight="semibold" className={styles.headerLabel}>
          Library
        </Text>
      </div>

      {views.map((v) => {
        const isPrivate = localOnlyById[v.id] === true;
        return (
          <div key={v.id} className={styles.row}>
            <button
              type="button"
              className={styles.rowButton}
              title={v.name}
              onClick={() => requestViewInspect(v.id)}
            >
              <Text size={300} className={styles.rowName}>
                {v.name}
              </Text>
              {isPrivate && (
                <LockClosedRegular
                  className={styles.lock}
                  aria-label="Private — this device only"
                  title="Private — this device only"
                />
              )}
            </button>
            <Menu>
              <MenuTrigger disableButtonEnhancement>
                <Button
                  appearance="subtle"
                  size="small"
                  icon={<MoreHorizontalRegular />}
                  aria-label={`Actions for ${v.name}`}
                  className={styles.rowMenuBtn}
                />
              </MenuTrigger>
              <MenuPopover>
                <MenuList>
                  <MenuItem icon={<EyeRegular />} onClick={() => requestViewInspect(v.id)}>
                    Inspect
                  </MenuItem>
                  <MenuItem icon={<RenameRegular />} onClick={() => openRename(v)}>
                    Rename
                  </MenuItem>
                  <MenuItem icon={<ChatRegular />} onClick={() => askAbout(v)}>
                    Ask about this view
                  </MenuItem>
                  <MenuItem icon={<DeleteRegular />} onClick={() => void openDelete(v)}>
                    Delete
                  </MenuItem>
                </MenuList>
              </MenuPopover>
            </Menu>
          </div>
        );
      })}

      {loaded && views.length === 0 && (
        <Text size={200} className={styles.note}>
          Saved views appear here — turn any answer into a reusable view.
        </Text>
      )}
      {navError && (
        <Text size={200} className={styles.errorNote} role="status">
          {navError}
        </Text>
      )}

      <Button
        appearance="subtle"
        size="small"
        icon={<AddRegular />}
        className={styles.newButton}
        onClick={() => setShapeOpen(true)}
      >
        New view
      </Button>

      {/* Shaping ask (already built): the source picker gets tabular tables +
          saved view names and their candidate file ids. */}
      <ShapeViewDialog
        open={shapeOpen}
        onClose={() => {
          setShapeOpen(false);
          // A shaping Save persists through createView; re-read so it appears.
          void refresh();
        }}
        sources={shapeSources}
        fileIds={shapeFileIds}
      />

      {/* Rename — the engine owns the rule; a dependents refusal shows verbatim. */}
      <Dialog
        open={rename !== null}
        onOpenChange={(_, d) => {
          if (!d.open) setRename(null);
        }}
      >
        <DialogSurface className={styles.dialogSurface}>
          <DialogBody>
            <DialogTitle>Rename view</DialogTitle>
            <DialogContent className={styles.dialogContent}>
              <Input
                value={rename?.name ?? ""}
                onChange={(_, d) => setRename((r) => r && { ...r, name: d.value })}
                placeholder="e.g. clean_sales"
                aria-label="New view name"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") void commitRename();
                }}
              />
              <Text size={200} className={styles.dialogHint}>
                lowercase letters, digits, and underscores
              </Text>
              {rename?.error && (
                <Text size={200} className={styles.errorNote} role="status">
                  {rename.error}
                </Text>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setRename(null)}>
                Cancel
              </Button>
              <Button
                appearance="primary"
                disabled={!rename || rename.busy || !rename.name.trim()}
                onClick={() => void commitRename()}
              >
                {rename?.busy ? "Renaming…" : "Rename"}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Delete — the two-step lifecycle (design.md "Cascade delete is
          explicit"): a plain confirm with no dependents, or a confirmation that
          shows the full transitive list before a cascade. Sources untouched. */}
      <Dialog
        open={del !== null}
        onOpenChange={(_, d) => {
          if (!d.open) setDel(null);
        }}
      >
        <DialogSurface className={styles.dialogSurface}>
          <DialogBody>
            <DialogTitle>
              {cascade ? `Delete “${del?.name ?? ""}” and its dependents?` : `Delete view “${del?.name ?? ""}”?`}
            </DialogTitle>
            <DialogContent className={styles.dialogContent}>
              {cascade ? (
                <Text size={300}>
                  “{del?.name}” is used by: {del?.transitive.join(", ")}. Deleting it will also
                  delete {del && del.transitive.length === 1 ? "that view" : "those views"}. Your
                  source files are never touched.
                </Text>
              ) : (
                <Text size={300}>
                  Delete view “{del?.name ?? ""}”? This never touches your source files.
                </Text>
              )}
              {del?.error && (
                <Text size={200} className={styles.errorNote} role="status">
                  {del.error}
                </Text>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setDel(null)}>
                Cancel
              </Button>
              <Button
                appearance="primary"
                disabled={!del || del.busy}
                onClick={() => void confirmDelete()}
              >
                {cascade
                  ? `Delete all ${(del?.transitive.length ?? 0) + 1}`
                  : del?.busy
                    ? "Deleting…"
                    : "Delete"}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* The single read-only inspector, driven by inspect-view + delete-close. */}
      <ViewInspector viewId={inspectId} onClose={() => setInspectId(null)} />
    </nav>
  );
}
