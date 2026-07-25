"use client";

/**
 * §48 §3b: the always-relevant Report door on a tabular analytics answer. A
 * "Report…" action beside Chart-it / Save-view opens the Standard / Scientific /
 * Business menu; picking a template opens the §46 working-hypothesis prompt, and
 * Generate runs the SAME templated report the InvestigationsNav launchers do —
 * ragService.investigate(sourceTable, currentInvestigation, template, hypothesis)
 * — saving into the current investigation and confirming "Saved <name> — Open".
 *
 * The source table is resolved from the answer's OWN files via capabilityMap
 * (the same investigable gate the chips use); when no table resolves — a prose
 * answer, or the web twin (empty map, investigate throws) — the action is ABSENT
 * (no dead door). Report generation is unchanged (reuse of #220's investigate +
 * hypothesis dialog); this only adds the entry point. UI-only.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogTitle,
  Text,
  Textarea,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { IconBeaker, IconBriefcase, IconDoc, IconReport } from "@/shell/icons";
import type { CapabilityMap, ReportTemplate } from "@/contracts";
import { EMPTY_CAPABILITY_MAP, ragService } from "@/contracts";
import { LhDialogSurface, LhMenu } from "@/shell/controls";
import { useChatStore } from "@/stores/useChatStore";

// The UI menu offers three, but the wire template is only "imrad" | "bluf";
// "standard" maps to NO template (the deterministic report), like the hero door.
type Picked = ReportTemplate | "standard";

const useStyles = makeStyles({
  note: {
    display: "inline-flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    color: tokens.colorNeutralForeground3,
  },
  dialogContent: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM },
  dialogHint: { color: tokens.colorNeutralForeground3 },
  errorNote: { color: tokens.colorPaletteRedForeground1 },
});

export function AnswerReportAction({ fileIds }: { fileIds: string[] }) {
  const styles = useStyles();
  const currentInvestigationId = useChatStore((s) => s.currentInvestigationId ?? undefined);
  const key = useMemo(() => fileIds.join("\n"), [fileIds]);
  const [map, setMap] = useState<CapabilityMap>(EMPTY_CAPABILITY_MAP);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [hypoText, setHypoText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ id: string; name: string } | null>(null);

  // Resolve THIS answer's source table from its own files (investigable gate).
  useEffect(() => {
    if (!key) {
      setMap(EMPTY_CAPABILITY_MAP);
      return;
    }
    let cancelled = false;
    ragService
      .capabilityMap(key.split("\n"))
      .then((m) => {
        if (!cancelled) setMap(m ?? EMPTY_CAPABILITY_MAP);
      })
      .catch(() => {
        if (!cancelled) setMap(EMPTY_CAPABILITY_MAP);
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  const table = map.tables.find((t) => t.investigable)?.name ?? null;
  // No resolvable source table (prose answer, or the web twin's empty map) ⇒ no
  // dead door.
  if (!table) return null;

  function openReport(p: Picked) {
    setPicked(p);
    setHypoText("");
    setError(null);
    setSaved(null);
  }

  async function generate() {
    if (!picked || busy) return;
    setBusy(true);
    setError(null);
    try {
      const template: ReportTemplate | undefined = picked === "standard" ? undefined : picked;
      const { savedId, savedName } = await ragService.investigate(
        table!,
        currentInvestigationId,
        template,
        hypoText.trim() || undefined,
      );
      setPicked(null);
      setSaved({ id: savedId, name: savedName });
    } catch {
      // Rust-only: the web twin throws — an honest note, never a fake save.
      setError("Deep analysis runs in the desktop engine.");
    } finally {
      setBusy(false);
    }
  }

  const dialogTitle =
    picked === "bluf" ? "Business report" : picked === "imrad" ? "Scientific report" : "Standard report";

  return (
    <>
      <LhMenu
        trigger={
          <Button
            appearance="subtle"
            size="small"
            shape="circular"
            icon={<IconReport />}
            title={`Write a report on ${table} from this answer`}
          >
            Report…
          </Button>
        }
        items={[
          { key: "standard", label: "Standard report", icon: <IconDoc />, onClick: () => openReport("standard") },
          { key: "imrad", label: "Scientific method", icon: <IconBeaker />, onClick: () => openReport("imrad") },
          { key: "bluf", label: "Business report", icon: <IconBriefcase />, onClick: () => openReport("bluf") },
        ]}
        aria-label={`Report on ${table}`}
      />
      {saved && (
        <Text size={200} className={styles.note} role="status">
          Saved {saved.name}
          <Button
            appearance="transparent"
            size="small"
            onClick={() => {
              if (typeof window !== "undefined") {
                window.dispatchEvent(
                  new CustomEvent("lighthouse:reveal-node", { detail: { id: saved.id } }),
                );
              }
            }}
          >
            Open
          </Button>
        </Text>
      )}

      <Dialog
        open={picked !== null}
        onOpenChange={(_, d) => {
          if (!d.open) setPicked(null);
        }}
      >
        <LhDialogSurface>
          <DialogBody>
            <DialogTitle>{dialogTitle}</DialogTitle>
            <DialogContent className={styles.dialogContent}>
              <Text size={200} className={styles.dialogHint}>
                A deep analysis of {table} saved to your vault. Every figure is computed by the
                engine — an optional hypothesis only frames the write-up, never the numbers.
              </Text>
              <Textarea
                value={hypoText}
                onChange={(_, d) => setHypoText(d.value)}
                placeholder="Optional hypothesis to frame around, e.g. “churn rose after the price change”"
                aria-label="Working hypothesis"
                autoFocus
                resize="vertical"
              />
              {error && (
                <Text size={200} className={styles.errorNote} role="status">
                  {error}
                </Text>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setPicked(null)}>
                Cancel
              </Button>
              <Button appearance="primary" disabled={busy} onClick={() => void generate()}>
                {busy ? "Generating…" : "Generate"}
              </Button>
            </DialogActions>
          </DialogBody>
        </LhDialogSurface>
      </Dialog>
    </>
  );
}
