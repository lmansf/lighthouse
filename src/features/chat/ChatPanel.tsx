"use client";

/**
 * [TEAM: chat] Conversational chat.
 *
 * A running dialogue: each question and grounded answer is kept in a transcript
 * so users can ask follow-up questions about the documents that came back. A
 * "New chat" button in the corner starts a fresh conversation. Retrieval is
 * scoped to `useRagStore().includedFileIds()` — never read other features'
 * internals. The Google-style "answer + related files underneath" layout is
 * preserved per assistant turn.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  Badge,
  Button,
  Card,
  Input,
  Text,
  Title3,
  makeStyles,
  mergeClasses,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import {
  AddRegular,
  DocumentRegular,
  OpenRegular,
  SendRegular,
} from "@fluentui/react-icons";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage, ChatTurn, RagReference } from "@/contracts";
import { chatService } from "@/contracts";
import { useRagStore } from "@/stores/useRagStore";
import { ACCENTS } from "@/shell/theme";

const useStyles = makeStyles({
  panel: {
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    height: "100%",
    ...shorthands.padding(tokens.spacingVerticalL),
  },
  // Front-and-center conversation: a readable column centered in the wide main
  // area rather than a full-bleed stretch.
  conversation: {
    width: "100%",
    maxWidth: "820px",
    marginLeft: "auto",
    marginRight: "auto",
    display: "flex",
    flexDirection: "column",
    flex: 1,
    minHeight: 0,
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalM,
    marginBottom: tokens.spacingVerticalM,
  },
  headerMeta: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS },
  body: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalL,
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
  heroComposer: { width: "100%", maxWidth: "640px", marginTop: tokens.spacingVerticalS },
  heroHint: { color: tokens.colorNeutralForeground2, maxWidth: "420px" },

  turn: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS },
  // The user's question — a compact tinted bubble aligned to the right.
  question: {
    alignSelf: "flex-end",
    maxWidth: "80%",
    ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalM),
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorNeutralForeground1,
    borderRadius: tokens.borderRadiusLarge,
    whiteSpace: "pre-wrap",
  },
  answer: {
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    // Tame the Markdown block elements react-markdown emits so answers read as a
    // tight, well-spaced block rather than with browser-default margins.
    "& p": { marginTop: 0, marginBottom: tokens.spacingVerticalS },
    "& p:last-child": { marginBottom: 0 },
    "& ul, & ol": { marginTop: 0, marginBottom: tokens.spacingVerticalS, paddingLeft: tokens.spacingHorizontalXL },
    "& li": { marginBottom: tokens.spacingVerticalXXS },
    "& h1, & h2, & h3, & h4": {
      marginTop: tokens.spacingVerticalM,
      marginBottom: tokens.spacingVerticalXS,
      lineHeight: tokens.lineHeightBase300,
    },
    "& h1": { fontSize: tokens.fontSizeBase500 },
    "& h2, & h3, & h4": { fontSize: tokens.fontSizeBase400 },
    "& a": { color: tokens.colorBrandForegroundLink },
    "& code": {
      fontFamily: tokens.fontFamilyMonospace,
      fontSize: "0.9em",
      backgroundColor: tokens.colorNeutralBackground3,
      ...shorthands.padding("1px", tokens.spacingHorizontalXXS),
      borderRadius: tokens.borderRadiusSmall,
    },
    "& pre": {
      backgroundColor: tokens.colorNeutralBackground3,
      ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalM),
      borderRadius: tokens.borderRadiusMedium,
      overflowX: "auto",
    },
    "& pre code": { backgroundColor: "transparent", padding: 0 },
    "& table": { borderCollapse: "collapse", width: "100%", marginBottom: tokens.spacingVerticalS },
    "& th, & td": {
      ...shorthands.border("1px", "solid", tokens.colorNeutralStroke2),
      ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalS),
      textAlign: "left",
    },
    "& blockquote": {
      marginLeft: 0,
      paddingLeft: tokens.spacingHorizontalM,
      borderLeftWidth: "3px",
      borderLeftStyle: "solid",
      borderLeftColor: tokens.colorNeutralStroke2,
      color: tokens.colorNeutralForeground2,
    },
  },
  refs: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    marginTop: tokens.spacingVerticalM,
  },
  refCard: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalM,
    ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalM),
  },
  refCardInteractive: {
    cursor: "pointer",
    ":hover": { backgroundColor: tokens.colorNeutralBackground2Hover },
    ":hover .open-affordance": { opacity: 1 },
  },
  openIcon: { opacity: 0, transition: "opacity 120ms ease", color: tokens.colorNeutralForeground3 },
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
    ...shorthands.padding(tokens.spacingVerticalS, "0"),
    color: tokens.colorNeutralForeground3,
  },
  // Static glowing beacon for the centered pre-ask prompt — the lighthouse light.
  beacon: {
    width: "14px",
    height: "14px",
    borderRadius: "50%",
    backgroundColor: tokens.colorBrandBackground,
    boxShadow: `0 0 12px 3px ${ACCENTS.beam}`,
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

const markdownComponents: Components = {
  a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
};

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
  const desktop = useRagStore((s) => s.desktop);
  const includedFileIds = useMemo(
    () => nodes.filter((n) => n.kind === "file" && n.ragIncluded).map((n) => n.id),
    [nodes],
  );

  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const idSeq = useRef(0);

  // Keep the newest turn in view as the transcript grows and tokens stream in.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  async function ask() {
    const q = question.trim();
    if (!q || streaming) return;
    // The conversation so far (completed turns only) becomes the model's history.
    const history: ChatTurn[] = messages.map((m) => ({ role: m.role, content: m.content }));
    const userMsg: ChatMessage = { id: `u${++idSeq.current}`, role: "user", content: q };
    const asstId = `a${++idSeq.current}`;
    const asstMsg: ChatMessage = { id: asstId, role: "assistant", content: "", references: [] };
    setMessages((m) => [...m, userMsg, asstMsg]);
    setQuestion("");
    setStreaming(true);
    try {
      for await (const chunk of chatService.ask(q, includedFileIds, history)) {
        if (chunk.delta) {
          setMessages((m) =>
            m.map((x) => (x.id === asstId ? { ...x, content: x.content + chunk.delta } : x)),
          );
        }
        if (chunk.references) {
          const refs = chunk.references;
          setMessages((m) => m.map((x) => (x.id === asstId ? { ...x, references: refs } : x)));
        }
      }
    } catch {
      setMessages((m) =>
        m.map((x) =>
          x.id === asstId && !x.content
            ? { ...x, content: "Something went wrong reaching the model. Please try again." }
            : x,
        ),
      );
    } finally {
      setStreaming(false);
    }
  }

  function newChat() {
    if (streaming) return;
    setMessages([]);
    setQuestion("");
  }

  // Open a cited file in its native app (desktop only; the route no-ops on web).
  async function openFile(fileId: string) {
    await fetch("/api/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId: fileId }),
    }).catch(() => {});
  }

  const composer = (placeholder: string) => (
    <div className={styles.composer}>
      <Input
        style={{ flex: 1 }}
        value={question}
        placeholder={placeholder}
        onChange={(_, d) => setQuestion(d.value)}
        onKeyDown={(e) => e.key === "Enter" && void ask()}
      />
      <Button appearance="primary" icon={<SendRegular />} disabled={streaming} onClick={() => void ask()}>
        Ask
      </Button>
    </div>
  );

  function References({ references }: { references: RagReference[] }) {
    return (
      <div className={styles.refs}>
        <Text weight="semibold" size={200}>
          Related files
        </Text>
        {references.map((r) => (
          <Card
            key={r.fileId}
            className={
              desktop ? mergeClasses(styles.refCard, styles.refCardInteractive) : styles.refCard
            }
            appearance="filled-alternative"
            {...(desktop
              ? {
                  role: "button",
                  tabIndex: 0,
                  title: `Open ${r.name}`,
                  onClick: () => void openFile(r.fileId),
                  onKeyDown: (e: KeyboardEvent) =>
                    (e.key === "Enter" || e.key === " ") && void openFile(r.fileId),
                }
              : {})}
          >
            <DocumentRegular fontSize={24} />
            <div className={styles.refMeta}>
              <Text weight="semibold" truncate>
                {r.name}
              </Text>
              <Text size={200} className={styles.empty}>
                {r.snippet}
              </Text>
            </div>
            {desktop && <OpenRegular className={`${styles.openIcon} open-affordance`} fontSize={18} />}
            <Badge appearance="outline">{Math.round(r.score * 100)}%</Badge>
          </Card>
        ))}
      </div>
    );
  }

  // Before the first question, center the prompt in the rail (Google-style).
  if (messages.length === 0 && !streaming) {
    return (
      <section className={styles.panel}>
        <div className={styles.hero}>
          <span className={styles.beacon} />
          <Title3>Ask Lighthouse</Title3>
          <Text className={styles.heroHint}>
            I&apos;ll answer using only the files you&apos;ve included. Ask follow-up questions to
            dig into what comes back.
          </Text>
          <Badge appearance="tint">{includedFileIds.length} sources available</Badge>
          <div className={styles.heroComposer}>{composer("Ask about your included files…")}</div>
        </div>
      </section>
    );
  }

  const lastId = messages[messages.length - 1]?.id;

  return (
    <section className={styles.panel}>
      <div className={styles.conversation}>
        <div className={styles.header}>
          <Title3>Ask</Title3>
          <div className={styles.headerMeta}>
            <Badge appearance="tint">{includedFileIds.length} sources available</Badge>
            <Button
              appearance="subtle"
              icon={<AddRegular />}
              disabled={streaming}
              onClick={newChat}
              title="Start a fresh conversation"
            >
              New chat
            </Button>
          </div>
        </div>

        <div className={styles.body} ref={bodyRef}>
          {messages.map((m) =>
            m.role === "user" ? (
              <div key={m.id} className={styles.turn}>
                <div className={styles.question}>{m.content}</div>
              </div>
            ) : (
              <div key={m.id} className={styles.turn}>
                {streaming && !m.content && m.id === lastId ? (
                  <LighthouseLoader className={styles.loader} dotClass={styles.loaderDot} />
                ) : (
                  <>
                    <div className={styles.answer}>
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                        {m.content}
                      </ReactMarkdown>
                      {streaming && m.id === lastId && <span className={styles.beaconInline} />}
                    </div>
                    {m.references && m.references.length > 0 && (
                      <References references={m.references} />
                    )}
                  </>
                )}
              </div>
            ),
          )}
        </div>

        {composer("Ask a follow-up…")}
      </div>
    </section>
  );
}
