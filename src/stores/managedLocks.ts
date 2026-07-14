/**
 * Managed-policy locks as a one-way, dependency-free signal (openspec:
 * add-managed-policy). The rag store publishes the locks here when the
 * policy snapshot loads; consumers that must not drag the contracts graph
 * into their module chain (the chat store — its node tests load it without
 * the `@/` alias resolver) read the plain module-level flag instead of
 * importing the store.
 */

let chatHistoryOff = false;

export function setManagedLocks(locks: { chatHistoryOff: boolean }): void {
  chatHistoryOff = locks.chatHistoryOff;
}

/** True when a managed policy forbids persisting conversations. */
export function chatHistoryLocked(): boolean {
  return chatHistoryOff;
}
