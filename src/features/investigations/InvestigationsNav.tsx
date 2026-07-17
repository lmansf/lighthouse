"use client";

/**
 * [TEAM: investigations] The sidebar's Investigations section (openspec:
 * add-investigations §4.1) — named, durable containers for analysis.
 *
 * Mounted ABOVE the FileExplorer in the sidebar fragment (app/page.tsx). One
 * row per non-archived investigation plus the global "All files" context;
 * clicking a row switches the chat context (useChatStore owns what that
 * means: fresh conversation when the active one belongs elsewhere). Create /
 * rename / archive go through the RagService investigations methods — the
 * ENGINE owns the records; this component only renders the shared session
 * cache (useInvestigationsStore) and refreshes it after each mutation.
 *
 * Quiet by design: the active row is the calmed explorer inset (neutral fill
 * + hairline — never an amber flood), archive hides and never deletes, and
 * the v1 scope picker is deliberately small — the files currently selected in
 * the explorer, or nothing (= the whole vault). No checkbox tree.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Checkbox,
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
  Switch,
  Text,
  Tooltip,
  makeStyles,
  mergeClasses,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import {
  AddRegular,
  ArchiveRegular,
  ArrowExportRegular,
  BranchRegular,
  CheckmarkRegular,
  DismissRegular,
  RenameRegular,
} from "@fluentui/react-icons";
import type { Investigation } from "@/contracts";
import { ragService } from "@/contracts";
import { useChatStore } from "@/stores/useChatStore";
import { useInvestigationsStore } from "@/stores/useInvestigationsStore";
import { useRagStore } from "@/stores/useRagStore";

const useStyles = makeStyles({
  // A quiet section above the file tree: hairline below, breathing room, and
  // nothing that competes with the explorer's own header.
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
  row: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    width: "100%",
    textAlign: "left",
    ...shorthands.border("none"),
    backgroundColor: "transparent",
    color: "inherit",
    ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalS),
    borderRadius: tokens.borderRadiusMedium,
    cursor: "pointer",
    minHeight: "32px",
    ":hover": { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
  // The calmed explorer selection: a neutral inset (fill + hairline ring),
  // NOT an amber fill — amber stays reserved for the visibility marks.
  rowActive: {
    backgroundColor: tokens.colorNeutralBackground1Selected,
    ...shorthands.outline("1px", "solid", tokens.colorNeutralStroke1),
  },
  rowMain: { display: "flex", flexDirection: "column", flex: 1, minWidth: 0 },
  rowName: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  rowCaption: { color: tokens.colorNeutralForeground3 },
  editRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalS),
  },
  // Quiet inline notes: the empty-state explainer and engine rejections.
  note: {
    color: tokens.colorNeutralForeground3,
    ...shorthands.padding("2px", tokens.spacingHorizontalS),
  },
  errorNote: {
    color: tokens.colorStatusDangerForeground1,
    ...shorthands.padding("2px", tokens.spacingHorizontalS),
  },
  newButton: { alignSelf: "flex-start", marginTop: tokens.spacingVerticalXXS },
  dialogContent: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
  },
  dialogHint: { color: tokens.colorNeutralForeground3 },
});

/** "Whole vault" or the LIVE count of still-present scope files — dangling
 *  ids (files deleted since scoping) are not counted, matching the pill. */
function scopeCaption(inv: Investigation, presentIds: Set<string>): string {
  if (inv.scopeFileIds.length === 0) return "Whole vault";
  const live = inv.scopeFileIds.filter((id) => presentIds.has(id)).length;
  return `${live} file${live === 1 ? "" : "s"}`;
}

export function InvestigationsNav() {
  const styles = useStyles();
  const investigations = useInvestigationsStore((s) => s.investigations);
  const loaded = useInvestigationsStore((s) => s.loaded);
  const refresh = useInvestigationsStore((s) => s.refresh);
  const ensureLoaded = useInvestigationsStore((s) => s.ensureLoaded);
  const currentInvestigationId = useChatStore((s) => s.currentInvestigationId);
  const setCurrentInvestigation = useChatStore((s) => s.setCurrentInvestigation);
  // Live vault nodes: scope captions count only still-present files, and the
  // create dialog reads the explorer's current multi-select for its v1 scope.
  const nodes = useRagStore((s) => s.nodes);
  const selectionMode = useRagStore((s) => s.selectionMode);
  const selectedIds = useRagStore((s) => s.selectedIds);

  // Inline rename (the history-drawer pattern) + one quiet error line for
  // engine rejections (duplicate name, record gone).
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [navError, setNavError] = useState<string | null>(null);

  // Create dialog state. `scopeToSelection` re-defaults to ON whenever the
  // dialog opens with a selection available (see openCreate).
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [scopeToSelection, setScopeToSelection] = useState(true);
  const [localOnly, setLocalOnly] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Branch (fork) dialog + a quiet success line for an export write (openspec:
  // add-automation §4). Fork mints a NEW line copying the parent's structure;
  // export writes a references-only markdown note under the investigation's
  // own folder — both go through the ENGINE, and errors surface inline.
  const [forkOpen, setForkOpen] = useState(false);
  const [forkSourceId, setForkSourceId] = useState<string | null>(null);
  const [forkName, setForkName] = useState("");
  const [forkError, setForkError] = useState<string | null>(null);
  const [navNote, setNavNote] = useState<string | null>(null);

  useEffect(() => {
    ensureLoaded();
  }, [ensureLoaded]);

  const presentIds = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes]);
  // The v1 scope source: FILE nodes currently multi-selected in the explorer
  // (folders in the selection are ignored — scope ids ride the attachment
  // machinery, which selects files).
  const selectedFileIds = useMemo(() => {
    if (!selectionMode || selectedIds.length === 0) return [];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    return selectedIds.filter((id) => byId.get(id)?.kind === "file");
  }, [selectionMode, selectedIds, nodes]);

  // Archive hides, never deletes: the nav lists live records only.
  const visible = useMemo(() => investigations.filter((i) => !i.archived), [investigations]);

  function openCreate() {
    setCreateName("");
    setScopeToSelection(true);
    setLocalOnly(false);
    setCreateError(null);
    setCreateOpen(true);
  }

  async function createNow() {
    const name = createName.trim();
    if (!name || busy) return;
    setBusy(true);
    setCreateError(null);
    try {
      const scopeFileIds = scopeToSelection && selectedFileIds.length > 0 ? selectedFileIds : [];
      const res = await ragService.createInvestigation({
        name,
        scopeFileIds,
        providerPolicy: localOnly ? "local-only" : "default",
      });
      if (res.error || !res.investigation) {
        setCreateError(res.error ?? "the investigation could not be created");
        return;
      }
      await refresh();
      setCreateOpen(false);
      // Creating one means working in it: enter the new context right away.
      setCurrentInvestigation(res.investigation.id);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "the investigation could not be created");
    } finally {
      setBusy(false);
    }
  }

  async function commitRename(id: string) {
    const name = renameText.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      const res = await ragService.renameInvestigation(id, name);
      if (res.error) {
        setNavError(res.error);
        return; // keep the editor open so the name can be corrected
      }
      setNavError(null);
      setRenamingId(null);
      await refresh();
    } catch (err) {
      setNavError(err instanceof Error ? err.message : "the name could not be changed");
    } finally {
      setBusy(false);
    }
  }

  async function archiveNow(id: string) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await ragService.setInvestigationArchived(id, true);
      if (res.error) {
        setNavError(res.error);
        return;
      }
      setNavError(null);
      await refresh();
      // Archiving the context you're standing in returns you to the global
      // one — the row is gone from this list, and an invisible active context
      // would be confusing. The record itself is untouched (hide, not delete).
      if (id === currentInvestigationId) setCurrentInvestigation(null);
    } catch (err) {
      setNavError(err instanceof Error ? err.message : "the investigation could not be archived");
    } finally {
      setBusy(false);
    }
  }

  function openFork(inv: Investigation) {
    setForkSourceId(inv.id);
    setForkName(`${inv.name} (branch)`);
    setForkError(null);
    setNavNote(null);
    setForkOpen(true);
  }

  async function forkNow() {
    const name = forkName.trim();
    if (!name || !forkSourceId || busy) return;
    setBusy(true);
    setForkError(null);
    try {
      const res = await ragService.forkInvestigation(forkSourceId, name);
      if (res.error || !res.investigation) {
        setForkError(res.error ?? "the investigation could not be branched");
        return;
      }
      await refresh();
      setForkOpen(false);
      // Branching means working in the new line: enter it right away.
      setCurrentInvestigation(res.investigation.id);
    } catch (err) {
      setForkError(err instanceof Error ? err.message : "the investigation could not be branched");
    } finally {
      setBusy(false);
    }
  }

  async function exportNow(inv: Investigation) {
    if (busy) return;
    setBusy(true);
    setNavError(null);
    setNavNote(null);
    try {
      const res = await ragService.exportInvestigation(inv.id, inv.name);
      if (res.error || !res.savedName) {
        setNavError(res.error ?? "the investigation could not be exported");
        return;
      }
      setNavNote(`Exported to ${res.savedName}`);
    } catch (err) {
      setNavError(err instanceof Error ? err.message : "the investigation could not be exported");
    } finally {
      setBusy(false);
    }
  }

  const globalActive = currentInvestigationId === null;

  return (
    <nav aria-label="Investigations" data-tour="investigations" className={styles.section}>
      <div className={styles.header}>
        <Text size={200} weight="semibold" className={styles.headerLabel}>
          Investigations
        </Text>
      </div>

      {/* The global context: every ask reads the whole visible vault and the
          history drawer shows only conversations outside any investigation. */}
      <button
        type="button"
        className={mergeClasses(styles.row, globalActive && styles.rowActive)}
        aria-current={globalActive ? "true" : undefined}
        onClick={() => setCurrentInvestigation(null)}
      >
        <div className={styles.rowMain}>
          <Text size={300} weight={globalActive ? "semibold" : "regular"} className={styles.rowName}>
            All files
          </Text>
        </div>
      </button>

      {visible.map((inv) => {
        const active = inv.id === currentInvestigationId;
        if (renamingId === inv.id) {
          return (
            <div key={inv.id} className={styles.editRow}>
              <Input
                value={renameText}
                onChange={(_, d) => setRenameText(d.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void commitRename(inv.id);
                  if (e.key === "Escape") {
                    setRenamingId(null);
                    setNavError(null);
                  }
                }}
                autoFocus
                style={{ flex: 1, minWidth: 0 }}
                aria-label={`Rename ${inv.name}`}
              />
              <Button
                size="small"
                appearance="primary"
                icon={<CheckmarkRegular />}
                aria-label="Save name"
                disabled={busy || !renameText.trim()}
                onClick={() => void commitRename(inv.id)}
              />
              <Button
                size="small"
                appearance="subtle"
                icon={<DismissRegular />}
                aria-label="Cancel rename"
                onClick={() => {
                  setRenamingId(null);
                  setNavError(null);
                }}
              />
            </div>
          );
        }
        return (
          // The explorer's row-menu pattern: right-click for Rename / Archive.
          <Menu key={inv.id} openOnContext>
            <MenuTrigger disableButtonEnhancement>
              <button
                type="button"
                className={mergeClasses(styles.row, active && styles.rowActive)}
                aria-current={active ? "true" : undefined}
                title={inv.name}
                onClick={() => setCurrentInvestigation(inv.id)}
              >
                <div className={styles.rowMain}>
                  <Text
                    size={300}
                    weight={active ? "semibold" : "regular"}
                    className={styles.rowName}
                  >
                    {inv.name}
                  </Text>
                  <Text size={200} className={styles.rowCaption}>
                    {scopeCaption(inv, presentIds)}
                    {inv.providerPolicy === "local-only" ? " · on-device" : ""}
                  </Text>
                </div>
              </button>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItem
                  icon={<RenameRegular />}
                  onClick={() => {
                    setRenamingId(inv.id);
                    setRenameText(inv.name);
                    setNavError(null);
                  }}
                >
                  Rename
                </MenuItem>
                {/* Branch: a fresh line seeded with this one's scope, policy,
                    and conversation context — its own id and empty notes. */}
                <MenuItem icon={<BranchRegular />} onClick={() => openFork(inv)}>
                  Branch
                </MenuItem>
                {/* Export: a references-only markdown note (structure +
                    membership, never transcripts) into this investigation's
                    own notes folder. */}
                <MenuItem icon={<ArrowExportRegular />} onClick={() => void exportNow(inv)}>
                  Export
                </MenuItem>
                {/* Archive hides it from this list; chats, pins, and notes stay. */}
                <MenuItem icon={<ArchiveRegular />} onClick={() => void archiveNow(inv.id)}>
                  Archive
                </MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
        );
      })}

      {loaded && visible.length === 0 && (
        <Text size={200} className={styles.note}>
          Keep related chats, pins, and notes together.
        </Text>
      )}
      {navError && (
        <Text size={200} className={styles.errorNote} role="status">
          {navError}
        </Text>
      )}
      {navNote && (
        <Text size={200} className={styles.note} role="status">
          {navNote}
        </Text>
      )}

      <Button
        appearance="subtle"
        size="small"
        icon={<AddRegular />}
        className={styles.newButton}
        onClick={openCreate}
      >
        New investigation
      </Button>

      <Dialog
        open={createOpen}
        onOpenChange={(_, d) => {
          if (!d.open) setCreateOpen(false);
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>New investigation</DialogTitle>
            <DialogContent className={styles.dialogContent}>
              <Input
                value={createName}
                onChange={(_, d) => setCreateName(d.value)}
                placeholder="Name, e.g. Q3 vendor audit"
                aria-label="Investigation name"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") void createNow();
                }}
              />
              {/* v1 scope: the explorer's current multi-select, or nothing.
                  A full file picker is a later change — the explorer already
                  does multi-select well. */}
              {selectedFileIds.length > 0 ? (
                <Checkbox
                  checked={scopeToSelection}
                  onChange={(_, d) => setScopeToSelection(Boolean(d.checked))}
                  label={`Scope to the ${selectedFileIds.length} file${
                    selectedFileIds.length === 1 ? "" : "s"
                  } selected in the explorer`}
                />
              ) : (
                <Text size={200} className={styles.dialogHint}>
                  Covers your whole vault. To scope it to specific files, select them in the
                  explorer first.
                </Text>
              )}
              <Tooltip
                content="Answers in this investigation always use the private on-device model."
                relationship="description"
              >
                <Switch
                  checked={localOnly}
                  onChange={(_, d) => setLocalOnly(Boolean(d.checked))}
                  label="Keep this investigation on-device"
                />
              </Tooltip>
              {createError && (
                <Text size={200} className={styles.errorNote} role="status">
                  {createError}
                </Text>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button
                appearance="primary"
                disabled={busy || !createName.trim()}
                onClick={() => void createNow()}
              >
                Create
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Branch dialog: a fork copies STRUCTURE only (scope, provider policy,
          conversation context) into a new line with its own id and empty
          notes folder — the engine owns the id minting and the name rule. */}
      <Dialog
        open={forkOpen}
        onOpenChange={(_, d) => {
          if (!d.open) setForkOpen(false);
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Branch investigation</DialogTitle>
            <DialogContent className={styles.dialogContent}>
              <Text size={200} className={styles.dialogHint}>
                Starts a new investigation with this one&apos;s scope, provider policy, and
                conversation context. Pins and notes are not copied.
              </Text>
              <Input
                value={forkName}
                onChange={(_, d) => setForkName(d.value)}
                placeholder="Name for the branch"
                aria-label="Branch name"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") void forkNow();
                }}
              />
              {forkError && (
                <Text size={200} className={styles.errorNote} role="status">
                  {forkError}
                </Text>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setForkOpen(false)}>
                Cancel
              </Button>
              <Button
                appearance="primary"
                disabled={busy || !forkName.trim()}
                onClick={() => void forkNow()}
              >
                Branch
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </nav>
  );
}
