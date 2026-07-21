"use client";

/**
 * [TEAM: capabilities] The sidebar's capability map (openspec: add-deep-analysis
 * §4.3) — one "what can I do with this vault" view, the ViewsNav/RecipesNav
 * Library sibling. It renders whatever `ragService.capabilityMap(includedFileIds)`
 * returns:
 *  - one block per analyzable table: its display name, an INVESTIGATE affordance
 *    (only for a Date+Numeric — "investigable" — table, so we never offer an
 *    investigation that would produce an empty report), and the recipes + metrics
 *    that apply to it;
 *  - the suggested asks the vault affords, as tap-to-ask chips (the RecipesNav ask
 *    seam — seed the chat, no new op);
 *  - an honest empty state when nothing is investigable.
 *
 * "Investigate {table}" runs the `investigate` op — the applicable recipe battery,
 * assembled into a report and WRITTEN in-vault — then reveals the saved note in the
 * tree (`lighthouse:reveal-node`, the chat-citation reveal seam). Every figure the
 * report carries is engine-computed; this panel introduces none.
 *
 * The ENGINE owns applicability + posture — this nav only presents the aggregate,
 * refetched when the included set changes (the RecipesNav lifecycle) and on the
 * shared `lighthouse:views-changed` signal. PARITY: the map is Rust-only
 * (DataFusion + recipes), so the web dev twin returns an EMPTY map and the panel
 * shows the empty state under `npm run dev` — correct, not special-cased.
 *
 * Beam treatment: Fluent tokens only (the ViewsNav/RecipesNav palette), both
 * light + dark themes free; no hand-picked colors.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Spinner,
  Text,
  makeStyles,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import {
  BeakerRegular,
  BriefcaseRegular,
  DocumentRegular,
  SearchRegular,
} from "@fluentui/react-icons";
import type { CapabilityMap, ReportTemplate } from "@/contracts";
import { EMPTY_CAPABILITY_MAP, ragService } from "@/contracts";
import { useRagStore } from "@/stores/useRagStore";

const useStyles = makeStyles({
  // The Library-sibling section chrome — the exact RecipesNav/InsightsNav
  // treatment (hairline below, breathing room), no new tokens.
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
    ...shorthands.padding("0", tokens.spacingHorizontalS),
  },
  headerLabel: { color: tokens.colorNeutralForeground3 },
  // A table block: a name row + the Investigate affordance, then its capabilities.
  tableBlock: {
    display: "flex",
    flexDirection: "column",
    gap: "1px",
    marginBottom: tokens.spacingVerticalXS,
  },
  tableTop: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    ...shorthands.padding(tokens.spacingVerticalXXS, tokens.spacingHorizontalS),
    minWidth: 0,
  },
  tableName: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: tokens.colorNeutralForeground1,
  },
  cap: {
    color: tokens.colorNeutralForeground3,
    ...shorthands.padding("1px", tokens.spacingHorizontalS, "1px", tokens.spacingHorizontalXL),
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // A tap-to-ask chip row (the RecipesNav run affordance): the whole row seeds the
  // chat with the suggested ask.
  askRow: {
    display: "flex",
    alignItems: "center",
    width: "100%",
    textAlign: "left",
    ...shorthands.border("none"),
    backgroundColor: "transparent",
    color: tokens.colorNeutralForeground2,
    ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalS),
    borderRadius: tokens.borderRadiusMedium,
    cursor: "pointer",
    minHeight: "28px",
    ":hover": { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
  note: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    color: tokens.colorNeutralForeground3,
    ...shorthands.padding("2px", tokens.spacingHorizontalS),
  },
});

/** Seed the chat with a suggested ask — the RecipesNav ask seam (no new op). */
function seedAsk(question: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("lighthouse:ask-question", { detail: { question } }));
}

export function CapabilityNav() {
  const styles = useStyles();
  // The included set drives the map (the RecipesNav idiom): re-read from the live
  // vault nodes, keyed by VALUE so idle polls don't refetch.
  const nodes = useRagStore((s) => s.nodes);
  const includedFileIds = useMemo(
    () => nodes.filter((n) => n.kind === "file" && n.ragIncluded).map((n) => n.id),
    [nodes],
  );
  const includedKey = useMemo(() => includedFileIds.join("\n"), [includedFileIds]);

  const [map, setMap] = useState<CapabilityMap>(EMPTY_CAPABILITY_MAP);
  const [loaded, setLoaded] = useState(false);
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
      setLoaded(true);
      return;
    }
    let cancelled = false;
    ragService
      .capabilityMap(includedKey.split("\n"))
      .then((m) => {
        if (!cancelled) {
          setMap(m ?? EMPTY_CAPABILITY_MAP);
          setLoaded(true);
        }
      })
      .catch(() => {
        // A failed aggregate degrades to the honest empty map, never an error card.
        if (!cancelled) {
          setMap(EMPTY_CAPABILITY_MAP);
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [includedKey, viewsNonce]);

  // Run the recipe battery + write the report, then reveal the saved note in the
  // tree (the chat-citation reveal seam). Rust-only, so the web twin throws — the
  // panel then shows an honest note instead of a fake saved file. `template`
  // (add-report-templates) optionally prescribes a structured shape — the engine
  // numbers are unchanged; a template only adds narrated framing over them.
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

  const hasAnything =
    map.tables.length > 0 || map.suggestedInvestigations.length > 0 || map.suggestedAsks.length > 0;

  return (
    <nav aria-label="What you can do" className={styles.section}>
      <div className={styles.header}>
        <Text size={200} weight="semibold" className={styles.headerLabel}>
          What you can do
        </Text>
      </div>

      {loaded &&
        map.tables.map((t) => {
          const recipes = map.recipes.filter((r) => r.table === t.name);
          const metrics = map.metrics.filter((m) => m.entity === t.name);
          return (
            <div key={t.name} className={styles.tableBlock}>
              <div className={styles.tableTop}>
                <Text size={300} weight="semibold" className={styles.tableName} title={t.name}>
                  {t.name}
                </Text>
                {t.investigable ? (
                  <Menu>
                    <MenuTrigger disableButtonEnhancement>
                      <Button
                        size="small"
                        appearance="subtle"
                        icon={<SearchRegular />}
                        disabled={busy === t.name}
                      >
                        {busy === t.name ? "Investigating…" : "Investigate"}
                      </Button>
                    </MenuTrigger>
                    <MenuPopover>
                      <MenuList>
                        {/* Standard: the deterministic report, unchanged. */}
                        <MenuItem
                          icon={<DocumentRegular />}
                          onClick={() => investigate(t.name)}
                        >
                          Standard report
                        </MenuItem>
                        {/* IMRaD — Introduction / Methods / Results / Discussion. */}
                        <MenuItem
                          icon={<BeakerRegular />}
                          onClick={() => investigate(t.name, "imrad")}
                        >
                          Scientific method
                        </MenuItem>
                        {/* BLUF — Bottom line up front + Minto-pyramid detail. */}
                        <MenuItem
                          icon={<BriefcaseRegular />}
                          onClick={() => investigate(t.name, "bluf")}
                        >
                          Business report
                        </MenuItem>
                      </MenuList>
                    </MenuPopover>
                  </Menu>
                ) : (
                  <Badge appearance="outline" color="informative" size="small">
                    reference
                  </Badge>
                )}
              </div>
              {recipes.map((r) => (
                <Text key={`${t.name}:${r.id}`} size={200} className={styles.cap} title={r.summary}>
                  · {r.name}
                </Text>
              ))}
              {metrics.map((m) => (
                <Text key={`${t.name}:${m.id}`} size={200} className={styles.cap} title={m.description}>
                  · metric {m.name}
                </Text>
              ))}
            </div>
          );
        })}

      {loaded &&
        map.suggestedAsks.map((a, i) => (
          <button
            key={`ask:${i}:${a.label}`}
            type="button"
            className={styles.askRow}
            title={a.question}
            onClick={() => seedAsk(a.question)}
          >
            <Text size={200}>Ask: {a.label}</Text>
          </button>
        ))}

      {!loaded && (
        <div className={styles.note} role="status">
          <Spinner size="tiny" label="Reading what your data supports…" labelPosition="after" />
        </div>
      )}

      {loaded && !hasAnything && (
        <Text size={200} className={styles.note}>
          Nothing to investigate yet — add a table with a date and a number, and its analyses appear
          here.
        </Text>
      )}

      {loaded && note && (
        <Text size={200} className={styles.note} role="status">
          {note}
        </Text>
      )}
    </nav>
  );
}
