"use client";

/**
 * [TEAM: semantic] "Define as metric" (openspec: add-semantic-layer §6.2) — the
 * dialog behind the chip on aggregate-bearing answers, the "Save as view"
 * precedent for a metric. On open it asks the engine to PROPOSE an aggregate
 * expression + entity from the answer's OWN executed SQL (defineMetric), shows
 * that proposal read-only, and on the user's Save persists it as a named metric
 * (createMetric) with the asked question recorded as its summary. No model is
 * consulted anywhere in this flow.
 *
 * PARITY: proposing parses SQL (Rust-only), so on the web dev twin defineMetric
 * answers {available:false} and the dialog explains honestly rather than
 * pretending. The ENGINE owns every save rule; a refusal shows verbatim.
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
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { ErrorCircleRegular } from "@fluentui/react-icons";
import { ragService } from "@/contracts";

const useStyles = makeStyles({
  surface: { maxWidth: "480px", width: "92vw" },
  content: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
  },
  quiet: { color: tokens.colorNeutralForeground3 },
  definition: {
    fontFamily: tokens.fontFamilyMonospace,
    backgroundColor: tokens.colorNeutralBackground3,
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusMedium,
    wordBreak: "break-word",
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
});

export function DefineMetricDialog({
  open,
  onClose,
  sql,
  fileIds,
  question,
}: {
  open: boolean;
  onClose: () => void;
  /** The answer's exact executed SQL (AnalyticsMeta.sql) — the engine parses it. */
  sql: string;
  /** The files that SQL read (AnalyticsMeta.fileIds) — reads derive from these. */
  fileIds: string[];
  /** The asked question — recorded as the metric's summary, labeled "question". */
  question: string;
}) {
  const styles = useStyles();
  const [name, setName] = useState("");
  const [proposing, setProposing] = useState(true);
  // The engine's proposal, or an honest unavailable reason.
  const [proposal, setProposal] = useState<{ expression: string; entity: string } | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fresh slate + a fresh proposal each open — a refusal or proposal from the
  // last answer must not haunt the next one.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setName("");
    setBusy(false);
    setError(null);
    setProposal(null);
    setUnavailable(null);
    setProposing(true);
    ragService
      .defineMetric(sql, fileIds)
      .then((res) => {
        if (cancelled) return;
        if (res.available) {
          setProposal({ expression: res.expression, entity: res.entity });
        } else {
          setUnavailable(res.reason);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setUnavailable(err instanceof Error ? err.message : "no metric could be proposed");
        }
      })
      .finally(() => {
        if (!cancelled) setProposing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, sql, fileIds]);

  async function create() {
    if (!proposal) return;
    setBusy(true);
    setError(null);
    try {
      await ragService.createMetric({
        name: name.trim(),
        expression: proposal.expression,
        entity: proposal.entity,
        description: "",
        summaryText: question,
        summarySource: "question",
        fileIds,
      });
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("lighthouse:semantic-changed"));
      }
      onClose();
    } catch (err) {
      // The engine's reason, verbatim — it owns the rules.
      setError(err instanceof Error ? err.message : "could not define the metric");
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
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <DialogTitle>Define as metric</DialogTitle>
          <DialogContent className={styles.content}>
            {proposing ? (
              <Text size={200} className={styles.quiet}>
                Reading this answer&apos;s query…
              </Text>
            ) : unavailable ? (
              <div className={styles.errorNote}>
                <ErrorCircleRegular fontSize={16} />
                <Text size={200}>{unavailable}</Text>
              </div>
            ) : (
              <>
                <Text size={200} className={styles.quiet}>
                  Names this answer&apos;s aggregation once, so future answers compute it the same
                  way and the engine can certify them. Nothing is copied or written.
                </Text>
                <Field label="Definition">
                  <Text size={300} className={styles.definition}>
                    {proposal?.expression} over {proposal?.entity}
                  </Text>
                </Field>
                <Field label="Name" hint="lowercase letters, digits, and underscores">
                  <Input
                    value={name}
                    onChange={(_, d) => setName(d.value)}
                    placeholder="e.g. revenue"
                    aria-label="Metric name"
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
                    <ErrorCircleRegular fontSize={16} />
                    <Text size={200}>{error}</Text>
                  </div>
                )}
              </>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              {unavailable ? "Close" : "Cancel"}
            </Button>
            {!unavailable && (
              <Button
                appearance="primary"
                disabled={proposing || busy || !proposal || !name.trim()}
                onClick={() => void create()}
              >
                {busy ? "Defining…" : "Define"}
              </Button>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
