/**
 * RAG Vault - service interfaces.
 *
 * Features depend on these interfaces, never on a concrete implementation.
 * The mock implementations live in ./mocks and are swapped for real ones
 * (vector store, identity provider, model API) behind the same surface.
 */

import type {
  ChatChunk,
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
}

/** Registration / sign-in. Mocked now; swap for a real identity provider later. */
export interface AuthService {
  getState(): OnboardingState;
  signIn(email: string, password: string): Promise<User>;
  register(name: string, email: string, password: string): Promise<User>;
  /** Advance past the welcome/registration step (whether submitted or skipped). */
  finishRegistration(): Promise<void>;
  selectModel(providerId: string, modelId: string, apiKey: string): Promise<void>;
  completeOnboarding(): Promise<void>;
  signOut(): Promise<void>;
}

/** Streams an assistant answer plus its references for a user question. */
export interface ChatService {
  /**
   * Ask a question against the included file set. Yields incremental chunks;
   * the final chunk carries `done: true` and the resolved references.
   */
  ask(question: string, includedFileIds: string[]): AsyncIterable<ChatChunk>;
}
