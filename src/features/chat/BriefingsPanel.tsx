"use client";

/**
 * [TEAM: chat] Briefings — group pinned analytics questions into one titled,
 * ordered report (add-briefings). Self-contained UI: it takes the current pins
 * as a prop, loads/saves/removes/runs briefings through `ragService`, and renders
 * a freshly composed report inline. Lives inside the Pinned-questions dialog, so
 * it stays compact.
 */

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Checkbox,
  Field,
  Input,
  Text,
  makeStyles,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import { IconClose } from "@/shell/icons";
import dynamic from "next/dynamic";
import { ragService } from "@/contracts";
import type { Briefing, BriefingReport, Cadence, Pin } from "@/contracts";
import { LhSelect } from "@/shell/controls";

// The ONE configured markdown renderer (remark-gfm applied inside), loaded on
// demand (the ChatPanel idiom) — only a composed report ever needs it.
const MarkdownView = dynamic(() => import("@/shell/MarkdownView"), { ssr: false });

/** Cadence choices for the create form, in the order the select lists them. */
const CADENCE_OPTIONS: { value: Cadence; label: string }[] = [
  { value: "manual", label: "Manual" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
];

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
  },
  muted: { color: tokens.colorNeutralForeground3 },
  danger: { color: tokens.colorStatusDangerForeground1 },

  // --- Create form ---
  form: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    ...shorthands.padding(tokens.spacingVerticalM, tokens.spacingHorizontalM),
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  checks: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
    maxHeight: "28vh",
    overflowY: "auto",
  },
  formActions: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
  },

  // --- Existing briefings ---
  list: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalM),
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  rowMain: { display: "flex", flexDirection: "column", gap: "2px", flexGrow: 1, minWidth: 0 },
  rowTitle: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },

  // --- Composed report ---
  report: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    ...shorthands.padding(tokens.spacingVerticalM, tokens.spacingHorizontalM),
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  section: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXXS },
  // Tame react-markdown's block elements (GFM tables are the heavy user) so the
  // report reads tightly inside the dialog; wide tables scroll horizontally.
  markdown: {
    overflowX: "auto",
    fontSize: tokens.fontSizeBase300,
    "& p": { marginTop: 0, marginBottom: tokens.spacingVerticalS },
    "& p:last-child": { marginBottom: 0 },
    "& table": { borderCollapse: "collapse", width: "100%" },
    "& th, & td": {
      ...shorthands.border("1px", "solid", tokens.colorNeutralStroke2),
      ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalS),
      textAlign: "left",
    },
  },
});

export function BriefingsPanel({ pins }: { pins: Pin[] }) {
  const styles = useStyles();

  const [briefings, setBriefings] = useState<Briefing[]>([]);
  // Create-form state.
  const [title, setTitle] = useState("");
  const [cadence, setCadence] = useState<Cadence>("manual");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // The most recently run report, rendered inline; and which briefing is running.
  const [report, setReport] = useState<BriefingReport | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setBriefings(await ragService.listBriefings());
    } catch {
      setBriefings([]);
    }
  }, []);

  // Load on mount (mutations call reload() directly afterwards).
  useEffect(() => {
    void reload();
  }, [reload]);

  // Selected pin ids in PIN order (not click order), pruned to pins that still
  // exist — this is exactly what saveBriefing persists.
  const selectedPinIds = pins.filter((p) => selected.has(p.id)).map((p) => p.id);
  const canSave = title.trim().length > 0 && selectedPinIds.length > 0 && !saving;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await ragService.saveBriefing(title.trim(), selectedPinIds, cadence);
      if (res.error) {
        setSaveError(res.error);
        return;
      }
      // Success: clear the form and refresh the list.
      setTitle("");
      setCadence("manual");
      setSelected(new Set());
      await reload();
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    await ragService.removeBriefing(id);
    // Drop the report if it belonged to the briefing just removed.
    setReport((r) => (r && r.id === id ? null : r));
    await reload();
  }

  async function run(id: string) {
    setRunningId(id);
    try {
      const rep = await ragService.runBriefing(id);
      if (rep) setReport(rep);
    } finally {
      setRunningId(null);
    }
  }

  return (
    <div className={styles.root}>
      {pins.length === 0 ? (
        <Text size={300} className={styles.muted}>
          Pin some analytics questions first, then group them into a briefing.
        </Text>
      ) : (
        <div className={styles.form}>
          <Field label="Title">
            <Input
              value={title}
              onChange={(_, d) => setTitle(d.value)}
              placeholder="e.g. Monday morning numbers"
            />
          </Field>
          <Field label="Cadence">
            <LhSelect
              options={CADENCE_OPTIONS}
              value={cadence}
              onChange={(v) => {
                const opt = CADENCE_OPTIONS.find((o) => o.value === v);
                if (opt) setCadence(opt.value);
              }}
              aria-label="Cadence"
            />
          </Field>
          <div>
            <Text weight="semibold" size={200}>
              Questions
            </Text>
            <div className={styles.checks}>
              {pins.map((p) => (
                <Checkbox
                  key={p.id}
                  checked={selected.has(p.id)}
                  onChange={() => toggle(p.id)}
                  label={p.question}
                />
              ))}
            </div>
          </div>
          <div className={styles.formActions}>
            <Button appearance="primary" disabled={!canSave} onClick={() => void save()}>
              {saving ? "Saving…" : "Save briefing"}
            </Button>
            {saveError && (
              <Text size={200} className={styles.danger}>
                {saveError}
              </Text>
            )}
          </div>
        </div>
      )}

      {briefings.length > 0 && (
        <div className={styles.list}>
          {briefings.map((b) => (
            <div key={b.id} className={styles.row}>
              <div className={styles.rowMain}>
                <Text weight="semibold" className={styles.rowTitle}>
                  {b.title}
                </Text>
                <Text size={200} className={styles.muted}>
                  {b.cadence} · {b.pinIds.length} question{b.pinIds.length === 1 ? "" : "s"}
                </Text>
              </div>
              <Button
                size="small"
                appearance="secondary"
                disabled={runningId !== null}
                onClick={() => void run(b.id)}
              >
                {runningId === b.id ? "Running…" : "Run"}
              </Button>
              <Button
                size="small"
                appearance="subtle"
                icon={<IconClose />}
                aria-label={`Remove briefing: ${b.title}`}
                onClick={() => void remove(b.id)}
              />
            </div>
          ))}
        </div>
      )}

      {report && (
        <div className={styles.report}>
          <Text weight="semibold" size={400}>
            {report.title}
          </Text>
          <Text size={200} className={styles.muted}>
            Generated {new Date(report.generatedMs).toLocaleString()}
          </Text>
          {report.sections.map((s, i) => (
            <div key={`${report.id}:${i}`} className={styles.section}>
              <Text weight="semibold" size={300}>
                {s.question}
              </Text>
              {s.error ? (
                <Text size={200} className={styles.danger}>
                  {s.error}
                </Text>
              ) : s.markdown.trim() ? (
                <div className={styles.markdown}>
                  <MarkdownView content={s.markdown} />
                </div>
              ) : (
                <Text size={200} italic className={styles.muted}>
                  no rows
                </Text>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
