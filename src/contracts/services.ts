/**
 * RAG Vault - service interfaces.
 *
 * Features depend on these interfaces, never on a concrete implementation.
 * The mock implementations live in ./mocks and are swapped for real ones
 * (vector store, identity provider, model API) behind the same surface.
 */

import type {
  ChatChunk,
  ChatTurn,
  DataSource,
  FileNode,
  OnboardingState,
  RagReference,
  User,
} from "./types";

/** Curates which files/sources are exposed to retrieval, and runs retrieval. */
export interface RagService {
  /** List every source the user has connected. */
  listSources(): Promise<DataSource[]>;
  /** List the file tree, optionally scoped to a parent node. */
  listNodes(parentId?: string | null): Promise<FileNode[]>;
  /** Include or exclude a node (and, for folders/sources, its descendants). */
  setIncluded(nodeId: string, included: boolean): Promise<void>;
  /** Toggle whether a whole source is available. */
  setSourceAvailable(sourceId: string, available: boolean): Promise<void>;
  /** Retrieve references relevant to a query from the currently-included set. */
  search(query: string, includedFileIds: string[]): Promise<RagReference[]>;
  /**
   * Link a file or folder by its real absolute path instead of copying it into
   * the vault (reduces duplication). Returns the new node id. Desktop-only —
   * the browser has no access to real filesystem paths.
   */
  addReference(path: string): Promise<{ id: string; kind: "file" | "folder" }>;
  /** Remove a reference (unlink); the real files on disk are left untouched. */
  removeReference(refId: string): Promise<void>;
  /**
   * Remove a node from the vault, non-destructively: a linked item unlinks, a
   * vault-resident item moves to a recoverable trash. Throws on failure.
   */
  removeFromVault(nodeId: string): Promise<void>;
  /**
   * Capabilities of the running deployment. `desktop` is true only in the
   * packaged desktop app, where filesystem-backed actions (opening a cited file
   * natively, linking by path) work; a plain web deployment reports false so the
   * UI can hide affordances the server would refuse.
   */
  capabilities(): Promise<{ desktop: boolean }>;
}

/** Registration / sign-in. Mocked now; swap for a real identity provider later. */
export interface AuthService {
  getState(): OnboardingState;
  signIn(email: string, password: string): Promise<User>;
  register(name: string, email: string, password: string): Promise<User>;
  /** Advance past the welcome/registration step (whether submitted or skipped). */
  finishRegistration(): Promise<void>;
  selectModel(providerId: string, modelId: string, apiKey: string): Promise<void>;
  /** Set whether newly-added files are searchable by default (chosen at onboarding). */
  setDefaultInclusion(value: "include" | "exclude"): Promise<void>;
  completeOnboarding(): Promise<void>;
  signOut(): Promise<void>;
}

/** Streams an assistant answer plus its references for a user question. */
export interface ChatService {
  /**
   * Ask a question against the included file set. Yields incremental chunks;
   * the final chunk carries `done: true` and the resolved references. `history`
   * carries prior turns so follow-up questions ("tell me more about the second
   * one") resolve against the ongoing conversation. When `attachmentFileIds` is
   * non-empty the answer is scoped to just those files (the user attached them to
   * this question), regardless of the global included set.
   */
  ask(
    question: string,
    includedFileIds: string[],
    history?: ChatTurn[],
    attachmentFileIds?: string[],
  ): AsyncIterable<ChatChunk>;
}
