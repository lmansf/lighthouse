# Storage model

RAG Vault is **local-first and standalone**. Your documents stay in a directory
on your own computer; derived state (which files are included, files you've
**linked** in place from elsewhere on disk, your profile and API key, the cached
text extracted from PDF/Word/Excel documents under `.rag-vault/cache/extract/`,
future indexes) lives in a hidden `.rag-vault/` folder beside them. Linked items are
read from their real location and are never copied into the vault. Removing an
item from the vault is non-destructive: vault files move to a recoverable trash
(`.rag-vault/trash/<date>/`) you can restore by hand, and linked items only
unlink.

There is no required cloud database. If you later want to host the app, the
`RagService` / `ChatService` / `AuthService` contracts are the seam: a cloud
adapter (for example Vercel Blob storage plus a hosted vector index) can be
dropped in behind the same interfaces. Note that a serverless host like Vercel
cannot persist files to a local directory — local-directory storage requires
running the app on your own machine (or any host with a writable disk).
