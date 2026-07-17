"use client";

/**
 * [TEAM: views] The shaping ask (openspec: add-shaped-views §3.2-3.3): pick a
 * source table or saved view, describe the transform in plain words, and
 * "Propose" runs ONE engine-guarded completion (`op:"shapeView"`). The engine
 * answers a PROPOSAL — the validated SELECT plus engine-rendered before/after
 * sample rows — and NOTHING persists until the user names it and clicks Save
 * (which calls the ordinary `createView`, summary labeled "model"). Cancel or
 * a refusal persists nothing; every piece of state resets when the dialog
 * closes. `{available:false}` (extractive provider, or the web dev twin —
 * PARITY) renders the engine's reason and retires the Propose button rather
 * than inviting retry spam.
 *
 * Self-contained by design: §3 exports the component; §4 wires the Library
 * entry point and feeds `sources`/`fileIds` from the catalog.
 *
 * Beam treatment: Fluent tokens only, so both themes come for free; the
 * surface sizing mirrors BoardPanel's dialog.
 */

import { useEffect, useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Field,
  Input,
  Option,
  Spinner,
  Text,
  Textarea,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { CheckmarkRegular, ErrorCircleRegular } from "@fluentui/react-icons";
import dynamic from "next/dynamic";
import type { ShapeProposal } from "@/contracts";
import { ragService } from "@/contracts";

// The markdown stack loads on demand (the ChatPanel idiom) — only a rendered
// proposal needs it, never the empty form.
const MarkdownView = dynamic(() => import("@/shell/MarkdownView"), { ssr: false });

const useStyles = makeStyles({
  surface: { maxWidth: "760px", width: "94vw" },
  content: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    maxHeight: "72vh",
    overflowY: "auto",
  },
  quiet: { color: tokens.colorNeutralForeground3 },
  status: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    color: tokens.colorNeutralForeground3,
  },
  errorNote: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorStatusDangerBackground1,
    color: tokens.colorStatusDangerForeground1,
  },
  savedNote: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    color: tokens.colorNeutralForeground3,
  },
  // The proposal's SQL — the Edit SQL dialog's monospace code-block register.
  sqlBlock: {
    margin: 0,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    overflowX: "auto",
  },
  // One labeled before/after sample: the engine's markdown table in a quiet
  // card, scrolling inside itself so a wide table never outgrows the dialog.
  sample: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    overflowX: "auto",
    "& table": {
      borderCollapse: "collapse",
      fontSize: tokens.fontSizeBase200,
    },
    "& th, & td": {
      padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalS}`,
      border: `1px solid ${tokens.colorNeutralStroke2}`,
      textAlign: "left",
    },
  },
  sampleLabel: { color: tokens.colorNeutralForeground3 },
  saveRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-end",
    gap: tokens.spacingHorizontalS,
  },
  grow: { flexGrow: 1, minWidth: "180px" },
});

type Phase =
  | { kind: "compose" }
  | { kind: "proposing" }
  | { kind: "proposal"; proposal: ShapeProposal }
  | { kind: "unavailable"; reason: string }
  | { kind: "saved"; name: string };

export function ShapeViewDialog({
  open,
  onClose,
  sources,
  fileIds,
  defaultSource,
}: {
  open: boolean;
  onClose: () => void;
  /** Table + saved-view names offered as the source picker (caller-fed). */
  sources: string[];
  /** The candidate file ids behind those sources — ride the shape ask and the save. */
  fileIds: string[];
  defaultSource?: string;
}) {
  const styles = useStyles();
  const [source, setSource] = useState("");
  const [instruction, setInstruction] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "compose" });
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  // State resets on close/open so Cancel provably leaves nothing behind —
  // the next open starts from a clean compose form.
  useEffect(() => {
    if (open) {
      setSource(defaultSource && sources.includes(defaultSource) ? defaultSource : (sources[0] ?? ""));
      setInstruction("");
      setPhase({ kind: "compose" });
      setError(null);
      setName("");
      setSaving(false);
    }
  }, [open, defaultSource, sources]);

  async function propose() {
    setPhase({ kind: "proposing" });
    setError(null);
    try {
      const res = await ragService.shapeView(source, instruction.trim(), fileIds);
      if (res.available === false) {
        // Honest unavailability (extractive provider / the dev twin): show
        // the reason and retire Propose — retrying can't change the answer.
        setPhase({ kind: "unavailable", reason: res.reason });
        return;
      }
      const { sql, before, after, summary } = res;
      setPhase({ kind: "proposal", proposal: { sql, before, after, summary } });
    } catch (err) {
      // A refusal (unknown source, guard rejection, the model's own words):
      // back to compose with the engine's reason — retry is free.
      setError(err instanceof Error ? err.message : "shaping failed");
      setPhase({ kind: "compose" });
    }
  }

  async function save(proposal: ShapeProposal) {
    setSaving(true);
    setError(null);
    try {
      const view = await ragService.createView({
        name: name.trim(),
        sql: proposal.sql,
        summaryText: proposal.summary,
        summarySource: "model",
        fileIds,
      });
      setPhase({ kind: "saved", name: view.name });
    } catch (err) {
      // The engine's refusal, verbatim; the proposal stays on screen and
      // nothing was persisted.
      setError(err instanceof Error ? err.message : "could not save the view");
    } finally {
      setSaving(false);
    }
  }

  const composing = phase.kind === "compose" || phase.kind === "proposing";

  return (
    <Dialog
      open={open}
      onOpenChange={(_, data) => {
        if (!data.open) onClose();
      }}
    >
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <DialogTitle>Shape a view</DialogTitle>
          <DialogContent className={styles.content}>
            {composing && (
              <>
                <Text size={200} className={styles.quiet}>
                  Describe how to clean or reshape a table. The AI proposes one read-only
                  query, Lighthouse verifies it and shows before/after sample rows — and
                  nothing is saved until you say so. Your files are never modified.
                </Text>
                <Field label="Source">
                  <Dropdown
                    value={source}
                    selectedOptions={source ? [source] : []}
                    onOptionSelect={(_, data) => setSource(data.optionValue ?? "")}
                    aria-label="Source table or view"
                    disabled={phase.kind === "proposing"}
                  >
                    {sources.map((s) => (
                      <Option key={s} value={s}>
                        {s}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
                <Field label="What should change?">
                  <Textarea
                    value={instruction}
                    onChange={(_, d) => setInstruction(d.value)}
                    resize="vertical"
                    rows={3}
                    placeholder="e.g. the amount column is text like “$1,234” — make it a real number"
                    aria-label="Shaping instruction"
                    disabled={phase.kind === "proposing"}
                  />
                </Field>
                {phase.kind === "proposing" && (
                  <div className={styles.status}>
                    <Spinner size="tiny" />
                    <Text size={200}>Proposing…</Text>
                  </div>
                )}
              </>
            )}

            {phase.kind === "unavailable" && (
              <Text size={200} className={styles.quiet}>
                {phase.reason}
              </Text>
            )}

            {phase.kind === "proposal" && (
              <>
                <Text size={200} className={styles.quiet}>
                  Proposed query over “{source}” — verified read-only. Nothing is saved
                  until you click Save.
                </Text>
                <pre className={styles.sqlBlock}>{phase.proposal.sql}</pre>
                {phase.proposal.summary && (
                  <Text size={200} className={styles.quiet}>
                    {phase.proposal.summary}
                  </Text>
                )}
                <div className={styles.sample}>
                  <Text size={200} className={styles.sampleLabel}>
                    Before — first rows of {source}
                  </Text>
                  <MarkdownView content={phase.proposal.before} />
                </div>
                <div className={styles.sample}>
                  <Text size={200} className={styles.sampleLabel}>
                    After — first rows of the shaped result
                  </Text>
                  <MarkdownView content={phase.proposal.after} />
                </div>
                <div className={styles.saveRow}>
                  <Field
                    label="View name"
                    hint="lowercase letters, digits, and underscores"
                    className={styles.grow}
                  >
                    <Input
                      value={name}
                      onChange={(_, d) => setName(d.value)}
                      placeholder="e.g. clean_sales"
                      aria-label="View name"
                    />
                  </Field>
                </div>
              </>
            )}

            {phase.kind === "saved" && (
              <div className={styles.savedNote}>
                <CheckmarkRegular fontSize={14} />
                <Text size={200}>
                  Saved view “{phase.name}” — ask against it like any table.
                </Text>
              </div>
            )}

            {error && (
              <div className={styles.errorNote}>
                <ErrorCircleRegular fontSize={16} />
                <Text size={200}>{error}</Text>
              </div>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              {phase.kind === "saved" ? "Done" : "Cancel"}
            </Button>
            {composing && (
              <Button
                appearance="primary"
                disabled={phase.kind === "proposing" || !source || !instruction.trim()}
                onClick={() => void propose()}
              >
                {phase.kind === "proposing" ? "Proposing…" : "Propose"}
              </Button>
            )}
            {phase.kind === "proposal" && (
              <Button
                appearance="primary"
                disabled={saving || !name.trim()}
                onClick={() => void save(phase.proposal)}
              >
                {saving ? "Saving…" : "Save"}
              </Button>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
