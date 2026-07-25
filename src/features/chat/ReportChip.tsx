"use client";

/**
 * §48 §1: one report-launcher chip for an investigable table — the three
 * template entries (Standard report, Scientific method, Business report), each
 * → ragService.investigate. Relocated out of the retired InvestigateChips so it
 * can ride the SINGLE combined ≤3 suggestion list (suggestionChips); the menu
 * labels stay byte-identical to the retired launcher. §3 relabels the trigger
 * "Report on <table>". Rust-engine-only: the web twin's investigate op throws,
 * so the chip degrades to an honest note instead of a fake saved file.
 */
import { useState } from "react";
import { Button, Text, makeStyles, tokens } from "@fluentui/react-components";
import { IconBeaker, IconBriefcase, IconDoc, IconSearch } from "@/shell/icons";
import type { ReportTemplate } from "@/contracts";
import { ragService } from "@/contracts";
import { LhMenu } from "@/shell/controls";

const useStyles = makeStyles({
  note: { color: tokens.colorNeutralForeground3 },
});

export function ReportChip({ table }: { table: string }) {
  const styles = useStyles();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // Run the recipe battery + write the report, then reveal the saved note in
  // the tree (the chat-citation reveal seam). No hypothesis on the hero door —
  // the per-answer Report action (§3b) owns the hypothesis-framed variant.
  async function investigate(template?: ReportTemplate) {
    setBusy(true);
    setNote(null);
    try {
      const { savedId, savedName } = await ragService.investigate(table, undefined, template);
      setNote(`Saved ${savedName}`);
      if (typeof window !== "undefined" && savedId) {
        window.dispatchEvent(new CustomEvent("lighthouse:reveal-node", { detail: { id: savedId } }));
      }
    } catch {
      setNote("Deep analysis runs in the desktop engine.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <LhMenu
        trigger={
          <Button
            appearance="secondary"
            size="small"
            shape="circular"
            icon={<IconSearch />}
            disabled={busy}
            title={`Run a deep analysis of ${table} and save the report to your vault`}
          >
            {busy ? "Investigating…" : `Investigate ${table}`}
          </Button>
        }
        items={[
          // Standard: the deterministic report, unchanged.
          {
            key: "standard",
            label: "Standard report",
            icon: <IconDoc />,
            onClick: () => void investigate(),
          },
          // IMRaD — Introduction / Methods / Results / Discussion.
          {
            key: "imrad",
            label: "Scientific method",
            icon: <IconBeaker />,
            onClick: () => void investigate("imrad"),
          },
          // BLUF — Bottom line up front + Minto-pyramid detail.
          {
            key: "bluf",
            label: "Business report",
            icon: <IconBriefcase />,
            onClick: () => void investigate("bluf"),
          },
        ]}
        aria-label={`Investigate ${table}`}
      />
      {note && (
        <Text size={200} className={styles.note} role="status">
          {note}
        </Text>
      )}
    </>
  );
}
