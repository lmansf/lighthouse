# How retrieval works

RAG Vault retrieves passages with a local TF-IDF cosine ranker — no cloud, no
database server, no embeddings download required.

1. **Scan** — included files are read from the vault directory.
2. **Chunk** — each file's text is split into overlapping ~120-word windows.
3. **Score** — the query and every chunk become TF-IDF vectors; chunks are
   ranked by cosine similarity.
4. **Ground** — the top chunks are passed to the answer step (Claude when a key
   is configured, otherwise a local extractive summary) and surfaced as the
   reference passages beneath the answer.

Because retrieval lives behind the `RagService.search` contract, this ranker can
later be swapped for vector embeddings (e.g. a local transformers.js model)
without changing the API routes or any UI code.
