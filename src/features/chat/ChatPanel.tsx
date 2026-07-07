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

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  Badge,
  Button,
  Card,
  DrawerBody,
  DrawerHeader,
  DrawerHeaderTitle,
  Input,
  OverlayDrawer,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  SearchBox,
  Switch,
  Text,
  Textarea,
  Title3,
  Tooltip,
  makeStyles,
  mergeClasses,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import {
  AddRegular,
  ArrowClockwiseRegular,
  ArrowDownRegular,
  ArrowUndoRegular,
  AttachRegular,
  CheckmarkRegular,
  CopyRegular,
  DeleteRegular,
  DismissRegular,
  DocumentAddRegular,
  DocumentRegular,
  EditRegular,
  ErrorCircleRegular,
  HistoryRegular,
  OpenRegular,
  SendRegular,
  SettingsRegular,
  SquareRegular,
  ThumbDislikeRegular,
  ThumbLikeRegular,
  WarningRegular,
} from "@fluentui/react-icons";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { DragEvent } from "react";
import type { ChatTurn, RagReference } from "@/contracts";
import { chatService, MODEL_PROVIDERS } from "@/contracts";
import { useRagStore } from "@/stores/useRagStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { logEvent } from "@/lib/logEvent";
import { useChatStore, type TranscriptMessage } from "@/stores/useChatStore";
import { modKey } from "@/features/onboarding/ModeChooser";
import { ACCENTS } from "@/shell/theme";
import { FILE_DRAG_MIME, parseDraggedFiles, type DraggedFile } from "@/shell/dnd";
import { isDesktopShell, pathsForFiles } from "@/shell/desktopBridge";

// A user this close to the bottom (px) counts as "pinned": we keep auto-
// scrolling for them as tokens stream in. Scrolling further up releases the
// pin so the view is never yanked back down mid-read.
const PIN_THRESHOLD = 80;

// Composer auto-grow cap: ~6 lines of fontSizeBase300 (20px line height) plus
// the Textarea's vertical padding. Beyond this the textarea scrolls internally.
const COMPOSER_MAX_HEIGHT = 132;

const useStyles = makeStyles({
  panel: {
    position: "relative",
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
  // Top-right History affordance for the empty (pre-conversation) hero, so past
  // chats are reachable even before the main header exists.
  heroHistory: { position: "absolute", top: tokens.spacingVerticalM, right: tokens.spacingHorizontalM },
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
  addNotice: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    marginBottom: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorStatusWarningBackground1,
    color: tokens.colorStatusWarningForeground1,
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
    // Lift the composer clear of the fixed bug-report FAB parked in the
    // bottom-right corner (40px tall + its bottom margin), so the "Ask" button
    // is never overlapped at any window width.
    paddingBottom: "56px",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalM,
    marginBottom: tokens.spacingVerticalM,
  },
  headerMeta: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS },
  // Positioning context for the floating "Jump to latest" pill, which hovers
  // over the scrolling transcript rather than taking layout space.
  bodyWrap: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    flex: 1,
    minHeight: 0,
  },
  body: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalL,
  },
  // Floating re-pin affordance shown when the user has scrolled up mid-stream.
  // A subtle Button needs its own surface + shadow to stay readable over text.
  jumpPill: {
    position: "absolute",
    bottom: tokens.spacingVerticalM,
    left: "50%",
    transform: "translateX(-50%)",
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow8,
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
  // Gentle pre-flight warning shown in the hero when no files are visible to
  // AI yet — informs without blocking (Ask stays enabled).
  noFilesCard: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: tokens.spacingVerticalS,
    maxWidth: "460px",
    ...shorthands.padding(tokens.spacingVerticalM, tokens.spacingHorizontalL),
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorStatusWarningBackground1,
    color: tokens.colorStatusWarningForeground1,
  },
  // Suggested prompts built from the user's own file names — clicking fills the
  // composer (never auto-sends) so the question stays editable.
  suggestRow: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: tokens.spacingHorizontalS,
  },

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
  // [n] citation markers rendered as clickable superscript chips that jump to
  // the matching reference card below the answer.
  citeChip: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    verticalAlign: "super",
    minWidth: "16px",
    height: "16px",
    ...shorthands.padding("0", tokens.spacingHorizontalXS),
    marginLeft: "1px",
    marginRight: "1px",
    fontSize: tokens.fontSizeBase100,
    lineHeight: "1",
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorBrandForeground2,
    backgroundColor: tokens.colorBrandBackground2,
    ...shorthands.border("0"),
    borderRadius: tokens.borderRadiusCircular,
    cursor: "pointer",
    ":hover": { backgroundColor: tokens.colorBrandBackground2Hover },
  },
  refs: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    marginTop: tokens.spacingVerticalM,
  },
  // Per-answer actions (read aloud, copy) in one quiet row under the answer.
  answerActions: {
    display: "flex",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: tokens.spacingHorizontalXXS,
    marginTop: tokens.spacingVerticalXXS,
  },
  actionBtn: { color: tokens.colorNeutralForeground3 },
  // Inline failure banner for a turn that couldn't get an answer — mirrors the
  // addNotice pattern, in danger colors, with Retry + settings escape hatches.
  errorNotice: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorStatusDangerBackground1,
    color: tokens.colorStatusDangerForeground1,
  },
  // Quiet one-liners: the "(stopped)" note and the zero-references honesty note.
  quietNote: { color: tokens.colorNeutralForeground3 },
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
  // Brief highlight when a citation chip jumps to this card (class is toggled
  // for ~1.2s): a brand-tinted background that fades back out.
  refCardFlash: {
    animationName: {
      from: { backgroundColor: tokens.colorBrandBackground2 },
      to: { backgroundColor: "transparent" },
    },
    animationDuration: "1.2s",
    animationTimingFunction: "ease-out",
  },
  openIcon: { opacity: 0, transition: "opacity 120ms ease", color: tokens.colorNeutralForeground3 },
  refMeta: { display: "flex", flexDirection: "column", flex: 1, minWidth: 0 },
  composer: {
    display: "flex",
    // The textarea grows downward as the draft gets longer; keep the send
    // button anchored to its bottom edge rather than stretching it.
    alignItems: "flex-end",
    gap: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalM,
  },
  // Multiline composer: starts one line tall (matching the Input it replaced)
  // and auto-grows with the draft up to COMPOSER_MAX_HEIGHT. The min/max here
  // override the Textarea's built-in medium-size bounds.
  composerField: {
    flexGrow: 1,
    minHeight: "32px",
    "& textarea": {
      height: "auto",
      maxHeight: `${COMPOSER_MAX_HEIGHT}px`,
    },
  },
  // Faint guidance under the composer: keyboard hint + where answers come from.
  composerMeta: {
    display: "flex",
    flexDirection: "column",
    rowGap: tokens.spacingVerticalXXS,
    marginTop: tokens.spacingVerticalXS,
  },
  metaLine: { color: tokens.colorNeutralForeground3 },
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

  // --- New chat "Undo" bar: a quiet reassurance strip shown briefly after a
  //     New chat archives the prior conversation, with one click back to it. ---
  undoBar: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    marginBottom: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground2,
  },

  // --- Recent-chats drawer ---
  historyDrawer: { width: "min(380px, 90vw)" },
  // Opt-in persistence control at the top of the drawer: a switch plus a hint
  // line that spells out where chats live and when they expire.
  histPersist: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
    ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalM),
    marginBottom: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  histPersistHint: { color: tokens.colorNeutralForeground3 },
  histSearch: { width: "100%", marginBottom: tokens.spacingVerticalM },
  histList: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXXS },
  histEmpty: {
    color: tokens.colorNeutralForeground3,
    textAlign: "center",
    ...shorthands.padding(tokens.spacingVerticalXXL, tokens.spacingHorizontalL),
  },
  histRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalS),
    borderRadius: tokens.borderRadiusMedium,
    ":hover": { backgroundColor: tokens.colorNeutralBackground2Hover },
    ":hover .hist-actions": { opacity: 1 },
  },
  histRowActive: { backgroundColor: tokens.colorBrandBackground2 },
  histRowMain: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    minWidth: 0,
    ...shorthands.padding("2px", "0"),
    cursor: "pointer",
    ...shorthands.border("none"),
    backgroundColor: "transparent",
    textAlign: "left",
    color: "inherit",
  },
  histTitle: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  histTime: { color: tokens.colorNeutralForeground3 },
  histActions: { display: "flex", gap: "0", opacity: 0, transition: "opacity 120ms ease" },
  histEditRow: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalXS, flex: 1 },
  histConfirm: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    flex: 1,
    flexWrap: "wrap",
  },
  histConfirmText: { color: tokens.colorStatusDangerForeground1, flex: 1, minWidth: "100px" },

  // --- Inline question editor (the edit-your-question pencil) ---
  questionRow: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: tokens.spacingVerticalXXS,
    ":hover .q-actions": { opacity: 1 },
    ":focus-within .q-actions": { opacity: 1 },
  },
  questionActions: {
    display: "flex",
    gap: "0",
    opacity: 0,
    transition: "opacity 120ms ease",
  },
  editWrap: { alignSelf: "stretch", display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS },
  editActions: { display: "flex", justifyContent: "flex-end", gap: tokens.spacingHorizontalS },

  // Selected thumb: filled brand color so the chosen rating reads as "set".
  thumbActive: { color: tokens.colorBrandForeground1 },

  // --- Attach picker popover: quick search over the vault's own files ---
  attachSurface: {
    width: "320px",
    maxWidth: "90vw",
    ...shorthands.padding(tokens.spacingVerticalS),
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
  },
  attachList: {
    display: "flex",
    flexDirection: "column",
    maxHeight: "260px",
    overflowY: "auto",
    gap: "1px",
  },
  attachItem: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalS),
    borderRadius: tokens.borderRadiusMedium,
    cursor: "pointer",
    ...shorthands.border("none"),
    backgroundColor: "transparent",
    color: "inherit",
    width: "100%",
    textAlign: "left",
    ":hover": { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
  attachItemName: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 },
  attachEmpty: { color: tokens.colorNeutralForeground3, ...shorthands.padding(tokens.spacingVerticalM, tokens.spacingHorizontalS) },
});

/** DOM id for a turn's nth reference card ([n] chips scroll to these). */
function citeCardId(turnId: string, n: number): string {
  return `cite-${turnId}-${n}`;
}

/**
 * Matches [n] citation markers the model emits per its citation contract (see
 * SYSTEM_PROMPT in src/server/llm.ts). Capped at 3 digits so ordinary
 * bracketed prose isn't misread as a citation.
 */
const CITATION_MARKER = /\[(\d{1,3})\]/g;

/** Minimal mdast node shape — just enough to walk the tree and split text nodes. */
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

/**
 * Remark plugin (a plain tree transform — no added dependency) that splits
 * "[n]" markers out of plain-text nodes into links targeting `#lh-cite-n`, so
 * the `a` component override below renders them as clickable chips. Working on
 * the mdast rather than regexing the source keeps markers inside code blocks /
 * inline code verbatim, and skipping `link` nodes never nests a link in a link.
 */
function remarkCitations() {
  return (tree: unknown) => splitCitationMarkers(tree as MdNode);
}

function splitCitationMarkers(node: MdNode): void {
  if (!node.children) return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string") {
      // Fresh regex per node: the shared constant is /g and stateful.
      const re = new RegExp(CITATION_MARKER.source, "g");
      let last = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(child.value))) {
        if (match.index > last) {
          next.push({ type: "text", value: child.value.slice(last, match.index) });
        }
        next.push({
          type: "link",
          url: `#lh-cite-${match[1]}`,
          children: [{ type: "text", value: match[1] }],
        });
        last = match.index + match[0].length;
      }
      if (last === 0) {
        next.push(child); // no markers — keep the node untouched
      } else if (last < child.value.length) {
        next.push({ type: "text", value: child.value.slice(last) });
      }
    } else {
      if (child.type !== "link") splitCitationMarkers(child);
      next.push(child);
    }
  }
  node.children = next;
}

/** Reduce a thrown ask() failure to a short plain-language reason for the banner. */
function describeAskError(err: unknown): string {
  // fetch() rejects with a TypeError when the network/server is unreachable.
  if (err instanceof TypeError) return "the model service couldn't be reached";
  if (err instanceof Error && err.message) return err.message;
  return "something unexpected went wrong";
}

/** Trim long file names so suggestion chips stay one-line scannable. */
function shortName(name: string): string {
  return name.length > 28 ? `${name.slice(0, 27).trimEnd()}…` : name;
}

/**
 * Strip [n] citation markers for "copy answer": the numbers point at reference
 * cards that don't come along with the copied text, so they're noise on paste.
 * Also tidies the spaces/space-before-punctuation the removal leaves behind.
 */
function stripCitations(content: string): string {
  return content
    .replace(/\s*\[\d{1,3}\]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,;:!?])/g, "$1");
}

/** Compact "how long ago" for the recent-chats list (e.g. "3m", "2h", "Apr 5"). */
function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Renders an assistant answer's Markdown, upgrading [n] citation markers into
 * clickable superscript chips that jump to the matching reference card below.
 * Memoized so finished turns don't re-render on every streamed token.
 */
const AnswerMarkdown = memo(function AnswerMarkdown({
  content,
  turnId,
  onCite,
}: {
  content: string;
  turnId: string;
  onCite: (turnId: string, n: number) => void;
}) {
  const styles = useStyles();
  const components = useMemo<Components>(
    () => ({
      a: ({ node, href, children, ...props }) => {
        // Links minted by remarkCitations carry a #lh-cite-n anchor; render
        // those as citation chips instead of navigable links.
        const cite = href?.match(/^#lh-cite-(\d+)$/);
        if (cite) {
          const n = Number(cite[1]);
          return (
            <button
              type="button"
              className={styles.citeChip}
              aria-label={`Go to reference ${n}`}
              onClick={() => onCite(turnId, n)}
            >
              {n}
            </button>
          );
        }
        return (
          <a {...props} href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        );
      },
    }),
    [styles, turnId, onCite],
  );
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkCitations]} components={components}>
      {content}
    </ReactMarkdown>
  );
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
  const desktop = useRagStore((s) => s.desktop);
  const upload = useRagStore((s) => s.upload);
  const linkPaths = useRagStore((s) => s.linkPaths);
  // Included files with names (for the suggestion chips) and ids (for asks).
  const includedFiles = useMemo(
    () =>
      nodes.filter((n) => n.kind === "file" && n.ragIncluded).map((n) => ({ id: n.id, name: n.name })),
    [nodes],
  );
  const includedFileIds = useMemo(() => includedFiles.map((f) => f.id), [includedFiles]);

  // Who answers, for the provenance line: the local model keeps everything on
  // this device; a hosted provider receives excerpts of files visible to AI.
  // No provider chosen yet means the private local default (see MODEL_PROVIDERS).
  const providerId = useAuthStore((s) => s.onboarding.providerId);
  const providerLabel =
    MODEL_PROVIDERS.find((p) => p.id === providerId)?.label ?? "your AI provider";
  const provenance =
    !providerId || providerId === "local"
      ? "Private — answers are generated entirely on this device."
      : `Excerpts from files visible to AI are sent to ${providerLabel} to answer your questions.`;

  const [question, setQuestion] = useState("");
  // The transcript lives in a session store so it survives leaving/returning to
  // the chat panel and a window reload (see useChatStore).
  const messages = useChatStore((s) => s.messages);
  const setMessages = useChatStore((s) => s.setMessages);
  const persistMessages = useChatStore((s) => s.persist);
  const conversations = useChatStore((s) => s.conversations);
  const currentId = useChatStore((s) => s.currentId);
  const newConversation = useChatStore((s) => s.newConversation);
  const undoNewConversation = useChatStore((s) => s.undoNewConversation);
  const openConversation = useChatStore((s) => s.openConversation);
  const renameConversation = useChatStore((s) => s.renameConversation);
  const deleteConversation = useChatStore((s) => s.deleteConversation);
  const historyPersistEnabled = useChatStore((s) => s.persistEnabled);
  const setHistoryPersist = useChatStore((s) => s.setPersistEnabled);
  const [streaming, setStreaming] = useState(false);

  // Recent-chats drawer + its inline rename/delete affordances.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [histSearch, setHistSearch] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // "Started a new chat — Undo" strip, auto-dismissed after a few seconds.
  const [showUndo, setShowUndo] = useState(false);
  const undoTimer = useRef<number | null>(null);
  // Inline editing of a past question (id of the user message being edited).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  // Attach-picker popover (quick search over the vault's own files) + its query.
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachSearch, setAttachSearch] = useState("");
  // Per-answer 👍/👎, remembered for the session so the choice reads as "set".
  const [ratings, setRatings] = useState<Record<string, "up" | "down">>({});
  // Cancels the in-flight ask() when the user presses Stop.
  const abortRef = useRef<AbortController | null>(null);
  // Files explicitly attached to the conversation (dragged from the explorer or
  // dropped from the OS). When present, questions are scoped to just these.
  const [attachments, setAttachments] = useState<DraggedFile[]>([]);
  // Surfaces OS-drop failures (a file that couldn't be linked or uploaded) as a
  // dismissible banner instead of a silent no-op.
  const [addNotice, setAddNotice] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const dropDepth = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // Seed the id counter past the HIGHEST restored id (not the length): Retry
  // removes a failed pair but mints higher ids, so ids can run ahead of the
  // transcript length — seeding from length would mint duplicates after a
  // reload and stream new tokens into an old turn.
  const idSeq = useRef(
    messages.reduce((max, m) => Math.max(max, Number(m.id.slice(1)) || 0), 0),
  );
  // Re-seed the id counter when the active conversation changes (open / undo /
  // delete), so new turns never collide with ids already in the loaded
  // transcript. Read from the store so we see the just-switched messages.
  useEffect(() => {
    const msgs = useChatStore.getState().messages;
    idSeq.current = msgs.reduce((max, m) => Math.max(max, Number(m.id.slice(1)) || 0), 0);
  }, [currentId]);
  // Fires the activation event only on the first answered question this session.
  const firstQueryLogged = useRef(false);

  // "Pinned" = the user is at (or near) the bottom of the transcript, so it's
  // safe to keep auto-scrolling as tokens stream in. The ref mirrors the state
  // for use inside the scroll effect without retriggering it.
  const [pinned, setPinned] = useState(true);
  const pinnedRef = useRef(true);

  // Copy-answer feedback: which message briefly shows the checkmark.
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyTimer = useRef<number | null>(null);
  // Citation-chip flash: "turnId:n" for the card currently highlighted.
  const [flashCite, setFlashCite] = useState<string | null>(null);
  const flashTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
      if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
    },
    [],
  );

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

  function reportSkipped(skipped: { name: string; reason: string }[]) {
    if (skipped.length === 0) return;
    const shown = skipped.slice(0, 3).map((s) => `${s.name} (${s.reason})`).join(", ");
    setAddNotice(
      `${skipped.length} item${skipped.length > 1 ? "s" : ""} could not be attached: ` +
        shown +
        (skipped.length > 3 ? `, and ${skipped.length - 3} more` : ""),
    );
  }

  // OS files dropped onto chat: LINK them in place when their real paths are
  // available (desktop) - no copy is made - then attach the linked file nodes
  // to the question. Files without a path (plain browser) upload as before.
  async function attachOsFiles(list: FileList) {
    const files = Array.from(list);
    const { paths, unresolved } = pathsForFiles(files);
    const attach: { id: string; name: string }[] = [];
    const skipped: { name: string; reason: string }[] = [];
    if (paths.length) {
      const { linked, failed } = await linkPaths(paths);
      // Only file nodes are attachable; a linked folder still lands in the
      // explorer, where its contents can be included for retrieval. A file
      // already covered by an existing link resolves to its node here too, so
      // re-dropping it attaches rather than silently vanishing.
      attach.push(...linked.filter((l) => l.kind === "file").map((l) => ({ id: l.id, name: l.name })));
      skipped.push(...failed.map((f) => ({ name: f.path.split(/[\\/]/).filter(Boolean).pop() ?? f.path, reason: f.reason })));
    }
    if (unresolved.length) {
      const { addedIds, skipped: uploadSkipped } = await upload(unresolved);
      const byId = new Map(useRagStore.getState().nodes.map((n) => [n.id, n]));
      attach.push(
        ...addedIds
          .map((id) => byId.get(id))
          .filter((n): n is NonNullable<typeof n> => !!n)
          .map((n) => ({ id: n.id, name: n.name })),
      );
      skipped.push(...uploadSkipped);
    }
    if (attach.length) addAttachments(attach);
    reportSkipped(skipped);
  }

  // Inside the Tauri shell, OS file drags arrive via the NATIVE drag-drop
  // events (rebroadcast as lighthouse:os-* CustomEvents) — the DOM "Files"
  // events never fire on Windows and would double-handle drops on macOS, so
  // the DOM path only reacts to OS files on the web. Internal drags from the
  // explorer (FILE_DRAG_MIME) are DOM-native everywhere and stay as they are.
  const isFileDrag = (e: DragEvent) =>
    e.dataTransfer.types.includes(FILE_DRAG_MIME) ||
    (!isDesktopShell() && e.dataTransfer.types.includes("Files"));

  // Link OS-dropped paths in place and attach the resulting file nodes — the
  // native-event twin of attachOsFiles (which handles browser File objects).
  const attachOsPaths = async (paths: string[]) => {
    const { linked, failed } = await linkPaths(paths);
    const attach = linked
      .filter((l) => l.kind === "file")
      .map((l) => ({ id: l.id, name: l.name }));
    if (attach.length) addAttachments(attach);
    reportSkipped(
      failed.map((f) => ({
        name: f.path.split(/[\\/]/).filter(Boolean).pop() ?? f.path,
        reason: f.reason,
      })),
    );
  };
  const attachOsPathsRef = useRef(attachOsPaths);
  attachOsPathsRef.current = attachOsPaths;

  // Native OS drag-drop (desktop shell): highlight while the pointer is over
  // the chat pane, and attach on a drop inside it. Drops elsewhere belong to
  // the explorer, which claims everything outside this pane.
  useEffect(() => {
    if (!isDesktopShell()) return;
    const overChat = (x: number, y: number) =>
      Boolean(document.elementFromPoint(x, y)?.closest('[data-lh-pane="chat"]'));
    const onDrag = (e: Event) => {
      const { x, y } = (e as CustomEvent<{ x: number; y: number }>).detail ?? { x: -1, y: -1 };
      setDropping(overChat(x, y));
    };
    const onLeave = () => setDropping(false);
    const onDrop = (e: Event) => {
      const detail = (e as CustomEvent<{ paths?: string[]; x: number; y: number }>).detail;
      setDropping(false);
      if (!detail?.paths?.length || !overChat(detail.x, detail.y)) return;
      void attachOsPathsRef.current(detail.paths).catch(() => {});
    };
    window.addEventListener("lighthouse:os-drag", onDrag);
    window.addEventListener("lighthouse:os-drag-leave", onLeave);
    window.addEventListener("lighthouse:os-drop", onDrop);
    return () => {
      window.removeEventListener("lighthouse:os-drag", onDrag);
      window.removeEventListener("lighthouse:os-drag-leave", onLeave);
      window.removeEventListener("lighthouse:os-drop", onDrop);
    };
  }, []);

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

  // Keep the newest turn in view as the transcript grows and tokens stream in —
  // but only while the user is pinned near the bottom. Scrolling up to re-read
  // releases the pin (see handleBodyScroll) so the view is never yanked down.
  useEffect(() => {
    const el = bodyRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  function handleBodyScroll() {
    const el = bodyRef.current;
    if (!el) return;
    // A small band above the bottom still counts as pinned, so touchpad wobble
    // or reflow from a streaming token doesn't spuriously release the pin.
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const next = distance < PIN_THRESHOLD;
    pinnedRef.current = next;
    setPinned(next);
  }

  function jumpToLatest() {
    pinnedRef.current = true;
    setPinned(true);
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }

  // Focus the composer on mount so the user can just start typing.
  useEffect(() => {
    composerRef.current?.focus();
  }, []);

  // Auto-grow the composer with the draft (one line up to ~six); beyond the cap
  // the textarea scrolls internally. Measured off scrollHeight, so pasted
  // multi-line text sizes correctly too.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }, [question]);

  // Other features start a fresh conversation by dispatching this window event
  // (e.g. the settings menu) rather than reaching into chat internals. The ref
  // indirection keeps the listener mounted once while calling the latest closure.
  const newChatRef = useRef<() => void>(() => {});
  useEffect(() => {
    const onNewChat = () => newChatRef.current();
    window.addEventListener("lighthouse:new-chat", onNewChat);
    return () => window.removeEventListener("lighthouse:new-chat", onNewChat);
  }, []);

  // The desktop widget's "Ask Lighthouse →" hand-off: Rust `show_main` emits
  // `ask-question` to this window and the transport re-broadcasts it as this
  // DOM event (docs/widget-scope.md, W1 contract). Send it through the same
  // path as pressing Ask — unless an answer is already streaming, in which
  // case only prefill the composer so the in-flight turn isn't clobbered.
  // Latest-closure ref pattern: the listener mounts once while the handler
  // always sees fresh state.
  const askSeedRef = useRef<(q: string) => void>(() => {});
  askSeedRef.current = (q: string) => {
    const seed = q.trim();
    if (!seed) return;
    if (streaming) {
      setQuestion(seed);
      return;
    }
    // Mirror ask(): the composer clears and the question goes out.
    setQuestion("");
    void sendQuestion(seed);
  };
  useEffect(() => {
    const onAskQuestion = (e: Event) => {
      const question = (e as CustomEvent<{ question?: string }>).detail?.question;
      if (typeof question === "string") askSeedRef.current(question);
    };
    window.addEventListener("lighthouse:ask-question", onAskQuestion);
    return () => window.removeEventListener("lighthouse:ask-question", onAskQuestion);
  }, []);

  /** Mark a turn as stopped-by-user, keeping whatever content already streamed. */
  function markStopped(asstId: string) {
    setMessages((m) => m.map((x) => (x.id === asstId ? { ...x, stopped: true } : x)));
  }

  async function sendQuestion(q: string) {
    if (!q || streaming) return;
    // The conversation so far (completed turns only — failed turns are excluded)
    // becomes the model's history. Read from the store, not the render closure,
    // so a retry that just removed its failed turn builds the right history.
    const history: ChatTurn[] = useChatStore
      .getState()
      .messages.filter((m) => !m.error && m.content)
      .map((m) => ({ role: m.role, content: m.content }));
    const attachmentIds = attachments.map((a) => a.id);
    const userMsg: TranscriptMessage = { id: `u${++idSeq.current}`, role: "user", content: q };
    const asstId = `a${++idSeq.current}`;
    const asstMsg: TranscriptMessage = {
      id: asstId,
      role: "assistant",
      content: "",
      references: [],
      // Recorded at ask time: whether any files were visible to AI (included or
      // attached) — drives the zero-reference honesty note on the finished answer.
      hadSources: includedFileIds.length > 0 || attachmentIds.length > 0,
    };
    setMessages((m) => [...m, userMsg, asstMsg]);
    setStreaming(true);
    // Asking always re-pins: the user wants to watch their new answer arrive.
    pinnedRef.current = true;
    setPinned(true);
    const controller = new AbortController();
    abortRef.current = controller;
    let sourceCount = 0;
    let finalContent = "";
    try {
      for await (const chunk of chatService.ask(
        q,
        includedFileIds,
        history,
        attachmentIds,
        controller.signal,
      )) {
        // Stop pressed: some transports (the Tauri fetch interceptor) don't
        // honor AbortSignal, so also bail out of the loop explicitly and keep
        // the partially-streamed answer.
        if (controller.signal.aborted) break;
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
      if (controller.signal.aborted) {
        markStopped(asstId);
      } else {
        // An answer rendered. `source_count` (incl. 0) is the empty-answer signal
        // for the default-inclusion experiment; the first answer of a session is
        // the onboarding activation event.
        logEvent("answer_rendered", { source_count: sourceCount });
        if (!firstQueryLogged.current) {
          firstQueryLogged.current = true;
          logEvent("first_query", { source_count: sourceCount });
        }
      }
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
        // Stop pressed while the request was in flight: keep what streamed.
        markStopped(asstId);
      } else {
        // Network/HTTP failure: mark the turn failed so it renders the inline
        // retry banner. Any partial content stays visible above it.
        setMessages((m) =>
          m.map((x) => (x.id === asstId ? { ...x, error: describeAskError(err) } : x)),
        );
      }
    } finally {
      abortRef.current = null;
      setStreaming(false);
      // Save the settled turn for this session (cheap: once per turn, not per token).
      persistMessages();
      // Hand focus back for the follow-up — but only if the user hasn't moved
      // focus elsewhere (e.g. the explorer's search box) while it streamed.
      const active = document.activeElement;
      if (!active || active === document.body || active.closest('[data-lh-pane="chat"]')) {
        composerRef.current?.focus();
      }
    }
  }

  function ask() {
    const q = question.trim();
    if (!q || streaming) return;
    setQuestion("");
    void sendQuestion(q);
  }

  /** Abort the in-flight answer; the partial text is kept with a "(stopped)" note. */
  function stopStreaming() {
    abortRef.current?.abort();
  }

  /** Re-send a failed turn's question, removing the failed turn first. */
  function retryTurn(asstId: string) {
    if (streaming) return;
    const msgs = useChatStore.getState().messages;
    const idx = msgs.findIndex((m) => m.id === asstId);
    const prev = idx > 0 ? msgs[idx - 1] : undefined;
    if (!prev || prev.role !== "user") return;
    setMessages((m) => m.filter((x) => x.id !== asstId && x.id !== prev.id));
    void sendQuestion(prev.content);
  }

  function newChat() {
    if (streaming) return;
    setQuestion("");
    setAttachments([]);
    setEditingId(null);
    // Nothing to archive when the conversation is already empty — just stay put.
    if (messages.length === 0) return;
    newConversation();
    // The prior conversation is safe in history; offer a few seconds to jump
    // back to it rather than hunting for it in the drawer.
    setShowUndo(true);
    if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => setShowUndo(false), 8000);
  }
  newChatRef.current = newChat;

  function undoNewChat() {
    if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
    setShowUndo(false);
    undoNewConversation();
  }

  /** Open a past conversation from the recent-chats drawer. */
  function openChat(id: string) {
    if (streaming || id === currentId) {
      setHistoryOpen(false);
      return;
    }
    openConversation(id);
    setHistoryOpen(false);
    setShowUndo(false);
    setQuestion("");
    setAttachments([]);
    setEditingId(null);
  }

  /** Begin editing a past question in place (pencil affordance / ArrowUp). */
  function startEdit(userId: string, current: string) {
    if (streaming) return;
    setEditingId(userId);
    setEditText(current);
  }
  function cancelEdit() {
    setEditingId(null);
    setEditText("");
  }
  /** Save an edited question: drop it (and everything after) and re-ask. */
  function saveEdit(userId: string) {
    const next = editText.trim();
    setEditingId(null);
    setEditText("");
    if (!next || streaming) return;
    const msgs = useChatStore.getState().messages;
    const idx = msgs.findIndex((m) => m.id === userId);
    if (idx < 0 || msgs[idx].role !== "user") return;
    setMessages((m) => m.slice(0, idx));
    void sendQuestion(next);
  }
  /** Regenerate an answer: drop the question+answer pair (and after) and re-ask. */
  function regenerate(asstId: string) {
    if (streaming) return;
    const msgs = useChatStore.getState().messages;
    const idx = msgs.findIndex((m) => m.id === asstId);
    const prev = idx > 0 ? msgs[idx - 1] : undefined;
    if (!prev || prev.role !== "user") return;
    setMessages((m) => m.slice(0, idx - 1));
    void sendQuestion(prev.content);
  }

  /** Record a 👍/👎 on an answer (a quality signal); clicking again clears it. */
  function rateAnswer(id: string, rating: "up" | "down") {
    setRatings((r) => {
      const next = { ...r };
      if (next[id] === rating) delete next[id];
      else next[id] = rating;
      return next;
    });
    logEvent("answer_feedback", { rating });
  }

  /** Commit an inline rename from the recent-chats drawer. */
  function commitRename(id: string) {
    const t = renameText.trim();
    if (t) renameConversation(id, t);
    setRenamingId(null);
    setRenameText("");
  }

  /** Copy an answer's Markdown (minus [n] markers); the icon flips to a check. */
  async function copyAnswer(id: string, content: string) {
    const text = stripCitations(content);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API unavailable (older webviews / stricter permissions):
      // fall back to the legacy hidden-textarea path.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* nothing else to try */
      }
      ta.remove();
    }
    setCopiedId(id);
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopiedId(null), 1500);
  }

  // Clicking a [n] chip scrolls that turn's nth reference card into view and
  // flashes it briefly so the eye lands on the right card.
  const handleCitationClick = useCallback((turnId: string, n: number) => {
    const card = document.getElementById(citeCardId(turnId, n));
    if (!card) return; // marker without a matching reference — nothing to jump to
    card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    setFlashCite(`${turnId}:${n}`);
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlashCite(null), 1200);
  }, []);

  // Open a cited file in its native app (desktop only; the route no-ops on web).
  async function openFile(fileId: string) {
    await fetch("/api/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId: fileId }),
    }).catch(() => {});
  }

  function handleComposerKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter inserts a newline. `isComposing` guards IME
    // composition (e.g. Japanese input), where Enter commits the composition
    // rather than the message.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      ask();
      return;
    }
    // ArrowUp on an empty composer edits your last question — the familiar
    // chat convention for "fix what I just asked".
    if (e.key === "ArrowUp" && !question && !streaming && messages.length > 0) {
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i].role === "user") {
          e.preventDefault();
          startEdit(messages[i].id, messages[i].content);
          break;
        }
      }
    }
  }

  /** Fill the composer with a suggested prompt (never auto-send) and focus it. */
  function applySuggestion(fill: string) {
    setQuestion(fill);
    composerRef.current?.focus();
  }

  // Up to 3 starter prompts built from the user's actual included file names.
  const suggestions = useMemo(() => {
    if (includedFiles.length === 0) return [];
    const first = includedFiles[0].name;
    const second = (includedFiles[1] ?? includedFiles[0]).name;
    return [
      { label: `Summarize "${shortName(first)}"`, fill: `Summarize "${first}"` },
      {
        label: `What are the key points in "${shortName(second)}"?`,
        fill: `What are the key points in "${second}"?`,
      },
      // Open-ended starter: fill ends with a space so the user completes it.
      { label: "What do my files say about…", fill: "What do my files say about " },
    ];
  }, [includedFiles]);

  // Recent conversations for the history drawer: real (non-empty) chats, newest
  // first, filtered by the search box (title match).
  const recentChats = useMemo(() => {
    const q = histSearch.trim().toLowerCase();
    return conversations
      .filter((c) => c.messages.length > 0)
      .filter((c) => !q || c.title.toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [conversations, histSearch]);

  // Vault files offered by the attach picker: files not already attached,
  // filtered by the picker's search, capped so the list stays snappy.
  const attachableFiles = useMemo(() => {
    const attached = new Set(attachments.map((a) => a.id));
    const q = attachSearch.trim().toLowerCase();
    return nodes
      .filter((n) => n.kind === "file" && !attached.has(n.id))
      .filter((n) => !q || n.name.toLowerCase().includes(q))
      .slice(0, 50);
  }, [nodes, attachments, attachSearch]);

  const visibleBadgeText = `${includedFileIds.length} ${
    includedFileIds.length === 1 ? "file" : "files"
  } visible to AI`;

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

  const attachButton = (
    <Popover
      open={attachOpen}
      onOpenChange={(_, d) => {
        setAttachOpen(d.open);
        if (!d.open) setAttachSearch("");
      }}
      trapFocus
      positioning="above-start"
    >
      <PopoverTrigger disableButtonEnhancement>
        <Tooltip content="Attach files to this question" relationship="label">
          <Button appearance="subtle" icon={<AttachRegular />} aria-label="Attach files" />
        </Tooltip>
      </PopoverTrigger>
      <PopoverSurface className={styles.attachSurface}>
        <SearchBox
          placeholder="Search your files…"
          value={attachSearch}
          onChange={(_, d) => setAttachSearch(d.value)}
        />
        <div className={styles.attachList}>
          {attachableFiles.length === 0 ? (
            <Text size={200} className={styles.attachEmpty}>
              {nodes.some((n) => n.kind === "file")
                ? "No matching files."
                : "No files in your vault yet."}
            </Text>
          ) : (
            attachableFiles.map((n) => (
              <button
                key={n.id}
                type="button"
                className={styles.attachItem}
                onClick={() => {
                  addAttachments([{ id: n.id, name: n.name }]);
                  setAttachOpen(false);
                  setAttachSearch("");
                }}
              >
                <DocumentRegular fontSize={16} />
                <span className={styles.attachItemName} title={n.name}>
                  {n.name}
                </span>
              </button>
            ))
          )}
        </div>
        <Button
          appearance="subtle"
          size="small"
          icon={<DocumentAddRegular />}
          onClick={() => {
            setAttachOpen(false);
            window.dispatchEvent(new CustomEvent("lighthouse:browse-files"));
          }}
        >
          Add files to vault…
        </Button>
      </PopoverSurface>
    </Popover>
  );

  const composer = (placeholder: string) => (
    <div>
      {showUndo && (
        <div className={styles.undoBar}>
          <ArrowUndoRegular fontSize={16} />
          <Text size={200}>Started a new chat — the previous one is saved in your history.</Text>
          <span style={{ flex: 1 }} />
          <Button size="small" appearance="primary" onClick={undoNewChat}>
            Undo
          </Button>
          <Button
            size="small"
            appearance="subtle"
            icon={<DismissRegular />}
            aria-label="Dismiss"
            onClick={() => {
              if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
              setShowUndo(false);
            }}
          />
        </div>
      )}
      {addNotice && (
        <div className={styles.addNotice}>
          <Text size={200}>{addNotice}</Text>
          <span style={{ flex: 1 }} />
          <Button
            icon={<DismissRegular />}
            size="small"
            appearance="subtle"
            aria-label="Dismiss"
            onClick={() => setAddNotice(null)}
          />
        </div>
      )}
      {attachmentBar}
      <div className={styles.composer}>
        {attachButton}
        <Textarea
          ref={composerRef}
          className={styles.composerField}
          resize="none"
          rows={1}
          value={question}
          placeholder={attachments.length > 0 ? "Ask about the attached files…" : placeholder}
          onChange={(_, d) => setQuestion(d.value)}
          onKeyDown={handleComposerKeyDown}
        />
        {streaming ? (
          <Button appearance="secondary" icon={<SquareRegular />} onClick={stopStreaming}>
            Stop
          </Button>
        ) : (
          <Button appearance="primary" icon={<SendRegular />} onClick={() => ask()}>
            Ask
          </Button>
        )}
      </div>
      <div className={styles.composerMeta}>
        <Text size={200} className={styles.metaLine}>
          Enter to send · Shift+Enter for a new line
          {messages.length > 0 ? " · ↑ to edit your last question" : ""}
        </Text>
        <Text size={200} className={styles.metaLine}>
          {provenance}
        </Text>
      </div>
    </div>
  );

  function References({ turnId, references }: { turnId: string; references: RagReference[] }) {
    return (
      <div className={styles.refs}>
        <Text weight="semibold" size={200}>
          Related files
        </Text>
        {references.map((r, i) => (
          <Card
            key={r.fileId}
            // Anchor for the [n] citation chips in the answer above.
            id={citeCardId(turnId, i + 1)}
            className={mergeClasses(
              styles.refCard,
              desktop && styles.refCardInteractive,
              flashCite === `${turnId}:${i + 1}` && styles.refCardFlash,
            )}
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
            {/* Number matches the [n] markers in the answer text. */}
            <Badge appearance="tint" shape="circular" size="small">
              {i + 1}
            </Badge>
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

  const historyButton = (
    <Button
      appearance="subtle"
      icon={<HistoryRegular />}
      onClick={() => setHistoryOpen(true)}
      title="Recent chats"
    >
      History
    </Button>
  );

  const historyDrawer = (
    <OverlayDrawer
      position="start"
      open={historyOpen}
      onOpenChange={(_, d) => {
        setHistoryOpen(d.open);
        if (!d.open) {
          setRenamingId(null);
          setConfirmDeleteId(null);
          setHistSearch("");
        }
      }}
      className={styles.historyDrawer}
    >
      <DrawerHeader>
        <DrawerHeaderTitle
          action={
            <Button
              appearance="subtle"
              aria-label="Close"
              icon={<DismissRegular />}
              onClick={() => setHistoryOpen(false)}
            />
          }
        >
          Recent chats
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody>
        {/* Saving is opt-in: off by default, kept on this device when on, and
            auto-cleared after two weeks. */}
        <div className={styles.histPersist}>
          <Switch
            checked={historyPersistEnabled}
            onChange={(_, d) => setHistoryPersist(Boolean(d.checked))}
            label="Save chats on this device"
          />
          <Text size={200} className={styles.histPersistHint}>
            {historyPersistEnabled
              ? "Kept on this device and cleared automatically after two weeks. Delete any chat with its trash icon."
              : "Chats aren't being saved — they clear when you close the app. Turn this on to keep them here."}
          </Text>
        </div>
        <Button
          appearance="secondary"
          icon={<AddRegular />}
          disabled={streaming || messages.length === 0}
          onClick={() => {
            newChat();
            setHistoryOpen(false);
          }}
          style={{ width: "100%", marginBottom: tokens.spacingVerticalM }}
        >
          New chat
        </Button>
        <SearchBox
          className={styles.histSearch}
          placeholder="Search chats…"
          value={histSearch}
          onChange={(_, d) => setHistSearch(d.value)}
        />
        {recentChats.length === 0 ? (
          <Text className={styles.histEmpty}>
            {histSearch
              ? "No chats match your search."
              : historyPersistEnabled
                ? "Your saved chats will appear here."
                : "Chats from this session will appear here."}
          </Text>
        ) : (
          <div className={styles.histList}>
            {recentChats.map((c) => {
              const active = c.id === currentId;
              if (renamingId === c.id) {
                return (
                  <div key={c.id} className={styles.histRow}>
                    <div className={styles.histEditRow}>
                      <Input
                        value={renameText}
                        onChange={(_, d) => setRenameText(d.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename(c.id);
                          if (e.key === "Escape") setRenamingId(null);
                        }}
                        autoFocus
                        style={{ flex: 1 }}
                      />
                      <Button
                        size="small"
                        appearance="primary"
                        icon={<CheckmarkRegular />}
                        aria-label="Save name"
                        onClick={() => commitRename(c.id)}
                      />
                      <Button
                        size="small"
                        appearance="subtle"
                        icon={<DismissRegular />}
                        aria-label="Cancel rename"
                        onClick={() => setRenamingId(null)}
                      />
                    </div>
                  </div>
                );
              }
              if (confirmDeleteId === c.id) {
                return (
                  <div key={c.id} className={styles.histRow}>
                    <div className={styles.histConfirm}>
                      <Text size={200} className={styles.histConfirmText}>
                        Delete this chat?
                      </Text>
                      <Button
                        size="small"
                        appearance="primary"
                        onClick={() => {
                          deleteConversation(c.id);
                          setConfirmDeleteId(null);
                        }}
                      >
                        Delete
                      </Button>
                      <Button
                        size="small"
                        appearance="subtle"
                        onClick={() => setConfirmDeleteId(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                );
              }
              return (
                <div
                  key={c.id}
                  className={mergeClasses(styles.histRow, active && styles.histRowActive)}
                >
                  <button
                    type="button"
                    className={styles.histRowMain}
                    onClick={() => openChat(c.id)}
                    disabled={streaming}
                  >
                    <Text
                      size={300}
                      weight={active ? "semibold" : "regular"}
                      className={styles.histTitle}
                    >
                      {c.title}
                    </Text>
                    <Text size={200} className={styles.histTime}>
                      {formatRelativeTime(c.updatedAt)}
                    </Text>
                  </button>
                  <div className={mergeClasses(styles.histActions, "hist-actions")}>
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<EditRegular />}
                      aria-label="Rename chat"
                      onClick={() => {
                        setRenamingId(c.id);
                        setRenameText(c.title);
                        setConfirmDeleteId(null);
                      }}
                    />
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<DeleteRegular />}
                      aria-label="Delete chat"
                      onClick={() => setConfirmDeleteId(c.id)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </DrawerBody>
    </OverlayDrawer>
  );

  // Before the first question, center the prompt in the rail (Google-style).
  if (messages.length === 0 && !streaming) {
    return (
      <section
        data-lh-pane="chat"
        className={mergeClasses(styles.panel, dropping ? styles.panelDropping : undefined)}
        {...dropHandlers}
      >
        {historyDrawer}
        {recentChats.length > 0 && <div className={styles.heroHistory}>{historyButton}</div>}
        <div className={styles.hero}>
          <span className={styles.beacon} />
          <Title3>Ask Lighthouse</Title3>
          <Text className={styles.heroHint}>
            I&apos;ll answer using only the files visible to AI. Drag a file from the
            explorer (or drop one here) to ask about just that file.
          </Text>
          {includedFileIds.length === 0 && attachments.length === 0 ? (
            // Pre-flight: nothing is visible to AI yet. Inform gently and offer
            // the fix, but never block asking.
            <div className={styles.noFilesCard}>
              <WarningRegular fontSize={20} />
              <Text size={300}>
                The AI can&apos;t see any files yet. Answers will be generic until you add
                files and make them visible.
              </Text>
              <Button
                appearance="primary"
                icon={<DocumentAddRegular />}
                onClick={() => window.dispatchEvent(new CustomEvent("lighthouse:browse-files"))}
              >
                Add files
              </Button>
            </div>
          ) : (
            <>
              <Badge appearance="tint">{visibleBadgeText}</Badge>
              <div className={styles.suggestRow}>
                {suggestions.map((s) => (
                  <Button
                    key={s.label}
                    appearance="secondary"
                    size="small"
                    shape="circular"
                    onClick={() => applySuggestion(s.fill)}
                  >
                    {s.label}
                  </Button>
                ))}
              </div>
            </>
          )}
          <div className={styles.heroComposer}>{composer("Ask about the files visible to AI…")}</div>
        </div>
      </section>
    );
  }

  const lastId = messages[messages.length - 1]?.id;

  return (
    <section
      data-lh-pane="chat"
      className={mergeClasses(styles.panel, dropping ? styles.panelDropping : undefined)}
      {...dropHandlers}
    >
      {historyDrawer}
      <div className={styles.conversation}>
        <div className={styles.header}>
          <Title3>Ask</Title3>
          <div className={styles.headerMeta}>
            <Badge appearance="tint">{visibleBadgeText}</Badge>
            {historyButton}
            <Button
              appearance="subtle"
              icon={<AddRegular />}
              disabled={streaming}
              onClick={newChat}
              title={`Start a fresh conversation (${modKey()}+N)`}
            >
              New chat
            </Button>
          </div>
        </div>

        <div className={styles.bodyWrap}>
          <div className={styles.body} ref={bodyRef} onScroll={handleBodyScroll}>
            {messages.map((m) =>
              m.role === "user" ? (
                <div key={m.id} className={styles.turn}>
                  {editingId === m.id ? (
                    <div className={styles.editWrap}>
                      <Textarea
                        value={editText}
                        onChange={(_, d) => setEditText(d.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                            e.preventDefault();
                            saveEdit(m.id);
                          }
                          if (e.key === "Escape") cancelEdit();
                        }}
                        autoFocus
                        resize="vertical"
                      />
                      <div className={styles.editActions}>
                        <Button size="small" appearance="subtle" onClick={cancelEdit}>
                          Cancel
                        </Button>
                        <Button
                          size="small"
                          appearance="primary"
                          icon={<SendRegular />}
                          onClick={() => saveEdit(m.id)}
                        >
                          Update
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className={styles.questionRow}>
                      <div className={styles.question}>{m.content}</div>
                      {!streaming && (
                        <div className={mergeClasses(styles.questionActions, "q-actions")}>
                          <Tooltip content="Edit & resend" relationship="label">
                            <Button
                              size="small"
                              appearance="subtle"
                              className={styles.actionBtn}
                              icon={<EditRegular />}
                              aria-label="Edit question"
                              onClick={() => startEdit(m.id, m.content)}
                            />
                          </Tooltip>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div key={m.id} className={styles.turn}>
                  {streaming && !m.content && m.id === lastId ? (
                    <LighthouseLoader className={styles.loader} dotClass={styles.loaderDot} />
                  ) : (
                    <>
                      {m.content && (
                        <div className={styles.answer}>
                          <AnswerMarkdown
                            content={m.content}
                            turnId={m.id}
                            onCite={handleCitationClick}
                          />
                          {streaming && m.id === lastId && <span className={styles.beaconInline} />}
                        </div>
                      )}
                      {m.stopped && (
                        <Text size={200} className={styles.quietNote}>
                          (stopped)
                        </Text>
                      )}
                      {m.error && (
                        <div className={styles.errorNotice}>
                          <ErrorCircleRegular fontSize={16} />
                          <Text size={200}>Couldn&apos;t get an answer — {m.error}.</Text>
                          <span style={{ flex: 1 }} />
                          <Button
                            size="small"
                            appearance="secondary"
                            disabled={streaming}
                            onClick={() => retryTurn(m.id)}
                          >
                            Retry
                          </Button>
                          <Button
                            size="small"
                            appearance="subtle"
                            icon={<SettingsRegular />}
                            onClick={() =>
                              window.dispatchEvent(new CustomEvent("lighthouse:open-ai-models"))
                            }
                          >
                            AI model settings
                          </Button>
                        </div>
                      )}
                      {/* Failed turns get no actions (Retry is the action) and are never spoken. */}
                      {!m.error && m.content && !(streaming && m.id === lastId) && (
                        <div className={styles.answerActions}>
                          <Tooltip
                            content={copiedId === m.id ? "Copied" : "Copy answer"}
                            relationship="label"
                          >
                            <Button
                              className={styles.actionBtn}
                              appearance="subtle"
                              size="small"
                              icon={copiedId === m.id ? <CheckmarkRegular /> : <CopyRegular />}
                              aria-label="Copy answer"
                              onClick={() => void copyAnswer(m.id, m.content)}
                            />
                          </Tooltip>
                          <Tooltip content="Regenerate answer" relationship="label">
                            <Button
                              className={styles.actionBtn}
                              appearance="subtle"
                              size="small"
                              icon={<ArrowClockwiseRegular />}
                              aria-label="Regenerate answer"
                              disabled={streaming}
                              onClick={() => regenerate(m.id)}
                            />
                          </Tooltip>
                          <Tooltip content="Good answer" relationship="label">
                            <Button
                              className={ratings[m.id] === "up" ? styles.thumbActive : styles.actionBtn}
                              appearance="subtle"
                              size="small"
                              icon={<ThumbLikeRegular />}
                              aria-label="Good answer"
                              aria-pressed={ratings[m.id] === "up"}
                              onClick={() => rateAnswer(m.id, "up")}
                            />
                          </Tooltip>
                          <Tooltip content="Needs work" relationship="label">
                            <Button
                              className={
                                ratings[m.id] === "down" ? styles.thumbActive : styles.actionBtn
                              }
                              appearance="subtle"
                              size="small"
                              icon={<ThumbDislikeRegular />}
                              aria-label="Bad answer"
                              aria-pressed={ratings[m.id] === "down"}
                              onClick={() => rateAnswer(m.id, "down")}
                            />
                          </Tooltip>
                        </div>
                      )}
                      {m.references && m.references.length > 0 && (
                        <References turnId={m.id} references={m.references} />
                      )}
                      {/* Honesty note: files were visible, yet nothing matched. */}
                      {!m.error &&
                        !m.stopped &&
                        m.hadSources &&
                        m.content &&
                        (m.references?.length ?? 0) === 0 &&
                        !(streaming && m.id === lastId) && (
                          <Text size={200} className={styles.quietNote}>
                            No matching passages were found in your files for this answer.
                          </Text>
                        )}
                    </>
                  )}
                </div>
              ),
            )}
          </div>
          {streaming && !pinned && (
            <Button
              className={styles.jumpPill}
              appearance="subtle"
              size="small"
              shape="circular"
              icon={<ArrowDownRegular />}
              onClick={jumpToLatest}
            >
              Jump to latest
            </Button>
          )}
        </div>

        {composer("Ask a follow-up…")}
      </div>
    </section>
  );
}
