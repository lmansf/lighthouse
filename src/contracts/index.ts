/** Public barrel for the contract layer. Import features from here. */
export * from "./types";
export * from "./services";

export { MODEL_PROVIDERS } from "./mocks/providers";
export { SEED_NODES, SEED_SOURCES } from "./mocks/files";

// Real, local-first implementations (filesystem vault + local retrieval +
// Claude/extractive chat). Swap back to ./mocks/* to run fully offline mocks.
export { ragService } from "./real/rag.real";
export { authService } from "./real/auth.real";
export { chatService } from "./real/chat.real";
