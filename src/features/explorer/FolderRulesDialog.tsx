"use client";

/**
 * [TEAM: explorer]
 *
 * "Rules for this folder…" (openspec: add-curation-rules) — the per-folder rule
 * manager opened from a folder row's context menu. Lists the rules scoped to
 * that folder and offers a create form: a predicate builder (file kind /
 * extension list / path pattern) plus an action picker. Rules are a RESOLUTION
 * layer — they decide matching files, present and FUTURE, wherever the user
 * hasn't set an explicit per-file flag (explicit choices always win) — so
 * creating one here never stamps per-file state.
 *
 * Keep using `useRagStore` (do not import other features directly).
 */

import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogTitle,
  Field,
  Input,
  Text,
  Tooltip,
  makeStyles,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import { IconAdd, IconTrash } from "@/shell/icons";
import type { CurationRuleAction, CurationRuleInput, CurationRuleKind } from "@/contracts";
import { useRagStore } from "@/stores/useRagStore";
import { LhDialogSurface, LhSelect } from "@/shell/controls";

/** Plain-language labels for a rule's action — shared with the Preferences
 *  rule list so the two surfaces never word the same action differently. */
export const RULE_ACTION_LABEL: Record<CurationRuleAction, string> = {
  include: "Show to AI",
  exclude: "Hide from AI",
  "local-only": "Keep on this device",
  clear: "Use the default",
};

const RULE_ACTION_OPTIONS = (Object.keys(RULE_ACTION_LABEL) as CurationRuleAction[]).map((a) => ({
  value: a,
  label: RULE_ACTION_LABEL[a],
}));

const KIND_LABEL: Record<CurationRuleKind, string> = {
  tabular: "Spreadsheets",
  document: "Documents",
  image: "Images",
};

const KIND_OPTIONS = (Object.keys(KIND_LABEL) as CurationRuleKind[]).map((k) => ({
  value: k,
  label: KIND_LABEL[k],
}));

type PredicateChoice = "kind" | "ext" | "glob";

const PREDICATE_LABEL: Record<PredicateChoice, string> = {
  kind: "File kind",
  ext: "Extensions",
  glob: "Path pattern",
};

const PREDICATE_OPTIONS = (Object.keys(PREDICATE_LABEL) as PredicateChoice[]).map((p) => ({
  value: p,
  label: PREDICATE_LABEL[p],
}));

const useStyles = makeStyles({
  body: { display: "flex", flexDirection: "column", ...shorthands.gap("14px"), minWidth: "min(520px, 80vw)" },
  list: { display: "flex", flexDirection: "column", ...shorthands.gap("4px") },
  row: {
    display: "flex",
    alignItems: "center",
    ...shorthands.gap("8px"),
    ...shorthands.padding("4px", "8px"),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    backgroundColor: tokens.colorNeutralBackground2,
  },
  ruleName: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  muted: { color: tokens.colorNeutralForeground3 },
  formRow: { display: "flex", flexWrap: "wrap", alignItems: "flex-end", ...shorthands.gap("8px") },
  grow: { flex: 1, minWidth: "140px" },
  error: { color: tokens.colorPaletteRedForeground1 },
  hint: { color: tokens.colorNeutralForeground3 },
});

export function FolderRulesDialog({
  scope,
  scopeName,
  onClose,
}: {
  /** The folder node id the dialog manages rules for; null closes it. */
  scope: string | null;
  /** The folder's display name for the title. */
  scopeName: string;
  onClose: () => void;
}) {
  const styles = useStyles();
  const rules = useRagStore((s) => s.rules);
  const loadRules = useRagStore((s) => s.loadRules);
  const addRule = useRagStore((s) => s.addRule);
  const removeRule = useRagStore((s) => s.removeRule);

  // Create-form state: which predicate is being built + its value + the action.
  const [predicate, setPredicate] = useState<PredicateChoice>("kind");
  const [kind, setKind] = useState<CurationRuleKind>("tabular");
  const [extText, setExtText] = useState("");
  const [glob, setGlob] = useState("");
  const [action, setAction] = useState<CurationRuleAction>("include");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Fresh list + a clean form every time the dialog opens for a folder.
  useEffect(() => {
    if (scope === null) return;
    void loadRules();
    setPredicate("kind");
    setKind("tabular");
    setExtText("");
    setGlob("");
    setAction("include");
    setError(null);
  }, [scope, loadRules]);

  const scoped = useMemo(() => rules.filter((r) => r.scope === scope), [rules, scope]);

  const submit = () => {
    if (scope === null) return;
    const input: CurationRuleInput = { scope, action };
    if (predicate === "kind") {
      input.kind = kind;
    } else if (predicate === "ext") {
      const list = extText.split(/[\s,]+/).filter(Boolean);
      if (list.length === 0) {
        setError("Enter at least one extension (e.g. xlsx, csv).");
        return;
      }
      input.ext = list;
    } else {
      if (!glob.trim()) {
        setError("Enter a pattern (e.g. **/*.xlsx).");
        return;
      }
      input.glob = glob.trim();
    }
    setError(null);
    setBusy(true);
    void addRule(input)
      .then((res) => {
        if (res.error) {
          setError(res.error);
          return;
        }
        // Keep the dialog open so several rules can be added in one visit;
        // just clear the value fields.
        setExtText("");
        setGlob("");
      })
      .finally(() => setBusy(false));
  };

  return (
    <Dialog
      open={scope !== null}
      onOpenChange={(_, d) => {
        if (!d.open) onClose();
      }}
    >
      <LhDialogSurface aria-describedby={undefined}>
        <DialogBody>
          <DialogTitle>Rules for {scopeName || "this folder"}</DialogTitle>
          <DialogContent className={styles.body}>
            {scoped.length === 0 ? (
              <Text className={styles.muted}>
                No rules for this folder yet. A rule decides matching files here — including ones
                added later — unless you have set a file yourself.
              </Text>
            ) : (
              <div className={styles.list}>
                {scoped.map((r) => (
                  <div key={r.id} className={styles.row}>
                    <Text size={300} className={styles.ruleName} title={r.name}>
                      {r.name}
                    </Text>
                    <Badge size="small" appearance="tint" color="brand">
                      {RULE_ACTION_LABEL[r.action] ?? r.action}
                    </Badge>
                    <Tooltip content="Remove this rule — files it decided revert to your settings" relationship="label">
                      <Button
                        size="small"
                        appearance="subtle"
                        icon={<IconTrash />}
                        aria-label={`Remove rule ${r.name}`}
                        onClick={() => void removeRule(r.id)}
                      />
                    </Tooltip>
                  </div>
                ))}
              </div>
            )}

            <div className={styles.formRow}>
              <Field label="Match" size="small">
                <LhSelect
                  options={PREDICATE_OPTIONS}
                  value={predicate}
                  onChange={(v) => {
                    setPredicate(v as PredicateChoice);
                    setError(null);
                  }}
                  aria-label="Match"
                />
              </Field>
              {predicate === "kind" && (
                <Field label="Kind" size="small">
                  <LhSelect
                    options={KIND_OPTIONS}
                    value={kind}
                    onChange={(v) => setKind(v as CurationRuleKind)}
                    aria-label="Kind"
                  />
                </Field>
              )}
              {predicate === "ext" && (
                <Field label="Extensions" size="small" className={styles.grow}>
                  <Input
                    size="small"
                    value={extText}
                    placeholder="xlsx, csv"
                    aria-label="Extensions, comma-separated"
                    onChange={(_, d) => setExtText(d.value)}
                  />
                </Field>
              )}
              {predicate === "glob" && (
                <Field label="Pattern" size="small" className={styles.grow}>
                  <Input
                    size="small"
                    value={glob}
                    placeholder="**/*.xlsx"
                    aria-label="Path pattern relative to this folder"
                    onChange={(_, d) => setGlob(d.value)}
                  />
                </Field>
              )}
              <Field label="Then" size="small">
                <LhSelect
                  options={RULE_ACTION_OPTIONS}
                  value={action}
                  onChange={(v) => setAction(v as CurationRuleAction)}
                  aria-label="Then"
                />
              </Field>
              <Button
                appearance="primary"
                size="small"
                icon={<IconAdd />}
                disabled={busy}
                onClick={submit}
              >
                Add rule
              </Button>
            </div>
            {error && (
              <Text size={200} className={styles.error}>
                {error}
              </Text>
            )}
            <Text size={200} className={styles.hint}>
              Patterns are relative to this folder and support *, ** and ?. Your explicit
              per-file choices always beat rules; removing a rule only undoes what it decided.
            </Text>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              Close
            </Button>
          </DialogActions>
        </DialogBody>
      </LhDialogSurface>
    </Dialog>
  );
}
