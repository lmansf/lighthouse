# Tasks — boards

## 1. Engine store + ops (both engines, PARITY)
- [x] 1.1 `boards.rs` ⇄ `boards.ts`: envelope {v:1, boards}, bak-on-write, CRUD (list/create/rename/delete/setCards) with per-scope name uniqueness + size enum validation; lazy defaults (virtual until first mutation); tombstone-tolerant (pin existence not enforced at write).
- [x] 1.2 `refreshCards` op: desktop wraps `run_direct` per pin (markdown/chart/footer/digest, live:true); twin returns stored pin state (live:false, PARITY comment); dispatch `op:"boards"` across routes.rs / commands.rs / app/api/rag/route.ts; RagService + real/mock; Board types.
- [x] 1.3 Store + refresh unit tests both engines: round trip order/sizes, bak-on-write, card-removal-preserves-pin, per-scope name collision, tombstone render data, twin stored-state shape.

## 2. Cards + board panel (UI)
- [ ] 2.1 BoardPanel + card components: chart card (AnalyticsChart from parsed spec), stat tile (tabular numeral + delta vs previous summary via pinChart parsing), compact table, tombstone, staleReason posture; freshness line per card; 0.12.0 card treatment both themes.
- [ ] 2.2 Diff badges from `lighthouse:pins-changed` (before→after retained until viewed); drill-in via the existing askPinned flow; nav entry scoped like pins (global + per investigation).

## 3. Refresh (no scheduler)
- [ ] 3.1 Open-board + manual "Refresh all" call refreshCards; watcher event triggers changed-pins refresh when the board is visible; zero model calls proven in tests; no conserve gating on SQL re-runs (documented), drill-in inherits ordinary ask behavior.

## 4. Layout
- [ ] 4.1 Responsive grid (S/M/L spans); keyboard-first move controls; HTML5 drag enhancement (FileExplorer pattern); size cycling via card menu; order/size persist through setCards.

## 5. Export
- [ ] 5.1 `composeBoardPack` in evidencePack.ts (title, per-card table HTML + inline SVG via standaloneChartSvg, freshness stamps, SQL appendix from pin SQL + engine footers) → exportChat into Lighthouse Results (html); unit tests on the composer.

## 6. Verify
- [ ] 6.1 E2E: pin two questions in an investigation → arrange board → modify fixture CSV → watcher recheck updates the card + diff badge with ZERO model calls (mocked provider proves) → drill-in narrates → export produces the file; twin renders boards with stored-state cards.
- [ ] 6.2 Full gates: cargo core+server, npm, tsc, lint, smoke, eval + chart floors, `openspec validate --all`.
