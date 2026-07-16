# add-investigations — design

## The object and its single sources of truth

Stored record (envelope `{v: 1, investigations: [...]}` in
`.rag-vault/investigations.json`, written with the shared atomic writer):

```
Investigation {
  id: string            // engine-minted, time-prefixed
  name: string          // display name, unique case-insensitively
  createdMs: i64
  archived: bool        // archive hides, never deletes
  scopeFileIds: [string]     // vault node ids; empty = whole vault
  providerPolicy: "default" | "local-only"
  conversationRefs: [string] // client Conversation.id values (opaque)
}
```

Pins and notes are deliberately NOT stored on the record:

- **Pins**: `Pin.investigationId` (new optional field) is the source of
  truth; the API's investigation view derives `pinRefs` from `pins.json` at
  read time. No two-way bookkeeping to drift.
- **Notes**: membership = location. `exportChat` writes under
  `Lighthouse Notes/<investigation name>/`; the view derives `noteRefs` by
  prefix. Rename moves nothing (the folder keeps the creation-time name —
  recorded on the record as `folderName` if it ever diverges; v1 folders are
  named at first export and remembered).
- **Conversations** must be stored refs — no engine store knows client
  conversation ids otherwise.

### Versioning posture (user data, not cache)

`answer-cache.json`'s "version mismatch reads empty" is correct for a cache
and wrong for user structure. Here: `v == 1` loads; any other/missing version
loads EMPTY for the session but the first subsequent write renames the
unreadable file to `investigations.json.bak-<epoch>` before writing a fresh
v1 envelope. Nothing is silently clobbered; a downgrade leaves the newer
file recoverable on disk. Unit-tested.

## History posture wins (engine-enforced)

`conversationRefs` writes ride an explicit `persistAllowed` boolean on the
`investigations` op (same client-computed value the ask path already sends:
`persistEnabled && !chatHistoryLocked()`), AND the engine independently
consults the managed policy's `history_allowed()`. Either false ⇒ the ref
write is a silent no-op; structure fields (name, scope, policy, archived)
persist regardless. Transcripts never touch either engine — unchanged
invariant, restated here because investigations are the first engine object
that *references* conversations.

## Scoping = the attachment machinery, resolved at the entry points

The ask body gains optional `investigationId`. At each of the three entry
points (routes.rs / commands.rs / app/api/chat/route.ts), immediately where
`model_config()` is consulted today:

```
(attachmentIds, cfg) = investigations::resolve_ask_context(
    investigationId, requestAttachmentIds, cfg)
```

- scope non-empty AND request attachments empty → attachments := scope
  (dangling scope ids are fine — downstream candidate selection already
  ignores unknown ids, and the skip-note honesty machinery counts drops).
- request attachments non-empty → **they win** (most-specific-wins, the same
  precedence philosophy as curation rules); scope is not intersected.
- archived investigations resolve like live ones (asking inside an archived
  investigation is allowed; the UI just hides it from the nav).

`answer_pipeline` / `answerPipeline` signatures are UNCHANGED — scope arrives
as ordinary attachments, so every existing choke point (`shareable_subset`,
analytics registration, multi-attach map, single-doc focus, retrieval) and
every honesty footer applies verbatim. Local-only marks therefore keep
applying within scope per provider with zero new code.

## Provider policy: same chokepoint as managed policy

`resolve_ask_context` also swaps the ask's resolved model config when the
investigation is `local-only`: `cfg := local` (provider "local", no key).
This is the identical depth at which the managed policy layer participates in
provider resolution (`model_config()` → llm-time `provider_allowed`): the
pipeline's `origin_of(cfg)` becomes "device", `is_cloud_provider(cfg)` false —
so cloud transports are never constructed, local-only-marked files remain
readable (the private model may read them), and the provenance stamp is
accurate with no additional code. The llm-layer `provider_allowed` belt stays
in place beneath it (managed `forceLocalOnly` composes: most-restrictive
wins because both act on the same cfg).

UI ALSO disables the provider switch inside a local-only investigation, but
the enforcement above is engine-side and holds for any client.

## Recall preference

`retrieve` (both engines) gains `preferredConversationIds: &[String]` /
`string[]`. Where `CONV_BOOST` (1.5×) applies today, candidates whose
conversation-note filename carries a `[cid8]` matching a preferred id get an
additional `INVESTIGATION_BOOST` (1.3×) — preference, not exclusion: global
notes still surface, ordered after. PARITY: identical constants and matching
logic both engines; parity fixture asserts identical candidate ORDER.

## UI

- `InvestigationsNav` mounts above `FileExplorer` via the `app/page.tsx`
  sidebar fragment (no `Sidebar.tsx` API change). Create / rename / archive
  through a Fluent Menu per row (the explorer row-menu pattern);
  `data-tour="investigations"`.
- `useChatStore` gains `currentInvestigationId` and `Conversation.investigationId`;
  the history drawer and `newConversation` respect the current investigation.
  Switching investigations switches the visible conversation list, scope
  pill, and enforcement badge; "New chat" inherits the current investigation.
- Compact header (both hero and conversation headers): name · scope size
  ("whole vault" when empty) · policy badge (amber shield when local-only,
  the provenance-dot convention).
- The ask call sites (ChatPanel, WidgetBar) pass `investigationId` on the
  wire. The widget ignores investigations in v1 (no selector) — it asks in
  the global context (`investigationId` absent).

## Read-from-the-top scroll (§6, client-only — PARITY N/A)

Replaces the streaming bottom-follow in `ChatPanel` (the `[messages]` effect
that pins `scrollTop = scrollHeight`):

- On the FIRST delta of a new assistant message (stream start), the top of
  that message element anchors to the top of the chat viewport
  (`scrollTop = messageEl.offsetTop - container padding`), applied instantly
  (plain `scrollTop` assignment — inherently reduced-motion-safe).
- HOLD: while that answer streams, the anchor is re-asserted on message
  growth ONLY if the user has not scrolled since the anchor was set
  (reflow above the anchor must not drift it). Any user scroll
  (`wheel`/`touchmove`/scrollbar → the existing `handleBodyScroll`) sets a
  `holdCancelled` flag for the in-flight answer — the transcript never
  fights the user.
- Reference cards, chips, and the provenance stamp render BELOW the answer
  text and never displace the anchored start (they append after; the anchor
  keeps the first line at the top).
- The "Jump to latest" pill keeps its meaning (visible when the viewport
  bottom is far from the transcript end).
- Main-window transcript only; `WidgetBar`'s pill behavior is untouched.
- Opening an existing conversation still lands at the bottom (unchanged);
  only streaming answers anchor.

## Rust/TS parity

- `investigations.rs` ⇄ `investigations.ts`: byte-compatible JSON envelope,
  identical validation (name uniqueness case-insensitive, policy enum,
  sanitized folder names), identical resolve precedence. PARITY comments at
  every deliberate divergence; none expected except the Tauri `vault-changed`
  emit (desktop-only).
- Pins/vault/retrieve changes land in both engines in the same commit.
- §6 scroll is client-only; no engine surface.

## Failure & degradation

- Unknown envelope version → session-empty + `.bak-<epoch>` preserved on
  first write (never clobber newer data silently).
- Dangling scope ids (files deleted since scoping) → ignored by candidate
  selection; the scope pill shows the live count of still-present files.
- Dangling conversation refs (history cleared/expired) → refs are opaque and
  harmless; the UI shows only conversations it actually has.
- Local-only investigation + managed `allowedProviders` excluding "local" →
  contradictory policy stays restrictive exactly as today (`provider_allowed`
  is unchanged); the ask lands on the extractive fallback.
- 6144-token local window: unaffected — scope changes candidate selection,
  not context assembly; the existing truncation honesty applies.
- investigations.json corrupt/unreadable JSON → same as version mismatch
  (empty + bak-on-write), tested.
