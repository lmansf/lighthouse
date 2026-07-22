"use client";

/**
 * [TEAM: semantic] The sidebar's Business definitions section (openspec:
 * add-semantic-layer §6.2) — the curated metrics + synonyms applicable to the
 * current tables (hosted in Settings since 0.13.10 §3). One row per metric
 * (name + its definition, a per-row lock badge when local-only, an overflow menu
 * with Ask / Rename / Delete) and one per synonym (term → canonical, Delete).
 * "New metric" / "New synonym" author definitions inline.
 *
 * The ENGINE owns every rule — this nav only renders what
 * `ragService.applicableSemantics(includedFileIds)` returns (refetched when the
 * included set changes and on the `lighthouse:semantic-changed` signal a
 * define-from-answer also fires) and surfaces the engine's refusals VERBATIM:
 *  - Create refuses an unguarded/duplicate/unknown-entity definition.
 *  - Rename/Delete refuse while dependent synonyms exist; Delete offers an
 *    explicit cascade that SHOWS the synonyms it will also remove.
 * No path ever writes to a source file.
 *
 * PARITY/scope: metric + synonym authoring is v1; a local-only metric shows a
 * lock badge exactly like a private view. Beam treatment: Fluent tokens only,
 * both themes free.
 */

import { useEffect, useMemo, useState } from "react";
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
  Textarea,
  makeStyles,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import { IconAdd, IconChat, IconLock, IconMore, IconRename, IconTrash } from "@/shell/icons";
import type { MetricCard, SuggestedMetric, SynonymCard } from "@/contracts";
import { ragService } from "@/contracts";
import { useRagStore } from "@/stores/useRagStore";
import { LhDialogSurface, LhMenu } from "@/shell/controls";

const useStyles = makeStyles({
  // The Library-sibling chrome — the exact ViewsNav treatment.
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
  subHeader: {
    color: tokens.colorNeutralForeground3,
    ...shorthands.padding(tokens.spacingVerticalXXS, tokens.spacingHorizontalS, "0"),
  },
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
    cursor: "default",
  },
  rowMain: { display: "flex", flexDirection: "column", flex: 1, minWidth: 0 },
  rowName: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  rowCaption: {
    color: tokens.colorNeutralForeground3,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
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
  newRow: { display: "flex", gap: tokens.spacingHorizontalXS, marginTop: tokens.spacingVerticalXXS },
  newButton: { alignSelf: "flex-start" },
  dialogSurface: { maxWidth: "480px", width: "92vw" },
  dialogContent: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
  },
  dialogHint: { color: tokens.colorNeutralForeground3 },
});

/** Tell every semantic surface (nav + recipes, a metric is context too) to
 *  re-read. A metric can add/drop applicability, so also nudge views-changed. */
function broadcastSemanticChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("lighthouse:semantic-changed"));
  }
}

/** Ask about a metric through the existing ask seam (the ViewsNav idiom). */
function askAbout(name: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("lighthouse:ask-question", { detail: { question: `Show me ${name}.` } }),
  );
}

interface NewMetricState {
  name: string;
  expression: string;
  entity: string;
  description: string;
  busy: boolean;
  error: string | null;
}

interface NewSynonymState {
  term: string;
  canonical: string;
  busy: boolean;
  error: string | null;
}

interface RenameState {
  id: string;
  name: string;
  busy: boolean;
  error: string | null;
}

interface DeleteMetricState {
  id: string;
  name: string;
  /** Dependent synonym terms — non-empty ⇒ the cascade confirmation. */
  dependents: string[];
  busy: boolean;
  error: string | null;
}

export function SemanticNav() {
  const styles = useStyles();
  const nodes = useRagStore((s) => s.nodes);
  const includedFileIds = useMemo(
    () => nodes.filter((n) => n.kind === "file" && n.ragIncluded).map((n) => n.id),
    [nodes],
  );
  // Key by VALUE: the vault poll rebuilds `nodes` every
  // few seconds even when nothing changed — a per-tick refetch would be waste.
  const includedKey = useMemo(() => includedFileIds.join("\n"), [includedFileIds]);

  const [metrics, setMetrics] = useState<MetricCard[]>([]);
  const [synonyms, setSynonyms] = useState<SynonymCard[]>([]);
  // §3.4 auto-derived PROPOSALS — the Suggested affordance. Never stored until
  // the user accepts (synonyms one-click; metrics prefill the New metric dialog).
  const [suggestedSynonyms, setSuggestedSynonyms] = useState<SynonymCard[]>([]);
  const [suggestedMetrics, setSuggestedMetrics] = useState<SuggestedMetric[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [navError, setNavError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const [newMetric, setNewMetric] = useState<NewMetricState | null>(null);
  const [newSynonym, setNewSynonym] = useState<NewSynonymState | null>(null);
  const [rename, setRename] = useState<RenameState | null>(null);
  const [delMetric, setDelMetric] = useState<DeleteMetricState | null>(null);

  // A metric/synonym created or defined anywhere re-reads the applicable set.
  useEffect(() => {
    const onChanged = () => setNonce((n) => n + 1);
    window.addEventListener("lighthouse:semantic-changed", onChanged);
    return () => window.removeEventListener("lighthouse:semantic-changed", onChanged);
  }, []);

  useEffect(() => {
    let cancelled = false;
    ragService
      .applicableSemantics(includedKey ? includedKey.split("\n") : [])
      .then((cards) => {
        if (!cancelled) {
          setMetrics(Array.isArray(cards.metrics) ? cards.metrics : []);
          setSynonyms(Array.isArray(cards.synonyms) ? cards.synonyms : []);
          setSuggestedSynonyms(Array.isArray(cards.suggestedSynonyms) ? cards.suggestedSynonyms : []);
          setSuggestedMetrics(Array.isArray(cards.suggestedMetrics) ? cards.suggestedMetrics : []);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMetrics([]);
          setSynonyms([]);
          setSuggestedSynonyms([]);
          setSuggestedMetrics([]);
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [includedKey, nonce]);

  function refresh() {
    setNonce((n) => n + 1);
  }

  async function commitNewMetric() {
    if (!newMetric || newMetric.busy) return;
    const name = newMetric.name.trim();
    const expression = newMetric.expression.trim();
    const entity = newMetric.entity.trim();
    if (!name || !expression || !entity) return;
    setNewMetric({ ...newMetric, busy: true, error: null });
    try {
      await ragService.createMetric({
        name,
        expression,
        entity,
        description: newMetric.description.trim(),
        // The nav-authored provenance: the analyst stated it (the question label
        // is the closest of the two-value whitelist for a hand-typed definition).
        summaryText: newMetric.description.trim() || name,
        summarySource: "question",
        // Reads derive from the in-scope files; the engine maps the entity to
        // whichever registered table matches.
        fileIds: includedFileIds,
      });
      setNewMetric(null);
      refresh();
      broadcastSemanticChanged();
    } catch (err) {
      setNewMetric(
        (m) =>
          m && {
            ...m,
            busy: false,
            error: err instanceof Error ? err.message : "the metric could not be created",
          },
      );
    }
  }

  async function commitNewSynonym() {
    if (!newSynonym || newSynonym.busy) return;
    const term = newSynonym.term.trim();
    const canonical = newSynonym.canonical.trim();
    if (!term || !canonical) return;
    setNewSynonym({ ...newSynonym, busy: true, error: null });
    try {
      await ragService.createSynonym(term, canonical);
      setNewSynonym(null);
      refresh();
      broadcastSemanticChanged();
    } catch (err) {
      setNewSynonym(
        (s) =>
          s && {
            ...s,
            busy: false,
            error: err instanceof Error ? err.message : "the synonym could not be created",
          },
      );
    }
  }

  async function commitRename() {
    if (!rename) return;
    const name = rename.name.trim();
    if (!name || rename.busy) return;
    setRename({ ...rename, busy: true, error: null });
    try {
      await ragService.renameMetric(rename.id, name);
      setRename(null);
      refresh();
      broadcastSemanticChanged();
    } catch (err) {
      setRename(
        (r) =>
          r && {
            ...r,
            busy: false,
            error: err instanceof Error ? err.message : "the metric could not be renamed",
          },
      );
    }
  }

  function openDeleteMetric(m: MetricCard) {
    setNavError(null);
    // Dependent synonyms are already loaded (a surfaced metric's synonyms surface
    // with it), so the cascade decision needs no round-trip.
    const dependents = synonyms
      .filter((s) => s.canonical.toLowerCase() === m.name.toLowerCase())
      .map((s) => s.term);
    setDelMetric({ id: m.id, name: m.name, dependents, busy: false, error: null });
  }

  async function confirmDeleteMetric() {
    if (!delMetric || delMetric.busy) return;
    const cascade = delMetric.dependents.length > 0;
    setDelMetric({ ...delMetric, busy: true, error: null });
    try {
      await ragService.deleteMetric(delMetric.id, cascade);
      setDelMetric(null);
      refresh();
      broadcastSemanticChanged();
    } catch (err) {
      setDelMetric(
        (d) =>
          d && {
            ...d,
            busy: false,
            error: err instanceof Error ? err.message : "the metric could not be deleted",
          },
      );
    }
  }

  async function deleteSynonym(term: string) {
    setNavError(null);
    try {
      await ragService.deleteSynonym(term);
      refresh();
      broadcastSemanticChanged();
    } catch (err) {
      setNavError(err instanceof Error ? err.message : "the synonym could not be deleted");
    }
  }

  // Accept a suggested synonym in one click — it routes through the SAME guarded
  // createSynonym as the manual flow; nothing was stored until now.
  async function acceptSuggestedSynonym(term: string, canonical: string) {
    setNavError(null);
    try {
      await ragService.createSynonym(term, canonical);
      refresh();
      broadcastSemanticChanged();
    } catch (err) {
      setNavError(err instanceof Error ? err.message : "the synonym could not be added");
    }
  }

  // Accept a suggested metric: prefill the manual New metric dialog with the
  // mined expression + entity so the user only has to NAME it (the manual create
  // flow is untouched — the guard still runs on Create).
  function acceptSuggestedMetric(p: SuggestedMetric) {
    setNewMetric({
      name: "",
      expression: p.expression,
      entity: p.entity,
      description: "",
      busy: false,
      error: null,
    });
  }

  const cascade = (delMetric?.dependents.length ?? 0) > 0;

  return (
    <nav aria-label="Business definitions" className={styles.section}>
      <div className={styles.header}>
        <Text size={200} weight="semibold" className={styles.headerLabel}>
          Business definitions
        </Text>
      </div>

      {metrics.map((m) => (
        <div key={m.id} className={styles.row}>
          <div className={styles.rowButton} title={`${m.name} = ${m.expression}`}>
            <div className={styles.rowMain}>
              <Text size={300} className={styles.rowName}>
                {m.name}
              </Text>
              <Text size={200} className={styles.rowCaption}>
                {m.expression}
              </Text>
            </div>
            {m.localOnly && (
              <IconLock
                className={styles.lock}
                aria-label="Private — this device only"
                title="Private — this device only"
              />
            )}
          </div>
          <LhMenu
            trigger={
              <Button
                appearance="subtle"
                size="small"
                icon={<IconMore />}
                aria-label={`Actions for ${m.name}`}
                className={styles.rowMenuBtn}
              />
            }
            items={[
              {
                key: "ask",
                label: "Ask about this metric",
                icon: <IconChat />,
                onClick: () => askAbout(m.name),
              },
              {
                key: "rename",
                label: "Rename",
                icon: <IconRename />,
                onClick: () => setRename({ id: m.id, name: m.name, busy: false, error: null }),
              },
              {
                key: "delete",
                label: "Delete",
                icon: <IconTrash />,
                onClick: () => openDeleteMetric(m),
              },
            ]}
            aria-label={`Actions for ${m.name}`}
          />
        </div>
      ))}

      {synonyms.length > 0 && (
        <Text size={200} className={styles.subHeader}>
          Synonyms
        </Text>
      )}
      {synonyms.map((s) => (
        <div key={s.term} className={styles.row}>
          <div className={styles.rowButton} title={`${s.term} → ${s.canonical}`}>
            <Text size={300} className={styles.rowName}>
              {s.term} → {s.canonical}
            </Text>
          </div>
          <Button
            appearance="subtle"
            size="small"
            icon={<IconTrash />}
            aria-label={`Delete synonym ${s.term}`}
            className={styles.rowMenuBtn}
            onClick={() => void deleteSynonym(s.term)}
          />
        </div>
      ))}

      {/* Suggested (openspec: field-patch-0.12.5 §3.4) — auto-derived proposals
          the user accepts one-by-one; the manual create flow above is untouched. */}
      {(suggestedSynonyms.length > 0 || suggestedMetrics.length > 0) && (
        <Text size={200} className={styles.subHeader}>
          Suggested
        </Text>
      )}
      {suggestedMetrics.map((p) => (
        <div key={`sm-${p.entity}-${p.expression}`} className={styles.row}>
          <div
            className={styles.rowButton}
            title={`${p.expression} over ${p.entity} — seen ${p.occurrences}×${p.certified ? ", certified" : ""}`}
          >
            <div className={styles.rowMain}>
              <Text size={300} className={styles.rowName}>
                {p.expression}
              </Text>
              <Text size={200} className={styles.rowCaption}>
                over {p.entity} · seen {p.occurrences}×{p.certified ? " · certified" : ""}
              </Text>
            </div>
          </div>
          <Button
            appearance="subtle"
            size="small"
            icon={<IconAdd />}
            aria-label={`Save ${p.expression} as a metric`}
            className={styles.rowMenuBtn}
            onClick={() => acceptSuggestedMetric(p)}
          >
            Save as metric
          </Button>
        </div>
      ))}
      {suggestedSynonyms.map((s) => (
        <div key={`ss-${s.term}`} className={styles.row}>
          <div className={styles.rowButton} title={`${s.term} → ${s.canonical}`}>
            <Text size={300} className={styles.rowName}>
              {s.term} → {s.canonical}
            </Text>
          </div>
          <Button
            appearance="subtle"
            size="small"
            icon={<IconAdd />}
            aria-label={`Add synonym ${s.term}`}
            className={styles.rowMenuBtn}
            onClick={() => void acceptSuggestedSynonym(s.term, s.canonical)}
          />
        </div>
      ))}

      {loaded && metrics.length === 0 && synonyms.length === 0 && (
        <Text size={200} className={styles.note}>
          Define a metric once — a business term with an exact definition your answers compute and
          the engine can certify.
        </Text>
      )}
      {navError && (
        <Text size={200} className={styles.errorNote} role="status">
          {navError}
        </Text>
      )}

      <div className={styles.newRow}>
        <Button
          appearance="subtle"
          size="small"
          icon={<IconAdd />}
          className={styles.newButton}
          onClick={() =>
            setNewMetric({ name: "", expression: "", entity: "", description: "", busy: false, error: null })
          }
        >
          New metric
        </Button>
        <Button
          appearance="subtle"
          size="small"
          icon={<IconAdd />}
          className={styles.newButton}
          onClick={() => setNewSynonym({ term: "", canonical: "", busy: false, error: null })}
        >
          New synonym
        </Button>
      </div>

      {/* New metric — the engine owns the guard; a refusal shows verbatim. */}
      <Dialog
        open={newMetric !== null}
        onOpenChange={(_, d) => {
          if (!d.open) setNewMetric(null);
        }}
      >
        <LhDialogSurface className={styles.dialogSurface}>
          <DialogBody>
            <DialogTitle>New metric</DialogTitle>
            <DialogContent className={styles.dialogContent}>
              <Field label="Name" hint="lowercase letters, digits, and underscores">
                <Input
                  value={newMetric?.name ?? ""}
                  onChange={(_, d) => setNewMetric((m) => m && { ...m, name: d.value })}
                  placeholder="e.g. revenue"
                  aria-label="Metric name"
                  autoFocus
                />
              </Field>
              <Field label="Definition" hint="an aggregation expression, e.g. SUM(amount) FILTER (WHERE status='paid')">
                <Input
                  value={newMetric?.expression ?? ""}
                  onChange={(_, d) => setNewMetric((m) => m && { ...m, expression: d.value })}
                  placeholder="SUM(amount)"
                  aria-label="Metric definition"
                />
              </Field>
              <Field label="Entity" hint="the table (or saved view) it aggregates over">
                <Input
                  value={newMetric?.entity ?? ""}
                  onChange={(_, d) => setNewMetric((m) => m && { ...m, entity: d.value })}
                  placeholder="sales"
                  aria-label="Metric entity"
                />
              </Field>
              <Field label="Description (optional)">
                <Textarea
                  value={newMetric?.description ?? ""}
                  onChange={(_, d) => setNewMetric((m) => m && { ...m, description: d.value })}
                  placeholder="what this metric means"
                  aria-label="Metric description"
                />
              </Field>
              {newMetric?.error && (
                <Text size={200} className={styles.errorNote} role="status">
                  {newMetric.error}
                </Text>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setNewMetric(null)}>
                Cancel
              </Button>
              <Button
                appearance="primary"
                disabled={
                  !newMetric ||
                  newMetric.busy ||
                  !newMetric.name.trim() ||
                  !newMetric.expression.trim() ||
                  !newMetric.entity.trim()
                }
                onClick={() => void commitNewMetric()}
              >
                {newMetric?.busy ? "Creating…" : "Create"}
              </Button>
            </DialogActions>
          </DialogBody>
        </LhDialogSurface>
      </Dialog>

      {/* New synonym */}
      <Dialog
        open={newSynonym !== null}
        onOpenChange={(_, d) => {
          if (!d.open) setNewSynonym(null);
        }}
      >
        <LhDialogSurface className={styles.dialogSurface}>
          <DialogBody>
            <DialogTitle>New synonym</DialogTitle>
            <DialogContent className={styles.dialogContent}>
              <Field label="Term" hint="the colloquial phrase, e.g. GMV">
                <Input
                  value={newSynonym?.term ?? ""}
                  onChange={(_, d) => setNewSynonym((s) => s && { ...s, term: d.value })}
                  placeholder="GMV"
                  aria-label="Synonym term"
                  autoFocus
                />
              </Field>
              <Field label="Canonical" hint="a column name or a metric name it maps to">
                <Input
                  value={newSynonym?.canonical ?? ""}
                  onChange={(_, d) => setNewSynonym((s) => s && { ...s, canonical: d.value })}
                  placeholder="revenue"
                  aria-label="Synonym canonical"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void commitNewSynonym();
                  }}
                />
              </Field>
              {newSynonym?.error && (
                <Text size={200} className={styles.errorNote} role="status">
                  {newSynonym.error}
                </Text>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setNewSynonym(null)}>
                Cancel
              </Button>
              <Button
                appearance="primary"
                disabled={
                  !newSynonym || newSynonym.busy || !newSynonym.term.trim() || !newSynonym.canonical.trim()
                }
                onClick={() => void commitNewSynonym()}
              >
                {newSynonym?.busy ? "Creating…" : "Create"}
              </Button>
            </DialogActions>
          </DialogBody>
        </LhDialogSurface>
      </Dialog>

      {/* Rename metric — a dependents refusal shows verbatim. */}
      <Dialog
        open={rename !== null}
        onOpenChange={(_, d) => {
          if (!d.open) setRename(null);
        }}
      >
        <LhDialogSurface className={styles.dialogSurface}>
          <DialogBody>
            <DialogTitle>Rename metric</DialogTitle>
            <DialogContent className={styles.dialogContent}>
              <Input
                value={rename?.name ?? ""}
                onChange={(_, d) => setRename((r) => r && { ...r, name: d.value })}
                placeholder="e.g. net_revenue"
                aria-label="New metric name"
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
        </LhDialogSurface>
      </Dialog>

      {/* Delete metric — plain confirm, or an explicit cascade that shows the
          synonyms it will also remove. Sources untouched. */}
      <Dialog
        open={delMetric !== null}
        onOpenChange={(_, d) => {
          if (!d.open) setDelMetric(null);
        }}
      >
        <LhDialogSurface className={styles.dialogSurface}>
          <DialogBody>
            <DialogTitle>
              {cascade
                ? `Delete “${delMetric?.name ?? ""}” and its synonyms?`
                : `Delete metric “${delMetric?.name ?? ""}”?`}
            </DialogTitle>
            <DialogContent className={styles.dialogContent}>
              {cascade ? (
                <Text size={300}>
                  “{delMetric?.name}” is mapped by: {delMetric?.dependents.join(", ")}. Deleting it
                  will also delete{" "}
                  {delMetric && delMetric.dependents.length === 1 ? "that synonym" : "those synonyms"}.
                  Your source files are never touched.
                </Text>
              ) : (
                <Text size={300}>
                  Delete metric “{delMetric?.name ?? ""}”? This never touches your source files.
                </Text>
              )}
              {delMetric?.error && (
                <Text size={200} className={styles.errorNote} role="status">
                  {delMetric.error}
                </Text>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setDelMetric(null)}>
                Cancel
              </Button>
              <Button
                appearance="primary"
                disabled={!delMetric || delMetric.busy}
                onClick={() => void confirmDeleteMetric()}
              >
                {cascade
                  ? `Delete all ${(delMetric?.dependents.length ?? 0) + 1}`
                  : delMetric?.busy
                    ? "Deleting…"
                    : "Delete"}
              </Button>
            </DialogActions>
          </DialogBody>
        </LhDialogSurface>
      </Dialog>
    </nav>
  );
}
