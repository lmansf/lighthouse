"use client";

/**
 * [TEAM: chat] PLACEHOLDER.
 *
 * Working stub: streams a mock answer and renders references below it, the
 * Google-style "answer on top, related files underneath" layout. The chat team
 * builds out the full transcript/composer here. Scope retrieval via
 * `useRagStore().includedFileIds()` - never read other features' internals.
 */

import { useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  Input,
  Text,
  Title3,
  makeStyles,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import { DocumentRegular, SendRegular } from "@fluentui/react-icons";
import type { RagReference } from "@/contracts";
import { chatService } from "@/contracts";
import { useRagStore } from "@/stores/useRagStore";

const useStyles = makeStyles({
  panel: {
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    height: "100%",
    // Transparent so the panel blends into its host surface (the left rail).
    ...shorthands.padding(tokens.spacingVerticalL),
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: tokens.spacingVerticalM,
  },
  body: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
  },
  // Pre-conversation: the prompt sits centered in the rail (Google-style),
  // rather than pinned to the bottom.
  hero: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
    gap: tokens.spacingVerticalM,
    ...shorthands.padding(tokens.spacingVerticalXL, tokens.spacingHorizontalL),
  },
  heroComposer: { width: "100%", maxWidth: "520px", marginTop: tokens.spacingVerticalS },
  heroHint: { color: tokens.colorNeutralForeground2, maxWidth: "420px" },
  answer: {
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    whiteSpace: "pre-wrap",
  },
  refs: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    marginTop: tokens.spacingVerticalL,
  },
  refCard: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalM,
    ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalM),
  },
  refMeta: { display: "flex", flexDirection: "column", flex: 1, minWidth: 0 },
  composer: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalM,
  },
  empty: { color: tokens.colorNeutralForeground3 },

  // --- Loading signal: a small, subtle Lighthouse beacon that gently pulses.
  //     Compact and unobtrusive — it's gone the moment the answer starts. ---
  loader: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    ...shorthands.padding(tokens.spacingVerticalL, "0"),
    color: tokens.colorNeutralForeground3,
  },
  // Static glowing beacon for the centered pre-ask prompt (decorative).
  beacon: {
    width: "14px",
    height: "14px",
    borderRadius: "50%",
    backgroundColor: tokens.colorBrandBackground,
    boxShadow: `0 0 10px 2px ${tokens.colorBrandBackground}`,
  },
  // Small gently-pulsing dot used by the loader.
  loaderDot: {
    width: "10px",
    height: "10px",
    borderRadius: "50%",
    flexShrink: 0,
    backgroundColor: tokens.colorBrandBackground,
    boxShadow: `0 0 6px 1px ${tokens.colorBrandBackground}`,
    animationName: {
      "0%, 100%": { opacity: 0.35 },
      "50%": { opacity: 1 },
    },
    animationDuration: "1.2s",
    animationIterationCount: "infinite",
    animationTimingFunction: "ease-in-out",
  },
  beaconInline: {
    display: "inline-block",
    width: "10px",
    height: "10px",
    marginLeft: "6px",
    verticalAlign: "middle",
    borderRadius: "50%",
    backgroundColor: tokens.colorBrandBackground,
    boxShadow: `0 0 8px 2px ${tokens.colorBrandBackground}`,
    animationName: {
      "0%, 100%": { opacity: 0.4 },
      "50%": { opacity: 1 },
    },
    animationDuration: "1s",
    animationIterationCount: "infinite",
    animationTimingFunction: "ease-in-out",
  },
});

/** Subtle Lighthouse beacon loader, shown briefly while we wait for the first token. */
function LighthouseLoader({ className, dotClass }: { className: string; dotClass: string }) {
  return (
    <div className={className}>
      <span className={dotClass} />
      <Text size={300}>Searching…</Text>
    </div>
  );
}

export function ChatPanel() {
  const styles = useStyles();
  // Subscribe to `nodes` (not the stable `includedFileIds` fn) so the panel
  // re-renders when the explorer toggles inclusion - this is the live seam.
  const nodes = useRagStore((s) => s.nodes);
  const includedFileIds = useMemo(
    () => nodes.filter((n) => n.kind === "file" && n.ragIncluded).map((n) => n.id),
    [nodes],
  );

  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [references, setReferences] = useState<RagReference[]>([]);
  const [streaming, setStreaming] = useState(false);

  async function ask() {
    const q = question.trim();
    if (!q || streaming) return;
    setStreaming(true);
    setAnswer("");
    setReferences([]);
    for await (const chunk of chatService.ask(q, includedFileIds)) {
      if (chunk.delta) setAnswer((a) => a + chunk.delta);
      if (chunk.references) setReferences(chunk.references);
    }
    setStreaming(false);
  }

  const composer = (
    <div className={styles.composer}>
      <Input
        style={{ flex: 1 }}
        value={question}
        placeholder="Ask about your included files…"
        onChange={(_, d) => setQuestion(d.value)}
        onKeyDown={(e) => e.key === "Enter" && void ask()}
      />
      <Button appearance="primary" icon={<SendRegular />} disabled={streaming} onClick={() => void ask()}>
        Ask
      </Button>
    </div>
  );

  // Before the first question, center the prompt in the rail (Google-style).
  if (!answer && !streaming) {
    return (
      <section className={styles.panel}>
        <div className={styles.hero}>
          <span className={styles.beacon} />
          <Title3>Ask Lighthouse</Title3>
          <Text className={styles.heroHint}>
            I&apos;ll answer using only the files you&apos;ve included.
          </Text>
          <Badge appearance="tint">{includedFileIds.length} sources available</Badge>
          <div className={styles.heroComposer}>{composer}</div>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.panel}>
      <div className={styles.header}>
        <Title3>Ask</Title3>
        <Badge appearance="tint">{includedFileIds.length} sources available</Badge>
      </div>

      <div className={styles.body}>
        {streaming && !answer ? (
          <LighthouseLoader className={styles.loader} dotClass={styles.loaderDot} />
        ) : (
          <>
            <Text className={styles.answer}>
              {answer}
              {streaming && <span className={styles.beaconInline} />}
            </Text>
            {references.length > 0 && (
              <div className={styles.refs}>
                <Text weight="semibold" size={200}>
                  Related files
                </Text>
                {references.map((r) => (
                  <Card key={r.fileId} className={styles.refCard} appearance="filled-alternative">
                    <DocumentRegular fontSize={24} />
                    <div className={styles.refMeta}>
                      <Text weight="semibold" truncate>
                        {r.name}
                      </Text>
                      <Text size={200} className={styles.empty}>
                        {r.snippet}
                      </Text>
                    </div>
                    <Badge appearance="outline">{Math.round(r.score * 100)}%</Badge>
                  </Card>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {composer}
    </section>
  );
}
