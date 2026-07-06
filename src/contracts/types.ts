/**
 * RAG Vault - shared domain types.
 *
 * This file is the contract every feature team codes against. Treat it as
 * append-only / backwards-compatible: changing a shape here ripples into
 * shell, onboarding, explorer, and chat. Coordinate before breaking it.
 */

/** A top-level source of documents the user can expose (or hide) from RAG. */
export interface DataSource {
  id: string;
  name: string;
  kind: "database" | "folder";
  /** Whether the source as a whole is available to the RAG system. */
  available: boolean;
}

/** A node in the file tree: a database, a folder, or a single file. */
export interface FileNode {
  id: string;
  /** Parent node id, or null for a top-level node under its source. */
  parentId: string | null;
  /** The DataSource this node belongs to. */
  sourceId: string;
  name: string;
  kind: "file" | "folder" | "database";
  /** MIME type for files (e.g. "application/pdf"). Undefined for folders. */
  mimeType?: string;
  /** Size in bytes for files. */
  size?: number;
  /** Whether this node is currently included in the RAG index. */
  ragIncluded: boolean;
  /**
   * True for items *referenced* in their real location on disk rather than
   * copied into the vault (added via "Link…"). The subtree root carries it; the
   * whole referenced tree is read in place, so no copies are made.
   */
  external?: boolean;
}

/**
 * Opaque token returned by `RagService.removeFromVault`. Hold onto it and pass
 * it to `restoreFromVault` to undo the removal (re-link, restore flags, or move
 * a trashed file back). The shape is engine-defined; the UI treats it as a
 * blob it round-trips.
 */
export type RestoreToken = Record<string, unknown>;

/** A model provider the user can pick during onboarding. */
export interface ModelProvider {
  id: string;
  label: string;
  /** Selectable model ids for this provider. */
  models: string[];
  /** Page where the user obtains an API key for this provider. */
  apiKeyUrl: string;
}

/** The signed-in (mock) user. */
export interface User {
  id: string;
  name: string;
  email: string;
}

/** Onboarding progress, persisted in the auth store. */
export interface OnboardingState {
  /** Which step the onboarding flow is currently on. */
  step: "sign-in" | "register" | "select-model" | "done";
  user: User | null;
  /** Chosen provider id, set during the select-model step. */
  providerId: string | null;
  /** Chosen model id within the provider. */
  modelId: string | null;
  /** Whether the user has supplied an API key (we never persist the key itself in plaintext beyond the mock). */
  hasApiKey: boolean;
  /**
   * A/B onboarding variant for this install (`play_first` drops straight into the
   * workspace on the local model and defers the key prompt; `key_first` is the
   * classic ask-for-a-key-first flow). Surfaced so the UI can branch copy and
   * affordances. Optional: absent in the mock / when experiments aren't resolved.
   */
  onboardingVariant?: "play_first" | "key_first";
  /**
   * A/B default-inclusion variant (`opt_out` includes new files by default with
   * a prominent control affordance; `opt_in` includes nothing until toggled).
   * This is the assigned experiment bucket and the *fallback* default when the
   * user hasn't made an explicit choice.
   */
  defaultInclusionVariant?: "opt_in" | "opt_out";
  /**
   * The user's *effective* default-inclusion behavior for newly-added files:
   * `include` = added files are searchable by default (toggle off what you don't
   * want); `exclude` = nothing is searchable until you include it. Chosen during
   * onboarding; when the user has made no explicit choice this mirrors
   * `defaultInclusionVariant` (opt_out → include, opt_in → exclude).
   */
  defaultInclusion?: "include" | "exclude";
}

/** A reference / related file surfaced beneath a chat answer. */
export interface RagReference {
  fileId: string;
  name: string;
  snippet: string;
  /** Relevance score in [0, 1]. */
  score: number;
}

export type ChatRole = "user" | "assistant";

/** A prior turn sent back to the model so follow-up questions have context. */
export interface ChatTurn {
  role: ChatRole;
  content: string;
}

/** A single message in the chat transcript. */
export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  /** References attached to an assistant message. */
  references?: RagReference[];
}

/** A streamed chunk emitted while the assistant answers. */
export interface ChatChunk {
  /** Incremental answer text to append. */
  delta: string;
  /** Final references, present on the terminating chunk. */
  references?: RagReference[];
  /** True on the last chunk of a response. */
  done: boolean;
}
