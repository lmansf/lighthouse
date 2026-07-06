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
  RestoreToken,
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
   * Move a node under a new parent folder within the same source (a vault-
   * internal reparent), or to the source root when `toParentId` is null. The
   * node's AI-visibility flags travel with it. Returns the node's new id (ids
   * are path-derived, so a move renames the id). Throws if the destination
   * already holds a same-named item, or the source can't move (e.g. cloud).
   */
  moveNode(fromId: string, toParentId: string | null): Promise<{ newId: string }>;
  /** Rename a node in place (same parent, new basename). Returns the new id. */
  renameNode(id: string, newName: string): Promise<{ newId: string }>;
  /** Create an empty folder under a parent (or the vault root, null). */
  createFolder(parentId: string | null, name: string): Promise<{ newId: string }>;
  /**
   * Remove a node from the vault, non-destructively: a linked item unlinks, a
   * vault-resident item moves to a recoverable trash. Throws on failure.
   * Returns a token that `restoreFromVault` can replay to undo the removal.
   */
  removeFromVault(nodeId: string): Promise<RestoreToken>;
  /** Undo a removeFromVault from the token it returned. Throws on failure. */
  restoreFromVault(token: RestoreToken): Promise<void>;
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
   * this question), regardless of the global included set. An aborted `signal`
   * cancels the in-flight request (the chat UI's Stop button); implementations
   * should surface the abort by throwing (an `AbortError` DOMException) so the
   * caller can keep the partial answer and settle its state.
   */
  ask(
    question: string,
    includedFileIds: string[],
    history?: ChatTurn[],
    attachmentFileIds?: string[],
    signal?: AbortSignal,
  ): AsyncIterable<ChatChunk>;
}
