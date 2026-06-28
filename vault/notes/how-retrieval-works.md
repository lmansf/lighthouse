# How retrieval works

RAG Vault retrieves passages with a local TF-IDF cosine ranker — no cloud, no
database server, no embeddings download required.

1. **Scan** — included files are read from the vault directory (or, for files
   linked in place, from their real location on disk). Plain-text files are read
   directly; PDF, Word (`.docx`), and Excel (`.xlsx`/`.xls`) documents have their
   text extracted by parsers loaded lazily on first use and cached on disk, so
   each document is parsed once and an unreadable file falls back to empty text
   while staying findable by name.
2. **Chunk** — each file's text is split into overlapping ~120-word windows.
3. **Score** — the query and every chunk become TF-IDF vectors; chunks are
   ranked by cosine similarity.
4. **Ground** — the top chunks are passed to the answer step (Claude when a key
   is configured, an on-device local model when the "Local model (private)"
   provider is selected, otherwise a local extractive summary) and surfaced as
   the reference passages beneath the answer.

Catalog-style questions ("show me all files", "list my datasets", "how many
PDFs") bypass the ranker entirely and instead **enumerate** the included files —
narrowing to a file kind (datasets, documents, PDFs, spreadsheets) or a named
type (`csv`, `pdf`, `md`, …) when the question names one.

Because retrieval lives behind the `RagService.search` contract, this ranker can
later be swapped for vector embeddings (e.g. a local transformers.js model)
without changing the API routes or any UI code.
