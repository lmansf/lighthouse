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
  Switch,
  Text,
  Title3,
  Tooltip,
  makeStyles,
  mergeClasses,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import {
  AddRegular,
  AttachRegular,
  DismissRegular,
  DocumentRegular,
  OpenRegular,
  SendRegular,
  Speaker2Regular,
  SpeakerOffRegular,
} from "@fluentui/react-icons";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { DragEvent } from "react";
import type { ChatMessage, ChatTurn, RagReference } from "@/contracts";
import { chatService } from "@/contracts";
import { useRagStore } from "@/stores/useRagStore";
import { logEvent } from "@/lib/logEvent";
import { isSpeechSupported, speak, stopSpeaking } from "@/lib/speech";

const READ_ALOUD_KEY = "lighthouse.chat.readAloud";
import { useChatStore } from "@/stores/useChatStore";
import { ACCENTS } from "@/shell/theme";
import { FILE_DRAG_MIME, parseDraggedFiles, type DraggedFile } from "@/shell/dnd";

const useStyles = makeStyles({
  panel: {
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    height: "100%",
    ...shorthands.padding(tokens.spacingVerticalL),
    ...shorthands.borderRadius(tokens.borderRadiusLarge),
    ...shorthands.border("2px", "dashed", "transparent"),
    transitionProperty: "border-color, background-color",
    transitionDuration: tokens.durationFaster,
  },
  // Highlight while a file is being dragged over the chat (from the explorer or
  // the OS), mirroring the explorer's drop affordance.
  panelDropping: {
    ...shorthands.borderColor(tokens.colorBrandStroke1),
    backgroundColor: tokens.colorBrandBackground2,
  },
  // --- Attached files: removable pills above the composer that scope the next
  //     question to just those files. ---
  attachBar: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    marginBottom: tokens.spacingVerticalS,
  },
  attachHint: {
    display: "inline-flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXXS,
    color: tokens.colorNeutralForeground3,
  },
  attachChip: {
    display: "inline-flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXXS,
    maxWidth: "220px",
    ...shorthands.padding("2px", tokens.spacingHorizontalS),
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorNeutralForeground1,
    borderRadius: tokens.borderRadiusCircular,
    fontSize: tokens.fontSizeBase200,
  },
  attachName: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  attachRemove: {
    display: "inline-flex",
    alignItems: "center",
    cursor: "pointer",
    color: tokens.colorNeutralForeground3,
    ":hover": { color: tokens.colorNeutralForeground1 },
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
  speakBtn: {
    marginTop: tokens.spacingVerticalXXS,
    alignSelf: "flex-start",
    color: tokens.colorNeutralForeground3,
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
  const upload = useRagStore((s) => s.upload);
  const includedFileIds = useMemo(
    () => nodes.filter((n) => n.kind === "file" && n.ragIncluded).map((n) => n.id),
    [nodes],
  );

  const [question, setQuestion] = useState("");
  // The transcript lives in a session store so it survives leaving/returning to
  // the chat panel and a window reload (see useChatStore).
  const messages = useChatStore((s) => s.messages);
  const setMessages = useChatStore((s) => s.setMessages);
  const persistMessages = useChatStore((s) => s.persist);
  const clearMessages = useChatStore((s) => s.clear);
  const [streaming, setStreaming] = useState(false);
  // Files explicitly attached to the conversation (dragged from the explorer or
  // dropped from the OS). When present, questions are scoped to just these.
  const [attachments, setAttachments] = useState<DraggedFile[]>([]);
  const [dropping, setDropping] = useState(false);
  const dropDepth = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Seed the id counter past any restored messages so new ids never collide.
  const idSeq = useRef(messages.length);
  // Fires the activation event only on the first answered question this session.
  const firstQueryLogged = useRef(false);

  // Read-aloud (on-device TTS): a remembered preference to auto-speak each new
  // answer, plus which message is speaking right now (for the per-message button).
  const speechSupported = isSpeechSupported();
  const [readAloud, setReadAloud] = useState(false);
  const [speakingId, setSpeakingId] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined" && window.localStorage.getItem(READ_ALOUD_KEY) === "1") {
      setReadAloud(true);
    }
  }, []);

  function setReadAloudPref(on: boolean) {
    setReadAloud(on);
    try {
      window.localStorage.setItem(READ_ALOUD_KEY, on ? "1" : "0");
    } catch {
      /* private mode / storage full - the in-session toggle still works */
    }
    if (!on) {
      stopSpeaking();
      setSpeakingId(null);
    }
  }

  /** Speak a message's answer, or stop if it's already the one playing. */
  function toggleSpeak(id: string, content: string) {
    if (speakingId === id) {
      stopSpeaking();
      setSpeakingId(null);
      return;
    }
    setSpeakingId(id);
    speak(content, () => setSpeakingId((cur) => (cur === id ? null : cur)));
  }

  // Stop any speech when the panel unmounts.
  useEffect(() => () => stopSpeaking(), []);

  function addAttachments(files: DraggedFile[]) {
    setAttachments((cur) => {
      const seen = new Set(cur.map((a) => a.id));
      const next = [...cur];
      for (const f of files) {
        if (!seen.has(f.id)) {
          seen.add(f.id);
          next.push({ id: f.id, name: f.name });
        }
      }
      return next;
    });
  }

  function removeAttachment(id: string) {
    setAttachments((cur) => cur.filter((a) => a.id !== id));
  }

  // OS files dropped onto chat: upload into the vault, then attach the new nodes.
  async function attachOsFiles(list: FileList) {
    const { addedIds } = await upload(Array.from(list));
    if (!addedIds.length) return;
    const byId = new Map(useRagStore.getState().nodes.map((n) => [n.id, n]));
    addAttachments(
      addedIds
        .map((id) => byId.get(id))
        .filter((n): n is NonNullable<typeof n> => !!n)
        .map((n) => ({ id: n.id, name: n.name })),
    );
  }

  const isFileDrag = (e: DragEvent) =>
    e.dataTransfer.types.includes(FILE_DRAG_MIME) || e.dataTransfer.types.includes("Files");

  const dropHandlers = {
    onDragEnter: (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      dropDepth.current += 1;
      setDropping(true);
    },
    onDragOver: (e: DragEvent) => {
      if (isFileDrag(e)) e.preventDefault();
    },
    onDragLeave: (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      dropDepth.current = Math.max(0, dropDepth.current - 1);
      if (dropDepth.current === 0) setDropping(false);
    },
    onDrop: (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      dropDepth.current = 0;
      setDropping(false);
      const dragged = parseDraggedFiles(e.dataTransfer);
      if (dragged.length) {
        addAttachments(dragged);
        return;
      }
      if (e.dataTransfer.files?.length) void attachOsFiles(e.dataTransfer.files).catch(() => {});
    },
  };

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
    // A new question interrupts any answer being read aloud.
    stopSpeaking();
    setSpeakingId(null);
    const attachmentIds = attachments.map((a) => a.id);
    let sourceCount = 0;
    let finalContent = "";
    try {
      for await (const chunk of chatService.ask(q, includedFileIds, history, attachmentIds)) {
        if (chunk.delta) {
          finalContent += chunk.delta;
          setMessages((m) =>
            m.map((x) => (x.id === asstId ? { ...x, content: x.content + chunk.delta } : x)),
          );
        }
        if (chunk.references) {
          const refs = chunk.references;
          sourceCount = refs.length;
          setMessages((m) => m.map((x) => (x.id === asstId ? { ...x, references: refs } : x)));
        }
      }
      // An answer rendered. `source_count` (incl. 0) is the empty-answer signal
      // for the default-inclusion experiment; the first answer of a session is
      // the onboarding activation event.
      logEvent("answer_rendered", { source_count: sourceCount });
      if (!firstQueryLogged.current) {
        firstQueryLogged.current = true;
        logEvent("first_query", { source_count: sourceCount });
      }
      // Read the finished answer aloud if the preference is on (on-device TTS).
      if (readAloud && finalContent.trim()) {
        setSpeakingId(asstId);
        speak(finalContent, () => setSpeakingId((cur) => (cur === asstId ? null : cur)));
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
      // Save the settled turn for this session (cheap: once per turn, not per token).
      persistMessages();
    }
  }

  function newChat() {
    if (streaming) return;
    stopSpeaking();
    setSpeakingId(null);
    clearMessages();
    setQuestion("");
    setAttachments([]);
  }

  // Open a cited file in its native app (desktop only; the route no-ops on web).
  async function openFile(fileId: string) {
    await fetch("/api/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId: fileId }),
    }).catch(() => {});
  }

  const attachmentBar =
    attachments.length > 0 ? (
      <div className={styles.attachBar}>
        <Text size={200} className={styles.attachHint}>
          <AttachRegular fontSize={14} />
          Asking about:
        </Text>
        {attachments.map((a) => (
          <span key={a.id} className={styles.attachChip}>
            <DocumentRegular fontSize={14} />
            <span className={styles.attachName} title={a.name}>
              {a.name}
            </span>
            <span
              role="button"
              tabIndex={0}
              aria-label={`Remove ${a.name}`}
              className={styles.attachRemove}
              onClick={() => removeAttachment(a.id)}
              onKeyDown={(e) =>
                (e.key === "Enter" || e.key === " ") && removeAttachment(a.id)
              }
            >
              <DismissRegular fontSize={12} />
            </span>
          </span>
        ))}
      </div>
    ) : null;

  const composer = (placeholder: string) => (
    <div>
      {attachmentBar}
      <div className={styles.composer}>
        <Input
          style={{ flex: 1 }}
          value={question}
          placeholder={attachments.length > 0 ? "Ask about the attached files…" : placeholder}
          onChange={(_, d) => setQuestion(d.value)}
          onKeyDown={(e) => e.key === "Enter" && void ask()}
        />
        <Button appearance="primary" icon={<SendRegular />} disabled={streaming} onClick={() => void ask()}>
          Ask
        </Button>
      </div>
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
      <section
        className={mergeClasses(styles.panel, dropping ? styles.panelDropping : undefined)}
        {...dropHandlers}
      >
        <div className={styles.hero}>
          <span className={styles.beacon} />
          <Title3>Ask Lighthouse</Title3>
          <Text className={styles.heroHint}>
            I&apos;ll answer using only the files you&apos;ve included. Drag a file from the
            explorer (or drop one here) to ask about just that file.
          </Text>
          <Badge appearance="tint">{includedFileIds.length} sources available</Badge>
          <div className={styles.heroComposer}>{composer("Ask about your included files…")}</div>
        </div>
      </section>
    );
  }

  const lastId = messages[messages.length - 1]?.id;

  return (
    <section
      className={mergeClasses(styles.panel, dropping ? styles.panelDropping : undefined)}
      {...dropHandlers}
    >
      <div className={styles.conversation}>
        <div className={styles.header}>
          <Title3>Ask</Title3>
          <div className={styles.headerMeta}>
            <Badge appearance="tint">{includedFileIds.length} sources available</Badge>
            {speechSupported && (
              <Tooltip content="Read new answers aloud (on-device)" relationship="label">
                <Switch
                  checked={readAloud}
                  onChange={(_, d) => setReadAloudPref(Boolean(d.checked))}
                  label="Read aloud"
                />
              </Tooltip>
            )}
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
                    {speechSupported && m.content && !(streaming && m.id === lastId) && (
                      <Tooltip
                        content={speakingId === m.id ? "Stop" : "Read this answer aloud"}
                        relationship="label"
                      >
                        <Button
                          className={styles.speakBtn}
                          appearance="subtle"
                          size="small"
                          icon={speakingId === m.id ? <SpeakerOffRegular /> : <Speaker2Regular />}
                          aria-label={speakingId === m.id ? "Stop reading" : "Read this answer aloud"}
                          onClick={() => toggleSpeak(m.id, m.content)}
                        />
                      </Tooltip>
                    )}
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
