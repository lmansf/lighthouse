/**
 * [TEAM: boards] Scope resolution + the "Add to board" seam (openspec:
 * add-boards §4.1).
 *
 * The board a user sees follows the chat context: the global "My board" in
 * the global context, the investigation's default board inside one — the
 * engine's listing returns a VIRTUAL default (deterministic id, empty cards)
 * for a scope with no persisted board, and the first mutation materializes
 * it, so this module never creates boards itself.
 *
 * Kept separate from BoardPanel so ChatPanel's "Add to board" affordances
 * (pin-success note, pins-dialog rows) can import it without pulling the
 * whole board UI into the chat chunk.
 */

import type { Board } from "@/contracts";
import { ragService } from "@/contracts";
import { useChatStore } from "@/stores/useChatStore";
import { appendCard } from "@/features/boards/boardModel";

/**
 * The current scope's board: the first global-scope board when
 * `investigationId` is null, the investigation's first board otherwise.
 * Either way the engine's lazy defaults guarantee at least a virtual one, so
 * null only means the listing itself failed.
 */
export async function currentScopeBoard(investigationId: string | null): Promise<Board | null> {
  if (investigationId) {
    const scoped = await ragService.listBoards(investigationId);
    return scoped[0] ?? null;
  }
  // The unfiltered listing is every board plus virtual defaults (the listPins
  // convention); the global scope's is the one without an investigation.
  const all = await ragService.listBoards();
  return all.find((b) => !b.investigationId) ?? null;
}

/**
 * Append a pin to the current scope's board (size M, the default footprint)
 * through the atomic full-list `setBoardCards` replace. Idempotent: a pin
 * already on the board reports so instead of duplicating its card. Returns a
 * short human note either way, or `error` with the engine's reason.
 */
export async function addPinToCurrentBoard(
  pinId: string,
): Promise<{ note?: string; error?: string }> {
  try {
    const board = await currentScopeBoard(useChatStore.getState().currentInvestigationId);
    if (!board) return { error: "the board for this context could not be loaded" };
    const cards = appendCard(board.cards, pinId, "M");
    if (!cards) return { note: `Already on “${board.name}”` };
    const res = await ragService.setBoardCards(board.id, cards);
    if (res.error || !res.board) {
      return { error: res.error ?? "the card could not be added" };
    }
    return { note: `Added to “${board.name}”` };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "the card could not be added" };
  }
}
