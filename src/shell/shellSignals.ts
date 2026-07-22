"use client";

/**
 * §33 §1: a tiny shell-state bus. AppShell owns the compact-layout signals
 * (form factor, active tab, software keyboard) and ChatPanel owns whether an
 * answer is streaming — but the surfaces that need to gate on them (the
 * feedback nudge) mount as SIBLINGS of AppShell in app/page.tsx, outside its
 * subtree. Publishing here lets them subscribe without prop-drilling through
 * the page. Same module-store + useSyncExternalStore idiom as Sheet's
 * useAnySheetOpen; desktop publishes compact=false forever, so every consumer
 * branch is a structural no-op there.
 */
import { useSyncExternalStore } from "react";
import type { CompactTab } from "./paneLayout";

export interface ShellUi {
  /** Below the breakpoint (the tab-bar arrangement). */
  compact: boolean;
  /** The tab currently on screen (meaningful only while compact). */
  activeTab: CompactTab;
  /** Software keyboard up: visualViewport inset OR an editable holding focus. */
  keyboardUp: boolean;
  /** An answer is streaming into the transcript right now. */
  streaming: boolean;
}

const state: ShellUi = { compact: false, activeTab: "chat", keyboardUp: false, streaming: false };
const listeners = new Set<() => void>();
let snapshot: ShellUi = { ...state };

function emit(): void {
  snapshot = { ...state };
  listeners.forEach((cb) => cb());
}

/** AppShell's publisher — call with the three signals it owns, every change. */
export function publishShellUi(ui: Pick<ShellUi, "compact" | "activeTab" | "keyboardUp">): void {
  if (
    ui.compact === state.compact &&
    ui.activeTab === state.activeTab &&
    ui.keyboardUp === state.keyboardUp
  ) {
    return;
  }
  state.compact = ui.compact;
  state.activeTab = ui.activeTab;
  state.keyboardUp = ui.keyboardUp;
  emit();
}

/** ChatPanel's publisher — flips while an answer streams. */
export function publishChatStreaming(streaming: boolean): void {
  if (state.streaming === streaming) return;
  state.streaming = streaming;
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Live shell-state snapshot (stable reference between publishes). */
export function useShellUi(): ShellUi {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}
