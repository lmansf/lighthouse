"use client";

/**
 * The mid-session ask, reduced to a single question. Instead of a six-field
 * survey, it shows the features we've shelved (src/lib/shelvedFeatures.ts) and
 * asks "Would you use any of these?" — each with a one-sentence caption. The
 * answer (which features they'd use, or none) is recorded in the dedicated
 * `feature_interest` Supabase table via useLicenseStore.submitFeatureInterest.
 *
 * It always completes (even with nothing checked — "none of these" is itself a
 * useful signal), so the nudge never traps the user, and it's best-effort: a
 * failed send still closes the nudge.
 */
import { useState } from "react";
import {
  Button,
  Checkbox,
  Spinner,
  Text,
  Title3,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { SHELVED_FEATURES } from "@/lib/shelvedFeatures";
import { useLicenseStore } from "@/stores/useLicenseStore";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM },
  sub: { color: tokens.colorNeutralForeground2 },
  list: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS },
  // A checkbox whose label stacks a bold name over a one-line caption.
  optionLabel: { display: "flex", flexDirection: "column", gap: "2px" },
  optionTitle: { fontWeight: tokens.fontWeightSemibold },
  caption: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  actions: { display: "flex", justifyContent: "flex-end" },
});

export function FeatureInterestVote({ onDone }: { onDone: () => void }) {
  const styles = useStyles();
  const submit = useLicenseStore((s) => s.submitFeatureInterest);
  const [wanted, setWanted] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  const toggle = (id: string) => setWanted((w) => ({ ...w, [id]: !w[id] }));

  async function send() {
    setBusy(true);
    const shown = SHELVED_FEATURES.map((f) => f.id);
    const chosen = shown.filter((id) => wanted[id]);
    // Best-effort: record the vote, but complete regardless so the nudge closes.
    await submit(shown, chosen).catch(() => false);
    setBusy(false);
    onDone();
  }

  return (
    <div className={styles.root}>
      <Title3>Would you use any of these features?</Title3>
      <Text className={styles.sub}>
        We&apos;re keeping Lighthouse lean — tick anything you&apos;d actually use and we&apos;ll
        know it&apos;s worth building.
      </Text>
      <div className={styles.list}>
        {SHELVED_FEATURES.map((f) => (
          <Checkbox
            key={f.id}
            checked={Boolean(wanted[f.id])}
            onChange={() => toggle(f.id)}
            label={
              <span className={styles.optionLabel}>
                <span className={styles.optionTitle}>{f.label}</span>
                <span className={styles.caption}>{f.caption}</span>
              </span>
            }
          />
        ))}
      </div>
      <div className={styles.actions}>
        <Button
          appearance="primary"
          disabled={busy}
          icon={busy ? <Spinner size="tiny" /> : undefined}
          onClick={() => void send()}
        >
          {busy ? "Sending…" : "Send"}
        </Button>
      </div>
    </div>
  );
}
