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
  Spinner,
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
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusXLarge,
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
});

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

  return (
    <section className={styles.panel}>
      <div className={styles.header}>
        <Title3>Ask</Title3>
        <Badge appearance="tint">{includedFileIds.length} sources available</Badge>
      </div>

      <div className={styles.body}>
        {answer ? (
          <>
            <Text className={styles.answer}>
              {answer}
              {streaming && <Spinner size="tiny" style={{ display: "inline-flex" }} />}
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
        ) : (
          <Text className={styles.empty}>
            Ask a question and I&apos;ll answer using only the files you&apos;ve included.
          </Text>
        )}
      </div>

      <div className={styles.composer}>
        <Input
          style={{ flex: 1 }}
          value={question}
          placeholder="Ask about your included files…"
          onChange={(_, d) => setQuestion(d.value)}
          onKeyDown={(e) => e.key === "Enter" && void ask()}
        />
        <Button
          appearance="primary"
          icon={<SendRegular />}
          disabled={streaming}
          onClick={() => void ask()}
        >
          Ask
        </Button>
      </div>
    </section>
  );
}
