/**
 * Features shelved from the app to keep it lean. Rather than carry the full
 * implementation of things few users reach for, each is reduced to a lightweight
 * blueprint (docs/blueprints/*.md) so it can be rebuilt quickly if there's real
 * demand — and the mid-session feedback nudge now asks which of these a user
 * would actually use (see FeatureInterestVote) instead of a long survey.
 *
 * Votes land in the dedicated `feature_interest` Supabase table (its own table,
 * separate from `feedback`) via the license Edge Function's `featureInterest` op.
 * The `id`s here are the stable vote keys and the Supabase `feature` values.
 */
export interface ShelvedFeature {
  /** Stable id — the vote key and the Supabase `feature` value. */
  id: string;
  /** Short label shown in the vote. */
  label: string;
  /** One-sentence description of what the feature is. */
  caption: string;
}

export const SHELVED_FEATURES: ShelvedFeature[] = [
  {
    id: "read-aloud",
    label: "Read answers aloud",
    caption: "Have Lighthouse read its answers out loud with a built-in voice.",
  },
  {
    id: "converse",
    label: "Conversation mode",
    caption: "Talk back and forth in a flowing conversation instead of one question at a time.",
  },
];
