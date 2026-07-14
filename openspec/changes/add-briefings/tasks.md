# Tasks — add-briefings

## 1. Engine (Rust, ships)
- [x] 1.1 `briefings.rs`: `Cadence`, `Briefing`, `BriefingSection`, `BriefingReport`;
      `state/briefings.json` store (atomic, load-or-empty, store lock, title id).
- [x] 1.2 CRUD: `list`, `add` (replace-by-title, cap, preserves createdMs), `remove`.
- [x] 1.3 `due(now)` pure scheduling; `run(id)` re-runs pins via `run_direct` and
      composes (missing/failed pin → error section); `render_markdown`.
- [x] 1.4 `lib.rs` module registration.
- [x] 1.5 Unit tests: CRUD/replace, empty+cap, due-by-cadence, missing-pin run,
      render shape (5 tests).

## 2. Wire (server + desktop + dev route)
- [x] 2.1 `routes.rs`: list/save/remove/run ops + `parse_cadence`.
- [x] 2.2 `commands.rs`: same four ops on `rag_op` (desktop; grep-verified).
- [x] 2.3 `app/api/rag/route.ts`: same four ops (dev twin).

## 3. Contracts + twin
- [x] 3.1 `types.ts`: Briefing/Cadence/BriefingSection/BriefingReport.
- [x] 3.2 `services.ts` + `real/rag.real.ts` + `mocks/rag.mock.ts` methods.
- [x] 3.3 `src/server/briefings.ts` twin (CRUD + due byte-identical; PARITY compose).
- [x] 3.4 `test/briefings.test.mjs` (CRUD, due, PARITY compose — 4 tests).

## 4. UI
- [x] 4.1 Briefings section in the pins dialog (`ChatPanel.tsx` + new
      `BriefingsPanel.tsx`): create (title + pick pins + cadence), list,
      run→inline report (GFM markdown), remove.

## 5. Gates
- [x] 5.1 `cargo test -p lighthouse-core` (134 lib + 5 briefings) +
      `cargo check -p lighthouse-server` green.
- [x] 5.2 `npm test` (102) + `npm run lint` (clean) + static export green.
