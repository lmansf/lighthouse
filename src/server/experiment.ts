/**
 * A/B experiment variant assignment (desktop side).
 *
 * Two independent experiments, each resolved ONCE per install and persisted to
 * `.rag-vault/experiments.json` (the same readJson/writeJson + stateDir pattern
 * as identity/profile). Assignment is either a hard-coded pilot-user override
 * (by email) or a deterministic hash of the stable contact id, so a user's
 * bucket is stable across launches and the two experiments randomize
 * independently (each has its own salt).
 *
 * Everything here is best-effort and must never throw into a launch, a query, or
 * onboarding: a missing or garbled file simply re-resolves.
 */
import crypto from "node:crypto";
import path from "node:path";
import { stateDir, readJson, writeJson, profilePath } from "./config";
import { getContactId } from "./license";

const identityPath = () => path.join(stateDir(), "identity.json");

/**
 * The user's email, read straight from the stored profile / identity files.
 *
 * This intentionally does NOT call license.accountEmail() (which calls
 * profile.getState()): profile.getState() resolves the experiment variants, so
 * going back through it here would recurse infinitely (getState -> getVariant ->
 * resolve -> email -> getState -> ...). Reading the files directly breaks that.
 */
function currentEmail(): string | undefined {
  const profile = readJson<{ user?: { email?: string } } | null>(profilePath(), null);
  const fromProfile = profile?.user?.email?.trim();
  if (fromProfile) return fromProfile;
  const identity = readJson<{ email?: string } | null>(identityPath(), null);
  return identity?.email?.trim() || undefined;
}

export type OnboardingVariant = "play_first" | "key_first";
export type DefaultInclusionVariant = "opt_in" | "opt_out";

export interface Variants {
  onboarding: OnboardingVariant;
  default_inclusion: DefaultInclusionVariant;
}

export type ExperimentName = keyof Variants;

/** Per-experiment salt so a user's two buckets don't correlate. */
const SALT: Record<ExperimentName, string> = {
  onboarding: "onboarding:v1",
  default_inclusion: "default_inclusion:v1",
};

/** The two variants of each experiment: [hash < 0.5, hash >= 0.5]. */
const VARIANTS: { [K in ExperimentName]: [Variants[K], Variants[K]] } = {
  onboarding: ["play_first", "key_first"],
  default_inclusion: ["opt_in", "opt_out"],
};

/**
 * Hard-coded assignment for the first pilot users, keyed by lower-cased email -
 * a 2x2 factorial across the four so every onboarding x default_inclusion cell
 * is covered exactly once. A pilot user is pinned to their cell as soon as their
 * email is known (it wins over any earlier hash assignment).
 *
 * TODO(lighthouse): replace these placeholder addresses with the real pilot
 * users' emails before release.
 */
const FIRST_USERS: Record<string, Variants> = {
  "user1@example.com": { onboarding: "play_first", default_inclusion: "opt_in" },
  "user2@example.com": { onboarding: "key_first", default_inclusion: "opt_out" },
  "user3@example.com": { onboarding: "play_first", default_inclusion: "opt_out" },
  "user4@example.com": { onboarding: "key_first", default_inclusion: "opt_in" },
};

const experimentsPath = () => path.join(stateDir(), "experiments.json");

/** Deterministic hash of a string to the unit interval [0, 1). */
export function hashToUnit(s: string): number {
  // Top 48 bits of a SHA-256 digest, divided by 2^48 - plenty of resolution
  // for a 50/50 split and stable across platforms.
  const n = crypto.createHash("sha256").update(s).digest().readUIntBE(0, 6);
  return n / 2 ** 48;
}

function assign<K extends ExperimentName>(experiment: K): Variants[K] {
  const [a, b] = VARIANTS[experiment];
  return hashToUnit(`${getContactId()}:${SALT[experiment]}`) < 0.5 ? a : b;
}

/** Resolve both variants once and persist; subsequent calls read the file. */
function resolve(): Variants {
  // A pilot override always wins once the user's email is known, so the four
  // pilots land in their assigned factorial cells regardless of hash.
  const email = currentEmail()?.toLowerCase();
  const override = email ? FIRST_USERS[email] : undefined;
  const stored = readJson<Partial<Variants> | null>(experimentsPath(), null);

  if (override) {
    if (
      stored?.onboarding !== override.onboarding ||
      stored?.default_inclusion !== override.default_inclusion
    ) {
      writeJson(experimentsPath(), override);
    }
    return override;
  }

  if (stored?.onboarding && stored?.default_inclusion) return stored as Variants;

  // First resolve for a non-pilot user: deterministic hash, then persist. Keep
  // any partially-stored bucket rather than reshuffling it.
  const resolved: Variants = {
    onboarding: stored?.onboarding ?? assign("onboarding"),
    default_inclusion: stored?.default_inclusion ?? assign("default_inclusion"),
  };
  writeJson(experimentsPath(), resolved);
  return resolved;
}

/** The user's variant for one experiment (resolved + persisted on first call). */
export function getVariant<K extends ExperimentName>(experiment: K): Variants[K] {
  return resolve()[experiment];
}

/** All of the user's variants, for stamping onto telemetry rows. */
export function getAllVariants(): Variants {
  return resolve();
}
