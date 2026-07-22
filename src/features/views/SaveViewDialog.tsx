"use client";

/**
 * [TEAM: views] "Save as view" (openspec: add-shaped-views §3.1) — the small
 * name dialog behind the chip on SQL-bearing answers. One name field,
 * Create/Cancel. Create persists the answer's OWN SQL as a view with the
 * asked question recorded as its summary (source "question") — no model call
 * anywhere in this flow. The ENGINE owns every rule (name sanitization, the
 * SQL guard, reads derivation, cycle/depth caps): the dialog trims the name
 * and otherwise shows the engine's refusal verbatim, never re-validating.
 *
 * Beam treatment: Fluent tokens only, so both themes come for free.
 */

import { useEffect, useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogTitle,
  Field,
  Input,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { IconError } from "@/shell/icons";
import type { View } from "@/contracts";
import { ragService } from "@/contracts";
import { LhDialogSurface } from "@/shell/controls";

const useStyles = makeStyles({
  surface: { maxWidth: "480px", width: "92vw" },
  content: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
  },
  quiet: { color: tokens.colorNeutralForeground3 },
  errorNote: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorStatusDangerBackground1,
    color: tokens.colorStatusDangerForeground1,
  },
});

export function SaveViewDialog({
  open,
  onClose,
  sql,
  fileIds,
  question,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  /** The answer's exact executed SQL (AnalyticsMeta.sql) — saved verbatim. */
  sql: string;
  /** The files that SQL read (AnalyticsMeta.fileIds) — reads derive from these. */
  fileIds: string[];
  /** The asked question — recorded as the view's summary, labeled "question". */
  question: string;
  /** Fires with the created view; the caller paints its quiet confirmation. */
  onSaved?: (view: View) => void;
}) {
  const styles = useStyles();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A clean slate every time the dialog opens — a refusal from the last
  // answer must not haunt the next one.
  useEffect(() => {
    if (open) {
      setName("");
      setBusy(false);
      setError(null);
    }
  }, [open]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const view = await ragService.createView({
        name: name.trim(),
        sql,
        summaryText: question,
        summarySource: "question",
        fileIds,
      });
      onSaved?.(view);
      onClose();
    } catch (err) {
      // The engine's reason, verbatim — it owns the rules.
      setError(err instanceof Error ? err.message : "could not save the view");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(_, data) => {
        if (!data.open) onClose();
      }}
    >
      <LhDialogSurface className={styles.surface}>
        <DialogBody>
          <DialogTitle>Save as view</DialogTitle>
          <DialogContent className={styles.content}>
            <Text size={200} className={styles.quiet}>
              Saves this answer&apos;s query as a named view you can ask against like a
              table. Results always come from your files&apos; current data — nothing is
              copied or written.
            </Text>
            <Field label="Name" hint="lowercase letters, digits, and underscores">
              <Input
                value={name}
                onChange={(_, d) => setName(d.value)}
                placeholder="e.g. clean_sales"
                aria-label="View name"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && name.trim() && !busy) {
                    e.preventDefault();
                    void create();
                  }
                }}
              />
            </Field>
            {error && (
              <div className={styles.errorNote}>
                <IconError fontSize={16} />
                <Text size={200}>{error}</Text>
              </div>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              appearance="primary"
              disabled={busy || !name.trim()}
              onClick={() => void create()}
            >
              {busy ? "Creating…" : "Create"}
            </Button>
          </DialogActions>
        </DialogBody>
      </LhDialogSurface>
    </Dialog>
  );
}
