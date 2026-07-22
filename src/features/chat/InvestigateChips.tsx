"use client";

/**
 * 0.13.10 §3: the Investigate → report-template launcher as chat chips. The
 * "What you can do" section is retired; its one result-producing control —
 * run the deep-analysis recipe battery over an investigable table and save
 * the report note — moves beside the recipe chips in the chat hero, gated on
 * the same data shape (`capabilityMap().tables[].investigable`). The three
 * template entries are byte-identical to the retired menu: Standard report
 * (deterministic, unchanged), Scientific method (IMRaD), Business report
 * (BLUF) — a template only adds narrated framing over engine numbers
 * (add-report-templates). Rust-engine-only: the web twin's investigate op
 * answers {available:false}, so the chips degrade to an honest note.
 */
import { useEffect, useMemo, useState } from "react";
import { Button, Text, makeStyles, tokens } from "@fluentui/react-components";
import { BeakerRegular, BriefcaseRegular, DocumentRegular, SearchRegular } from "@fluentui/react-icons";
import type { CapabilityMap, ReportTemplate } from "@/contracts";
import { EMPTY_CAPABILITY_MAP, ragService } from "@/contracts";
import { LhMenu } from "@/shell/controls";

const useStyles = makeStyles({
  note: { color: tokens.colorNeutralForeground3 },
});

/**
 * One "Investigate <table>" chip per investigable table (capped to keep the
 * hero calm), each opening the three-template menu. Renders nothing while the
 * map is loading or when no table qualifies — the chips are data-gated.
 */
export function InvestigateChips({ includedFileIds }: { includedFileIds: string[] }) {
  const styles = useStyles();
  const includedKey = useMemo(() => includedFileIds.join("\n"), [includedFileIds]);
  const [map, setMap] = useState<CapabilityMap>(EMPTY_CAPABILITY_MAP);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // A saved/renamed/deleted view re-reads the map (a view is a table too).
  const [viewsNonce, setViewsNonce] = useState(0);

  useEffect(() => {
    const onChanged = () => setViewsNonce((n) => n + 1);
    window.addEventListener("lighthouse:views-changed", onChanged);
    return () => window.removeEventListener("lighthouse:views-changed", onChanged);
  }, []);

  useEffect(() => {
    if (!includedKey) {
      setMap(EMPTY_CAPABILITY_MAP);
      return;
    }
    let cancelled = false;
    ragService
      .capabilityMap(includedKey.split("\n"))
      .then((m) => {
        if (!cancelled) setMap(m ?? EMPTY_CAPABILITY_MAP);
      })
      .catch(() => {
        // A failed aggregate degrades to the honest empty map, never an error.
        if (!cancelled) setMap(EMPTY_CAPABILITY_MAP);
      });
    return () => {
      cancelled = true;
    };
  }, [includedKey, viewsNonce]);

  // Run the recipe battery + write the report, then reveal the saved note in
  // the tree (the chat-citation reveal seam). Rust-only, so the web twin
  // throws — the chips then show an honest note instead of a fake saved file.
  async function investigate(table: string, template?: ReportTemplate) {
    setBusy(table);
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
      setBusy(null);
    }
  }

  const investigable = map.tables.filter((t) => t.investigable).slice(0, 3);
  if (investigable.length === 0) return null;

  return (
    <>
      {investigable.map((t) => (
        <LhMenu
          key={`investigate:${t.name}`}
          trigger={
            <Button
              appearance="secondary"
              size="small"
              shape="circular"
              icon={<SearchRegular />}
              disabled={busy === t.name}
              title={`Run a deep analysis of ${t.name} and save the report to your vault`}
            >
              {busy === t.name ? "Investigating…" : `Investigate ${t.name}`}
            </Button>
          }
          items={[
            // Standard: the deterministic report, unchanged.
            {
              key: "standard",
              label: "Standard report",
              icon: <DocumentRegular />,
              onClick: () => void investigate(t.name),
            },
            // IMRaD — Introduction / Methods / Results / Discussion.
            {
              key: "imrad",
              label: "Scientific method",
              icon: <BeakerRegular />,
              onClick: () => void investigate(t.name, "imrad"),
            },
            // BLUF — Bottom line up front + Minto-pyramid detail.
            {
              key: "bluf",
              label: "Business report",
              icon: <BriefcaseRegular />,
              onClick: () => void investigate(t.name, "bluf"),
            },
          ]}
          aria-label={`Investigate ${t.name}`}
        />
      ))}
      {note && (
        <Text size={200} className={styles.note} role="status">
          {note}
        </Text>
      )}
    </>
  );
}
