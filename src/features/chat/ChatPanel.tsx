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
  type ComponentProps,
  type KeyboardEvent,
} from "react";
import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogTitle,
  Divider,
  Link,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  SearchBox,
  Spinner,
  Text,
  Textarea,
  Title3,
  Tooltip,
  makeStyles,
  mergeClasses,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import { IconAdd, IconArrowDown, IconAttach, IconBoard, IconChat, IconCheck, IconChevronDown, IconClose, IconCode, IconCopy, IconDoc, IconDocAdd, IconEdit, IconError, IconFilter, IconHistory, IconLock, IconOpen, IconPin, IconPlay, IconRefresh, IconSave, IconSend, IconSettings, IconShield, IconSparkle, IconStop, IconTable, IconTag, IconThumbDown, IconThumbUp, IconTrash, IconUndo, IconWarning } from "@/shell/icons";
import dynamic from "next/dynamic";
import { type Components } from "react-markdown";
import type { DragEvent, ReactNode } from "react";
import type { AnalyticsMeta, ChangedPin, ChatTurn, Pin, RagReference } from "@/contracts";
import { chatService, MODEL_PROVIDERS, ragService, runRecipeQuestion } from "@/contracts";
import { useRagStore } from "@/stores/useRagStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { parseChartSpec, stripChartRequestFences, stripChartFences, tableToCsv } from "@/lib/chartSpec";
import { parseStatSpec } from "@/lib/statSpec";
import { stripAppearanceRequestFences } from "@/lib/appearanceSpec";
import {
  cloudProviderActive,
  hiddenFromCloudCount,
  LOCAL_ONLY_SKIP_NOTE_RE,
} from "@/lib/privacyState";
import { chartSpecFromTable, hasEngineChartFence } from "@/lib/chartFromTable";
import { answerTable, parseTableJson } from "@/lib/answerTable";
import {
  sortRows,
  truncationCaption,
  truncationNoteFrom,
  type SortDir,
} from "@/lib/sortTable";
import { pinChartData } from "@/lib/pinChart";
import { addPinToCurrentBoard } from "@/features/boards/boardScope";
import { citationQuery, requestFileInspect } from "@/lib/citePreview";
import { composeEvidencePack, provenanceStampText } from "@/lib/evidencePack";
import { recallRelated, type RecallHit } from "@/lib/recall";
import { askSuggestions, ghostCompletion, lastAsk, type AskHistoryItem } from "@/lib/askTypeahead";
import { quickOpenMatches } from "@/lib/quickOpen";
import { activeMention, replaceMention, type MentionSpan } from "@/lib/mentionQuery";
import { emphasize } from "@/features/quickopen/QuickOpen";
import { AnalyticsChart, standaloneChartSvg } from "@/features/chat/AnalyticsChart";
import { StatTile } from "@/features/chat/StatTile";
import { SqlBlock } from "@/features/chat/SqlBlock";
import { formatSql } from "@/lib/sqlFormat";
import { safeMarkdownPrefix, splitMarkdownBlocks } from "@/lib/streamingMarkdown";
import { BriefingsPanel } from "@/features/chat/BriefingsPanel";
import { PinMiniChart } from "@/features/chat/PinMiniChart";
import { SaveViewDialog } from "@/features/views/SaveViewDialog";
import { DefineMetricDialog } from "@/features/semantic/DefineMetricDialog";
import { EgressShield } from "@/features/egress/EgressShield";
import { ProviderSwitch } from "@/features/chat/ProviderSwitch";
import { useChatStore, type TranscriptMessage } from "@/stores/useChatStore";
import { useValidatedChips } from "@/features/chat/useValidatedChips";
import { refineEligibility, type RefineEligibility } from "@/lib/refineChips";
import { useInvestigationsStore } from "@/stores/useInvestigationsStore";
import { chatHistoryLocked } from "@/stores/managedLocks";
import { modKey } from "@/features/onboarding/ModeChooser";
import { LhDialogSurface } from "@/shell/controls";
import { ACCENTS, BEAM_SWEEP } from "@/shell/theme";
import { FILE_DRAG_MIME, parseDraggedFiles, type DraggedFile } from "@/shell/dnd";
import { isDesktopShell, pathsForFiles, platformKind } from "@/shell/desktopBridge";
import { useCoarsePointer, usePaneLayout } from "@/shell/paneLayout";
import { Sheet } from "@/shell/Sheet";
import { HistoryNav } from "./HistoryNav";
import { InvestigateChips } from "./InvestigateChips";
import { InvestigationsNav } from "@/features/investigations/InvestigationsNav";

// The markdown stack (react-markdown + remark-gfm + micromark, ~263 KB) is the
// single largest chunk and is only needed once a finished answer renders — not
// for onboarding, an empty chat, or a streaming turn (which renders as plain
// text, see StreamingAnswer). Load it on demand so it's out of the first-paint
// bundle; `warmMarkdown()` pre-fetches the chunk the moment a question is asked
// so it's ready by the time the answer settles (no flash of unstyled answer).
const MarkdownView = dynamic(() => import("@/shell/MarkdownView"), { ssr: false });
function warmMarkdown() {
  void import("@/shell/MarkdownView");
}

// A user this close to the bottom (px) counts as "pinned" — near enough that
// "Jump to latest" would be a no-op, so the pill stays hidden. The band also
// absorbs touchpad wobble and streaming reflow so the state doesn't flap.
// Pinned gates ONLY the pill: it drives no automatic scrolling (a streaming
// answer anchors its own top instead — see the read-from-the-top hold).
const PIN_THRESHOLD = 80;

// Read-from-the-top hold (openspec: add-investigations §5.1): the scrollTop
// that puts an anchored message row's first line at the top of the scrollport,
// just below the container's own top padding, clamped to the scrollable range.
// `anchorTop` is the row's top in scroll-content coordinates. Pure — the
// [messages] effect feeds it live geometry on every growth of the answer.
export function computeAnchorScrollTop(
  anchorTop: number,
  paddingTop: number,
  maxScrollTop: number,
): number {
  return Math.max(0, Math.min(anchorTop - paddingTop, Math.max(0, maxScrollTop)));
}

// Composer auto-grow cap: ~6 lines of fontSizeBase300 (20px line height) plus
// the Textarea's vertical padding. Beyond this the textarea scrolls internally.
const COMPOSER_MAX_HEIGHT = 132;

// §22.1 ghost autocomplete: how long the draft must sit still before the ghost
// re-ranks. Under a typical inter-keystroke gap it renders once per pause, not
// per key — the "never flickers" half of the feature.
const GHOST_DEBOUNCE_MS = 120;

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
  // 0.13.10 §2: the desktop History popover — the same HistoryNav the compact
  // Sheet hosts, anchored to the header's clock button.
  historySurface: { width: "360px", maxHeight: "70vh", overflowY: "auto" },
  // 0.13.10 §3: the header investigation picker — the title IS the control.
  invPickerBtn: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    backgroundColor: "transparent",
    ...shorthands.border("none"),
    ...shorthands.padding(0),
    cursor: "pointer",
    color: "inherit",
    fontFamily: "inherit",
    minWidth: 0,
    "@media (pointer: coarse)": { minHeight: "44px" },
  },
  invSurface: { width: "380px", maxHeight: "70vh", overflowY: "auto" },
  // Compact context header (openspec: add-investigations §4.2): the Title3 is
  // the investigation's name with its scope size as a quiet baseline caption
  // ("Ask" alone in the global context). The name truncates before it can
  // shove the meta row around.
  headerTitle: {
    display: "flex",
    alignItems: "baseline",
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
  },
  headerTitleName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  headerCaption: { color: tokens.colorNeutralForeground3, whiteSpace: "nowrap" },
  // The hero's investigation line: name · scope + the policy badge, kept
  // together so the context is visible even when the visible-files badge is
  // replaced by the no-files card.
  heroInvRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    color: tokens.colorNeutralForeground3,
  },
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
    // The read-from-the-top hold is the only scroll compensation this
    // container wants: native scroll anchoring would fight it, and its
    // adjustments look like user scrolls and would spuriously cancel the hold.
    overflowAnchor: "none",
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalL,
  },
  // Floating affordance shown mid-stream whenever the viewport is far from the
  // transcript bottom (an anchored answer outgrowing the viewport, or the user
  // scrolled away). A subtle Button needs its own surface + shadow to stay
  // readable over text.
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
  // Each Q&A pair after the first opens on a hairline, so the transcript
  // reads as document sections on the paper canvas rather than one long
  // scroll. Applied to user turns only; the first turn stays clean.
  turnBoundary: {
    ...shorthands.borderTop("1px", "solid", tokens.colorNeutralStroke3),
    paddingTop: tokens.spacingVerticalL,
    ":first-child": {
      borderTopStyle: "none",
      paddingTop: "0",
    },
  },
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
    // Prose keeps a generous document measure (~72ch) so answers read like
    // pages on the paper canvas; data surfaces (tables, code, charts) keep
    // the full column.
    "& p": { marginTop: 0, marginBottom: tokens.spacingVerticalS, maxWidth: "72ch" },
    "& p:last-child": { marginBottom: 0 },
    "& ul, & ol": {
      marginTop: 0,
      marginBottom: tokens.spacingVerticalS,
      paddingLeft: tokens.spacingHorizontalXL,
      maxWidth: "72ch",
    },
    "& li": { marginBottom: tokens.spacingVerticalXXS },
    "& h1, & h2, & h3, & h4": {
      marginTop: tokens.spacingVerticalM,
      marginBottom: tokens.spacingVerticalXS,
      lineHeight: tokens.lineHeightBase300,
      maxWidth: "72ch",
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
      // Result tables are number surfaces: lining digits keep columns scannable.
      fontVariantNumeric: "tabular-nums",
    },
    "& blockquote": {
      marginLeft: 0,
      paddingLeft: tokens.spacingHorizontalM,
      borderLeftWidth: "3px",
      borderLeftStyle: "solid",
      borderLeftColor: tokens.colorNeutralStroke2,
      color: tokens.colorNeutralForeground2,
      maxWidth: "72ch",
    },
    // --- The Beam answer card (flagship): the verified result table, the
    //     quiet engine footers between, and the chart ride ONE elevated card —
    //     10px radius, rest elevation (hairline ring + soft ambient, one
    //     token). Grouped by remarkAnswerCard below; presentation only, the
    //     engine's bytes are never edited.
    "& .lh-answer-card": {
      backgroundColor: tokens.colorNeutralBackground1,
      borderRadius: tokens.borderRadiusLarge,
      boxShadow: tokens.shadow4,
      ...shorthands.padding(tokens.spacingVerticalM, tokens.spacingHorizontalL),
      marginTop: tokens.spacingVerticalM,
      marginBottom: tokens.spacingVerticalM,
    },
    // The card's tiny "Beam" wordmark — UI chrome naming the analytics engine
    // (the engine's own footer text never carries the name and is never
    // edited). Type only, quiet neutral, top-right, in normal flow so it can
    // never overlap the result table; aria-hidden and unselectable so it
    // stays out of copies and screen-reader passes.
    "& .lh-beam-mark": {
      display: "block",
      textAlign: "right",
      color: tokens.colorNeutralForeground4,
      fontSize: tokens.fontSizeBase100,
      lineHeight: "1",
      letterSpacing: "0.08em",
      textTransform: "uppercase",
      userSelect: "none",
      marginBottom: tokens.spacingVerticalXS,
    },
    // The engine's SQL-transparency footer, folded quiet: a collapsed native
    // disclosure whose <summary> is the engine's own label paragraph (text
    // byte-identical), in the small-print register. Keyboard focus gets the
    // theme's amber ring.
    "& .lh-query-used": {
      marginTop: tokens.spacingVerticalXS,
      marginBottom: tokens.spacingVerticalXS,
    },
    "& .lh-query-used summary": {
      cursor: "pointer",
      width: "fit-content",
      color: tokens.colorNeutralForeground3,
      fontSize: tokens.fontSizeBase200,
      lineHeight: tokens.lineHeightBase300,
      userSelect: "none",
    },
    "& .lh-query-used summary:focus-visible": {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "2px",
      borderRadius: tokens.borderRadiusSmall,
    },
    "& .lh-query-used summary::marker": { color: tokens.colorNeutralForeground3 },
    // The label rides an emphasis node; render it upright — a disclosure
    // label, not a caption.
    "& .lh-query-used em": { fontStyle: "normal" },
    "& .lh-query-used pre": {
      marginTop: tokens.spacingVerticalXS,
      marginBottom: tokens.spacingVerticalXS,
    },
    // Engine footers (freshness stamp, truncation/coverage honesty lines) in
    // the quiet small-print register — text untouched, numbers lining.
    "& .lh-card-note": {
      color: tokens.colorNeutralForeground3,
      fontSize: tokens.fontSizeBase200,
      lineHeight: tokens.lineHeightBase300,
      marginTop: tokens.spacingVerticalXXS,
      marginBottom: tokens.spacingVerticalXXS,
      fontVariantNumeric: "tabular-nums",
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
  // Chat tables: horizontal scroll for wide results + a hover "Copy CSV"
  // affordance (analytics result tables are the heavy user, but any markdown
  // table gets it).
  tableWrap: {
    position: "relative",
    overflowX: "auto",
    // fp3 §2 (scroll truth): keep a horizontal swipe on a wide result table
    // INSIDE the table — it must never chain out to navigate the chat page or
    // trigger the browser's back-swipe. Momentum scroll on iOS.
    overscrollBehaviorX: "contain",
    WebkitOverflowScrolling: "touch",
    ":hover .lh-copy-csv": { opacity: 1 },
    ":focus-within .lh-copy-csv": { opacity: 1 },
  },
  copyCsvBtn: {
    position: "absolute",
    top: "2px",
    right: "2px",
    opacity: 0.55,
    transitionProperty: "opacity",
    transitionDuration: tokens.durationFaster,
    // Touch has no hover to reveal this, so show it outright on no-hover
    // pointers. Desktop (hover: hover) keeps the hover-gated reveal.
    "@media (hover: none)": { opacity: 1 },
  },
  // Sortable result tables: the whole header cell is the click target, with a
  // subtle pointer + hover and a keyboard focus ring. Border/padding/alignment
  // stay inherited from the surrounding `.answer` `& th` rule, so the table
  // looks unchanged apart from the caret the active column renders.
  sortHeader: {
    cursor: "pointer",
    userSelect: "none",
    ":hover": { backgroundColor: tokens.colorNeutralBackground2Hover },
    ":focus-visible": {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "-2px",
    },
  },
  sortCaret: {
    marginLeft: tokens.spacingHorizontalXXS,
    fontSize: "0.75em",
    color: tokens.colorNeutralForeground3,
  },
  refs: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    marginTop: tokens.spacingVerticalM,
  },
  // Per-answer actions (copy) in one quiet row under the answer.
  answerActions: {
    display: "flex",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: tokens.spacingHorizontalXXS,
    marginTop: tokens.spacingVerticalXXS,
  },
  actionBtn: { color: tokens.colorNeutralForeground3 },
  // --- Analytics refinement: quick-action chips under answers that carry
  //     analytics metadata, and the Edit SQL dialog they open. ---
  refineRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    marginTop: tokens.spacingVerticalXS,
  },
  // Quiet secondary actions under an answer (refine/Edit SQL/save/evidence
  // pack/pin): subtle buttons carrying only a hairline, so the row reads as
  // small print until engaged. Text/disabled colors stay Fluent's subtle
  // defaults (fg2 / disabled) — only the stroke is added.
  quietChip: {
    ...shorthands.border("1px", "solid", tokens.colorNeutralStroke2),
  },
  sqlDialogSurface: { maxWidth: "720px", width: "92vw" },
  sqlDialogContent: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
  },
  sqlEditor: {
    width: "100%",
    "& textarea": { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200 },
  },
  sqlStatus: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    color: tokens.colorNeutralForeground3,
  },
  // The re-run result inside the dialog: same markdown styling as chat answers,
  // scrolling within the dialog so a wide/tall table never outgrows the screen.
  sqlResult: { maxHeight: "40vh", overflowY: "auto" },
  // Inline confirmation under an answer after Save as CSV — quiet, with a
  // Reveal affordance (answer artifacts land as ordinary vault files).
  savedNote: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalXXS,
    color: tokens.colorNeutralForeground3,
  },
  // Certified / trust badges under an analytics answer (openspec:
  // add-semantic-layer §6.2): a VERIFIED mark, never a decoration — a failed
  // reconcile is a visible caution, never hidden. Tokens only, both themes free.
  trustRow: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalXS,
    marginTop: tokens.spacingVerticalXS,
  },
  trustDetail: { color: tokens.colorNeutralForeground3 },
  // The engine's local-only skip note ("(n files skipped — marked private…)",
  // byte-identical across engines) rendered as a distinct inline callout
  // instead of plain italics (0.12.1 §2): a hairline box + small lock in the
  // savedNote/quietChip family, tokens only so both themes read. The string
  // itself is the engine's — presentation only.
  skipNoteCallout: {
    display: "inline-flex",
    alignItems: "flex-start",
    gap: tokens.spacingHorizontalXS,
    ...shorthands.padding("2px", tokens.spacingHorizontalS),
    ...shorthands.border("1px", "solid", tokens.colorNeutralStroke2),
    borderRadius: tokens.borderRadiusMedium,
    color: tokens.colorNeutralForeground2,
    fontStyle: "normal",
  },
  skipNoteIcon: { flexShrink: 0, marginTop: "3px", color: tokens.colorNeutralForeground3 },
  // --- Pinned questions: the changed-pins alert banner and the dialog. ---
  pinBanner: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    marginBottom: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorNeutralForeground1,
  },
  // One changed pin: its re-ask button with the before→after mini-chart tucked
  // beneath, so the numbers and the drill-down stay visually paired.
  pinAlertItem: {
    display: "inline-flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: tokens.spacingVerticalXXS,
  },
  pinDialogSurface: { maxWidth: "640px", width: "92vw" },
  pinList: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    maxHeight: "48vh",
    overflowY: "auto",
  },
  pinRow: {
    display: "flex",
    alignItems: "flex-start",
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  pinRowMain: { display: "flex", flexDirection: "column", gap: "2px", flexGrow: 1, minWidth: 0 },
  pinStale: { color: tokens.colorPaletteRedForeground1 },
  pinMeta: { color: tokens.colorNeutralForeground3 },
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
  // Engine-emitted provenance stamp under an answer ("Answered on this device /
  // via <vendor>") — a small hairline badge whose dot carries the origin:
  // amber = on-device (the AA-gated mark amber), neutral = a named vendor.
  // The stamp text itself is engine-emitted and byte-unchanged.
  provenanceStamp: {
    display: "inline-flex",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: tokens.spacingHorizontalXS,
    marginTop: tokens.spacingVerticalXS,
    ...shorthands.padding("2px", tokens.spacingHorizontalS),
    ...shorthands.border("1px", "solid", tokens.colorNeutralStroke2),
    borderRadius: tokens.borderRadiusCircular,
    color: tokens.colorNeutralForeground3,
    fontVariantNumeric: "tabular-nums",
  },
  provenanceDot: {
    width: "6px",
    height: "6px",
    borderRadius: "50%",
    flexShrink: 0,
  },
  provenanceDotDevice: { backgroundColor: tokens.colorBrandForeground1 },
  provenanceDotVendor: { backgroundColor: tokens.colorNeutralForeground3 },
  // Answer-cache line under a replayed answer ("From cache · same data as
  // HH:MM · Re-run") — same quiet register as the provenance stamp; rendered
  // only from the final chunk's engine-emitted `meta.cachedAt`.
  cacheLine: {
    display: "block",
    marginTop: tokens.spacingVerticalXXS,
    color: tokens.colorNeutralForeground3,
    fontVariantNumeric: "tabular-nums",
  },
  // G4: the truncation disclosure bound to a sortable result table's <caption>,
  // so it stays with the table through sorting.
  tableCaption: {
    captionSide: "bottom",
    textAlign: "left",
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    fontStyle: "italic",
    paddingTop: tokens.spacingVerticalXXS,
    fontVariantNumeric: "tabular-nums",
  },
  // G2 draft-then-verify: the muted "verifying…" badge shown under the
  // provisional extractive draft while the private model composes the answer.
  draftBadge: {
    color: tokens.colorNeutralForeground3,
    fontStyle: "italic",
    display: "block",
    marginTop: tokens.spacingVerticalXS,
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
    // Keyboard path: reveal the secondary open-in-app button on focus too.
    ":focus-within .open-affordance": { opacity: 1 },
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
    "@media (prefers-reduced-motion: reduce)": { animationName: "none" },
  },
  openIcon: { opacity: 0.55, transition: "opacity 120ms ease", color: tokens.colorNeutralForeground3, "@media (hover: none)": { opacity: 1 } },
  refMeta: { display: "flex", flexDirection: "column", flex: 1, minWidth: 0 },
  // §3: related files as compact GitHub-tag-style chips on a wrapping row.
  // fp3 §2: the row WRAPS (never shrinks its chips) so touch targets stay full
  // size when they overflow; a coarse pointer gets a roomier gap.
  refChipRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    marginTop: tokens.spacingVerticalXS,
    "@media (pointer: coarse)": { gap: tokens.spacingHorizontalS },
  },
  refChip: {
    display: "inline-flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXXS,
    maxWidth: "100%",
    ...shorthands.padding("2px", tokens.spacingHorizontalSNudge),
    ...shorthands.border("1px", "solid", tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusCircular),
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground1,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    cursor: "pointer",
    transition: "background-color 120ms ease",
    ":hover": { backgroundColor: tokens.colorNeutralBackground3Hover },
    ":hover .open-affordance": { opacity: 1 },
    ":focus-within .open-affordance": { opacity: 1 },
    // fp3 §2 tap sizing: a coarse pointer gets a ≥44pt effective hit area —
    // grown by padding + min-height, NOT by font size (the chip stays visually
    // compact). touch-action kills the double-tap zoom while pinch still works.
    "@media (pointer: coarse)": {
      minHeight: "44px",
      ...shorthands.padding(tokens.spacingVerticalSNudge, tokens.spacingHorizontalM),
      touchAction: "manipulation",
    },
  },
  refChipName: { fontWeight: tokens.fontWeightSemibold, whiteSpace: "nowrap" },
  refChipPct: { color: tokens.colorNeutralForeground3, fontVariantNumeric: "tabular-nums" },
  refChipOpen: {
    opacity: 0.55,
    "@media (hover: none)": { opacity: 1 },
    transition: "opacity 120ms ease",
    color: tokens.colorNeutralForeground3,
    display: "inline-flex",
    cursor: "pointer",
    marginInlineStart: "2px",
  },
  // The "Synthesize" affordance and the "+N more" overflow toggle: same chip
  // shape, but accent-tinted (synthesize) / plain (more).
  synthChip: {
    display: "inline-flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXXS,
    ...shorthands.padding("2px", tokens.spacingHorizontalSNudge),
    ...shorthands.border("1px", "solid", tokens.colorBrandStroke1),
    ...shorthands.borderRadius(tokens.borderRadiusCircular),
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground2,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    cursor: "pointer",
    ":hover": { backgroundColor: tokens.colorBrandBackground2Hover },
    // fp3 §2 tap sizing (see refChip).
    "@media (pointer: coarse)": {
      minHeight: "44px",
      ...shorthands.padding(tokens.spacingVerticalSNudge, tokens.spacingHorizontalM),
      touchAction: "manipulation",
    },
  },
  moreChip: {
    ...shorthands.padding("2px", tokens.spacingHorizontalSNudge),
    ...shorthands.border("1px", "dashed", tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusCircular),
    backgroundColor: "transparent",
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
    cursor: "pointer",
    // fp3 §2 tap sizing (see refChip).
    "@media (pointer: coarse)": {
      minHeight: "44px",
      ...shorthands.padding(tokens.spacingVerticalSNudge, tokens.spacingHorizontalM),
      touchAction: "manipulation",
    },
  },
  composer: {
    display: "flex",
    // The textarea grows downward as the draft gets longer; keep the send
    // button anchored to its bottom edge rather than stretching it.
    alignItems: "flex-end",
    gap: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalM,
    // The ask box is the focal point — Spotlight-calm: ONE raised paper
    // surface (generous 12px radius, level-2 elevation, roomy padding) that
    // IS the field; the Textarea inside is stripped bare (composerField) so
    // the shell carries the whole look.
    backgroundColor: tokens.colorNeutralBackground1,
    // §31 §5: the capsule field — a true pill at one line (44pt tall, 22px
    // radius = half), softening rather than ballooning as the draft grows
    // multiline (the Messages idiom; a 999px capsule looks inflated there).
    ...shorthands.borderRadius("22px"),
    boxShadow: tokens.shadow8,
    ...shorthands.padding(
      tokens.spacingVerticalS,
      tokens.spacingHorizontalS,
      tokens.spacingVerticalS,
      tokens.spacingHorizontalM,
    ),
    // Focus is the theme's amber ring, drawn on the shell (the field's own
    // indicator is suppressed below); outline follows the radius.
    ":focus-within": {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "1px",
    },
  },
  // Multiline composer: starts one line tall (matching the Input it replaced)
  // and auto-grows with the draft up to COMPOSER_MAX_HEIGHT. The min/max here
  // override the Textarea's built-in medium-size bounds.
  composerField: {
    flexGrow: 1,
    minHeight: "32px",
    // Bare inside the shell: no own border, fill, or focus underline — the
    // composer shell above carries the box and the amber focus ring.
    backgroundColor: "transparent",
    ...shorthands.borderColor("transparent"),
    "::after": { display: "none" },
    "& textarea": {
      height: "auto",
      maxHeight: `${COMPOSER_MAX_HEIGHT}px`,
      // iOS WKWebView paints its own UA chrome on a bare <textarea> (white
      // fill, hairline border, small radius) — a second box INSIDE the shell
      // (0.13.9 field screenshot). The slot must be stripped explicitly, not
      // just left to whatever the platform default happens to paint.
      WebkitAppearance: "none",
      appearance: "none",
      backgroundColor: "transparent",
      borderTopStyle: "none",
      borderRightStyle: "none",
      borderBottomStyle: "none",
      borderLeftStyle: "none",
      outlineStyle: "none",
    },
  },
  // --- §22.1 ghost autocomplete: the inline greyed continuation. ---
  // The wrap hosts an aria-hidden MIRROR behind the (transparent-background)
  // textarea: it repeats the typed draft invisibly so the grey suffix starts
  // exactly at the caret — wrapping included, because the mirror pins the SAME
  // text metrics + padding Fluent's medium textarea slot uses
  // (typographyStyles.body1; spacingVerticalSNudge / MNudge+XXS). overflow
  // hidden means an internally-scrolled draft merely clips the ghost (never
  // misdraws it), and pointer-events stay with the field.
  ghostWrap: { position: "relative", display: "flex", flexGrow: 1, minWidth: 0 },
  ghostMirror: {
    position: "absolute",
    top: "0",
    right: "0",
    bottom: "0",
    left: "0",
    overflow: "hidden",
    pointerEvents: "none",
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
    fontFamily: tokens.fontFamilyBase,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    fontWeight: tokens.fontWeightRegular,
    ...shorthands.padding(
      tokens.spacingVerticalSNudge,
      `calc(${tokens.spacingHorizontalMNudge} + ${tokens.spacingHorizontalXXS})`,
    ),
  },
  // The typed prefix is repeated INVISIBLY (it only positions the suffix);
  // the suffix reads as a quiet hint in the placeholder grey.
  ghostTyped: { color: "transparent" },
  ghostSuffix: { color: tokens.colorNeutralForeground4 },
  // fp3 §2: the ghost's TOUCH affordance. On a coarse pointer there is no →
  // key to accept the inline completion, so a tappable pill under the composer
  // offers the same accept — the ghost itself is NEVER gated on platform (iPads
  // have hardware keyboards); only this fallback is coarse-pointer-only.
  ghostAcceptTouch: {
    alignSelf: "flex-start",
    display: "inline-flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    maxWidth: "100%",
    minHeight: "44px",
    ...shorthands.padding(tokens.spacingVerticalSNudge, tokens.spacingHorizontalM),
    ...shorthands.border("1px", "dashed", tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusCircular),
    backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
    cursor: "pointer",
    touchAction: "manipulation",
    ":hover": { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
  ghostAcceptText: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: tokens.colorNeutralForeground3,
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

  // "From earlier chats" recall row above the composer (add-conversation-recall):
  // a quiet label + tappable chips that reopen a past conversation. Wraps so a
  // few suggestions never push the composer around.
  recallBar: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalXS,
    marginBottom: tokens.spacingVerticalXS,
  },
  recallLabel: { color: tokens.colorNeutralForeground3 },
  recallChip: { maxWidth: "320px" },

  // --- Loading signal: a small, subtle Lighthouse beacon that gently pulses.
  //     Compact and unobtrusive — it's gone the moment the answer starts. ---
  loader: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    ...shorthands.padding(tokens.spacingVerticalS, "0"),
    color: tokens.colorNeutralForeground3,
  },
  // Static glowing beacon for the centered pre-ask prompt — the lighthouse
  // light, carrying the Beam signature: the ink→amber sweep (a hero moment —
  // the empty state — never behind content). providers.tsx stamps
  // data-theme on <html>; the :global() rule (compiled to
  // `[data-theme="dark"] .beacon`) picks the sweep variant with the theme.
  beacon: {
    width: "14px",
    height: "14px",
    borderRadius: "50%",
    backgroundColor: tokens.colorBrandBackground,
    backgroundImage: BEAM_SWEEP.light,
    boxShadow: `0 0 12px 3px ${ACCENTS.beam}`,
    ':global([data-theme="dark"])': { backgroundImage: BEAM_SWEEP.dark },
  },
  // Small gently-pulsing dot used by the loader; rests steady (fully lit)
  // under prefers-reduced-motion.
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
    "@media (prefers-reduced-motion: reduce)": { animationName: "none" },
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
    "@media (prefers-reduced-motion: reduce)": { animationName: "none" },
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
    opacity: 0.55,
    transition: "opacity 120ms ease",
    "@media (hover: none)": { opacity: 1 },
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

  // --- Ask type-ahead (time-savers): past asks + pinned questions matched
  //     against the draft, in a compact flyout anchored to the composer. It
  //     opens UPWARD (the composer sits at the panel's bottom edge) and is
  //     absolutely positioned so it never shoves the layout around. Rows
  //     follow attachItem; the surface uses the flyout tokens (both themes). ---
  composerWrap: { position: "relative" },
  askSuggestPop: {
    position: "absolute",
    bottom: "calc(100% + 4px)",
    left: "0",
    right: "0",
    zIndex: 10,
    display: "flex",
    flexDirection: "column",
    gap: "1px",
    maxHeight: "240px",
    overflowY: "auto",
    ...shorthands.padding(tokens.spacingVerticalXS),
    ...shorthands.border("1px", "solid", tokens.colorNeutralStroke2),
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow16,
  },
  askSuggestItem: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalS),
    borderRadius: tokens.borderRadiusMedium,
    cursor: "pointer",
    ":hover": { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
  askSuggestItemActive: { backgroundColor: tokens.colorNeutralBackground1Selected },
  askSuggestIcon: { color: tokens.colorNeutralForeground3, flexShrink: 0 },
  askSuggestText: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    flexGrow: 1,
    minWidth: 0,
  },
  // @-mention picker (openspec §2) — reuses the askSuggest popover layout; these
  // add the quick-open-style hit emphasis and the dimmed relative path.
  mentionHit: { color: tokens.colorBrandForeground1, fontWeight: tokens.fontWeightSemibold },
  mentionDir: {
    color: tokens.colorNeutralForeground3,
    flexShrink: 0,
    maxWidth: "45%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
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

/** Minimal mdast node shape — just enough to walk the tree, split text nodes,
 *  and (for remarkAnswerCard) regroup block siblings via the standard
 *  `data.hName`/`hProperties` mdast→hast escape hatch. */
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  lang?: string | null;
  data?: { hName?: string; hProperties?: Record<string, unknown> };
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

/** The engine's SQL-transparency label (singular and plural forms), as the
 *  emphasis-only paragraph that precedes the ```sql fence(s). Matched by
 *  prefix so both forms fold; the label text itself is never touched. */
const QUERY_LABEL_RE = /^Quer(?:y|ies) used/;

/** All text under an mdast node (labels may nest inside emphasis). */
function mdText(node: MdNode): string {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(mdText).join("");
}

/** Paragraph consisting of the engine's SQL-transparency label. The plural
 *  numbered form drags its first "1." numbering artifact into the label's
 *  paragraph (an empty list item cannot interrupt a paragraph), so allow only
 *  digits/dots/whitespace after the emphasis — never real prose. */
function isQueryLabel(node: MdNode): boolean {
  const first = node.children?.[0];
  return (
    node.type === "paragraph" &&
    first?.type === "emphasis" &&
    QUERY_LABEL_RE.test(mdText(first)) &&
    /^[\s\d.]*$/.test((node.children ?? []).slice(1).map(mdText).join(""))
  );
}

/** The engine's assumption-ledger label (openspec: add-recipes §1): the
 *  emphasis-only `*Assumptions:*` paragraph that precedes the bullet list. */
const ASSUMPTIONS_LABEL_RE = /^Assumptions:?\s*$/;

/** Paragraph consisting solely of the engine's assumption-ledger label — the
 *  emphasis node, nothing else of substance. Folded, with the list that follows
 *  it, into its own <details> the same way the SQL footer is. */
function isAssumptionsLabel(node: MdNode): boolean {
  const first = node.children?.[0];
  return (
    node.type === "paragraph" &&
    first?.type === "emphasis" &&
    ASSUMPTIONS_LABEL_RE.test(mdText(first)) &&
    (node.children ?? [])
      .slice(1)
      .map(mdText)
      .join("")
      .trim() === ""
  );
}

function isSqlFence(node: MdNode): boolean {
  return node.type === "code" && node.lang === "sql";
}

function isChartFence(node: MdNode): boolean {
  return node.type === "code" && node.lang === "lighthouse-chart";
}

/** Footer-shaped block between the result table and the chart: the folded SQL
 *  disclosure, the engine's emphasis-led honesty lines (freshness, truncation,
 *  coverage, row cap), or the stray list nodes a numbered multi-query footer
 *  parses into. */
function isFooterish(node: MdNode): boolean {
  return (
    node.type === "lhQueryDetails" ||
    node.type === "lhAssumptions" ||
    node.type === "list" ||
    (node.type === "paragraph" && node.children?.[0]?.type === "emphasis")
  );
}

/**
 * Remark plugin (a plain tree transform, like remarkCitations — no added
 * dependency) that gives an analytics answer its Beam card treatment without
 * editing a byte of the engine's text:
 *
 *  1. The SQL-transparency footer — the engine's emphasis-only label
 *     paragraph followed by its ```sql fence(s) — becomes a collapsed native
 *     <details> disclosure. The label paragraph itself is re-tagged as the
 *     <summary> (via `data.hName`), so the visible label stays byte-identical.
 *  1b. The engine's assumption ledger — its `*Assumptions:*` label paragraph
 *     followed by the bullet list (openspec: add-recipes §1) — is folded the
 *     SAME way into its own <details>, so it reads as a peer disclosure of the
 *     SQL footer rather than flat card-note text.
 *  2. The verified result table, the quiet footers between, and the
 *     ```lighthouse-chart fence are wrapped into ONE `.lh-answer-card` <div> —
 *     the elevated flagship card (styled in `answer` above), crowned by a
 *     tiny injected "Beam" wordmark (UI chrome, not engine text).
 *  3. Emphasis-led footer paragraphs inside that card get `.lh-card-note`
 *     for the quiet small-print register.
 *
 * Prose-only answers (no disclosure, no chart) are left completely alone, so
 * an ordinary markdown table in a document summary renders as before.
 */
function remarkAnswerCard(options?: { chart?: string; table?: string }) {
  return (tree: unknown) => {
    const root = tree as MdNode;
    const children = root.children;
    if (!children) return;

    // §22.6 (chart) / §32 §3 (table): the engine's validated structures now
    // arrive on the final chunk's meta, not as text. Re-materialize them HERE
    // as synthetic nodes so the whole downstream path — card anchoring, the
    // code/table overrides, styling, copy-as-CSV — behaves byte-identically
    // to the in-text era. Placed before the SQL disclosure (the historic
    // position), table before chart (the answer's table position); appended
    // when there is no disclosure.
    const injected: MdNode[] = [];
    if (options?.table) {
      const parsed = parseTableJson(options.table);
      if (parsed) {
        const cell = (value: string): MdNode =>
          ({ type: "tableCell", children: [{ type: "text", value }] }) as MdNode;
        const row = (cells: string[]): MdNode =>
          ({ type: "tableRow", children: cells.map(cell) }) as MdNode;
        injected.push({
          type: "table",
          align: parsed.header.map(() => null),
          children: [row(parsed.header), ...parsed.rows.map(row)],
        } as MdNode);
      }
    }
    if (options?.chart) {
      injected.push({
        type: "code",
        lang: "lighthouse-chart",
        value: options.chart,
      } as MdNode);
    }
    if (injected.length > 0) {
      // This runs BEFORE step 1 folds the disclosure, so anchor on the raw
      // "*Query used:*" label paragraph, not the not-yet-created details node.
      const beforeLabel = children.findIndex((n) => isQueryLabel(n));
      if (beforeLabel >= 0) children.splice(beforeLabel, 0, ...injected);
      else children.push(...injected);
    }

    // 1) Fold the SQL fence(s) behind their engine-written label. The plural
    //    numbered form interleaves list artifacts between fences; they ride
    //    along inside the disclosure. A label with no fence is left alone.
    for (let i = 0; i < children.length; i += 1) {
      if (!isQueryLabel(children[i])) continue;
      let end = i + 1;
      while (
        end < children.length &&
        (isSqlFence(children[end]) || children[end].type === "list")
      ) {
        end += 1;
      }
      if (!children.slice(i + 1, end).some(isSqlFence)) continue;
      const label = children[i];
      // The plural form's leading "1." numbering artifact rides the label's
      // paragraph; split it into the disclosure body so the <summary> is the
      // label alone — same bytes, same reading order.
      const extras = (label.children ?? []).slice(1);
      const extrasPara: MdNode | null =
        extras.length > 0 && extras.map(mdText).join("").trim() !== ""
          ? { type: "paragraph", children: extras }
          : null;
      if (extras.length > 0) label.children = [label.children![0]];
      label.data = { ...label.data, hName: "summary" };
      const details: MdNode = {
        type: "lhQueryDetails",
        data: { hName: "details", hProperties: { className: ["lh-query-used"] } },
        children: [label, ...(extrasPara ? [extrasPara] : []), ...children.slice(i + 1, end)],
      };
      children.splice(i, end - i, details);
      break; // the engine writes one transparency footer per answer
    }

    // 1b) Fold the assumption ledger (openspec: add-recipes §1) — its emphasis
    //     label paragraph followed by the bullet list — into its own native
    //     <details>, mirroring the SQL fold above (same summary/hName wiring and
    //     the same quiet `lh-query-used` disclosure styling; `lh-assumptions` is
    //     a semantic hook carrying no rules). A label with no list after it is
    //     left alone.
    for (let i = 0; i < children.length; i += 1) {
      if (!isAssumptionsLabel(children[i])) continue;
      if (i + 1 >= children.length || children[i + 1].type !== "list") continue;
      const label = children[i];
      label.data = { ...label.data, hName: "summary" };
      const details: MdNode = {
        type: "lhAssumptions",
        data: {
          hName: "details",
          hProperties: { className: ["lh-query-used", "lh-assumptions"] },
        },
        children: [label, children[i + 1]],
      };
      children.splice(i, 2, details);
      break; // the engine writes one assumption ledger per answer
    }

    // 2) Card range: anchored on the chart fence (the engine appends it last)
    //    or, chartless, on the disclosure; extends back across the footer run
    //    to the result table directly above it, and forward to the end of the
    //    footer run. No analytics markers → no card.
    const detailsIdx = children.findIndex((n) => n.type === "lhQueryDetails");
    let chartIdx = -1;
    for (let i = children.length - 1; i >= 0; i -= 1) {
      if (isChartFence(children[i])) {
        chartIdx = i;
        break;
      }
    }
    if (detailsIdx === -1 && chartIdx === -1) return;
    const anchor = chartIdx >= 0 ? chartIdx : detailsIdx;
    let start = anchor;
    while (start > 0 && isFooterish(children[start - 1])) start -= 1;
    if (start > 0 && children[start - 1].type === "table") start -= 1;
    let end = anchor;
    while (
      end + 1 < children.length &&
      (isFooterish(children[end + 1]) || isChartFence(children[end + 1]))
    ) {
      end += 1;
    }

    // 3) Quiet register for the engine's footer lines riding the card.
    for (let i = start; i <= end; i += 1) {
      const n = children[i];
      if (n.type === "paragraph" && n.children?.[0]?.type === "emphasis") {
        n.data = {
          ...n.data,
          hProperties: { ...n.data?.hProperties, className: ["lh-card-note"] },
        };
      }
    }

    // A tiny "Beam" wordmark crowns the card — injected UI chrome (a synthetic
    // node, aria-hidden), NOT engine text: the engine's own footers stay
    // byte-identical and never carry the name.
    const beamMark: MdNode = {
      type: "lhBeamMark",
      data: {
        hName: "span",
        hProperties: { className: ["lh-beam-mark"], ariaHidden: "true" },
      },
      children: [{ type: "text", value: "Beam" }],
    };
    const card: MdNode = {
      type: "lhAnswerCard",
      data: { hName: "div", hProperties: { className: ["lh-answer-card"] } },
      children: [beamMark, ...children.slice(start, end + 1)],
    };
    children.splice(start, end - start + 1, card);
  };
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

// The engine-emitted provenance stamp ("Answered on this device" / "Answered
// via <vendor> — …") is rendered via `provenanceStampText` from
// @/lib/evidencePack — one source of truth shared with the evidence-pack
// export, so the pack's stamp line is byte-identical to the on-screen one.

/**
 * The freshness stamp on a replayed answer's cache line (openspec:
 * add-answer-cache): "HH:MM" for a same-day answer, date + time once it
 * crosses midnight (the disk cache survives restarts) — the honest "same data
 * as" moment must never read as today when it isn't. Rendered ONLY from the
 * final chunk's engine-emitted `meta.cachedAt`, never from prose.
 */
function cachedAtLabel(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return time;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
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

/** The fence language the analytics engine uses for verified chart specs. */
const CHART_LANG = "language-lighthouse-chart";
/** The fence language the engine uses for a single verified number (§2). */
const STAT_LANG = "language-lighthouse-stat";

/** All text under a hast node — cell contents may nest strong/em/code. */
function hastText(node: unknown): string {
  if (typeof node !== "object" || node === null) return "";
  const n = node as { type?: string; value?: string; children?: unknown[] };
  if (n.type === "text") return n.value ?? "";
  return (n.children ?? []).map(hastText).join("");
}

/** Rows (header first) of a hast <table>, for the copy-as-CSV affordance. */
function hastTableRows(table: unknown): string[][] {
  const rows: string[][] = [];
  const walk = (node: unknown) => {
    if (typeof node !== "object" || node === null) return;
    const n = node as { tagName?: string; children?: unknown[] };
    if (n.tagName === "tr") {
      const cells = (n.children ?? [])
        .filter((c) => {
          const t = (c as { tagName?: string }).tagName;
          return t === "td" || t === "th";
        })
        .map((c) => hastText(c).trim());
      if (cells.length) rows.push(cells);
      return;
    }
    (n.children ?? []).forEach(walk);
  };
  walk(table);
  return rows;
}

/** True when every cell of a hast <table> is plain text — no links, citations,
 *  emphasis, or code. Only then is it safe to render the sortable variant, which
 *  reads cells as strings; a table with rich in-cell markdown stays the
 *  passthrough so that content (e.g. a citation link) survives. */
function hastTableIsPlain(table: unknown): boolean {
  let plain = true;
  const walk = (node: unknown) => {
    if (!plain || typeof node !== "object" || node === null) return;
    const n = node as { tagName?: string; children?: unknown[] };
    if (n.tagName === "td" || n.tagName === "th") {
      const hasElement = (n.children ?? []).some(
        (c) => typeof c === "object" && c !== null && "tagName" in (c as object),
      );
      if (hasElement) plain = false;
      return;
    }
    (n.children ?? []).forEach(walk);
  };
  walk(table);
  return plain;
}

/** Hover "Copy CSV" button on chat tables; flips to a checkmark briefly. */
function CopyCsvButton({ rows }: { rows: string[][] }) {
  const styles = useStyles();
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip content="Copy table as CSV" relationship="label">
      <Button
        size="small"
        appearance="secondary"
        className={mergeClasses(styles.copyCsvBtn, "lh-copy-csv")}
        icon={copied ? <IconCheck /> : <IconCopy />}
        aria-label="Copy table as CSV"
        onClick={() => {
          void navigator.clipboard
            .writeText(tableToCsv(rows))
            .then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1600);
            })
            .catch(() => {});
        }}
      />
    </Tooltip>
  );
}

/** Per-table sort state: the active column + direction, or null for the
 *  table's original (unsorted) row order. */
type TableSort = { col: number; dir: SortDir } | null;

/**
 * A chat result table the analyst can sort by clicking a column header. The
 * sort state lives here (per instance, via useState) so every table on screen
 * sorts independently and the hooks are never called conditionally — the
 * `table` markdown override renders one of these per data table.
 *
 * The table is rendered from the extracted `rows` (header + data as plain
 * strings — the same shape Copy-CSV already uses) rather than react-markdown's
 * children, so the displayed order and the exported CSV always agree. Clicking
 * a header cycles ascending -> descending -> original; the active column shows a
 * caret and its <th> carries aria-sort. Border/padding/alignment are inherited
 * from the surrounding `.answer` `& th`/`& td` rules, so it looks identical to a
 * plain markdown table apart from the caret + pointer cursor.
 */
function SortableTable({
  rows,
  passthroughProps,
  truncationNote,
}: {
  rows: string[][];
  passthroughProps: ComponentProps<"table">;
  /** G4: the G1 "first N of M rows" disclosure, bound to the table so it stays
   *  visible through sorting and marks a sort as covering the shown subset. */
  truncationNote?: string;
}) {
  const styles = useStyles();
  const [sort, setSort] = useState<TableSort>(null);
  const header = rows[0];
  // Only the data rows are reordered; the header stays put. `null` sort shows
  // the original order untouched (no sortRows call).
  const view = useMemo(
    () => (sort ? sortRows(rows, sort.col, sort.dir) : rows),
    [rows, sort],
  );

  // Click / Enter / Space on a header cycles that column asc -> desc -> original.
  // Activating a different column starts it ascending.
  const cycle = (col: number) =>
    setSort((cur) => {
      if (!cur || cur.col !== col) return { col, dir: "asc" };
      if (cur.dir === "asc") return { col, dir: "desc" };
      return null;
    });

  return (
    <div className={styles.tableWrap}>
      {/* Exports the CURRENTLY displayed (sorted) order, not the original. */}
      <CopyCsvButton rows={view} />
      <table {...passthroughProps}>
        {truncationNote && sort !== null && (
          <caption className={styles.tableCaption}>
            {truncationCaption(truncationNote, true)}
          </caption>
        )}
        <thead>
          <tr>
            {header.map((cell, col) => {
              const dir = sort && sort.col === col ? sort.dir : null;
              const ariaSort: "ascending" | "descending" | "none" =
                dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none";
              return (
                <th
                  key={col}
                  aria-sort={ariaSort}
                  tabIndex={0}
                  className={styles.sortHeader}
                  onClick={() => cycle(col)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      cycle(col);
                    }
                  }}
                >
                  {cell}
                  {dir && (
                    <span aria-hidden="true" className={styles.sortCaret}>
                      {dir === "asc" ? "▲" : "▼"}
                    </span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {view.slice(1).map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (
                <td key={c}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Canned refinement follow-ups for analytics answers. These ride the normal
 * ask path — the engine sees the conversation's prior "Query used" fence and
 * adapts that SQL — so the client never rewrites SQL itself (design:
 * add-analytics-refinement, decision 4). §22.3: each chip carries its
 * eligibility read against refineEligibility(answer's own table) — a chip
 * that cannot succeed ("Monthly" on an undated result, "Top 10" on 4 rows,
 * "As %" on one) does not render.
 */
const REFINE_CHIPS: {
  label: string;
  ask: string;
  applies: (e: RefineEligibility) => boolean;
}[] = [
  {
    label: "Top 10",
    ask: "Refine the previous result: only the top 10 rows.",
    applies: (e) => e.topN,
  },
  {
    label: "Monthly",
    ask: "Refine the previous result: break it down by month.",
    applies: (e) => e.monthly,
  },
  {
    label: "As %",
    ask: "Refine the previous result: show each row as a percentage of the total.",
    applies: (e) => e.asPercent,
  },
];

/**
 * Quick-action chips under an analytics answer. The canned three refine "the
 * previous result", so they render only on the conversation's last turn where
 * that phrase is unambiguous; Edit SQL re-runs THIS answer's own SQL over its
 * own files (deterministic, model-free), so it stays useful on older turns.
 * "Chart it" (charts by default, 0.12.1) offers a client-built chart of the
 * answer's own table when the ENGINE didn't chart — zero model/network calls.
 */
function RefineChips({
  meta,
  content,
  metaChart,
  metaTable,
  isLast,
  disabled,
  onAsk,
  onEditSql,
  chartShown,
  onToggleChart,
  onSave,
  savePending,
  onEvidencePack,
  packPending,
  onPin,
  pinPending,
  onSaveView,
  onDefineMetric,
}: {
  meta: AnalyticsMeta;
  /** The answer markdown — the "Chart it" heuristic reads its GFM table. */
  content: string;
  /** §22.6: the engine chart from the final chunk's meta — when present the
   *  answer is already charted, so "Chart it" must not double-offer. */
  metaChart?: string;
  /** §32 §3: the engine's structured result table — the accessor prefers it
   *  over parsing the (possibly prose-only) answer markdown. */
  metaTable?: string;
  isLast: boolean;
  disabled: boolean;
  onAsk: (q: string) => void;
  onEditSql: (meta: AnalyticsMeta) => void;
  /** "Chart it" per-turn visibility (savedNotes-style state in the parent). */
  chartShown: boolean;
  onToggleChart: () => void;
  /** Save-as-CSV (desktop engine only — omitted on the web dev twin). */
  onSave?: (meta: AnalyticsMeta) => void;
  savePending?: boolean;
  /** Evidence pack: one self-contained HTML file of this answer (question,
   *  narrative, table, chart, SQL, provenance) — desktop-gated like onSave. */
  onEvidencePack?: (meta: AnalyticsMeta) => void;
  packPending?: boolean;
  /** Pin this answer so vault changes recheck it (desktop rechecks live). */
  onPin?: (meta: AnalyticsMeta) => void;
  pinPending?: boolean;
  /** Save this answer's SQL as a named view (openspec: add-shaped-views) —
   *  same visibility as Edit SQL: any answer whose meta carries the SQL. */
  onSaveView?: (meta: AnalyticsMeta) => void;
  /** Define this answer's aggregation as a named metric (openspec:
   *  add-semantic-layer §6.2) — offered only when the SQL carries an aggregate. */
  onDefineMetric?: (meta: AnalyticsMeta) => void;
}) {
  const styles = useStyles();
  // "Chart it": offered only when (a) the answer carries a table — the §3b
  // accessor prefers the engine's structured meta.table (apple-fm prose
  // answers) and falls back to the GFM parse — (b) the client heuristic
  // builds a spec the REAL parser accepts, and (c) the engine didn't already
  // chart this answer — meta chart (§22.6) or legacy fence. Pure computation
  // over displayed data — no rag/chat service is ever consulted.
  const tableChart = useMemo(() => {
    if (metaChart || hasEngineChartFence(content)) return null;
    const table = answerTable({ content, meta: { table: metaTable } });
    return table ? chartSpecFromTable(table) : null;
  }, [content, metaChart, metaTable]);
  // §22.3: gate each canned chip on the answer's OWN result table — pure
  // computation (refineEligibility over the §3b accessor's table), no
  // service. A prose-only answer with no meta.table resolves null and keeps
  // every chip (unknown shape is not known-bad — see src/lib/refineChips.ts).
  const refine = useMemo(
    () => refineEligibility(answerTable({ content, meta: { table: metaTable } })),
    [content, metaTable],
  );
  // Quiet secondary actions (Beam): subtle + hairline, never a filled chip —
  // the answer stays the loudest thing on the card.
  return (
    <>
    <div className={styles.refineRow}>
      {isLast &&
        REFINE_CHIPS.filter((c) => c.applies(refine)).map((c) => (
          <Button
            key={c.label}
            appearance="subtle"
            size="small"
            shape="circular"
            className={styles.quietChip}
            disabled={disabled}
            onClick={() => onAsk(c.ask)}
          >
            {c.label}
          </Button>
        ))}
      {tableChart && (
        <Button
          appearance="subtle"
          size="small"
          shape="circular"
          className={styles.quietChip}
          onClick={onToggleChart}
        >
          {chartShown ? "Hide chart" : "Chart it"}
        </Button>
      )}
      <Button
        appearance="subtle"
        size="small"
        shape="circular"
        className={styles.quietChip}
        icon={<IconCode />}
        disabled={disabled}
        onClick={() => onEditSql(meta)}
      >
        Edit SQL
      </Button>
      {onSave && (
        <Button
          appearance="subtle"
          size="small"
          shape="circular"
          className={styles.quietChip}
          icon={<IconSave />}
          disabled={disabled || savePending}
          onClick={() => onSave(meta)}
        >
          {savePending ? "Saving…" : "Save as CSV"}
        </Button>
      )}
      {onEvidencePack && (
        <Button
          appearance="subtle"
          size="small"
          shape="circular"
          className={styles.quietChip}
          icon={<IconDoc />}
          disabled={disabled || packPending}
          onClick={() => onEvidencePack(meta)}
        >
          {packPending ? "Saving…" : "Evidence pack"}
        </Button>
      )}
      {onPin && (
        <Button
          appearance="subtle"
          size="small"
          shape="circular"
          className={styles.quietChip}
          icon={<IconPin />}
          disabled={disabled || pinPending}
          onClick={() => onPin(meta)}
        >
          {pinPending ? "Pinning…" : "Pin"}
        </Button>
      )}
      {onSaveView && (
        <Button
          appearance="subtle"
          size="small"
          shape="circular"
          className={styles.quietChip}
          icon={<IconTable />}
          disabled={disabled}
          onClick={() => onSaveView(meta)}
        >
          Save as view
        </Button>
      )}
      {onDefineMetric && sqlHasAggregate(meta.sql) && (
        <Button
          appearance="subtle"
          size="small"
          shape="circular"
          className={styles.quietChip}
          icon={<IconTag />}
          disabled={disabled}
          onClick={() => onDefineMetric(meta)}
        >
          Define as metric
        </Button>
      )}
    </div>
    {/* "Chart it" inline mount: the client-built chart of this answer's own
        table, drawn with the house renderer. Per-turn UI state only — never
        persisted, recomputed from the markdown, zero model/network calls. */}
    {chartShown && tableChart && <AnalyticsChart spec={tableChart} />}
    </>
  );
}

/** A cheap client heuristic: does this answer's SQL carry an aggregate the
 *  "Define as metric" chip could name? Gates the chip so it offers only on
 *  aggregate answers; the engine's `propose_metric` is authoritative. */
function sqlHasAggregate(sql: string): boolean {
  return /\b(sum|count|avg|min|max|median|stddev|var|variance|approx_)\s*\(/i.test(sql);
}

/**
 * Certified badge + trust verdict on an analytics answer (openspec:
 * add-semantic-layer §6.2), rendered from the VERIFIED `AnalyticsMeta.certified`
 * / `.trust` the engine set — never a decoration. A certified metric shows a
 * "Certified" affordance; a failed reconcile (the check CAUGHT a mismatch, or
 * degraded honestly) shows a visible caution with the engine's expected/got,
 * never hidden. PARITY: certification/reconciliation are Rust-only, so the web
 * dev twin never populates these and this renders nothing there.
 */
function TrustBadges({ meta }: { meta: AnalyticsMeta }) {
  const styles = useStyles();
  const trust = meta.trust;
  const certifiedNames =
    meta.certified && meta.certified.length > 0
      ? meta.certified
      : trust?.certified && trust.metric
        ? [trust.metric]
        : [];
  if (certifiedNames.length === 0) return null;
  const reconcileFailed = trust?.certified === true && trust.reconciled === false;
  return (
    <div className={styles.trustRow}>
      <Tooltip
        content="The engine parsed this answer's SQL and confirmed it computes the blessed definition."
        relationship="description"
      >
        <Badge appearance="tint" color="success" icon={<IconShield />}>
          Certified: {certifiedNames.join(", ")}
        </Badge>
      </Tooltip>
      {trust?.reconciled === true && (
        <Text size={200} className={styles.trustDetail}>
          reconciled against its definition
        </Text>
      )}
      {reconcileFailed && (
        <Badge appearance="tint" color="danger" icon={<IconWarning />}>
          Couldn&apos;t reconcile{trust?.metric ? ` ${trust.metric}` : ""}
        </Badge>
      )}
      {reconcileFailed && (trust?.expected || trust?.got) && (
        <Text size={200} className={styles.trustDetail}>
          {trust?.expected ? `expected ${trust.expected}` : ""}
          {trust?.expected && trust?.got ? ", " : ""}
          {trust?.got ? `got ${trust.got}` : ""}
        </Text>
      )}
    </div>
  );
}

/**
 * "Chart it" for answers WITHOUT analytics metadata (charts by default,
 * 0.12.1): ANY answer whose markdown carries a chartable GFM table gets the
 * same client-built chart — the numbers are already on screen, so drawing
 * them adds no new trust surface. Same zero-model contract as RefineChips'
 * chip; per-turn UI state only.
 */
function ChartItRow({
  content,
  metaChart,
  metaTable,
  chartShown,
  onToggleChart,
}: {
  content: string;
  /** §22.6: engine chart on the final chunk's meta — already charted. */
  metaChart?: string;
  /** §32 §3: engine table on the final chunk's meta — the accessor's
   *  preferred source (prose answers carry no markdown table to parse). */
  metaTable?: string;
  chartShown: boolean;
  onToggleChart: () => void;
}) {
  const styles = useStyles();
  const tableChart = useMemo(() => {
    if (metaChart || hasEngineChartFence(content)) return null;
    const table = answerTable({ content, meta: { table: metaTable } });
    return table ? chartSpecFromTable(table) : null;
  }, [content, metaChart, metaTable]);
  if (!tableChart) return null;
  return (
    <>
      <div className={styles.refineRow}>
        <Button
          appearance="subtle"
          size="small"
          shape="circular"
          className={styles.quietChip}
          onClick={onToggleChart}
        >
          {chartShown ? "Hide chart" : "Chart it"}
        </Button>
      </div>
      {chartShown && <AnalyticsChart spec={tableChart} />}
    </>
  );
}

/** True when a hast <pre> wraps exactly a lighthouse-chart / -stat code fence —
 *  either becomes a figure/tile, so the enclosing <pre> is unwrapped. */
function isChartPre(node: unknown): boolean {
  const child = (node as { children?: unknown[] })?.children?.[0] as
    | { tagName?: string; properties?: { className?: unknown } }
    | undefined;
  const cls = child?.properties?.className;
  return (
    child?.tagName === "code" &&
    Array.isArray(cls) &&
    (cls.includes(CHART_LANG) || cls.includes(STAT_LANG))
  );
}

/**
 * Renders an assistant answer's Markdown, upgrading [n] citation markers into
 * clickable superscript chips that jump to the matching reference card below.
 * Analytics extras (Phase C): ```lighthouse-chart fences render as theme-aware
 * SVG charts (the spec is engine-built from the verified query result — a
 * malformed spec falls back to a visible code block, never a broken drawing),
 * and every table gets a hover copy-as-CSV button.
 * Memoized so finished turns don't re-render on every streamed token.
 */
const AnswerMarkdown = memo(function AnswerMarkdown({
  content,
  turnId,
  onCite,
  metaChart,
  metaTable,
  legacyFences = true,
}: {
  content: string;
  turnId: string;
  onCite: (turnId: string, n: number) => void;
  /** §22.6: the engine-validated chart spec from the final chunk's meta —
   *  re-materialized as a synthetic AST node inside remarkAnswerCard. */
  metaChart?: string;
  /** §32 §3: the engine's structured result table from the final chunk's
   *  meta — re-materialized as a synthetic GFM table node at the answer's
   *  table position, so SortableTable/copy-as-CSV treat it exactly like a
   *  markdown table the model would have typed. */
  metaTable?: string;
  /** §22.6: false for NEW-ERA turns (the final chunk carried `meta`), where a
   *  chart fence in TEXT can only be model-injected and is stripped, never
   *  rendered. True (default) only for legacy saved chats with no meta, which
   *  still render their persisted engine fence. */
  legacyFences?: boolean;
}) {
  const styles = useStyles();
  // Belt-and-braces (chart-directive): the engine already withholds
  // lighthouse-chart-request fences from streamed deltas; displayed prose
  // strips any residue too. On legacy turns, plain ```lighthouse-chart fences
  // are NOT stripped — they render as charts below; on new-era turns EVERY
  // chart fence is stripped (the real spec rides `metaChart`).
  const cleaned = useMemo(
    () =>
      stripAppearanceRequestFences(
        legacyFences ? stripChartRequestFences(content) : stripChartFences(content),
      ),
    [content, legacyFences],
  );
  // G4: a truncated analytics result carries the G1 "first N of M rows" footer.
  // The footer ALWAYS stays in the body (a deterministic, never-model-generated
  // disclosure — never stripped, so it shows even when the answer narrates in
  // prose with no result table). When a result table IS rendered and the user
  // sorts it, a caption additionally flags that the sort covers only the shown
  // rows (see SortableTable).
  const truncationNote = useMemo(() => truncationNoteFrom(cleaned), [cleaned]);
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
      // The engine's local-only skip note streams inline as one emphasis node
      // ("_({n} files skipped — marked private …)_", byte-identical in both
      // engines). Render THAT em — detected by its stable prefix over the
      // node's text — as a small hairline callout with a lock, so "files were
      // withheld" is visible at a scan instead of hiding in italics. Every
      // other emphasis stays a plain <em>. Presentation only: the emitted
      // string is untouched (test/privacyLegibility.test.mjs pins both
      // engine templates).
      em: ({ node, children, ...props }) => {
        if (LOCAL_ONLY_SKIP_NOTE_RE.test(hastText(node))) {
          return (
            <span className={styles.skipNoteCallout}>
              <IconLock fontSize={14} className={styles.skipNoteIcon} />
              <span>{children}</span>
            </span>
          );
        }
        return <em {...props}>{children}</em>;
      },
      // Unwrap the <pre> around chart fences so the figure isn't inside
      // preformatted text; all other code blocks keep their default <pre>.
      pre: ({ node, children, ...props }) =>
        isChartPre(node) ? <>{children}</> : <pre {...props}>{children}</pre>,
      code: ({ node, className, children, ...props }) => {
        if (className?.split(" ").includes(CHART_LANG)) {
          const spec = parseChartSpec(String(children ?? ""));
          if (spec) return <AnalyticsChart spec={spec} />;
          // §22.6: never dump raw spec text — one quiet line says why. (Reached
          // only by a legacy saved chat whose persisted fence no longer
          // validates; new-era specs are engine-validated before they ship.)
          return <em className="lh-card-note">Chart couldn&apos;t be drawn — its saved spec didn&apos;t validate.</em>;
        }
        // §2: a single verified number renders as an inline stat tile (the
        // engine emits the fence from a count/single-value result; a malformed
        // spec falls through to a visible code block, never a broken tile).
        if (className?.split(" ").includes(STAT_LANG)) {
          const stat = parseStatSpec(String(children ?? ""));
          if (stat) return <StatTile spec={stat} />;
        }
        // §1: the engine pretty-prints its "Query used" SQL; give that fence a
        // theme-aware highlighter so the disclosure reads like a SQL console.
        if (className?.split(" ").includes("language-sql")) {
          return <SqlBlock code={String(children ?? "")} className={className} />;
        }
        return (
          <code {...props} className={className}>
            {children}
          </code>
        );
      },
      table: ({ node, children, ...props }) => {
        const rows = hastTableRows(node);
        // Sort only PLAIN data tables (the analytics result tables). A
        // header-only/empty table has nothing to sort; a table with rich
        // in-cell markdown (links, citations, emphasis) keeps the passthrough
        // so that content survives — the sortable variant renders cells as
        // strings.
        if (rows.length <= 1 || !hastTableIsPlain(node)) {
          return (
            <div className={styles.tableWrap}>
              <table {...props}>{children}</table>
            </div>
          );
        }
        return (
          <SortableTable rows={rows} passthroughProps={props} truncationNote={truncationNote ?? undefined} />
        );
      },
    }),
    [styles, turnId, onCite, truncationNote],
  );
  return (
    <MarkdownView
      content={cleaned}
      components={components}
      remarkPlugins={[remarkCitations, [remarkAnswerCard, { chart: metaChart, table: metaTable }]]}
    />
  );
});

/** One settled (or the final in-progress) markdown block of a streaming turn.
 *  Memoized on its content so a completed block parses exactly ONCE — only the
 *  last, still-growing block re-parses per frame. */
const StreamBlock = memo(function StreamBlock({
  content,
  turnId,
  onCite,
}: {
  content: string;
  turnId: string;
  onCite: (turnId: string, n: number) => void;
}) {
  // A live turn is always new-era (§22.6): any chart fence in its text is
  // model-injected and must not render; the real spec arrives on settle.
  return <AnswerMarkdown content={content} turnId={turnId} onCite={onCite} legacyFences={false} />;
});

/**
 * The in-flight (streaming) turn, rendered PROGRESSIVELY (patch section 2). Each
 * COMPLETED markdown block renders as markdown the moment it settles; the final,
 * still-growing block is shown only up to a SAFE prefix (safeMarkdownPrefix)
 * that holds back an unterminated code fence, a half-typed table row, or an
 * unclosed bold/code-span/link, so raw markup never flashes and a table never
 * renders torn. Blocks are memoized (StreamBlock), so this does NOT reintroduce
 * the quadratic whole-answer re-parse the old plain-text path avoided: a settled
 * block parses once and only the growing block re-parses per flush. On settle
 * the turn renders through the normal AnswerMarkdown path (transcript branch
 * below), so the final output is byte-identical to before. It keeps the
 * per-flush cadence so the anchored read-from-the-top hold (the messages effect)
 * re-anchors as blocks mount and grow.
 */
const StreamingAnswer = memo(function StreamingAnswer({
  content,
  className,
  turnId,
  onCite,
}: {
  content: string;
  className?: string;
  turnId: string;
  onCite: (turnId: string, n: number) => void;
}) {
  const blocks = useMemo(() => {
    // Same belt-and-braces strip as AnswerMarkdown (a still-open request fence
    // never shows), then split the safe prefix into independently-parsed blocks.
    // §22.6: live turns are new-era — strip EVERY chart fence (a fence here
    // can only be model-injected; the engine's spec rides the final chunk).
    const clean = stripAppearanceRequestFences(stripChartFences(content));
    return splitMarkdownBlocks(safeMarkdownPrefix(clean));
  }, [content]);
  return (
    <div className={className}>
      {blocks.map((b, i) => (
        <StreamBlock key={i} content={b} turnId={turnId} onCite={onCite} />
      ))}
    </div>
  );
});

/** Related-file chips collapse past this count behind a "+N more" toggle. */
const REF_CHIPS_COLLAPSED = 6;

/** Middle-truncate a filename so the base AND the extension stay legible —
 *  "quarterly-revenue-by-region.csv" → "quarterly-r…egion.csv". */
function middleTruncateName(name: string, max = 24): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : "";
  const stem = ext ? name.slice(0, name.length - ext.length) : name;
  const keep = Math.max(6, max - ext.length - 1);
  const head = Math.ceil(keep * 0.55);
  const tail = keep - head;
  return `${stem.slice(0, head)}…${tail > 0 ? stem.slice(stem.length - tail) : ""}${ext}`;
}

/**
 * The "Related files" chips under an answer (§3): compact GitHub-tag-style chips
 * on a wrapping row — "name.ext · 87%", middle-truncated names, full name in the
 * tooltip, same click behaviors as the old cards (preview primary, open-in-app
 * secondary). Overflow past REF_CHIPS_COLLAPSED collapses behind "+N more", and
 * a "Synthesize" chip re-asks the question drawing on all the files together.
 * Hoisted + memoized so the chips only re-render when that turn's references,
 * the desktop capability, or the citation-flash target change.
 */
const References = memo(function References({
  turnId,
  references,
  desktop,
  flashCite,
  onOpen,
  onPreview,
  onSynthesize,
}: {
  turnId: string;
  references: RagReference[];
  desktop: boolean;
  flashCite: string | null;
  /** Secondary action (desktop only): hand the file to its OS app. */
  onOpen: (fileId: string) => void;
  /** Primary action: open the in-app preview ON the cited chunk (time-savers
   *  feature 4) — works on the web twin too, so chips are always interactive. */
  onPreview: (turnId: string, r: RagReference) => void;
  /** §3: re-ask this turn's question scoped to its own source files. */
  onSynthesize?: (turnId: string, refs: RagReference[]) => void;
}) {
  const styles = useStyles();
  const [expanded, setExpanded] = useState(false);
  // A citation jumping to a hidden chip force-expands the row so its anchor
  // exists and is visible.
  const forceExpand = expanded || (flashCite?.startsWith(`${turnId}:`) ?? false);
  const overflow = !forceExpand && references.length > REF_CHIPS_COLLAPSED;
  const shown = overflow ? references.slice(0, REF_CHIPS_COLLAPSED - 1) : references;
  const hidden = references.length - shown.length;
  const fileCount = references.filter((r) => r.kind !== "conversation").length;
  return (
    <div className={styles.refs}>
      <Text weight="semibold" size={200}>
        Related files
      </Text>
      <div className={styles.refChipRow}>
        {shown.map((r, i) => (
          <span
            key={r.fileId}
            // Anchor for the [n] citation chips in the answer above (index is
            // stable — `shown` is always a prefix of `references`).
            id={citeCardId(turnId, i + 1)}
            className={mergeClasses(
              styles.refChip,
              flashCite === `${turnId}:${i + 1}` && styles.refCardFlash,
            )}
            role="button"
            tabIndex={0}
            title={
              r.kind === "conversation"
                ? "Preview the cited passage from this past conversation"
                : r.name
            }
            onClick={() => onPreview(turnId, r)}
            onKeyDown={(e: KeyboardEvent) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onPreview(turnId, r);
              }
            }}
          >
            <Badge appearance="tint" shape="circular" size="tiny">
              {i + 1}
            </Badge>
            {r.kind === "conversation" ? (
              <IconChat fontSize={14} />
            ) : (
              <IconDoc fontSize={14} />
            )}
            <span className={styles.refChipName}>{middleTruncateName(r.name)}</span>
            <span className={styles.refChipPct}>· {Math.round(r.score * 100)}%</span>
            {desktop && (
              <span
                role="button"
                tabIndex={-1}
                className={`${styles.refChipOpen} open-affordance`}
                aria-label={
                  r.kind === "conversation"
                    ? "Open the conversation note in its app"
                    : `Open ${r.name} in its app`
                }
                title="Open in app"
                onClick={(e) => {
                  e.stopPropagation();
                  void onOpen(r.fileId);
                }}
              >
                <IconOpen fontSize={14} />
              </span>
            )}
          </span>
        ))}
        {overflow && (
          <button type="button" className={styles.moreChip} onClick={() => setExpanded(true)}>
            +{hidden} more
          </button>
        )}
        {onSynthesize && fileCount >= 2 && (
          <button
            type="button"
            className={styles.synthChip}
            title="Re-ask this question drawing on all of these files together"
            onClick={() => onSynthesize(turnId, references)}
          >
            <IconSparkle fontSize={14} /> Synthesize
          </button>
        )}
      </div>
    </div>
  );
});

/** Result-first paint (faster & calmer): render heavier, non-critical chrome
 *  (citation references and the like) ONE frame after mount, so the answer text
 *  above it is visible and interactive first. The answer already streams in
 *  live; this just keeps the settle moment from mounting a big sub-tree in the
 *  same commit. A settled turn loaded from history defers by a single frame on
 *  first open — imperceptible — and never unmounts thereafter. */
function DeferredMount({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  return ready ? <>{children}</> : null;
}

/** Subtle Lighthouse beacon loader, shown briefly while we wait for the first
 *  token. Multi-document synthesis narrates its stages through `label`
 *  ("Reading q3-summary.csv (2/5)…") instead of the generic "Searching…". */
function LighthouseLoader({
  className,
  dotClass,
  label,
}: {
  className: string;
  dotClass: string;
  label?: string | null;
}) {
  return (
    <div className={className}>
      <span className={dotClass} />
      <Text size={300}>{label || "Searching…"}</Text>
    </div>
  );
}

export function ChatPanel() {
  const styles = useStyles();
  // fp3 §2: the touch (coarse-pointer) axis — drives tap behaviors that CSS
  // media queries can't reach (mount-autofocus suppression, instant citation
  // jump, tappable ghost). Distinct from compact/width and from platformKind.
  const coarsePointer = useCoarsePointer();
  // 0.13.10 §2: the History surface opens from the chat header on EVERY
  // platform — a full-screen Sheet on compact, an anchored popover on desktop.
  const compactLayout = usePaneLayout(false).compact;
  const [historyOpen, setHistoryOpen] = useState(false);
  // 0.13.10 §3: the investigation PICKER — the header title opens the full
  // InvestigationsNav operations surface (switch, create, scope-from-selection,
  // local-only policy, rename/branch/archive) with the Sections rail retired.
  const [invOpen, setInvOpen] = useState(false);
  // §4: the Files action row's "Add to investigation scope" opens the picker
  // (its scope-from-selection reads the live grid selection).
  useEffect(() => {
    const onOpen = () => setInvOpen(true);
    window.addEventListener("lighthouse:open-investigations", onOpen);
    return () => window.removeEventListener("lighthouse:open-investigations", onOpen);
  }, []);
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
  // No provider chosen yet answers on this device either way — the private
  // local default on desktop, the deterministic/extractive path on mobile
  // (§3: mobile profiles default to NO provider) — matching originOf's
  // "device" stamp for both.
  const providerId = useAuthStore((s) => s.onboarding.providerId);
  const providerLabel =
    MODEL_PROVIDERS.find((p) => p.id === providerId)?.label ?? "your AI provider";
  // Local-only legibility (0.12.1 §2): while a CLOUD provider answers, the
  // header counts the files actually being withheld right now — marked
  // "Private — this device only" AND otherwise visible to AI. Same single
  // rule as the engine's is_cloud_provider (src/lib/privacyState.ts); the
  // count hides entirely on the private model (nothing is withheld) and at
  // zero. Clicking filters the explorer to exactly that set.
  const cloudActive = cloudProviderActive(providerId);
  const hiddenFromCloud = useMemo(() => hiddenFromCloudCount(nodes), [nodes]);

  // --- Investigation context (openspec: add-investigations §4.2). The chat
  //     store owns WHICH investigation is current; the investigations store
  //     caches the engine records (name, scope, policy) behind it. ---
  const currentInvestigationId = useChatStore((s) => s.currentInvestigationId);
  const investigations = useInvestigationsStore((s) => s.investigations);
  const ensureInvestigationsLoaded = useInvestigationsStore((s) => s.ensureLoaded);
  useEffect(() => {
    ensureInvestigationsLoaded();
  }, [ensureInvestigationsLoaded]);
  const currentInvestigation = useMemo(
    () =>
      currentInvestigationId
        ? investigations.find((i) => i.id === currentInvestigationId) ?? null
        : null,
    [investigations, currentInvestigationId],
  );
  const investigationLocalOnly = currentInvestigation?.providerPolicy === "local-only";

  const provenance = investigationLocalOnly
    ? // The engine forces the private path for every ask in a local-only
      // investigation (the cfg swap at the model_config chokepoint), so this
      // line stays truthful regardless of the profile's active provider.
      "Private — this investigation always answers on this device."
    : !providerId || providerId === "local"
      ? "Private — answers are generated entirely on this device."
      : `Excerpts from files visible to AI are sent to ${providerLabel} to answer your questions.`;

  // LIVE scope size: dangling scope ids (files deleted since scoping) don't
  // count — the pill shows what the scope can actually reach right now.
  // null = no investigation or an empty scope (= the whole vault, no pill).
  const scopeCount = useMemo(() => {
    if (!currentInvestigation || currentInvestigation.scopeFileIds.length === 0) return null;
    const present = new Set(nodes.map((n) => n.id));
    return currentInvestigation.scopeFileIds.filter((id) => present.has(id)).length;
  }, [currentInvestigation, nodes]);
  const scopeLabel =
    scopeCount === null ? "Whole vault" : `Scoped to ${scopeCount} file${scopeCount === 1 ? "" : "s"}`;

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
  const historyPersistEnabled = useChatStore((s) => s.persistEnabled);
  const [streaming, setStreaming] = useState(false);
  // Pre-answer stage note from the engine ("Reading q3.csv (2/5)…") — shown in
  // the loader while multi-document synthesis works; cleared on the first token.
  const [progressLabel, setProgressLabel] = useState<string | null>(null);
  // G2 draft-then-verify: while the streaming answer is still the provisional
  // extractive draft, show a "verifying…" badge. `draftRef` mirrors it
  // synchronously so the `for await` loop can test it without a stale closure.
  const [draftActive, setDraftActive] = useState(false);
  const draftRef = useRef(false);
  // G6: guards the auto-export-note write so overlapping turn-settles don't
  // race two writes for the same conversation.
  const exportNoteRef = useRef(false);

  // Recent chats moved to the sidebar History section (§22.2 — HistoryNav
  // owns its own search/rename/delete state; nothing drawer-shaped lives here).
  // "Started a new chat — Undo" strip, auto-dismissed after a few seconds.
  const [showUndo, setShowUndo] = useState(false);
  const undoTimer = useRef<number | null>(null);
  // Inline editing of a past question (id of the user message being edited).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  // Attach-picker popover (quick search over the vault's own files) + its query.
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachSearch, setAttachSearch] = useState("");
  // Ask type-ahead (time-savers): open only tracks TYPED input (Esc/accept/blur
  // close it; programmatic fills never open it); index is the highlighted row,
  // -1 = none — so a plain Enter still sends (see handleComposerKeyDown).
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestIndex, setSuggestIndex] = useState(-1);
  // @-mention file picker (openspec §2): the active `@…` span under the caret
  // (null = none), the highlighted row, and a dismiss key (the span the user
  // pressed Esc on, so it stays closed until the token changes).
  const [mention, setMention] = useState<MentionSpan | null>(null);
  const [mentionSel, setMentionSel] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState<string | null>(null);
  // Per-answer 👍/👎, remembered for the session so the choice reads as "set".
  const [ratings, setRatings] = useState<Record<string, "up" | "down">>({});
  // --- Edit SQL dialog (analytics refinement): the answer meta being edited
  //     (null = closed), the SQL draft, and the last run's outcome. ---
  const [sqlEdit, setSqlEdit] = useState<AnalyticsMeta | null>(null);
  const [sqlDraft, setSqlDraft] = useState("");
  const [sqlRunning, setSqlRunning] = useState(false);
  const [sqlOutcome, setSqlOutcome] = useState<{ content?: string; error?: string } | null>(null);
  // Generation token for dialog runs: bumped on open/close so a slow query
  // from a CLOSED dialog can never paint its result into a newer one.
  const sqlRunSeq = useRef(0);
  // --- Answer artifacts: per-turn Save-as-CSV outcome, and the transient
  //     export-chat-to-note confirmation bar. ---
  const [savedNotes, setSavedNotes] = useState<
    Record<string, { pending?: boolean; id?: string; name?: string; error?: string }>
  >({});
  // Per-turn evidence-pack outcome — the pack chip's twin of savedNotes.
  const [packNotes, setPackNotes] = useState<
    Record<string, { pending?: boolean; id?: string; name?: string; error?: string }>
  >({});
  const [exportNote, setExportNote] = useState<{ id?: string; name?: string; error?: string } | null>(
    null,
  );
  const exportNoteTimer = useRef<number | null>(null);
  // Quick provider switch (header menu): its transient confirmation strip,
  // house-styled like the export/undo bars and auto-dismissed the same way.
  const [providerNote, setProviderNote] = useState<{ ok: boolean; text: string } | null>(null);
  const providerNoteTimer = useRef<number | null>(null);
  const noteProviderSwitch = useCallback((note: { ok: boolean; text: string }) => {
    setProviderNote(note);
    if (providerNoteTimer.current !== null) window.clearTimeout(providerNoteTimer.current);
    providerNoteTimer.current = window.setTimeout(() => setProviderNote(null), 6000);
  }, []);
  // In-flight guard: a double-click must not write "Chat.md" AND "Chat (1).md".
  const [exportBusy, setExportBusy] = useState(false);
  // --- Pinned questions: per-turn pin outcome, the changed-pins alerts (from
  //     the shell's watcher-driven recheck pass), and the pins dialog. ---
  const [pinNotes, setPinNotes] = useState<
    Record<
      string,
      // `pinId` (set on success) feeds the "Add to board" affordance beside
      // the confirmation; `boardNote` is that affordance's outcome line
      // (openspec: add-boards §4.1).
      { pending?: boolean; ok?: boolean; error?: string; pinId?: string; boardNote?: string }
    >
  >({});
  const [pinAlerts, setPinAlerts] = useState<ChangedPin[]>([]);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [pinList, setPinList] = useState<Pin[]>([]);
  const [pinsBusy, setPinsBusy] = useState(false);
  // --- Save as view (openspec: add-shaped-views §3.1): the dialog's target
  //     (the answer's meta + the question that produced it) and the per-turn
  //     saved confirmation — the savedNotes idiom. ---
  const [saveView, setSaveView] = useState<{
    msgId: string;
    meta: AnalyticsMeta;
    question: string;
  } | null>(null);
  const [viewNotes, setViewNotes] = useState<Record<string, { name?: string }>>({});
  // "Define as metric" (openspec: add-semantic-layer §6.2): the dialog's target
  // — the answer's meta + the question that produced it (the Save-as-view idiom).
  const [defineMetric, setDefineMetric] = useState<{
    msgId: string;
    meta: AnalyticsMeta;
    question: string;
  } | null>(null);
  // G5: transient "Saved to Lighthouse Notes" note after a manual refresh.
  const [briefingSaved, setBriefingSaved] = useState<string | null>(null);
  // Outcome of a pins-dialog row's "Add to board" (openspec: add-boards).
  const [pinBoardNote, setPinBoardNote] = useState<string | null>(null);
  // "Chart it" (charts by default, 0.12.1): per-turn inline table-chart
  // visibility — savedNotes-style UI state, never persisted; the spec itself
  // recomputes from the answer markdown, zero model/network calls.
  const [inlineCharts, setInlineCharts] = useState<Record<string, boolean>>({});
  // Saved/pinned notes AND thumbs ratings are keyed by message id, and ids
  // RESTART per conversation — clear them on a conversation switch so a new
  // chat's "a2" never inherits another chat's "Saved…"/"Pinned…"/👍.
  useEffect(() => {
    setSavedNotes({});
    setPackNotes({});
    setPinNotes({});
    setRatings({});
    setInlineCharts({});
    // Save-as-view state is per-conversation too (like the "Chart it" inline
    // charts above): close a dialog opened from another chat and drop its
    // notes, so a same-id answer here can never inherit a "Saved view…" line.
    setSaveView(null);
    setViewNotes({});
    setDefineMetric(null);
    // §22.2: conversations can now be opened from OUTSIDE this panel (the
    // sidebar History section) — the in-place question editor is keyed by
    // message id like the notes above, so close it on any switch. (The old
    // drawer's openChat did this inline; the effect covers every path.)
    setEditingId(null);
    setEditText("");
  }, [currentId]);
  // Cancels the in-flight ask() when the user presses Stop.
  const abortRef = useRef<AbortController | null>(null);
  // Streamed-token coalescing. `sendQuestion` appends a delta per token inside a
  // `for await` loop, and each write lands in its own microtask, so React 19
  // can't batch them — the whole panel re-rendered once per token. Instead we
  // stash the growing answer in a ref and flush it to the store at most once per
  // animation frame: renders drop from O(tokens) → O(frames). The turn settles
  // with a final synchronous flush so no buffered token is ever lost.
  const streamPendingRef = useRef<{ id: string; content: string } | null>(null);
  const streamRafRef = useRef<number | null>(null);
  const writeStreamContent = useCallback(() => {
    const pending = streamPendingRef.current;
    if (!pending) return;
    streamPendingRef.current = null;
    setMessages((m) =>
      m.map((x) => (x.id === pending.id ? { ...x, content: pending.content } : x)),
    );
  }, [setMessages]);
  const scheduleStreamFlush = useCallback(
    (id: string, content: string) => {
      streamPendingRef.current = { id, content };
      if (streamRafRef.current === null) {
        streamRafRef.current = requestAnimationFrame(() => {
          streamRafRef.current = null;
          writeStreamContent();
        });
      }
    },
    [writeStreamContent],
  );
  const flushStreamNow = useCallback(() => {
    if (streamRafRef.current !== null) {
      cancelAnimationFrame(streamRafRef.current);
      streamRafRef.current = null;
    }
    writeStreamContent();
  }, [writeStreamContent]);
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
  // §22.6: assistant turns created in THIS session. Live turns never render
  // chart fences from answer text (the engine's spec rides `meta.chart`;
  // a text fence can only be model-injected); hydrated saved chats — absent
  // from this set — keep the legacy fence-rendering path for their persisted
  // engine charts.
  const liveTurnIds = useRef<Set<string>>(new Set());
  // Re-seed the id counter when the active conversation changes (open / undo /
  // delete), so new turns never collide with ids already in the loaded
  // transcript. Read from the store so we see the just-switched messages.
  useEffect(() => {
    const msgs = useChatStore.getState().messages;
    idSeq.current = msgs.reduce((max, m) => Math.max(max, Number(m.id.slice(1)) || 0), 0);
  }, [currentId]);
  // Fires the activation event only on the first answered question this session.

  // "Pinned" = the viewport is at (or near) the transcript bottom. It gates
  // exactly one thing: the "Jump to latest" pill stays hidden while pinned
  // (jumping would be a no-op). It drives no automatic scrolling. The ref
  // mirrors the state for use inside scroll handlers without re-binding them.
  const [pinned, setPinned] = useState(true);
  const pinnedRef = useRef(true);
  // Read-from-the-top hold (openspec: add-investigations §5.1): the in-flight
  // answer whose message row owns the viewport top.
  //   "armed"   = question sent, no answer content yet — the transcript may
  //               still show the bottom (the just-sent question + loader).
  //   "holding" = the answer is streaming — its row's top is held at the top
  //               of the viewport, re-asserted as the message grows.
  //   null      = no hold: nothing in flight, the stream settled, or the user
  //               scrolled (any manual scroll cancels the hold for that
  //               answer — the transcript never fights the user).
  const anchorRef = useRef<{ id: string; phase: "armed" | "holding" } | null>(null);
  // scrollTop as WE last wrote it (post-clamp). A scroll event reporting
  // (about) this value is our own write echoing back; any other position is
  // user intent and releases the hold (see handleBodyScroll). All programmatic
  // writes go through writeScrollTop so this bookkeeping can't be skipped.
  const programmaticScrollTopRef = useRef<number | null>(null);

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
      if (exportNoteTimer.current !== null) window.clearTimeout(exportNoteTimer.current);
      if (providerNoteTimer.current !== null) window.clearTimeout(providerNoteTimer.current);
      if (streamRafRef.current !== null) cancelAnimationFrame(streamRafRef.current);
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

  // Inside the DESKTOP Tauri shell, OS file drags arrive via the NATIVE
  // drag-drop events (rebroadcast as lighthouse:os-* CustomEvents) — the DOM
  // "Files" events never fire on Windows and would double-handle drops on
  // macOS, so the DOM path only reacts to OS files off the desktop shell.
  // fp3 §5: an iPad is an embedded shell too, but Tauri's desktop drag bridge
  // does NOT fire for Files-app drags into the WKWebView — iPadOS delivers them
  // as ordinary DOM drag events — so a mobile shell keeps the DOM path live as
  // the working fallback. Internal explorer drags (FILE_DRAG_MIME) are
  // DOM-native everywhere and stay as they are.
  const isFileDrag = (e: DragEvent) =>
    e.dataTransfer.types.includes(FILE_DRAG_MIME) ||
    ((!isDesktopShell() || platformKind() !== "desktop") &&
      e.dataTransfer.types.includes("Files"));

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

  // Every programmatic scroll is a plain, instant scrollTop assignment — never
  // a smooth scrollIntoView — so reduced-motion preferences need no special
  // case. Records the value actually applied (post-clamp) so handleBodyScroll
  // can tell our own echo from a user scroll.
  const writeScrollTop = useCallback((el: HTMLElement, top: number) => {
    el.scrollTop = top;
    programmaticScrollTopRef.current = el.scrollTop;
  }, []);

  // Re-derive "pinned" from live geometry. Called from scroll events AND from
  // the [messages] effect: content growing under a held anchor moves the
  // bottom without firing any scroll event, and the pill must track that.
  const derivePinned = useCallback((el: HTMLElement) => {
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const next = distance < PIN_THRESHOLD;
    pinnedRef.current = next;
    setPinned(next);
  }, []);

  // Opening a conversation (initial mount, drawer, undo, delete-fallback)
  // lands at the bottom, exactly as before read-from-the-top: the landing is a
  // conversation-level event, not part of any answer's hold — so it clears one.
  useEffect(() => {
    anchorRef.current = null;
    const el = bodyRef.current;
    if (!el) return;
    writeScrollTop(el, el.scrollHeight);
    derivePinned(el);
  }, [currentId, writeScrollTop, derivePinned]);

  // Read-from-the-top (openspec: add-investigations §5.1). While an ask is in
  // flight this effect owns the scroll position, in two phases:
  //   armed   → no answer content yet: keep the bottom in view so the
  //             just-sent question and the loader are visible.
  //   holding → the answer is streaming: hold the TOP of its message row at
  //             the top of the viewport, re-asserted on every growth so
  //             reflow above the row (e.g. the markdown chunk mounting into
  //             earlier turns) never drifts the first line. Reference cards,
  //             chips, and the provenance stamp append BELOW the answer and
  //             never displace the anchored start; the question bubble
  //             scrolling out above is deliberate — the answer owns the top.
  // The hold is one-sided: any user scroll clears anchorRef (handleBodyScroll,
  // wheel/touch) and this effect goes dormant — with no hold active it never
  // scrolls at all, so a settling stream stops anchoring without jumping.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const anchor = anchorRef.current;
    if (anchor) {
      if (anchor.phase === "armed") {
        if (messages.some((m) => m.id === anchor.id && m.content !== "")) {
          anchor.phase = "holding";
        } else {
          writeScrollTop(el, el.scrollHeight);
        }
      }
      if (anchor.phase === "holding") {
        // The turn ROW is the anchor target — it exists from the moment the
        // ask is appended and data-lh-turn already identifies it. Rect delta
        // rather than offsetTop: the rows' offsetParent is the positioned
        // bodyWrap, not the scroll container.
        const row = el.querySelector<HTMLElement>(`[data-lh-turn="${anchor.id}"]`);
        if (row) {
          const anchorTop =
            row.getBoundingClientRect().top -
            el.getBoundingClientRect().top -
            el.clientTop +
            el.scrollTop;
          const paddingTop = Number.parseFloat(getComputedStyle(el).paddingTop) || 0;
          writeScrollTop(
            el,
            computeAnchorScrollTop(anchorTop, paddingTop, el.scrollHeight - el.clientHeight),
          );
        }
      }
    }
    derivePinned(el);
  }, [messages, writeScrollTop, derivePinned]);

  function handleBodyScroll() {
    const el = bodyRef.current;
    if (!el) return;
    // A scroll we didn't write ourselves is user intent: release the hold for
    // the in-flight answer. Our own writes echo back at exactly the recorded
    // position (sub-pixel slack for zoomed displays); anything else — wheel,
    // touch, scrollbar, keyboard, a citation-chip scrollIntoView — cancels.
    const expected = programmaticScrollTopRef.current;
    if (expected === null || Math.abs(el.scrollTop - expected) > 1) {
      anchorRef.current = null;
    }
    derivePinned(el);
  }

  // Belt-and-braces for the cancel rule: a wheel tick or touch drag is user
  // intent even when it cannot move scrollTop (already clamped at an edge),
  // and it fires before any scroll event it causes.
  function cancelHoldOnUserInput() {
    anchorRef.current = null;
  }

  function jumpToLatest() {
    // Explicit user intent: drop any hold and go watch the transcript tail.
    anchorRef.current = null;
    const el = bodyRef.current;
    if (!el) return;
    writeScrollTop(el, el.scrollHeight);
    derivePinned(el);
  }

  // Focus the composer on mount so the user can just start typing. fp3 §2: NOT
  // on a coarse pointer — auto-focusing pops the on-screen keyboard the instant
  // chat opens, covering half the phone/iPad before the user has done anything.
  // A hardware keyboard is still a coarse-pointer device (iPad + Magic Keyboard)
  // but the tap-to-focus cost there is trivial; the keyboard-pop cost is not.
  useEffect(() => {
    if (coarsePointer) return;
    composerRef.current?.focus();
  }, [coarsePointer]);

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

  // fp4 §3: re-tapping the active Chat tab in the compact tab bar scrolls the
  // transcript to the top (the iOS convention). The tab bar (AppShell) dispatches
  // this; the composer/FAB don't move. Instant, matching the touch scroll idiom.
  useEffect(() => {
    const onScrollTop = () => bodyRef.current?.scrollTo({ top: 0, behavior: "auto" });
    window.addEventListener("lighthouse:chat-scroll-top", onScrollTop);
    return () => window.removeEventListener("lighthouse:chat-scroll-top", onScrollTop);
  }, []);

  // Quick-open's Ctrl/Cmd+Enter attaches a file to the conversation through
  // this window event, the same decoupling as new-chat above. It rides the
  // exact append path the explorer-drag/OS-drop use (addAttachments dedupes by
  // id) and then focuses the composer so the follow-up question can be typed
  // immediately — rAF so the focus lands after the palette dialog's own
  // close-time focus restore. Latest-closure ref pattern.
  const attachFileRef = useRef<(f: DraggedFile) => void>(() => {});
  attachFileRef.current = (f) => {
    addAttachments([f]);
    requestAnimationFrame(() => composerRef.current?.focus());
  };
  useEffect(() => {
    const onAttachFile = (e: Event) => {
      const d = (e as CustomEvent<{ id?: string; name?: string }>).detail;
      if (d && typeof d.id === "string" && typeof d.name === "string") {
        attachFileRef.current({ id: d.id, name: d.name });
      }
    };
    window.addEventListener("lighthouse:attach-file", onAttachFile);
    return () => window.removeEventListener("lighthouse:attach-file", onAttachFile);
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

  async function sendQuestion(
    q: string,
    opts?: { bypassCache?: boolean; attachmentsOverride?: { id: string }[] },
  ) {
    if (!q || streaming) return;
    // Warm the split markdown chunk now, while the answer streams as plain text,
    // so it's ready the instant the turn settles into a full markdown render.
    warmMarkdown();
    // Answer cache (openspec: add-answer-cache): the client's per-ask
    // persistence verdict. Chat-history opt-in is client-only state by design
    // (useChatStore + localStorage), so the engine only ever learns this
    // per-request boolean — read LIVE from the store plus the managed-policy
    // lock (same fail-closed pairing as the conversation-note export below),
    // so a policy applied after mount can't let a disk write slip through.
    const persistAllowed = useChatStore.getState().persistEnabled && !chatHistoryLocked();
    // Investigation context (openspec: add-investigations §4.2), captured at
    // ask time: the id rides the wire (scope + local-only policy resolve
    // ENGINE-side), and the settle-time conversation-ref write below reuses
    // this exact id + conversation + persistAllowed verdict, so a mid-stream
    // context or chat switch can never retarget any of them.
    const investigationId = useChatStore.getState().currentInvestigationId ?? undefined;
    const conversationIdAtAsk = useChatStore.getState().currentId;
    // The conversation so far (completed turns only — failed turns are excluded)
    // becomes the model's history. Read from the store, not the render closure,
    // so a retry that just removed its failed turn builds the right history.
    const history: ChatTurn[] = useChatStore
      .getState()
      .messages.filter((m) => !m.error && m.content)
      .map((m) => ({ role: m.role, content: m.content }));
    // §3 "Synthesize": a one-shot attachment scope (the answer's own source
    // files) overrides the composer pills without disturbing them.
    const attachmentIds = (opts?.attachmentsOverride ?? attachments).map((a) => a.id);
    const userMsg: TranscriptMessage = { id: `u${++idSeq.current}`, role: "user", content: q };
    const asstId = `a${++idSeq.current}`;
    // §22.6: turns born in THIS session never render chart fences from text —
    // the engine's spec arrives on meta, so any fence in a live answer is
    // model-injected. Hydrated (saved/legacy) turns keep fence rendering.
    liveTurnIds.current.add(asstId);
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
    // Read-from-the-top: arm the hold for the answer about to stream. Until
    // its first content arrives the [messages] effect keeps the bottom in view
    // (the just-sent question + loader); the first delta then anchors the
    // answer's top to the viewport top and holds it there.
    anchorRef.current = { id: asstId, phase: "armed" };
    const controller = new AbortController();
    abortRef.current = controller;
    draftRef.current = false;
    setDraftActive(false);
    let finalContent = "";
    try {
      for await (const chunk of chatService.ask(
        q,
        includedFileIds,
        history,
        attachmentIds,
        controller.signal,
        { bypassCache: opts?.bypassCache === true, persistAllowed, investigationId },
      )) {
        // Stop pressed: some transports (the Tauri fetch interceptor) don't
        // honor AbortSignal, so also bail out of the loop explicitly and keep
        // the partially-streamed answer.
        if (controller.signal.aborted) break;
        if (chunk.progress) setProgressLabel(chunk.progress.label);
        if (chunk.delta) {
          setProgressLabel(null); // the answer is starting — stage notes are done
          if (chunk.draft) {
            // Provisional extractive draft (G2): show it immediately, flagged.
            if (!draftRef.current) {
              draftRef.current = true;
              setDraftActive(true);
            }
            finalContent += chunk.delta;
          } else {
            // First authoritative token: wipe the draft and stream the verified
            // answer in its place (one clean replacement, no interleaving).
            if (draftRef.current) {
              draftRef.current = false;
              setDraftActive(false);
              finalContent = "";
            }
            finalContent += chunk.delta;
          }
          // Buffer the growing answer and flush on the next frame instead of
          // writing the store per token (see scheduleStreamFlush).
          scheduleStreamFlush(asstId, finalContent);
        }
        if (chunk.references) {
          const refs = chunk.references;
          setMessages((m) => m.map((x) => (x.id === asstId ? { ...x, references: refs } : x)));
        }
        if (chunk.analytics) {
          // Structured provenance of an analytics answer (final chunk): the
          // exact SQL + files read. Stored on the turn to power the refinement
          // chips and Edit SQL. Desktop engine only — absent elsewhere.
          const meta = chunk.analytics;
          setMessages((m) => m.map((x) => (x.id === asstId ? { ...x, analytics: meta } : x)));
        }
        if (chunk.meta) {
          // Engine-emitted provenance stamp (final chunk): where the answer was
          // computed + how much was sent. Stored on the turn for the truthful
          // "Answered on this device / via <vendor>" footer.
          const provenance = chunk.meta;
          setMessages((m) => m.map((x) => (x.id === asstId ? { ...x, meta: provenance } : x)));
        }
      }
      if (controller.signal.aborted) {
        markStopped(asstId);
      } else if (investigationId) {
        // The ask succeeded inside an investigation: record this conversation
        // on it — a REF (an opaque id), never a transcript — with the SAME
        // persistAllowed verdict the ask itself carried. Fire-and-forget: the
        // engine silently no-ops the write when the history posture (client
        // opt-out or managed policy) disallows it.
        void ragService
          .addInvestigationConversationRef(investigationId, conversationIdAtAsk, persistAllowed)
          .catch(() => {});
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
      // Trust guard (G2): if the stream ended while STILL showing only the
      // provisional draft (Stop or an error mid-draft, before any verified
      // token), the draft must not settle as the answer — an unverified
      // extractive preview would then be indistinguishable from a grounded
      // answer once the "Draft" badge (gated on `streaming`) disappears. Blank
      // it so nothing false persists. (A clean local completion always emits a
      // real answer that already replaced the draft, so this only bites the
      // interrupted paths.)
      if (draftRef.current) {
        finalContent = "";
        scheduleStreamFlush(asstId, "");
      }
      // Land every buffered token into the store before the turn settles, so the
      // finished transcript (and what we persist) holds the complete answer even
      // if the last frame's flush hadn't fired yet.
      flushStreamNow();
      // The stream is over: stop anchoring and go nowhere. Cleared before
      // React flushes the batched settle updates, so the [messages] effect
      // sees no hold and the settle re-render (markdown swap, actions,
      // provenance stamp) cannot move the reader.
      anchorRef.current = null;
      abortRef.current = null;
      setStreaming(false);
      setProgressLabel(null);
      draftRef.current = false;
      setDraftActive(false);
      // Save the settled turn for this session (cheap: once per turn, not per token).
      persistMessages();
      // G6: with "Save chats on this device" ON, also export the settled
      // conversation as an indexed vault note so it becomes retrievable content.
      // Fail-closed: honor the LIVE managed-policy lock too, not just the
      // opt-in field — `persistMessages()` re-checks `chatHistoryLocked()` the
      // same way, so a policy applied AFTER bootstrap (when the store field was
      // already true) must not let a note slip through. Fire-and-forget.
      if (historyPersistEnabled && !chatHistoryLocked()) void exportConversationNoteNow();
      // Hand focus back for the follow-up — but NOT on touch, where a
      // programmatic focus pops the on-screen keyboard (and, historically, the
      // iOS focus-zoom) uninvited the moment an answer lands. On iPhone/iPad the
      // reader keeps the finished answer in view; tapping the composer is how a
      // follow-up starts. Desktop keeps the hand-back — the keyboard is free
      // there — and still only when the user hasn't moved focus elsewhere (e.g.
      // the explorer's search box) mid-stream.
      const active = document.activeElement;
      if (
        !coarsePointer &&
        (!active || active === document.body || active.closest('[data-lh-pane="chat"]'))
      ) {
        composerRef.current?.focus();
      }
    }
  }

  /** Reveal a saved artifact in the OS file manager (desktop shell only). */
  function revealSaved(nodeId: string) {
    void fetch("/api/reveal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId }),
    }).catch(() => {});
  }

  /**
   * Save an analytics answer's full result as a CSV into the vault
   * (Lighthouse Results/) — the engine re-runs the answer's own SQL with its
   * save cap; the file becomes ordinary, queryable vault input. The name hint
   * is the question that produced the answer.
   */
  async function saveResultCsv(asstId: string, meta: AnalyticsMeta) {
    const msgs = useChatStore.getState().messages;
    const idx = msgs.findIndex((x) => x.id === asstId);
    const prev = idx > 0 ? msgs[idx - 1] : undefined;
    const hint =
      (prev?.role === "user" ? prev.content : "").trim().replace(/\s+/g, " ").slice(0, 60) ||
      "Result";
    // Message ids restart per conversation, so a note written after the user
    // switched chats would attach to an unrelated same-id answer. Drop the
    // post-await writes if the conversation changed while we saved.
    const convo = useChatStore.getState().currentId;
    const stillHere = () => useChatStore.getState().currentId === convo;
    setSavedNotes((s) => ({ ...s, [asstId]: { pending: true } }));
    try {
      const res = await ragService.analyticsSql(meta.sql, meta.fileIds, hint);
      if (!stillHere()) return;
      if (res.error || !res.savedId) {
        setSavedNotes((s) => ({ ...s, [asstId]: { error: res.error ?? "save failed" } }));
      } else {
        setSavedNotes((s) => ({ ...s, [asstId]: { id: res.savedId, name: res.savedName } }));
      }
    } catch (err) {
      if (!stillHere()) return;
      setSavedNotes((s) => ({
        ...s,
        [asstId]: { error: err instanceof Error ? err.message : "save failed" },
      }));
    }
  }

  /**
   * Evidence pack (Beam §2): compose ONE self-contained HTML file from this
   * analytics answer — question, narrative + result table (honesty footers
   * verbatim), the rendered chart as inline SVG, the exact SQL, and file
   * provenance/freshness — and write it into `Lighthouse Results/` through
   * the same sanitized artifact op the chat export uses. Everything is
   * composed CLIENT-SIDE from what's already on the turn: no re-query, no
   * model, no network beyond the local write op.
   */
  async function saveEvidencePack(asstId: string, meta: AnalyticsMeta) {
    const msgs = useChatStore.getState().messages;
    const idx = msgs.findIndex((x) => x.id === asstId);
    const msg = idx >= 0 ? msgs[idx] : undefined;
    if (!msg || !msg.content) return;
    const prev = idx > 0 ? msgs[idx - 1] : undefined;
    const question =
      (prev?.role === "user" ? prev.content : "").trim().replace(/\s+/g, " ") ||
      "Analytics answer";
    const hint = question.slice(0, 60) || "Evidence pack";
    // Serialize the ALREADY-RENDERED chart SVG for this turn (theme colors
    // baked in). Absent or unparsable chart ⇒ the pack omits the section.
    let chartSvg: string | undefined;
    const svgEl = document.querySelector<SVGSVGElement>(
      `[data-lh-turn="${asstId}"] figure svg[role="img"]`,
    );
    if (svgEl) {
      try {
        chartSvg = standaloneChartSvg(svgEl);
      } catch {
        /* chart capture is best-effort — the pack stands without it */
      }
    }
    const html = composeEvidencePack({
      question,
      contentMarkdown: msg.content,
      chartSvg,
      meta: msg.meta,
      analytics: meta,
      references: msg.references ?? [],
      generatedAt: Date.now(),
    });
    // Same per-conversation guard as saveResultCsv: ids restart per chat.
    const convo = useChatStore.getState().currentId;
    const stillHere = () => useChatStore.getState().currentId === convo;
    setPackNotes((s) => ({ ...s, [asstId]: { pending: true } }));
    try {
      const res = await ragService.exportChat(hint, html, {
        subdir: "Lighthouse Results",
        ext: "html",
      });
      if (!stillHere()) return;
      if (res.error || !res.savedId) {
        setPackNotes((s) => ({ ...s, [asstId]: { error: res.error ?? "save failed" } }));
      } else {
        setPackNotes((s) => ({ ...s, [asstId]: { id: res.savedId, name: res.savedName } }));
      }
    } catch (err) {
      if (!stillHere()) return;
      setPackNotes((s) => ({
        ...s,
        [asstId]: { error: err instanceof Error ? err.message : "save failed" },
      }));
    }
  }

  /** The transcript as portable markdown — the client owns what's visible. */
  function transcriptMarkdown(msgs: TranscriptMessage[], title: string): string {
    const lines: string[] = [`# ${title}`, ""];
    for (const m of msgs) {
      if (m.error || !m.content) continue;
      lines.push(m.role === "user" ? "**You:**" : "**Lighthouse:**", "", m.content, "");
      if (m.role === "assistant") {
        if (m.stopped) lines.push("_(stopped)_", "");
        if (m.references?.length) {
          lines.push(`_Sources: ${m.references.map((r) => r.name).join(", ")}_`, "");
        }
      }
    }
    return lines.join("\n");
  }

  /**
   * G6: auto-export the settled conversation as an indexed vault note (YAML
   * frontmatter + the same transcript markdown), overwritten in place per
   * conversation so past chats become retrievable content. Fire-and-forget;
   * the CALLER gates on "Save chats on this device". Failures are swallowed —
   * this is a background convenience, never a blocker.
   */
  async function exportConversationNoteNow() {
    if (exportNoteRef.current) return; // a write is already in flight
    const state = useChatStore.getState();
    const msgs = state.messages;
    const convo = state.currentId;
    // Worth a note only once there's a real answer to recall.
    if (!convo || !msgs.some((m) => m.role === "assistant" && m.content && !m.error)) return;
    const title =
      state.conversations.find((c) => c.id === convo)?.title.trim() || "Lighthouse chat";
    const citedFileIds = Array.from(
      new Set(msgs.flatMap((m) => m.references?.map((r) => r.fileId) ?? [])),
    );
    // Double-quote every scalar so a title/path with a colon or quote stays valid YAML.
    const yaml = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    const frontmatter = [
      "---",
      `date: ${new Date().toISOString()}`,
      `title: ${yaml(title)}`,
      `provider: ${yaml(providerLabel)}`,
      `citedFileIds: [${citedFileIds.map(yaml).join(", ")}]`,
      "---",
      "",
    ].join("\n");
    exportNoteRef.current = true;
    try {
      await ragService.exportConversationNote(convo, title, frontmatter + transcriptMarkdown(msgs, title));
    } catch {
      /* background best-effort — never surface */
    } finally {
      exportNoteRef.current = false;
    }
  }

  /** Export the conversation as a markdown note into Lighthouse Notes/. */
  async function exportChatToNote() {
    const msgs = useChatStore.getState().messages;
    if (msgs.length === 0 || streaming || exportBusy) return;
    setExportBusy(true);
    const title =
      conversations.find((c) => c.id === currentId)?.title.trim() || "Lighthouse chat";
    // Inside an investigation the note lands in ITS folder under Lighthouse
    // Notes/ — the engine resolves the folder from the record (openspec:
    // add-investigations §3); the global context keeps the original path.
    const investigationId = useChatStore.getState().currentInvestigationId ?? undefined;
    let next: { id?: string; name?: string; error?: string };
    try {
      const res = await ragService.exportChat(
        title,
        transcriptMarkdown(msgs, title),
        investigationId ? { investigationId } : undefined,
      );
      next =
        res.error || !res.savedId
          ? { error: res.error ?? "export failed" }
          : { id: res.savedId, name: res.savedName };
    } catch (err) {
      next = { error: err instanceof Error ? err.message : "export failed" };
    } finally {
      setExportBusy(false);
    }
    setExportNote(next);
    if (exportNoteTimer.current !== null) window.clearTimeout(exportNoteTimer.current);
    exportNoteTimer.current = window.setTimeout(() => setExportNote(null), 8000);
  }

  /**
   * "Save as view" (openspec: add-shaped-views §3.1): open the name dialog
   * with this answer's meta and the question that produced it — the same
   * preceding-user-turn derivation as pinAnswer. The question becomes the
   * view's summary, labeled "question"; no model is consulted anywhere in
   * this flow.
   */
  function openSaveView(asstId: string, meta: AnalyticsMeta) {
    const msgs = useChatStore.getState().messages;
    const idx = msgs.findIndex((x) => x.id === asstId);
    const prev = idx > 0 ? msgs[idx - 1] : undefined;
    const question =
      (prev?.role === "user" ? prev.content : "").trim().replace(/\s+/g, " ").slice(0, 200) ||
      "Saved view";
    setSaveView({ msgId: asstId, meta, question });
  }

  /**
   * "Define as metric" (openspec: add-semantic-layer §6.2): open the dialog with
   * this answer's meta and the question that produced it (the openSaveView
   * derivation). The engine proposes the aggregation from the answer's own SQL;
   * the question becomes the metric's summary, labeled "question".
   */
  function openDefineMetric(asstId: string, meta: AnalyticsMeta) {
    const msgs = useChatStore.getState().messages;
    const idx = msgs.findIndex((x) => x.id === asstId);
    const prev = idx > 0 ? msgs[idx - 1] : undefined;
    const question =
      (prev?.role === "user" ? prev.content : "").trim().replace(/\s+/g, " ").slice(0, 200) ||
      "Defined metric";
    setDefineMetric({ msgId: asstId, meta, question });
  }

  /**
   * Pin an analytics answer: the engine watches its files and flags this
   * question when the computed result changes. Question = the user turn that
   * produced the answer.
   */
  async function pinAnswer(asstId: string, meta: AnalyticsMeta) {
    const msgs = useChatStore.getState().messages;
    const idx = msgs.findIndex((x) => x.id === asstId);
    const prev = idx > 0 ? msgs[idx - 1] : undefined;
    const question =
      (prev?.role === "user" ? prev.content : "").trim().replace(/\s+/g, " ").slice(0, 200) ||
      "Pinned question";
    // Same per-conversation guard as saveResultCsv: ids restart per chat, so
    // don't paint a "Pinned" note onto a same-id answer in a chat the user
    // switched to mid-request.
    const convo = useChatStore.getState().currentId;
    const stillHere = () => useChatStore.getState().currentId === convo;
    setPinNotes((s) => ({ ...s, [asstId]: { pending: true } }));
    try {
      // The pin adopts the current investigation (openspec: add-investigations
      // §3) — its membership; the global context leaves it uncategorized.
      const res = await ragService.pinAsk(
        question,
        meta.sql,
        meta.fileIds,
        useChatStore.getState().currentInvestigationId ?? undefined,
      );
      if (!stillHere()) return;
      if (res.error || !res.pin) {
        setPinNotes((s) => ({ ...s, [asstId]: { error: res.error ?? "could not pin" } }));
      } else {
        setPinNotes((s) => ({ ...s, [asstId]: { ok: true, pinId: res.pin?.id } }));
      }
    } catch (err) {
      if (!stillHere()) return;
      setPinNotes((s) => ({
        ...s,
        [asstId]: { error: err instanceof Error ? err.message : "could not pin" },
      }));
    }
  }

  // Changed-pin alerts pushed by the desktop shell after its watcher-driven
  // recheck pass (openspec: add-pinned-questions). Newest wins per pin id.
  useEffect(() => {
    const onPinsChanged = (e: Event) => {
      const changed = (e as CustomEvent<{ changed?: ChangedPin[] }>).detail?.changed;
      if (!Array.isArray(changed) || changed.length === 0) return;
      setPinAlerts((prev) => {
        const ids = new Set(changed.map((c) => c.id));
        return [...changed, ...prev.filter((p) => !ids.has(p.id))].slice(0, 5);
      });
    };
    window.addEventListener("lighthouse:pins-changed", onPinsChanged);
    return () => window.removeEventListener("lighthouse:pins-changed", onPinsChanged);
  }, []);

  // The pins dialog opens from the settings gear (or anywhere) via this event.
  useEffect(() => {
    const onOpen = () => setPinsOpen(true);
    window.addEventListener("lighthouse:open-pins", onOpen);
    return () => window.removeEventListener("lighthouse:open-pins", onOpen);
  }, []);

  // Load the pin list whenever the dialog opens.
  useEffect(() => {
    if (!pinsOpen) return;
    setPinBoardNote(null); // last session's "Added to …" note is stale
    let cancelled = false;
    ragService
      .listPins()
      .then((pins) => {
        if (!cancelled) setPinList(pins);
      })
      .catch(() => {
        if (!cancelled) setPinList([]);
      });
    return () => {
      cancelled = true;
    };
  }, [pinsOpen]);

  // …and once at mount, so pinned questions feed the ask type-ahead before the
  // dialog is ever opened. Same local engine list the dialog reads — on
  // failure the type-ahead simply has no pins.
  useEffect(() => {
    let cancelled = false;
    ragService
      .listPins()
      .then((pins) => {
        if (!cancelled && pins.length > 0) setPinList(pins);
      })
      .catch(() => {
        /* history-only suggestions */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Manual re-check from the dialog; changed pins also feed the banner. */
  async function recheckPinsNow() {
    if (pinsBusy) return;
    setPinsBusy(true);
    try {
      const { changed, pins } = await ragService.recheckPins();
      setPinList(pins);
      if (changed.length > 0) {
        setPinAlerts((prev) => {
          const ids = new Set(changed.map((c) => c.id));
          return [...changed, ...prev.filter((p) => !ids.has(p.id))].slice(0, 5);
        });
      }
    } catch {
      /* the list simply stays as-is */
    } finally {
      setPinsBusy(false);
    }
  }

  /** G5: refresh the "Lighthouse Briefing" note on demand and confirm inline. */
  async function refreshBriefingNoteNow() {
    if (pinsBusy) return;
    setPinsBusy(true);
    setBriefingSaved(null);
    try {
      const res = await ragService.refreshBriefingNote();
      setBriefingSaved(res.error ? `Couldn't save: ${res.error}` : "Saved to Lighthouse Notes");
    } catch {
      setBriefingSaved("Couldn't save the briefing note");
    } finally {
      setPinsBusy(false);
    }
  }

  /** Remove a pin from the dialog. */
  async function removePin(id: string) {
    try {
      await ragService.unpinAsk(id);
    } catch {
      /* idempotent — refresh below tells the truth */
    }
    setPinList((pins) => pins.filter((p) => p.id !== id));
    setPinAlerts((alerts) => alerts.filter((a) => a.id !== id));
  }

  /**
   * "Add to board" beside a pin confirmation (openspec: add-boards §4.1):
   * append a size-M card for the just-created pin to the current scope's
   * board; the outcome replaces the button inline.
   */
  async function addPinNoteToBoard(asstId: string) {
    const note = pinNotes[asstId];
    if (!note?.pinId || note.boardNote) return; // in flight or already added
    // The interim note replaces the button at once, so a double-click can't
    // race two appends past the board's duplicate check.
    setPinNotes((s) => ({ ...s, [asstId]: { ...s[asstId], boardNote: "Adding…" } }));
    const res = await addPinToCurrentBoard(note.pinId);
    setPinNotes((s) => ({
      ...s,
      [asstId]: { ...s[asstId], boardNote: res.note ?? `Couldn't add — ${res.error}` },
    }));
  }

  /** "Add to board" on a pins-dialog row; the outcome shows in the actions row. */
  async function addPinRowToBoard(pinId: string) {
    if (pinsBusy) return;
    setPinsBusy(true); // one add at a time — the row buttons disable meanwhile
    try {
      const res = await addPinToCurrentBoard(pinId);
      setPinBoardNote(res.note ?? `Couldn't add — ${res.error}`);
    } finally {
      setPinsBusy(false);
    }
  }

  /** §3 Synthesize: re-ask the SAME question scoped to an answer's own source
   *  files, so the response INTEGRATES all of them (>= 2 attachments routes
   *  through the multi-doc synthesis pipeline). One-shot — the composer's
   *  attachment pills are left untouched. */
  function synthesizeAcross(turnId: string, refs: RagReference[]) {
    const fileRefs = refs.filter((r) => r.kind !== "conversation");
    if (fileRefs.length < 2 || streaming) return;
    const msgs = useChatStore.getState().messages;
    const idx = msgs.findIndex((m) => m.id === turnId);
    let question = "";
    for (let i = idx - 1; i >= 0; i--) {
      if (msgs[i].role === "user") {
        question = msgs[i].content;
        break;
      }
    }
    if (!question) return;
    void sendQuestion(question, { attachmentsOverride: fileRefs.map((r) => ({ id: r.fileId })) });
  }

  /** Ask a pinned/changed question again — the fresh answer is the drill-down. */
  function askPinned(question: string, pinId?: string) {
    if (streaming) return;
    setPinsOpen(false);
    if (pinId) setPinAlerts((alerts) => alerts.filter((a) => a.id !== pinId));
    void sendQuestion(question);
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

  /** Open the Edit SQL dialog seeded with an analytics answer's own query. */
  function openSqlEditor(meta: AnalyticsMeta) {
    sqlRunSeq.current += 1; // invalidate any run from a previous dialog
    setSqlEdit(meta);
    // §1: seed the editor with the pretty-printed query so it opens readable;
    // it is AST-identical to meta.sql and re-parses on run, so what executes is
    // exactly what the user submits.
    setSqlDraft(formatSql(meta.sql));
    setSqlOutcome(null);
    setSqlRunning(false);
  }

  /** Close the dialog, orphaning (not adopting) any still-running query. */
  function closeSqlEditor() {
    sqlRunSeq.current += 1;
    setSqlEdit(null);
    setSqlRunning(false);
  }

  /**
   * Run the edited SQL through the guarded, model-free engine path — same
   * files as the original answer, single SELECT enforced engine-side. The
   * result (or the guard's reason) renders inside the dialog; the transcript
   * is never touched.
   */
  async function runSqlDraft() {
    const meta = sqlEdit;
    const sql = sqlDraft.trim();
    if (!meta || !sql || sqlRunning) return;
    const seq = ++sqlRunSeq.current;
    setSqlRunning(true);
    setSqlOutcome(null);
    try {
      const res = await ragService.analyticsSql(sql, meta.fileIds);
      if (seq !== sqlRunSeq.current) return; // dialog closed/reopened meanwhile
      if (res.error) {
        setSqlOutcome({ error: res.error });
      } else {
        // Compose the same shape a chat analytics answer has: table, then the
        // chart fence when chartable, then the provenance footer.
        const parts = [res.markdown ?? ""];
        if (res.chart) parts.push("```lighthouse-chart\n" + res.chart + "\n```");
        if (res.footer) parts.push(res.footer);
        setSqlOutcome({ content: parts.filter(Boolean).join("\n\n") });
      }
    } catch (err) {
      if (seq !== sqlRunSeq.current) return;
      setSqlOutcome({
        error: err instanceof Error ? err.message : "the query could not be run",
      });
    } finally {
      if (seq === sqlRunSeq.current) setSqlRunning(false);
    }
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

  /** Begin editing a past question in place (pencil affordance). */
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
  /**
   * Regenerate an answer: drop the question+answer pair (and after) and re-ask
   * LIVE. Always bypasses the answer cache — regenerating into an identical
   * cached replay would be a no-op — and the fresh completion refreshes the
   * entry. The "Re-run" affordance on a cached answer is this same path.
   */
  function regenerate(asstId: string) {
    if (streaming) return;
    const msgs = useChatStore.getState().messages;
    const idx = msgs.findIndex((m) => m.id === asstId);
    const prev = idx > 0 ? msgs[idx - 1] : undefined;
    if (!prev || prev.role !== "user") return;
    setMessages((m) => m.slice(0, idx - 1));
    void sendQuestion(prev.content, { bypassCache: true });
  }

  /** Record a 👍/👎 on an answer (a quality signal); clicking again clears it. */
  function rateAnswer(id: string, rating: "up" | "down") {
    setRatings((r) => {
      const next = { ...r };
      if (next[id] === rating) delete next[id];
      else next[id] = rating;
      return next;
    });
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

  // Citation → preview (time-savers feature 4): open the file inspector ON the
  // cited chunk. References carry no chunk id — the inspector's file-scoped
  // test-search relocates the chunk from the citation's snippet (or, when the
  // snippet has nothing scorable, the turn's question). Stable identity so the
  // hoisted, memoized <References> keeps a stable onPreview.
  const openPreview = useCallback((turnId: string, r: RagReference) => {
    // The user question that produced this turn — the fallback locator query.
    const msgs = useChatStore.getState().messages;
    const idx = msgs.findIndex((x) => x.id === turnId);
    const prev = idx > 0 ? msgs[idx - 1] : undefined;
    const question = prev?.role === "user" ? prev.content : "";
    requestFileInspect({
      fileId: r.fileId,
      name: r.name,
      query: citationQuery(r.snippet, question),
    });
  }, []);

  // Clicking a [n] chip scrolls that turn's nth reference card into view,
  // flashes it briefly so the eye lands on the right card — and opens the
  // in-app preview on the passage that citation drew on.
  const handleCitationClick = useCallback(
    (turnId: string, n: number) => {
      const card = document.getElementById(citeCardId(turnId, n));
      if (card) {
        // fp3 §2: instant on touch — a smooth citation jump fights the browser's
        // own scroll during an iOS pinch/zoom and lands in the wrong place; a
        // coarse pointer takes the deterministic jump. Mouse keeps the glide.
        card.scrollIntoView({ behavior: coarsePointer ? "auto" : "smooth", block: "nearest" });
        setFlashCite(`${turnId}:${n}`);
        if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
        flashTimer.current = window.setTimeout(() => setFlashCite(null), 1200);
      }
      // Marker without a matching reference (e.g. the SQL editor's transient
      // answers) — nothing to preview.
      const ref = useChatStore.getState().messages.find((x) => x.id === turnId)?.references?.[n - 1];
      if (ref) openPreview(turnId, ref);
    },
    [openPreview, coarsePointer],
  );

  // Open a cited file in its native app (desktop only; the route no-ops on web).
  // Now the SECONDARY action — the card body opens the in-app preview instead.
  // useCallback so the hoisted, memoized <References> keeps a stable onOpen and
  // its cards don't re-render as the panel does.
  const openFile = useCallback(async (fileId: string) => {
    await fetch("/api/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId: fileId }),
    }).catch(() => {});
  }, []);

  // §3: a STABLE identity for the memoized <References>' Synthesize handler, so
  // the chips don't re-render per streamed token; it always calls the latest
  // synthesizeAcross closure (which reads live state and sendQuestion).
  const synthesizeRef = useRef(synthesizeAcross);
  synthesizeRef.current = synthesizeAcross;
  const onSynthesizeStable = useCallback(
    (t: string, refs: RagReference[]) => synthesizeRef.current(t, refs),
    [],
  );

  // --- Ask type-ahead (time-savers): local autocomplete over past asks. ---
  // Every past user ask, stamped with its conversation's updatedAt (messages
  // carry no per-turn clock). The live transcript stands in for the current
  // conversation — its copy in `conversations` lags until persist(). With
  // "save chats" off the store only holds this session anyway, so history-off
  // = session asks by construction. Zero network: it all ranks in memory.
  const askHistoryItems = useMemo<AskHistoryItem[]>(() => {
    const items: AskHistoryItem[] = [];
    const currentTs = conversations.find((c) => c.id === currentId)?.updatedAt ?? 0;
    for (const c of conversations) {
      if (c.id === currentId) continue;
      for (const m of c.messages) {
        if (m.role === "user" && m.content.trim()) items.push({ text: m.content, ts: c.updatedAt });
      }
    }
    for (const m of messages) {
      if (m.role === "user" && m.content.trim()) items.push({ text: m.content, ts: currentTs });
    }
    return items;
  }, [conversations, currentId, messages]);
  const pinQuestions = useMemo(() => pinList.map((p) => p.question), [pinList]);
  const askSuggests = useMemo(
    () => askSuggestions(question, { history: askHistoryItems, pins: pinQuestions }),
    [question, askHistoryItems, pinQuestions],
  );
  // @-mention matches (openspec §2): rank the vault with the SAME matcher
  // quick-open uses, then keep only attachable FILES not already attached. Path
  // ranking needs the whole tree, so match over all nodes and filter the results
  // (never the input). Linked/external files match too — the kind==="file" rule,
  // not the `external` flag.
  const attachedIds = useMemo(() => new Set(attachments.map((a) => a.id)), [attachments]);
  const mentionMatches = useMemo(() => {
    if (!mention) return [];
    return quickOpenMatches(mention.query, nodes, { limit: 24 })
      .filter((c) => c.kind === "file" && !attachedIds.has(c.id))
      .slice(0, 8);
  }, [mention, nodes, attachedIds]);
  const mentionKey = mention ? `${mention.start} ${mention.query}` : null;
  const mentionShown =
    mention !== null && mentionMatches.length > 0 && mentionKey !== mentionDismissed;
  const mentionSelClamped =
    mentionMatches.length > 0 ? Math.min(Math.max(mentionSel, 0), mentionMatches.length - 1) : 0;
  // The mention picker owns the popover slot while it's up — suppress the ask
  // type-ahead so only one listbox ever shows.
  const suggestsShown = suggestOpen && askSuggests.length > 0 && !mentionShown;
  // Clamp the highlight when the list shrinks under it (a turn settling can
  // re-rank mid-hover): out of range reads as "nothing highlighted".
  const suggestSel = suggestIndex < askSuggests.length ? suggestIndex : -1;
  // Shell-style ↑-recall target: this conversation's last ask (index as the
  // tiebreak clock — later turn wins), else the most recent ask anywhere.
  const lastAskText = useMemo(() => {
    const session = messages
      .filter((m) => m.role === "user")
      .map((m, i) => ({ text: m.content, ts: i }));
    return lastAsk({ history: session }) ?? lastAsk({ history: askHistoryItems });
  }, [messages, askHistoryItems]);

  // --- §22.3: validated, PRELOADED suggestion chips (asks + recipes) — the
  // one shared hook (also RecipesNav's source, same module cache). It re-keys
  // on the included set, provider, investigation, and the views nonce, so a
  // posture flip can never serve another posture's chips. The hero keeps its
  // old visual caps (4 asks, 3 recipes) at the consumption site. ---
  const validatedChips = useValidatedChips(includedFileIds);
  const engineAsks = useMemo(() => validatedChips.asks.slice(0, 4), [validatedChips.asks]);
  // 0.13.10 §3: chips are the ONLY recipe surface now (RecipesNav, the
  // uncapped path, is retired) — every applicable recipe gets its chip.
  const recipeChips = validatedChips.recipes;

  // --- §22.1 ghost autocomplete: the single best inline continuation of the
  //     draft, greyed after the caret; Right Arrow at the end accepts it. ---
  // Completion-only extras: the engine's validated suggested asks (ALL of
  // them, not just the hero's four) feed the GHOST, never the dropdown
  // (whose rows stay history/pin labeled).
  const ghostExtras = useMemo(
    () => validatedChips.asks.map((a) => a.question),
    [validatedChips.asks],
  );
  // ~120ms debounced draft: the ghost re-ranks only after a typing pause (and
  // hides while draft ≠ debounced), so it never flickers per keystroke.
  const [ghostDraft, setGhostDraft] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setGhostDraft(question), GHOST_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [question]);
  // Esc parks the ghost for exactly this draft; any edit revives it.
  const [ghostDismissed, setGhostDismissed] = useState<string | null>(null);
  // IME composition suppresses the ghost — a half-composed draft must not
  // grow a tail. Tracked from the textarea's own composition events.
  const [composing, setComposing] = useState(false);
  const ghostSuggested = useMemo(
    () =>
      ghostCompletion(ghostDraft, {
        history: askHistoryItems,
        pins: pinQuestions,
        extras: ghostExtras,
      }),
    [ghostDraft, askHistoryItems, pinQuestions, ghostExtras],
  );
  // Visible only when nothing else owns the slot: the @-mention picker and the
  // type-ahead popover win (their key claims would fight the arrow), IME
  // composition hides it, and the ranker itself gates GHOST_MIN_CHARS.
  const ghostText =
    ghostSuggested !== null &&
    ghostDraft === question &&
    !mentionShown &&
    !suggestsShown &&
    !composing &&
    ghostDismissed !== question
      ? ghostSuggested
      : null;

  function handleComposerKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // @-mention picker owns the keys while it's up — a mention resolves to an
    // attachment before the ask type-ahead or send ever see the key. Enter/Tab
    // accept the highlighted file; Esc dismisses (the draft `@…` is untouched).
    if (mentionShown) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionSel((mentionSelClamped + 1) % mentionMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionSel(mentionSelClamped <= 0 ? mentionMatches.length - 1 : mentionSelClamped - 1);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionDismissed(mentionKey); // stays closed until the token changes
        return;
      }
      if (
        (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) ||
        (e.key === "Tab" && !e.shiftKey)
      ) {
        e.preventDefault();
        acceptMention(mentionMatches[mentionSelClamped]);
        return;
      }
    }
    // Type-ahead first: while the popover is open it owns Down/Up/Esc — and
    // Enter/Tab only when a row is highlighted (suggestSel >= 0), so a plain
    // Enter still sends and Shift+Enter still makes a newline.
    if (suggestsShown) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSuggestIndex((suggestSel + 1) % askSuggests.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSuggestIndex(suggestSel <= 0 ? askSuggests.length - 1 : suggestSel - 1);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSuggestOpen(false); // dismiss only — the draft is untouched
        return;
      }
      if (e.key === "Tab" && !e.shiftKey) {
        // Shell-style completion: Tab takes the highlighted row (or the top one).
        e.preventDefault();
        acceptSuggestion(askSuggests[Math.max(suggestSel, 0)].text);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && suggestSel >= 0) {
        e.preventDefault();
        acceptSuggestion(askSuggests[suggestSel].text);
        return;
      }
    }
    // §22.1 ghost: Right Arrow ACCEPTS the inline continuation — but only from
    // a collapsed caret at the very END of the draft, so → anywhere else keeps
    // moving the caret and a text selection collapses normally. The pickers
    // above keep their precedence for free: while either is open there IS no
    // ghost (ghostText gates on mentionShown/suggestsShown), and Tab is left
    // entirely to the type-ahead above.
    if (e.key === "ArrowRight" && ghostText !== null) {
      const el = e.currentTarget;
      if (el.selectionStart === el.selectionEnd && el.selectionEnd === el.value.length) {
        e.preventDefault();
        applySuggestion(question + ghostText);
        return;
      }
    }
    // Esc with a ghost showing parks it for THIS draft (any edit revives it).
    // Reachable only when no picker is open — each picker claims Esc first.
    if (e.key === "Escape" && ghostText !== null) {
      e.preventDefault();
      setGhostDismissed(question);
      return;
    }
    // Enter sends; Shift+Enter inserts a newline. `isComposing` guards IME
    // composition (e.g. Japanese input), where Enter commits the composition
    // rather than the message.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      ask();
      return;
    }
    // ArrowUp on an EMPTY composer recalls your last ask into the box,
    // shell-style — edit or resend without retyping (the pencil on a past turn
    // still edits in place). A fill, not a search: the popover stays closed.
    if (e.key === "ArrowUp" && !question && lastAskText) {
      e.preventDefault();
      applySuggestion(lastAskText);
    }
  }

  /** Accept a type-ahead row: fill the composer (never auto-send) and close. */
  function acceptSuggestion(text: string) {
    applySuggestion(text);
    setSuggestOpen(false);
    setSuggestIndex(-1);
  }

  /** Recompute the active @-mention span from the LIVE textarea (value + caret),
   *  not React state — so it's correct mid-keystroke. */
  function refreshMention() {
    const el = composerRef.current;
    setMention(el ? activeMention(el.value, el.selectionStart ?? el.value.length) : null);
  }

  /** Accept a mention row: attach the file and strip its `@fragment` from the
   *  draft, leaving the caret where the token was (openspec §2). */
  function acceptMention(candidate: { id: string; name: string }) {
    addAttachments([{ id: candidate.id, name: candidate.name }]);
    const el = composerRef.current;
    const text = el ? el.value : question;
    if (mention) {
      const { text: next, caret } = replaceMention(text, mention);
      setQuestion(next);
      requestAnimationFrame(() => {
        const e2 = composerRef.current;
        if (!e2) return;
        e2.focus();
        e2.setSelectionRange(caret, caret);
      });
    }
    setMention(null);
    setMentionSel(0);
    setMentionDismissed(null);
  }

  /** Fill the composer with a suggested prompt (never auto-send), focus it,
   *  and land the caret at the end so typing continues the fill. */
  function applySuggestion(fill: string) {
    setQuestion(fill);
    requestAnimationFrame(() => {
      const el = composerRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }

  // The empty-state suggestion chips (engine asks + applicable recipes) come
  // from useValidatedChips above (§22.3) — preloaded, validated per posture,
  // and shared with RecipesNav; the two per-surface fetch effects that lived
  // here are gone. openspec: add-vault-meta-answers / add-recipes §3.1.

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

  // Cross-conversation recall (openspec: add-conversation-recall): prior
  // exchanges from OTHER chats relevant to the current draft, surfaced passively
  // (tap to reopen — nothing is injected into the ask). Gated on history
  // persistence: with nothing stored, there is nothing to recall, so this is
  // empty whenever "save chats on this device" is off.
  const recalled = useMemo<RecallHit[]>(() => {
    if (!historyPersistEnabled) return [];
    return recallRelated(question, conversations, { currentId });
  }, [historyPersistEnabled, question, conversations, currentId]);

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

  // §22.2: the header's separate diagnostics (visible-files badge, On-device
  // badge, hidden-from-cloud button) collapsed into the EgressShield's status
  // popover — ONE quiet chip in both header paths. The shield receives the
  // same data those surfaces read; the ENGINE still enforces the local-only
  // policy at the model-config chokepoint — the popover only tells the truth.
  const revealHiddenFromCloud = useCallback(() => {
    // The click hands off to the explorer via the filter event; the detail-less
    // reveal-node ping rides along so a collapsed sidebar opens (AppShell
    // listens by event NAME alone, and the explorer's reveal handler ignores a
    // dispatch without an id).
    window.dispatchEvent(new CustomEvent("lighthouse:filter-local-only"));
    window.dispatchEvent(new CustomEvent("lighthouse:reveal-node"));
  }, []);
  const statusShield = (
    <EgressShield
      visibleCount={includedFileIds.length}
      hiddenFromCloud={cloudActive ? hiddenFromCloud : 0}
      onRevealHidden={revealHiddenFromCloud}
      onDeviceLocalOnly={investigationLocalOnly}
    />
  );

  // 0.13.10 §2: the History entry — one clock button in the header (hero and
  // conversation alike). Compact opens the full-screen Sheet below; desktop
  // anchors the same HistoryNav in a popover.
  const historyButton = compactLayout ? (
    <Tooltip content="Chat history" relationship="label">
      <Button
        appearance="subtle"
        icon={<IconHistory />}
        aria-label="Chat history"
        onClick={() => setHistoryOpen(true)}
      />
    </Tooltip>
  ) : (
    <Popover open={historyOpen} onOpenChange={(_, d) => setHistoryOpen(d.open)} positioning="below-end">
      <PopoverTrigger disableButtonEnhancement>
        <Button
          appearance="subtle"
          icon={<IconHistory />}
          aria-label="Chat history"
          title="Chat history"
        />
      </PopoverTrigger>
      <PopoverSurface className={styles.historySurface}>
        <HistoryNav onClose={() => setHistoryOpen(false)} />
      </PopoverSurface>
    </Popover>
  );
  const historySheet =
    compactLayout && historyOpen ? (
      <Sheet title="History" onClose={() => setHistoryOpen(false)}>
        <HistoryNav onClose={() => setHistoryOpen(false)} />
      </Sheet>
    ) : null;
  const investigationsSheet =
    compactLayout && invOpen ? (
      <Sheet title="Investigations" onClose={() => setInvOpen(false)} initialDetent="medium">
        <InvestigationsNav />
      </Sheet>
    ) : null;

  // Scope pill (openspec: add-investigations §4.2), the attachBar register: a
  // quiet reminder that asks here read only the investigation's files. Hidden
  // for an empty scope (= the whole vault — nothing narrower to disclose).
  // Per-ask attachments still override scope; their own bar says so beneath.
  const scopePill =
    currentInvestigation && scopeCount !== null ? (
      <div className={styles.attachBar}>
        <Text size={200} className={styles.attachHint}>
          <IconFilter fontSize={14} />
          {scopeLabel} · {currentInvestigation.name}
        </Text>
      </div>
    ) : null;

  const attachmentBar =
    attachments.length > 0 ? (
      <div className={styles.attachBar}>
        <Text size={200} className={styles.attachHint}>
          <IconAttach fontSize={14} />
          Asking about:
        </Text>
        {attachments.map((a) => (
          <span key={a.id} className={styles.attachChip}>
            <IconDoc fontSize={14} />
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
              <IconClose fontSize={12} />
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
          <Button appearance="subtle" icon={<IconAttach />} aria-label="Attach files" />
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
                <IconDoc fontSize={16} />
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
          icon={<IconDocAdd />}
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
          <IconUndo fontSize={16} />
          <Text size={200}>Started a new chat — the previous one is saved in your history.</Text>
          <span style={{ flex: 1 }} />
          <Button size="small" appearance="primary" onClick={undoNewChat}>
            Undo
          </Button>
          <Button
            size="small"
            appearance="subtle"
            icon={<IconClose />}
            aria-label="Dismiss"
            onClick={() => {
              if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
              setShowUndo(false);
            }}
          />
        </div>
      )}
      {exportNote && (
        <div className={styles.undoBar}>
          {exportNote.error ? (
            <>
              <IconError fontSize={16} />
              <Text size={200}>Couldn&apos;t save the note — {exportNote.error}</Text>
            </>
          ) : (
            <>
              <IconCheck fontSize={16} />
              <Text size={200}>Saved “{exportNote.name}” to Lighthouse Notes in your vault.</Text>
            </>
          )}
          <span style={{ flex: 1 }} />
          {!exportNote.error && desktop && (
            <Button
              size="small"
              appearance="primary"
              onClick={() => revealSaved(exportNote.id ?? "")}
            >
              Reveal
            </Button>
          )}
          <Button
            size="small"
            appearance="subtle"
            icon={<IconClose />}
            aria-label="Dismiss"
            onClick={() => {
              if (exportNoteTimer.current !== null) window.clearTimeout(exportNoteTimer.current);
              setExportNote(null);
            }}
          />
        </div>
      )}
      {providerNote && (
        <div className={styles.undoBar} role="status">
          {providerNote.ok ? (
            <IconCheck fontSize={16} />
          ) : (
            <IconError fontSize={16} />
          )}
          <Text size={200}>{providerNote.text}</Text>
          <span style={{ flex: 1 }} />
          <Button
            size="small"
            appearance="subtle"
            icon={<IconClose />}
            aria-label="Dismiss"
            onClick={() => {
              if (providerNoteTimer.current !== null)
                window.clearTimeout(providerNoteTimer.current);
              setProviderNote(null);
            }}
          />
        </div>
      )}
      {addNotice && (
        <div className={styles.addNotice}>
          <Text size={200}>{addNotice}</Text>
          <span style={{ flex: 1 }} />
          <Button
            icon={<IconClose />}
            size="small"
            appearance="subtle"
            aria-label="Dismiss"
            onClick={() => setAddNotice(null)}
          />
        </div>
      )}
      {recalled.length > 0 && (
        <div className={styles.recallBar} role="group" aria-label="Related earlier chats">
          <Text size={200} className={styles.recallLabel}>
            From earlier chats:
          </Text>
          {recalled.map((h) => (
            <Tooltip
              key={h.conversationId}
              content={`In "${h.conversationTitle}" — tap to reopen`}
              relationship="description"
            >
              <Button
                size="small"
                appearance="subtle"
                shape="circular"
                className={styles.recallChip}
                onClick={() => openConversation(h.conversationId)}
              >
                {h.question.length > 52 ? `${h.question.slice(0, 51)}…` : h.question}
              </Button>
            </Tooltip>
          ))}
        </div>
      )}
      {scopePill}
      {attachmentBar}
      <div className={styles.composerWrap}>
        {mentionShown && (
          <div
            role="listbox"
            id="mention-listbox"
            aria-label="Attach a file"
            className={styles.askSuggestPop}
          >
            {mentionMatches.map((m, i) => (
              <div
                key={m.id}
                id={`mention-opt-${i}`}
                role="option"
                aria-selected={i === mentionSelClamped}
                title={m.dir ? `${m.name} — ${m.dir}` : m.name}
                className={mergeClasses(
                  styles.askSuggestItem,
                  i === mentionSelClamped && styles.askSuggestItemActive,
                )}
                // Keep the caret in the composer through the click (mirrors the
                // ask type-ahead) so accepting doesn't blur-close the picker.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => acceptMention(m)}
              >
                <IconDoc fontSize={14} className={styles.askSuggestIcon} />
                <span className={styles.askSuggestText}>
                  {emphasize(m.name, m.nameHits, styles.mentionHit)}
                </span>
                {m.dir && <span className={styles.mentionDir}>{m.dir}</span>}
              </div>
            ))}
          </div>
        )}
        {suggestsShown && (
          <div
            role="listbox"
            id="ask-typeahead-listbox"
            aria-label="Suggestions from your past questions"
            className={styles.askSuggestPop}
          >
            {askSuggests.map((s, i) => (
              <div
                key={`${s.source}:${s.text}`}
                id={`ask-suggest-${i}`}
                role="option"
                aria-selected={i === suggestSel}
                title={s.source === "pin" ? "Pinned question" : "You asked this before"}
                className={mergeClasses(
                  styles.askSuggestItem,
                  i === suggestSel && styles.askSuggestItemActive,
                )}
                // The highlight is KEYBOARD-driven only (hover keeps its CSS
                // affordance): a mouse resting over the popover must never
                // flip Enter from "send" to "accept".
                // Keep keyboard focus in the composer while clicking rows.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => acceptSuggestion(s.text)}
              >
                {s.source === "pin" ? (
                  <IconPin fontSize={14} className={styles.askSuggestIcon} />
                ) : (
                  <IconHistory fontSize={14} className={styles.askSuggestIcon} />
                )}
                <span className={styles.askSuggestText}>{s.text}</span>
              </div>
            ))}
          </div>
        )}
        <div className={styles.composer} data-tour="chat">
          {attachButton}
          <div className={styles.ghostWrap}>
            {/* §22.1: the ghost mirror sits BEHIND the transparent textarea
                (the field's own relative root paints over it), repeating the
                typed draft invisibly so the grey suffix lands exactly after
                the caret, line wraps included. aria-hidden + pointer-events
                none: it is pure paint — keys, clicks, and AT all see only the
                textarea. */}
            {ghostText !== null && (
              <div aria-hidden="true" className={styles.ghostMirror}>
                <span className={styles.ghostTyped}>{question}</span>
                <span className={styles.ghostSuffix}>{ghostText}</span>
              </div>
            )}
            <Textarea
              ref={composerRef}
              className={styles.composerField}
              resize="none"
              rows={1}
              value={question}
              placeholder={attachments.length > 0 ? "Ask about the attached files…" : placeholder}
              aria-activedescendant={
                mentionShown
                  ? `mention-opt-${mentionSelClamped}`
                  : suggestsShown && suggestSel >= 0
                    ? `ask-suggest-${suggestSel}`
                    : undefined
              }
              onChange={(_, d) => {
                setQuestion(d.value);
                // Typing (re)filters and reopens; the highlight restarts unset so
                // Enter keeps sending until the user arrows into the list.
                setSuggestIndex(-1);
                setSuggestOpen(d.value.trim().length > 0);
                // Re-detect the @-mention token once the value settles; typing
                // resets its highlight to the top row (so Enter picks it).
                setMentionSel(0);
                requestAnimationFrame(refreshMention);
              }}
              onSelect={refreshMention}
              // §22.1: no ghost while an IME composition is in flight.
              onCompositionStart={() => setComposing(true)}
              onCompositionEnd={() => setComposing(false)}
              onBlur={() => {
                setSuggestOpen(false);
                // Close the picker after a row click can land — rows keep focus via
                // onMouseDown preventDefault, so a real blur means "left the field".
                requestAnimationFrame(() => setMention(null));
              }}
              onKeyDown={handleComposerKeyDown}
            />
          </div>
          {streaming ? (
            <Button appearance="secondary" icon={<IconStop />} onClick={stopStreaming}>
              Stop
            </Button>
          ) : (
            <Button appearance="primary" icon={<IconSend />} onClick={() => ask()}>
              Ask
            </Button>
          )}
        </div>
      </div>
      <div className={styles.composerMeta}>
        {/* fp2 §3: keyboard-shortcut lines are desktop copy (the fp1 §2 rule —
            the tour was gated, this line was missed). On a mobile shell the
            labeled Ask button IS the affordance; dropping the line also
            reclaims two wrapped rows under the phone composer. The provenance
            line below stays on every platform — that one is the privacy truth. */}
        {platformKind() === "desktop" && (
          <Text size={200} className={styles.metaLine}>
            Enter to send · Shift+Enter for a new line
            {lastAskText ? " · ↑ to recall your last question" : ""}
            {ghostText !== null ? " · → to complete" : ""}
          </Text>
        )}
        {/* fp3 §2: on a coarse pointer, the ghost completion is tappable (there
            is no → key). The ghost itself is never platform-gated — only this
            touch fallback is; a hardware keyboard (iPad) keeps using →. */}
        {coarsePointer && ghostText !== null && (
          <button
            type="button"
            className={styles.ghostAcceptTouch}
            onClick={() => applySuggestion(question + ghostText)}
          >
            <IconCheck fontSize={14} />
            <span>Complete:</span>
            <span className={styles.ghostAcceptText}>{ghostText.trim()}</span>
          </button>
        )}
        <Text size={200} className={styles.metaLine} data-tour="models">
          {provenance}
        </Text>
      </div>
    </div>
  );

  // Changed-pins alert: one dismissible banner; each entry re-asks on click
  // (the fresh narrated answer IS the drill-down). Rendered in both the hero
  // and the conversation views — alerts land whenever the vault changes.
  const pinAlertBanner =
    pinAlerts.length > 0 ? (
      <div className={styles.pinBanner} role="status">
        <IconPin fontSize={16} />
        <Text size={200} weight="semibold">
          {pinAlerts.length === 1 ? "A pinned answer changed:" : "Pinned answers changed:"}
        </Text>
        {pinAlerts.map((a) => {
          // When the engine's before/after summaries are cleanly numeric, embed
          // a tiny before→after chart from those verified numbers; otherwise the
          // tooltip carries the change as text (pinChartData fails closed).
          const mini = pinChartData(a.before, a.after);
          return (
            <div key={a.id} className={styles.pinAlertItem}>
              <Tooltip
                content={a.before ? `was: ${a.before} → now: ${a.after}` : `now: ${a.after}`}
                relationship="description"
              >
                <Button
                  size="small"
                  appearance="secondary"
                  shape="circular"
                  disabled={streaming}
                  onClick={() => askPinned(a.question, a.id)}
                >
                  {a.question.length > 48 ? `${a.question.slice(0, 47)}…` : a.question}
                </Button>
              </Tooltip>
              {mini && <PinMiniChart data={mini} />}
            </div>
          );
        })}
        <span style={{ flex: 1 }} />
        <Button
          size="small"
          appearance="subtle"
          icon={<IconClose />}
          aria-label="Dismiss pin alerts"
          onClick={() => setPinAlerts([])}
        />
      </div>
    ) : null;

  // Pins dialog (opened from the settings gear or a pin confirmation): list,
  // manual re-check, remove; stale pins show the engine's reason.
  const pinsDialog = (
    <Dialog
      open={pinsOpen}
      onOpenChange={(_, data) => {
        if (!data.open) setPinsOpen(false);
      }}
    >
      <LhDialogSurface className={styles.pinDialogSurface}>
        <DialogBody>
          <DialogTitle>Pinned questions</DialogTitle>
          <DialogContent className={styles.sqlDialogContent}>
            <Text size={200} className={styles.quietNote}>
              Lighthouse re-runs each pin&apos;s saved query when the files it reads change —
              no AI involved — and flags the ones whose numbers moved.
            </Text>
            {pinList.length === 0 ? (
              <Text size={300}>
                No pins yet. Ask a data question, then choose <b>Pin</b> under the answer.
              </Text>
            ) : (
              <div className={styles.pinList}>
                {pinList.map((p) => (
                  <div key={p.id} className={styles.pinRow}>
                    <IconPin fontSize={16} />
                    <div className={styles.pinRowMain}>
                      <Text size={300} weight="semibold">
                        {p.question}
                      </Text>
                      {p.staleReason ? (
                        <Text size={200} className={styles.pinStale}>
                          stale: {p.staleReason}
                        </Text>
                      ) : (
                        <Text size={200} className={styles.pinMeta}>
                          {p.lastSummary ?? "not checked yet"}
                        </Text>
                      )}
                      <Text size={200} className={styles.pinMeta}>
                        {p.fileIds.length} file{p.fileIds.length === 1 ? "" : "s"} watched
                        {p.lastRunMs
                          ? ` · checked ${formatRelativeTime(p.lastRunMs)}`
                          : ""}
                      </Text>
                    </div>
                    <Button
                      size="small"
                      appearance="secondary"
                      disabled={streaming}
                      onClick={() => askPinned(p.question)}
                    >
                      Ask again
                    </Button>
                    {/* Every listed pin can become a board card (add-boards). */}
                    <Tooltip content="Add to board" relationship="label">
                      <Button
                        size="small"
                        appearance="subtle"
                        icon={<IconBoard />}
                        aria-label={`Add to board: ${p.question}`}
                        disabled={pinsBusy}
                        onClick={() => void addPinRowToBoard(p.id)}
                      />
                    </Tooltip>
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<IconTrash />}
                      aria-label={`Remove pin: ${p.question}`}
                      disabled={pinsBusy}
                      onClick={() => void removePin(p.id)}
                    />
                  </div>
                ))}
              </div>
            )}
            <Divider />
            <Text weight="semibold">Briefings</Text>
            <BriefingsPanel pins={pinList} />
          </DialogContent>
          <DialogActions>
            {pinBoardNote && (
              <Text size={200} className={styles.quietNote} role="status">
                {pinBoardNote}
              </Text>
            )}
            {briefingSaved && (
              <Text size={200} className={styles.quietNote}>
                {briefingSaved}
              </Text>
            )}
            <Button appearance="secondary" onClick={() => setPinsOpen(false)}>
              Close
            </Button>
            <Button
              appearance="secondary"
              disabled={pinsBusy || pinList.length === 0}
              onClick={() => void refreshBriefingNoteNow()}
            >
              Refresh briefing note
            </Button>
            <Button
              appearance="primary"
              disabled={pinsBusy || pinList.length === 0}
              onClick={() => void recheckPinsNow()}
            >
              {pinsBusy ? "Checking…" : "Re-check now"}
            </Button>
          </DialogActions>
        </DialogBody>
      </LhDialogSurface>
    </Dialog>
  );

  // Before the first question, center the prompt in the rail (Google-style).
  if (messages.length === 0 && !streaming) {
    return (
      <section
        data-lh-pane="chat"
        className={mergeClasses(styles.panel, dropping ? styles.panelDropping : undefined)}
        {...dropHandlers}
      >
        {pinsDialog}
        {pinAlertBanner}
        <div className={styles.hero}>
          <span className={styles.beacon} />
          <Title3 data-tour="beam">
            {currentInvestigation ? currentInvestigation.name : "Ask Lighthouse"}
          </Title3>
          {/* Hero context line (openspec: add-investigations §4.2): name is the
              title above; this row carries the scope size. */}
          {currentInvestigation && (
            <div className={styles.heroInvRow}>
              <Text size={200}>{scopeLabel}</Text>
            </div>
          )}
          <Text className={styles.heroHint}>
            Answers use only the files visible to AI. Drop a file from the explorer
            here to ask about that file alone.
          </Text>
          {/* §22.2: the one status popover (visible-files count, on-device
              policy, hidden-from-cloud, egress) — OUTSIDE the visible-files
              branch so the on-device promise never disappears with it when no
              files are visible yet. 0.13.10 §2: past chats open from the
              History button here too — an empty screen must still reach them. */}
          <div className={styles.heroInvRow}>
            {statusShield}
            {historyButton}
            {compactLayout ? (
              <Button
                appearance="subtle"
                size="small"
                icon={<IconChevronDown />}
                onClick={() => setInvOpen(true)}
              >
                Investigations
              </Button>
            ) : (
              <Popover open={invOpen} onOpenChange={(_, d) => setInvOpen(d.open)} positioning="below-start">
                <PopoverTrigger disableButtonEnhancement>
                  <Button appearance="subtle" size="small" icon={<IconChevronDown />}>
                    Investigations
                  </Button>
                </PopoverTrigger>
                <PopoverSurface className={styles.invSurface}>
                  <InvestigationsNav />
                </PopoverSurface>
              </Popover>
            )}
          </div>
          {includedFileIds.length === 0 && attachments.length === 0 ? (
            // Pre-flight: nothing is visible to AI yet. Inform gently and offer
            // the fix, but never block asking.
            <div className={styles.noFilesCard}>
              <IconWarning fontSize={20} />
              <Text size={300}>
                The AI can&apos;t see any files yet. Answers will be generic until you add
                files and make them visible.
              </Text>
              <Button
                appearance="primary"
                icon={<IconDocAdd />}
                onClick={() => window.dispatchEvent(new CustomEvent("lighthouse:browse-files"))}
              >
                Add files
              </Button>
            </div>
          ) : (
            <div className={styles.suggestRow}>
              {engineAsks.length > 0
                ? // Catalog-derived asks submit immediately — every one is a
                  // real, answerable question about a real included file.
                  engineAsks.map((s) => (
                    <Button
                      key={s.label}
                      appearance="secondary"
                      size="small"
                      shape="circular"
                      onClick={() => void sendQuestion(s.question)}
                    >
                      {s.label}
                    </Button>
                  ))
                : suggestions.map((s) => (
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
              {/* Applicable-recipe chips (openspec: add-recipes §3.1), beside
                  the suggested asks and styled identically. Each submits its
                  recipe-cued question immediately — the engine plans it
                  model-free before the model gate. */}
              {recipeChips.map((r) => (
                <Button
                  key={`recipe:${r.id}:${r.table}`}
                  appearance="secondary"
                  size="small"
                  shape="circular"
                  title={r.summary}
                  onClick={() => void sendQuestion(runRecipeQuestion(r.id, r.table))}
                >
                  {r.name}
                </Button>
              ))}
              {/* 0.13.10 §3: the Investigate → report-template launcher (the
                  retired "What you can do" section's one result-producing
                  control), data-gated on investigable tables like the recipe
                  chips beside it. */}
              <InvestigateChips includedFileIds={includedFileIds} />
            </div>
          )}
          <div className={styles.heroComposer}>{composer("Ask about the files visible to AI…")}</div>
        </div>
        {historySheet}
        {investigationsSheet}
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
      {pinsDialog}
      {historySheet}
      {investigationsSheet}
      <div className={styles.conversation}>
        {pinAlertBanner}
        <div className={styles.header}>
          {/* Compact context header (openspec: add-investigations §4.2): inside
              an investigation the Title3 is its name with the scope size as a
              quiet caption; the global context stays plain "Ask". */}
          {/* fp4 §3: the lone compact "open files and sections" button that used
              to live here is gone — the portrait bottom tab bar (AppShell) is the
              way into Files and Sections now. Desktop header is unchanged. */}
          <div className={styles.headerTitle}>
            {/* 0.13.10 §3: the title is the investigation PICKER — tap/click
                opens the operations surface (InvestigationsNav verbatim). */}
            {compactLayout ? (
              <button
                type="button"
                className={styles.invPickerBtn}
                aria-label="Investigations"
                onClick={() => setInvOpen(true)}
              >
                <Title3 className={styles.headerTitleName}>
                  {currentInvestigation ? currentInvestigation.name : "Ask"}
                </Title3>
                <IconChevronDown fontSize={16} aria-hidden />
              </button>
            ) : (
              <Popover open={invOpen} onOpenChange={(_, d) => setInvOpen(d.open)} positioning="below-start">
                <PopoverTrigger disableButtonEnhancement>
                  <button type="button" className={styles.invPickerBtn} aria-label="Investigations">
                    <Title3 className={styles.headerTitleName}>
                      {currentInvestigation ? currentInvestigation.name : "Ask"}
                    </Title3>
                    <IconChevronDown fontSize={16} aria-hidden />
                  </button>
                </PopoverTrigger>
                <PopoverSurface className={styles.invSurface}>
                  <InvestigationsNav />
                </PopoverSurface>
              </Popover>
            )}
            {currentInvestigation && (
              <Text size={200} className={styles.headerCaption}>
                {scopeLabel}
              </Text>
            )}
          </div>
          <div className={styles.headerMeta}>
            {/* Quick provider switch (time-savers): configured providers only;
                selection applies from the NEXT ask — provenance + local-only
                enforcement follow the active provider automatically. Inside a
                local-only investigation the switch is moot (the engine forces
                the private path), so it renders disabled with the reason. */}
            <ProviderSwitch
              onSwitched={noteProviderSwitch}
              disabledReason={
                investigationLocalOnly ? "This investigation always answers on-device" : undefined
              }
            />
            {/* §22.2: the ONE status popover — the egress shield's dialog now
                carries the visible-files count, the on-device policy line, and
                the hidden-from-cloud reveal (0.12.1 §2 — its click still flips
                the explorer's "Hidden from cloud" filter via the same events).
                History moved to the sidebar section; Save-to-note and New chat
                stay as the header's quiet actions. */}
            {statusShield}
            {historyButton}
            <Tooltip content="Save this chat as a note in your vault" relationship="label">
              <Button
                appearance="subtle"
                icon={<IconSave />}
                aria-label="Save chat to a vault note"
                disabled={streaming || exportBusy}
                onClick={() => void exportChatToNote()}
              />
            </Tooltip>
            <Button
              appearance="subtle"
              icon={<IconAdd />}
              disabled={streaming}
              onClick={newChat}
              title={`Start a fresh conversation (${modKey()}+N)`}
            >
              New chat
            </Button>
          </div>
        </div>

        <div className={styles.bodyWrap} data-tour="beam">
          <div
            className={styles.body}
            ref={bodyRef}
            onScroll={handleBodyScroll}
            onWheel={cancelHoldOnUserInput}
            onTouchMove={cancelHoldOnUserInput}
          >
            {messages.map((m) =>
              m.role === "user" ? (
                // Each new question opens a document section: hairline above
                // (except the very first), so Q&A pairs read as pages.
                <div key={m.id} className={mergeClasses(styles.turn, styles.turnBoundary)}>
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
                          icon={<IconSend />}
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
                              icon={<IconEdit />}
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
                // data-lh-turn: DOM anchor for the evidence-pack chart capture
                // (the handler serializes this turn's rendered chart SVG) and
                // for the read-from-the-top hold (the streaming answer's row
                // is looked up by id and its top held at the viewport top).
                <div key={m.id} className={styles.turn} data-lh-turn={m.id}>
                  {streaming && !m.content && m.id === lastId ? (
                    <LighthouseLoader
                      className={styles.loader}
                      dotClass={styles.loaderDot}
                      label={progressLabel}
                    />
                  ) : (
                    <>
                      {m.content && (
                        <div className={styles.answer}>
                          {streaming && m.id === lastId ? (
                            // §2: the live turn renders progressively — completed
                            // blocks as markdown, the growing block held to a safe
                            // prefix — then re-renders through AnswerMarkdown once
                            // it settles (byte-identical final).
                            <StreamingAnswer
                              content={m.content}
                              turnId={m.id}
                              onCite={handleCitationClick}
                            />
                          ) : (
                            <AnswerMarkdown
                              content={m.content}
                              turnId={m.id}
                              onCite={handleCitationClick}
                              metaChart={m.meta?.chart}
                              metaTable={m.meta?.table}
                              legacyFences={!liveTurnIds.current.has(m.id)}
                            />
                          )}
                          {streaming && m.id === lastId && <span className={styles.beaconInline} />}
                        </div>
                      )}
                      {/* Certified badge + trust verdict (openspec:
                          add-semantic-layer §6.2): rendered from the engine's
                          VERIFIED meta, a failed reconcile shown, never hidden. */}
                      {m.analytics && !m.error && !(streaming && m.id === lastId) && (
                        <TrustBadges meta={m.analytics} />
                      )}
                      {streaming && m.id === lastId && draftActive && (
                        <Text size={200} className={styles.draftBadge}>
                          Draft — verifying with the private model…
                        </Text>
                      )}
                      {m.stopped && (
                        <Text size={200} className={styles.quietNote}>
                          (stopped)
                        </Text>
                      )}
                      {m.error && (
                        <div className={styles.errorNotice}>
                          <IconError fontSize={16} />
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
                            icon={<IconSettings />}
                            onClick={() =>
                              window.dispatchEvent(new CustomEvent("lighthouse:open-ai-models"))
                            }
                          >
                            AI model settings
                          </Button>
                        </div>
                      )}
                      {/* Failed turns get no actions (Retry is the action). */}
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
                              icon={copiedId === m.id ? <IconCheck /> : <IconCopy />}
                              aria-label="Copy answer"
                              onClick={() => void copyAnswer(m.id, m.content)}
                            />
                          </Tooltip>
                          <Tooltip content="Regenerate answer" relationship="label">
                            <Button
                              className={styles.actionBtn}
                              appearance="subtle"
                              size="small"
                              icon={<IconRefresh />}
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
                              icon={<IconThumbUp />}
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
                              icon={<IconThumbDown />}
                              aria-label="Bad answer"
                              aria-pressed={ratings[m.id] === "down"}
                              onClick={() => rateAnswer(m.id, "down")}
                            />
                          </Tooltip>
                        </div>
                      )}
                      {/* Refinement chips: only under answers carrying analytics
                          metadata (i.e. the engine computed this via SQL). */}
                      {m.analytics && !m.error && !(streaming && m.id === lastId) && (
                        <>
                          <RefineChips
                            meta={m.analytics}
                            content={m.content}
                            metaChart={m.meta?.chart}
                            metaTable={m.meta?.table}
                            isLast={m.id === lastId}
                            disabled={streaming}
                            onAsk={(q) => void sendQuestion(q)}
                            onEditSql={openSqlEditor}
                            chartShown={!!inlineCharts[m.id]}
                            onToggleChart={() =>
                              setInlineCharts((prev) => ({ ...prev, [m.id]: !prev[m.id] }))
                            }
                            onSave={
                              desktop ? (meta) => void saveResultCsv(m.id, meta) : undefined
                            }
                            savePending={savedNotes[m.id]?.pending}
                            onEvidencePack={
                              desktop ? (meta) => void saveEvidencePack(m.id, meta) : undefined
                            }
                            packPending={packNotes[m.id]?.pending}
                            onPin={(meta) => void pinAnswer(m.id, meta)}
                            pinPending={pinNotes[m.id]?.pending}
                            onSaveView={(meta) => openSaveView(m.id, meta)}
                            onDefineMetric={(meta) => openDefineMetric(m.id, meta)}
                          />
                          {pinNotes[m.id]?.ok && (
                            <div className={styles.savedNote}>
                              <IconPin fontSize={14} />
                              <Text size={200}>
                                Pinned — Lighthouse will flag this question when the underlying
                                files change.
                              </Text>
                              <Button
                                size="small"
                                appearance="subtle"
                                onClick={() => setPinsOpen(true)}
                              >
                                View pins
                              </Button>
                              {/* The pin-success moment doubles as the board's
                                  add affordance (openspec: add-boards §4.1). */}
                              {pinNotes[m.id]?.boardNote ? (
                                <Text size={200}>{pinNotes[m.id].boardNote}</Text>
                              ) : (
                                <Button
                                  size="small"
                                  appearance="subtle"
                                  icon={<IconBoard />}
                                  onClick={() => void addPinNoteToBoard(m.id)}
                                >
                                  Add to board
                                </Button>
                              )}
                            </div>
                          )}
                          {pinNotes[m.id]?.error && (
                            <div className={styles.savedNote}>
                              <IconError fontSize={14} />
                              <Text size={200}>Couldn&apos;t pin — {pinNotes[m.id].error}</Text>
                            </div>
                          )}
                          {savedNotes[m.id]?.name && (
                            <div className={styles.savedNote}>
                              <IconCheck fontSize={14} />
                              <Text size={200}>
                                Saved “{savedNotes[m.id].name}” to Lighthouse Results — now a
                                queryable vault file.
                              </Text>
                              <Button
                                size="small"
                                appearance="subtle"
                                onClick={() => revealSaved(savedNotes[m.id].id ?? "")}
                              >
                                Reveal
                              </Button>
                            </div>
                          )}
                          {savedNotes[m.id]?.error && (
                            <div className={styles.savedNote}>
                              <IconError fontSize={14} />
                              <Text size={200}>Couldn&apos;t save — {savedNotes[m.id].error}</Text>
                            </div>
                          )}
                          {packNotes[m.id]?.name && (
                            <div className={styles.savedNote}>
                              <IconCheck fontSize={14} />
                              <Text size={200}>
                                Saved “{packNotes[m.id].name}” to Lighthouse Results — a
                                self-contained evidence pack you can share.
                              </Text>
                              <Button
                                size="small"
                                appearance="subtle"
                                onClick={() => revealSaved(packNotes[m.id].id ?? "")}
                              >
                                Reveal
                              </Button>
                            </div>
                          )}
                          {packNotes[m.id]?.error && (
                            <div className={styles.savedNote}>
                              <IconError fontSize={14} />
                              <Text size={200}>
                                Couldn&apos;t save the evidence pack — {packNotes[m.id].error}
                              </Text>
                            </div>
                          )}
                          {/* Save-as-view confirmation (openspec:
                              add-shaped-views §3.1) — the Save-as-CSV quiet
                              inline pattern; refusals show in the dialog. */}
                          {viewNotes[m.id]?.name && (
                            <div className={styles.savedNote}>
                              <IconCheck fontSize={14} />
                              <Text size={200}>
                                Saved view “{viewNotes[m.id].name}” — ask against it like any
                                table.
                              </Text>
                            </div>
                          )}
                        </>
                      )}
                      {/* "Chart it" on ANY tabular answer (charts by default,
                          0.12.1): answers without analytics meta — prose
                          answers whose table is already on screen — get the
                          same client-built chart, zero model calls. */}
                      {!m.analytics && !m.error && !(streaming && m.id === lastId) && (
                        <ChartItRow
                          content={m.content}
                          metaChart={m.meta?.chart}
                          metaTable={m.meta?.table}
                          chartShown={!!inlineCharts[m.id]}
                          onToggleChart={() =>
                            setInlineCharts((prev) => ({ ...prev, [m.id]: !prev[m.id] }))
                          }
                        />
                      )}
                      {m.references && m.references.length > 0 && (
                        <DeferredMount>
                          <References
                            turnId={m.id}
                            references={m.references}
                            desktop={desktop}
                            flashCite={flashCite}
                            onOpen={openFile}
                            onPreview={openPreview}
                            onSynthesize={onSynthesizeStable}
                          />
                        </DeferredMount>
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
                      {/* Engine-emitted provenance stamp: where this answer was
                          computed and how much left the machine. Rendered only
                          from the final chunk's meta — always truthful. */}
                      {m.meta && !m.error && !(streaming && m.id === lastId) && (
                        <Text size={200} className={styles.provenanceStamp}>
                          <span
                            aria-hidden
                            className={mergeClasses(
                              styles.provenanceDot,
                              m.meta.origin === "device"
                                ? styles.provenanceDotDevice
                                : styles.provenanceDotVendor,
                            )}
                          />
                          {provenanceStampText(m.meta)}
                        </Text>
                      )}
                      {/* Answer-cache honesty line (openspec: add-answer-cache):
                          a replayed answer is visibly marked with the ORIGINAL
                          answer time, from the engine-emitted meta.cachedAt
                          only — never model text. Re-run re-asks the same
                          question live (bypassCache) and refreshes the entry. */}
                      {m.meta?.cachedAt !== undefined &&
                        !m.error &&
                        !(streaming && m.id === lastId) && (
                          <Text size={200} className={styles.cacheLine}>
                            From cache · same data as {cachedAtLabel(m.meta.cachedAt)} ·{" "}
                            <Link inline disabled={streaming} onClick={() => regenerate(m.id)}>
                              Re-run
                            </Link>
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
              icon={<IconArrowDown />}
              onClick={jumpToLatest}
            >
              Jump to latest
            </Button>
          )}
        </div>

        {composer("Ask a follow-up…")}
      </div>

      {/* Edit SQL: the deterministic escape hatch on analytics answers. Runs
          the draft through the engine's guarded single-SELECT path over the
          same files the answer read — instant, model-free, never persisted. */}
      <Dialog
        open={sqlEdit !== null}
        onOpenChange={(_, data) => {
          if (!data.open) closeSqlEditor();
        }}
      >
        <LhDialogSurface className={styles.sqlDialogSurface}>
          <DialogBody>
            <DialogTitle>Edit SQL</DialogTitle>
            <DialogContent className={styles.sqlDialogContent}>
              <Text size={200} className={styles.quietNote}>
                Runs instantly against the same files as the answer — one read-only SELECT,
                no AI involved. {modKey()}+Enter to run.
              </Text>
              <Textarea
                className={styles.sqlEditor}
                value={sqlDraft}
                onChange={(_, d) => setSqlDraft(d.value)}
                resize="vertical"
                rows={6}
                spellCheck={false}
                aria-label="SQL query"
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                    e.preventDefault();
                    void runSqlDraft();
                  }
                }}
              />
              {sqlRunning && (
                <div className={styles.sqlStatus}>
                  <Spinner size="tiny" />
                  <Text size={200}>Running…</Text>
                </div>
              )}
              {sqlOutcome?.error && (
                <div className={styles.errorNotice}>
                  <IconError fontSize={16} />
                  <Text size={200}>{sqlOutcome.error}</Text>
                </div>
              )}
              {sqlOutcome?.content && (
                <div className={mergeClasses(styles.answer, styles.sqlResult)}>
                  <AnswerMarkdown
                    content={sqlOutcome.content}
                    turnId="sql-editor"
                    onCite={handleCitationClick}
                  />
                </div>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={closeSqlEditor}>
                Close
              </Button>
              <Button
                appearance="primary"
                icon={<IconPlay />}
                disabled={sqlRunning || !sqlDraft.trim()}
                onClick={() => void runSqlDraft()}
              >
                Run
              </Button>
            </DialogActions>
          </DialogBody>
        </LhDialogSurface>
      </Dialog>

      {/* Save as view (openspec: add-shaped-views §3.1): a name-only dialog
          over this answer's exact SQL + files; the asked question is recorded
          as the summary (source "question"). The engine owns every rule —
          refusals render inside the dialog, the success line above is the
          quiet Save-as-CSV pattern. */}
      <SaveViewDialog
        open={saveView !== null}
        onClose={() => setSaveView(null)}
        sql={saveView?.meta.sql ?? ""}
        fileIds={saveView?.meta.fileIds ?? []}
        question={saveView?.question ?? ""}
        onSaved={(view) => {
          const target = saveView;
          if (target) {
            setViewNotes((s) => ({ ...s, [target.msgId]: { name: view.name } }));
          }
        }}
      />

      {/* Define as metric (openspec: add-semantic-layer §6.2): the engine
          proposes an aggregate expression + entity from this answer's own SQL;
          the user names it and saves. PARITY: unavailable on the web twin. */}
      <DefineMetricDialog
        open={defineMetric !== null}
        onClose={() => setDefineMetric(null)}
        sql={defineMetric?.meta.sql ?? ""}
        fileIds={defineMetric?.meta.fileIds ?? []}
        question={defineMetric?.question ?? ""}
      />
    </section>
  );
}
