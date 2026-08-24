/**
 * Privacy legibility (0.12.1 §2) — the pure derivation behind "is a cloud
 * provider answering right now". UI-free and dependency-free by construction
 * (test/privacyState.test.mjs runs it straight under node).
 *
 * The per-file lock ("Private — this device only") and the withheld-count it
 * fed went with the vault in 0.15.0 (openspec: refocus-chat-attachments):
 * there is no per-file cloud gate any more, because the corpus is the files
 * the user attached to THIS chat and the provider choice applies to the whole
 * ask. What survives is the question the header shield still asks — cloud, or
 * this device?
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
