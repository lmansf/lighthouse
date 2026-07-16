"use client";

/**
 * [TEAM: boards] The board panel (openspec: add-boards §2-§4): the current
 * scope's pins arranged as a living, local dashboard. Opens from the settings
 * gear's "Board" entry via `lighthouse:open-board` (the open-pins seam) as a
 * large dialog — no AppShell routing change. The scope follows the chat
 * context: the global "My board" in the global context, the investigation's
 * default board inside one (the engine lists virtual defaults lazily).
 *
 * REFRESH POSTURE (§3.1 — no scheduler, ever): cards refresh exactly three
 * ways —
 *   1. opening the board (one refreshBoardCards for its pins),
 *   2. the "Refresh all" button (same call, on demand),
 *   3. while the board is OPEN, the existing watcher recheck's
 *      `lighthouse:pins-changed` relay (changed pins only).
 * No timers, no polling, no background work of its own. A card refresh
 * re-runs the pin's stored SQL through the engine's guarded, MODEL-FREE
 * `run_direct` path (DataFusion only) — the recheck loop's own posture — so
 * power-conserve does NOT gate it: conserve gates only model-touching
 * actions. Drill-in (clicking a card) is an ORDINARY ask through the normal
 * ask path and inherits ordinary ask behavior — answer cache, provenance
 * stamp, conserve — unchanged.
 *
 * DIFF BADGES (§2.2): `pins-changed` payloads are retained per pin — board
 * open or closed — so a card shows a "changed" badge holding the before→after
 * (stat delta, mini-chart, tooltip) until the user has viewed the board:
 * closing the board consumes the badges for its cards, drilling into a card
 * consumes that card's, and "Refresh all" consumes all of them. No new
 * events, no new scheduler — the one existing relay.
 *
 * EXPORT (§5.1): "Export board" composes ONE self-contained evidence-pack
 * HTML CLIENT-SIDE from exactly what the panel is showing — live
 * markdown/footers on desktop, stored summaries on the twin, each card's
 * rendered chart serialized in place — and writes it through the existing
 * allowlisted `exportChat` artifact path into `Lighthouse Results/`. No
 * re-query, no model, no network beyond the local write op.
 */

import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { ArrowClockwiseRegular, DocumentRegular } from "@fluentui/react-icons";
import type {
  Board,
  BoardCardRef,
  BoardCardRefresh,
  BoardCardSize,
  ChangedPin,
} from "@/contracts";
import { ragService } from "@/contracts";
import { useChatStore } from "@/stores/useChatStore";
import { composeBoardPack, type BoardPackCard } from "@/lib/evidencePack";
import { standaloneChartSvg } from "@/features/chat/AnalyticsChart";
import { currentScopeBoard } from "@/features/boards/boardScope";
import {
  cardFreshness,
  moveCard,
  reorderCard,
  withCardSize,
  withoutCard,
} from "@/features/boards/boardModel";
import { BOARD_CARD_MIME, BoardCard } from "@/features/boards/BoardCard";

const useStyles = makeStyles({
  // The pins dialog's surface, sized for a dashboard: v1 is a large dialog,
  // not a route (openspec design — no AppShell restructure).
  surface: {
    maxWidth: "1080px",
    width: "94vw",
  },
  content: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
    maxHeight: "72vh",
    overflowY: "auto",
  },
  // Responsive grid (§4.1): auto-fill tracks; spans come from the card's
  // size class (S 1, M 2, L full row — see BoardCard/spanForSize).
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
    gap: tokens.spacingHorizontalM,
    alignItems: "start",
  },
  quietNote: { color: tokens.colorNeutralForeground3 },
  errorNote: { color: tokens.colorStatusDangerForeground1 },
});

/** Merge a refresh response into the per-pin answer map. */
function mergeAnswers(
  prev: Record<string, BoardCardRefresh>,
  incoming: BoardCardRefresh[],
): Record<string, BoardCardRefresh> {
  const next = { ...prev };
  for (const c of incoming) next[c.pinId] = c;
  return next;
}

/**
 * The board host: mounted once from app/page.tsx (the QuickOpen sibling
 * pattern) so the `pins-changed` listener outlives the dialog — change
 * badges accumulate while the board is closed and are shown on next view.
 */
export function BoardHost() {
  const styles = useStyles();
  const currentInvestigationId = useChatStore((s) => s.currentInvestigationId);

  const [open, setOpen] = useState(false);
  const [board, setBoard] = useState<Board | null>(null);
  const [answers, setAnswers] = useState<Record<string, BoardCardRefresh>>({});
  const [changed, setChanged] = useState<Record<string, ChangedPin>>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // The export confirmation (the saveEvidencePack packNotes idiom): pending
  // while writing, then the saved name — or the engine's error — verbatim.
  const [packNote, setPackNote] = useState<{
    pending?: boolean;
    name?: string;
    error?: string;
  } | null>(null);

  // Latest-closure refs (the ChatPanel askSeedRef pattern): the mount-once
  // listeners below act on fresh state without re-subscribing per render.
  const openRef = useRef(open);
  openRef.current = open;
  const boardRef = useRef(board);
  boardRef.current = board;

  // Stale-response guard: reloads race (open, context switch, refresh-all).
  const loadSeq = useRef(0);

  /** Re-fetch some cards' answers — engine-computed, model-free. */
  const refreshSome = useCallback(async (pinIds: string[]) => {
    if (pinIds.length === 0) return;
    try {
      const cards = await ragService.refreshBoardCards(pinIds);
      setAnswers((prev) => mergeAnswers(prev, cards));
    } catch {
      // Cards keep their last render; the next open or Refresh all retries.
    }
  }, []);

  /** Load the current scope's board and refresh all its cards (trigger 1). */
  const loadBoard = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setNote(null);
    setPackNote(null);
    try {
      const b = await currentScopeBoard(currentInvestigationId);
      if (seq !== loadSeq.current) return;
      setBoard(b);
      setAnswers({});
      if (!b) {
        setNote("The board could not be loaded.");
      } else if (b.cards.length > 0) {
        const cards = await ragService.refreshBoardCards(b.cards.map((c) => c.pinId));
        if (seq !== loadSeq.current) return;
        setAnswers(mergeAnswers({}, cards));
      }
    } catch (err) {
      if (seq === loadSeq.current) {
        setNote(err instanceof Error ? err.message : "The board could not be loaded.");
      }
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [currentInvestigationId]);

  // Open by event — the same cross-feature seam as lighthouse:open-pins.
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener("lighthouse:open-board", onOpen);
    return () => window.removeEventListener("lighthouse:open-board", onOpen);
  }, []);

  // Opening the board IS a refresh; so is a context switch while open.
  useEffect(() => {
    if (open) void loadBoard();
  }, [open, loadBoard]);

  // The watcher recheck's relay (the ChatPanel pins-changed pattern): retain
  // the before→after per pin for the diff badge, and — while the board is
  // open — re-fetch just the changed cards (trigger 3). Mounted once.
  useEffect(() => {
    const onPinsChanged = (e: Event) => {
      const list = (e as CustomEvent<{ changed?: ChangedPin[] }>).detail?.changed;
      if (!Array.isArray(list) || list.length === 0) return;
      setChanged((prev) => {
        const next = { ...prev };
        for (const c of list) next[c.id] = c; // newest wins per pin id
        return next;
      });
      const b = boardRef.current;
      if (openRef.current && b) {
        const onBoard = list
          .map((c) => c.id)
          .filter((id) => b.cards.some((k) => k.pinId === id));
        void refreshSome(onBoard);
      }
    };
    window.addEventListener("lighthouse:pins-changed", onPinsChanged);
    return () => window.removeEventListener("lighthouse:pins-changed", onPinsChanged);
  }, [refreshSome]);

  /** Badges are held "until viewed": consume the given pins' (or all). */
  const consumeChanged = useCallback((pinIds?: string[]) => {
    setChanged((prev) => {
      if (!pinIds) return {};
      const next = { ...prev };
      for (const id of pinIds) delete next[id];
      return next;
    });
  }, []);

  /** Trigger 2: the manual "Refresh all" — one call for the board's pins. */
  async function refreshAll() {
    const b = board;
    if (!b || loading || busy) return;
    setBusy(true);
    try {
      await refreshSome(b.cards.map((c) => c.pinId));
      consumeChanged(b.cards.map((c) => c.pinId));
    } finally {
      setBusy(false);
    }
  }

  /**
   * "Export board" (§5.1): compose ONE self-contained board pack from the
   * panel's CURRENT refresh state and save it through the allowlisted
   * artifact path. Charts are snapshotted synchronously at click time — the
   * saveEvidencePack capture idiom: the ALREADY-RENDERED SVG inside each
   * card's node, theme colors baked in (only live chart cards render one;
   * stored cards export their summary text). Tombstones are skipped: a
   * deleted pin has no question, result, or SQL — nothing shareable.
   */
  async function exportBoard() {
    const b = board;
    if (!b || loading || busy || packNote?.pending || b.cards.length === 0) return;
    const now = Date.now();
    const svgByPin = new Map<string, string>();
    for (const ref of b.cards) {
      const el = document.querySelector<SVGSVGElement>(
        `[data-lh-board-card="${ref.pinId}"] figure svg[role="img"]`,
      );
      if (!el) continue;
      try {
        svgByPin.set(ref.pinId, standaloneChartSvg(el));
      } catch {
        /* capture is best-effort — the card's table/summary still travels */
      }
    }
    const current = answers;
    setPackNote({ pending: true });
    try {
      // SQL lives on the PIN (refresh answers don't carry it): one listing,
      // indexed by id. It doubles as the stored-state fallback for a card
      // whose refresh never landed — exactly the twin's own answer shape.
      const pins = await ragService.listPins();
      const pinById = new Map(pins.map((p) => [p.id, p]));
      const cards: BoardPackCard[] = [];
      for (const ref of b.cards) {
        const pin = pinById.get(ref.pinId);
        const answer: BoardCardRefresh | undefined =
          current[ref.pinId] ??
          (pin
            ? {
                pinId: ref.pinId,
                live: false,
                question: pin.question,
                lastRunMs: pin.lastRunMs,
                lastSummary: pin.lastSummary,
                staleReason: pin.staleReason,
              }
            : undefined);
        if (!answer || answer.tombstone || !pin) continue;
        const failed = Boolean(answer.error || answer.staleReason);
        cards.push({
          question: answer.question ?? pin.question,
          // The on-screen body: live → the engine's row-capped result table;
          // stored → the pin's compact summary text; failed → omitted (the
          // stale note stands as the body, exactly like the card).
          markdown: failed
            ? undefined
            : answer.live
              ? answer.markdown ?? ""
              : answer.lastSummary ?? "Not checked yet.",
          chartSvg: answer.live ? svgByPin.get(ref.pinId) : undefined,
          freshness: cardFreshness(answer, now),
          sql: pin.sql,
          footer: answer.live ? answer.footer : undefined,
          live: answer.live,
          staleNote: failed ? answer.error ?? `stale: ${answer.staleReason}` : undefined,
        });
      }
      const html = composeBoardPack({ title: b.name, generatedAt: now, cards });
      const hint = b.name.trim().replace(/\s+/g, " ").slice(0, 60) || "Board";
      const res = await ragService.exportChat(hint, html, {
        subdir: "Lighthouse Results",
        ext: "html",
      });
      if (res.error || !res.savedId) {
        setPackNote({ error: res.error ?? "save failed" });
      } else {
        setPackNote({ name: res.savedName });
      }
    } catch (err) {
      setPackNote({ error: err instanceof Error ? err.message : "save failed" });
    }
  }

  /** Closing = the badges for this board's cards were viewed; consume them. */
  function close() {
    setOpen(false);
    const b = board;
    if (b) consumeChanged(b.cards.map((c) => c.pinId));
  }

  /**
   * Drill-in: the pin's question through the NORMAL ask path — the same
   * `lighthouse:ask-question` seam the desktop widget's hand-off rides lands
   * in ChatPanel's sendQuestion (askPinned's own flow), so the narrated
   * answer, answer cache, and provenance stamp all apply unchanged. The
   * dialog closes first so the transcript is visible when the answer streams.
   */
  function drillIn(question: string, pinId: string) {
    setOpen(false);
    consumeChanged([pinId]);
    window.dispatchEvent(
      new CustomEvent("lighthouse:ask-question", { detail: { question } }),
    );
  }

  /**
   * Persist a card-list edit (§4.1): order and size ride the ONE atomic
   * full-list replace. Optimistic — keyboard moves feel instant — with the
   * previous list restored when the engine refuses.
   */
  async function persistCards(next: BoardCardRef[] | null) {
    const b = board;
    if (!next || !b || busy) return;
    setBusy(true);
    setNote(null);
    const prev = b;
    setBoard({ ...b, cards: next });
    try {
      const res = await ragService.setBoardCards(b.id, next);
      if (res.board) {
        setBoard(res.board);
      } else {
        setBoard(prev);
        setNote(res.error ?? "The change could not be saved.");
      }
    } catch (err) {
      setBoard(prev);
      setNote(err instanceof Error ? err.message : "The change could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  const onMove = (index: number, dir: -1 | 1) =>
    void persistCards(board ? moveCard(board.cards, index, dir) : null);
  const onSize = (index: number, size: BoardCardSize) =>
    void persistCards(board ? withCardSize(board.cards, index, size) : null);
  const onRemove = (index: number) =>
    void persistCards(board ? withoutCard(board.cards, index) : null);

  // HTML5 drag enhancement (the FileExplorer MIME idiom); `dropIndex` is the
  // hovered card's highlight. Keyboard moves remain the primary path.
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const onDragStartCard = (index: number, e: DragEvent<HTMLDivElement>) => {
    e.dataTransfer.setData(BOARD_CARD_MIME, String(index));
    e.dataTransfer.effectAllowed = "move";
  };
  const onDragOverCard = (index: number, e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes(BOARD_CARD_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dropIndex !== index) setDropIndex(index);
  };
  const onDragLeaveCard = () => setDropIndex(null);
  const onDropCard = (index: number, e: DragEvent<HTMLDivElement>) => {
    const raw = e.dataTransfer.getData(BOARD_CARD_MIME);
    setDropIndex(null);
    if (!raw) return;
    e.preventDefault();
    const from = Number(raw);
    if (!Number.isInteger(from) || !board) return;
    void persistCards(reorderCard(board.cards, from, index));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(_, data) => {
        if (!data.open) close();
      }}
    >
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <DialogTitle>{board ? board.name : "Board"}</DialogTitle>
          <DialogContent className={styles.content}>
            <Text size={200} className={styles.quietNote}>
              Cards re-run each pin&apos;s saved query on your device — no AI involved.
              Click a card to ask its question again in the chat.
            </Text>
            {note && (
              <Text size={200} className={styles.errorNote} role="status">
                {note}
              </Text>
            )}
            {packNote?.name && (
              <Text size={200} className={styles.quietNote} role="status">
                Saved “{packNote.name}” to Lighthouse Results — a self-contained board
                pack you can share.
              </Text>
            )}
            {packNote?.error && (
              <Text size={200} className={styles.errorNote} role="status">
                Couldn&apos;t save the board pack — {packNote.error}
              </Text>
            )}
            {board && board.cards.length === 0 && !loading && (
              <Text size={300}>
                No cards yet. Ask a data question, choose <b>Pin</b> under the answer, then{" "}
                <b>Add to board</b>.
              </Text>
            )}
            {board && board.cards.length > 0 && (
              <div className={styles.grid} role="list" aria-label={`${board.name} cards`}>
                {board.cards.map((c, i) => (
                  <BoardCard
                    key={c.pinId}
                    cardRef={c}
                    index={i}
                    count={board.cards.length}
                    answer={answers[c.pinId]}
                    changed={changed[c.pinId]}
                    busy={busy || loading}
                    onMove={onMove}
                    onSize={onSize}
                    onRemove={onRemove}
                    onDrill={drillIn}
                    dropTarget={dropIndex === i}
                    onDragStartCard={onDragStartCard}
                    onDragOverCard={onDragOverCard}
                    onDragLeaveCard={onDragLeaveCard}
                    onDropCard={onDropCard}
                  />
                ))}
              </div>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={close}>
              Close
            </Button>
            {/* Quiet, beside Refresh all (§5.1): the evidence-pack affordance
                for the whole board — works on BOTH engines (stored summaries
                export honestly on the twin). */}
            <Button
              appearance="subtle"
              icon={<DocumentRegular />}
              disabled={
                loading || busy || packNote?.pending || !board || board.cards.length === 0
              }
              onClick={() => void exportBoard()}
            >
              {packNote?.pending ? "Exporting…" : "Export board"}
            </Button>
            <Button
              appearance="primary"
              icon={<ArrowClockwiseRegular />}
              disabled={loading || busy || !board || board.cards.length === 0}
              onClick={() => void refreshAll()}
            >
              {loading || busy ? "Refreshing…" : "Refresh all"}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
