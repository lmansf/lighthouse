/**
 * Privacy legibility (0.12.1 §2) — the pure derivations behind the lock's TWO
 * states and the chat header's "hidden from cloud models" count. UI-free and
 * dependency-free by construction (test/privacyState.test.mjs runs it straight
 * under node); the node slice is structural so `FileNode` assigns directly.
 *
 * The lock ("Private — this device only") is enforced by the ENGINE at the
 * retrieval/prompt chokepoint; nothing here gates anything. These helpers only
 * make that enforcement visible: whether a mark is currently ENFORCING (a
 * cloud provider would receive files, so marked ones are being withheld right
 * now) or DORMANT (the private model answers on-device; the mark is armed but
 * idle).
 */

/**
 * Whether a CLOUD provider is active — the UI mirror of the single engine
 * predicate that arms local-only enforcement. No provider at all and the
 * "local" provider both answer on this device; ANY other id is cloud. Keyed on
 * provider IDENTITY, not key presence, so the UI reads "enforcing" even before
 * a key is entered — the same fail-closed-toward-privacy posture as the engine.
 * KEEP IN SYNC with synth.rs::is_cloud_provider (⇄ synth.ts::isCloudProvider):
 * both resolve origin "device" ⇔ providerId null/empty/"local".
 */
export function cloudProviderActive(providerId: string | null | undefined): boolean {
  return Boolean(providerId) && providerId !== "local";
}

/** The slice of a FileNode the withheld-count needs (structurally FileNode-compatible). */
export interface PrivacyCountNode {
  kind: string;
  ragIncluded: boolean;
  /** Effective "Private — this device only" (ancestor-wins), absent ⇒ unmarked. */
  localOnly?: boolean;
}

/**
 * How many FILES a cloud provider is being denied right now: marked private
 * AND otherwise visible to AI — the exact set the engine's cloud gate drops.
 * A marked file that is also hidden from AI isn't withheld BY THE LOCK (the
 * eye already excludes it), so it doesn't count. Folder marks count through
 * their descendants, which carry the effective (ancestor-wins) `localOnly`.
 */
export function hiddenFromCloudCount(nodes: readonly PrivacyCountNode[]): number {
  let n = 0;
  for (const node of nodes) {
    if (node.kind === "file" && node.localOnly === true && node.ragIncluded) n += 1;
  }
  return n;
}

/** The header count's exact copy — "1 file…" / "N files… hidden from cloud models". */
export function hiddenFromCloudLabel(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"} hidden from cloud models`;
}

/**
 * Detects the engine's local-only skip note by its STABLE PREFIX, tolerant of
 * count and pluralization. Matched against the TEXT of an emphasis node — the
 * markdown `_(…)_` wrapper is syntax, so the text starts at the paren.
 * PRESENTATION ONLY: the emitted string stays byte-identical in both engines
 * (synth.rs::local_only_skip_note ⇄ synth.ts::localOnlySkipNote);
 * test/privacyLegibility.test.mjs pins both templates untouched.
 */
export const LOCAL_ONLY_SKIP_NOTE_RE = /^\(\d+ files? skipped — marked private/;
