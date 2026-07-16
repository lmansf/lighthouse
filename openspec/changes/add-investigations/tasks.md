# Tasks — investigations

## 1. Engine store + ops (both engines, PARITY)
- [x] 1.1 `investigations.rs` ⇄ `investigations.ts`: envelope {v:1, investigations}, atomic writes, unknown-version bak-on-write; CRUD (create/list/rename/setArchived/addConversationRef) with name uniqueness + sanitized folder name; history-posture gate on ref writes (persistAllowed AND policy history_allowed).
- [x] 1.2 `op: "investigations"` across routes.rs / commands.rs / app/api/rag/route.ts; RagService methods + real/mock; contracts types (Investigation, enriched view with derived pinRefs/noteRefs).
- [x] 1.3 Store unit tests: round trip, versioning bak, history-off ref rule, name collision, archive flag.

## 2. Scoping + provider policy (engine)
- [x] 2.1 `resolve_ask_context(investigationId, attachments, cfg)` both engines: scope→attachments (attachments win when present), local-only→cfg swap to local at the model_config resolution point; wire `investigationId` through the three ask entry points.
- [x] 2.2 Parity test: fixture vault, scoped ask → identical candidate sets Rust ⇄ TS.
- [x] 2.3 Unit tests: local-only cfg swap (mocked cloud cfg in → local out), attachments-override precedence, dangling scope ids ignored.

## 3. Belonging (engine)
- [ ] 3.1 `Pin.investigationId` optional (serde default ⇄ TS optional) + pinAsk op carries current id; list filter.
- [ ] 3.2 `exportChat` under `Lighthouse Notes/<investigation>/` (allowlist extension, sanitized, traversal-safe).
- [ ] 3.3 Recall preference: retrieve gains preferred conversation ids; INVESTIGATION_BOOST above CONV_BOOST; parity-identical ordering test.

## 4. UI
- [ ] 4.1 `InvestigationsNav` in the sidebar fragment (create/rename/archive, data-tour anchor); useChatStore currentInvestigationId + Conversation.investigationId; history drawer + newChat respect it.
- [ ] 4.2 Scope pill + policy badge (hero and conversation headers); ask call sites pass investigationId; provider switch disabled inside local-only investigations.

## 5. Read-from-the-top scroll (client-only)
- [ ] 5.1 Replace the streaming bottom-follow: anchor the streaming answer's top at stream start; hold unless the user scrolls; reduced-motion instant; widget untouched; opening old conversations unchanged.

## 6. Verify
- [ ] 6.1 E2E: scoped ask cites only scope; local-only with mocked cloud → private path + on-device stamp; archive non-destructive; scroll E2E (first line at top; manual scroll not overridden).
- [ ] 6.2 Full gates: cargo core+server, npm test, tsc, lint, smoke, eval + chart floors, `openspec validate --all`.
