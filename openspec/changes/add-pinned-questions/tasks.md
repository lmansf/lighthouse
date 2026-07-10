# Tasks — add-pinned-questions

## 1. Engine core (pins.rs)

- [x] 1.1 Pin type + pins.json store (load-or-empty, save, cap 20) + unit tests (corrupt file resets, cap enforced)
- [x] 1.2 `recheck_all()` via analytics::run_direct: digest (sha1 of result markdown), summary (≤3 rows), stale_reason on failure; returns changed set; unit tests over temp CSVs (change detected, identical → none, missing file → stale)
- [x] 1.3 Ops in routes.rs + commands.rs: pinAsk / unpinAsk / listPins / recheckPins

## 2. Desktop scheduler

- [x] 2.1 main.rs tokio task: sample watch::generation() every 30 s, 60 s quiet debounce, recheck_all, emit `pins-changed` Tauri event; log failures to shell.log

## 3. TS twin

- [x] 3.1 Pin CRUD + on-demand recheck on listPins/recheckPins in /api/rag with PARITY comment (no background loop; recheck via analyticsSql-equivalent is desktop-only ⇒ TS rechecks mark pins unverified)

## 4. UI

- [x] 4.1 Contracts: Pin type, rag ops, mocks
- [x] 4.2 Pin toggle on analytics answers (uses analytics meta); pins dialog under settings gear (list, status/stale reason, re-check, remove)
- [x] 4.3 Alert banner in ChatPanel driven by pins-changed event (+ widget dot); click submits the pin's question

## 5. Verification

- [x] 5.1 cargo + node tests, tsc, lint; live check: pin over a temp CSV, edit the file, observe the changed event and banner within the debounce window
