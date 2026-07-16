# add-investigations

## Why

Analysis today lives in loose chats: scope is re-attached ask by ask, pins and
exported notes pool globally, and there is no way to say "everything in this
line of inquiry stays on this device." Analysts work in *investigations* — a
named question with a fixed set of source files, an evidence trail (pins,
notes, conversations), and sometimes a confidentiality posture. Lighthouse has
every ingredient already built (attachment scoping, managed-policy chokepoints,
pins, conversation notes, recall boost); investigations compose them into one
durable object without adding a single new data path.

Also folded in (owner-reported, 2026-07-15): the transcript auto-scrolls to
the bottom as an answer lands, so a long Related-files list hides the answer's
first line. Answers should read from the top.

## What Changes

- A new vault-scoped store `.rag-vault/investigations.json` (versioned
  envelope, atomic writes) holding investigation structure: id, name, created,
  archived, optional file scope (vault node ids), provider policy
  (`default` | `local-only`), and conversation refs. Pin and note membership
  are derived, not duplicated (pins carry the id; notes live under the
  investigation's folder).
- Chat asks gain an optional `investigationId`. A non-empty scope resolves
  through the existing attachment-scoping machinery (explicit set bypassing
  the global included set); explicit per-ask attachments override scope.
  Local-only file marks keep applying within scope per provider.
- A `local-only` investigation swaps the ask's resolved model config to the
  private path at the same engine chokepoint where `model_config()` /
  `modelConfig()` is consulted — the identical depth the managed policy layer
  gates — so cloud is never called and the provenance stamp stays accurate
  for free.
- Pins gain an optional `investigationId` (serde-default / TS-optional;
  existing pins stay uncategorized). `exportChat` notes land under
  `Lighthouse Notes/<investigation name>/`. Conversation-recall prefers the
  current investigation's notes ahead of global ones (a second boost above
  `CONV_BOOST`).
- UI: an Investigations section in the left nav (create, rename, archive —
  archive hides, never deletes); switching investigations switches chat
  context, scope pill, and provider enforcement; "New chat" stays within the
  current investigation; a compact header shows name · scope size · policy
  badge.
- Chat scroll: when an answer begins streaming, the top of that assistant
  message anchors to the top of the chat viewport and holds; a manual scroll
  cancels the hold for that answer; reduced motion means instant jumps; the
  widget pill is unaffected.

## Capabilities

### New Capabilities

- `investigations`: named, durable containers for analysis — scope, provider
  policy, membership (conversations, pins, notes), archive lifecycle, ask
  integration, and the read-from-the-top transcript behavior.

## Non-goals

- **No transcript storage in any engine.** Chat history remains client-only;
  with "Save chats on this device" off, an investigation persists structure
  (name, scope, pins, notes) but conversation refs are not accepted and
  transcripts never touch disk. Chat-history posture always wins.
- **No sharing/sync/multi-vault.** An investigation is about THIS vault's
  files; the store is vault-scoped and stays local.
- **No per-investigation provider *selection*.** Policy is a binary
  (`default` | `local-only`); picking a specific cloud vendor per
  investigation is out.
- **No deletion of anything on archive.** Archive is a visibility flag; no
  cascade of pins, notes, files, or conversations.
- **No scope editing UI beyond create in v1.** Scope is set at creation
  (from selection or empty = whole vault); re-scoping is a rename-scale
  follow-on.
- **No new scroll physics.** §6 changes when the transcript follows, not how
  scrolling works; no virtualization, no smooth-scroll library.

## Impact

- Engine (Rust ships / TS twins byte-compatible where shared):
  - NEW `native/crates/lighthouse-core/src/investigations.rs` ⇄
    `src/server/investigations.ts` (store, CRUD, ask-context resolution).
  - `native/crates/lighthouse-core/src/pins.rs` ⇄ `src/server/pins.ts` +
    `src/contracts/types.ts` (optional `investigationId`).
  - `native/crates/lighthouse-core/src/vault.rs` ⇄ `src/server/vault.ts`
    (artifact subdir allowlist for investigation folders; recall preference
    beside `CONV_BOOST`; retrieve signature gains preferred conversation ids).
  - Ask entry points parse `investigationId` and resolve scope/policy:
    `native/crates/lighthouse-server/src/routes.rs`,
    `native/crates/lighthouse-desktop/src/commands.rs`,
    `app/api/chat/route.ts`.
  - CRUD dispatch: `routes.rs` / `commands.rs` / `app/api/rag/route.ts`
    (`op: "investigations"`).
- Contracts/UI: `src/contracts/services.ts` (+ real/mock), `types.ts`,
  `src/stores/useChatStore.ts` (currentInvestigationId, Conversation
  `investigationId`), new `src/features/investigations/InvestigationsNav.tsx`,
  `app/page.tsx` (sidebar fragment), `src/features/chat/ChatPanel.tsx`
  (scope pill, header, ask opts, scroll §6).
- Docs: `docs/data-flows.md` MUST NOT grow (no new egress).
