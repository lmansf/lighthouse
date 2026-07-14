# Tasks — add-audit-log

## 1. Engine core (audit.rs)

- [ ] 1.1 `native/crates/lighthouse-core/src/audit.rs`: `AuditRecord` struct
      (ts, questionSha256, question?, fileIds, provider, egress: none|hosts,
      artifacts, prevHmac, hmac); `audit_path()` (app-state
      `audit/audit-<YYYY-MM>.jsonl`); `audit_key()` (HMAC-SHA256 key derived
      from `secrets::machine_secret` with label "lighthouse-audit-hmac-v1");
      `enabled()` (settings.audit_enabled == Some(true) || policy::
      audit_forced_on()); `append(record_fields)` — reads the last line's
      hmac (genesis if none), computes the chain hmac over the canonical
      record, appends the line 0600; `verify(path) -> Result<usize, break_at>`.
      Unit tests: append→verify intact; edit a middle record→verify fails at
      it; gating (disabled writes nothing); egress none vs hosts.
- [ ] 1.2 `settings.rs`/`settings.ts`: add `audit_enabled: Option<bool>`
      (+ optional `audit_verbatim`) to DesktopSettings, wired through
      write_desktop_settings + settings_test's exhaustive round-trip.

## 2. Choke-point instrumentation

- [ ] 2.1 Rust: capture the egress host-set + question sha at the start of
      `chat_ask` (commands.rs) and `chat_post` (routes.rs); when the stream's
      final (done) chunk lands, assemble the AuditRecord (provider from cfg,
      fileIds from the final references, egress delta, artifacts from the
      final analytics/artifact meta) and `audit::append` it (best-effort,
      after the user has the answer). One helper in audit.rs so both sites
      share the assembly.
- [ ] 2.2 TS twin: `audit.ts` (same record shape, NO hmac chain — PARITY)
      appended at the `app/api/chat` route's completion, same egress-delta
      approach over the TS registry.

## 3. Ops + viewer

- [ ] 3.1 `rag_op`/routes `{op:"auditList"}` (recent N records) and
      `{op:"auditExport"}` (write CSV to the vault via the sanitized
      vault-write helper, returning its id) + `{op:"auditVerify"}` (intact +
      break index). commands.rs mirror.
- [ ] 3.2 Contracts: `RagService.audit()` (list + verify状态) — AuditSnapshot
      type; real via ops, mock returns disabled/empty.
- [ ] 3.3 UI: an AuditLogDialog under SettingsMenu (recent records table:
      time · provider · files · egress · tamper-ok; Export CSV button) and
      the Preferences "Keep a local audit log" toggle with the managed-lock
      state (locks.auditLogOn).

## 4. Docs + verification

- [ ] 4.1 `docs/data-flows.md` note: the audit log is local-only, never an
      egress; `docs/managed-deployment.md` `auditLog` key already documented —
      cross-link the record shape + tamper model.
- [ ] 4.2 E2E (phase gate): with audit on, a cloud-provider ask logs the
      host and a local ask logs egress:none (server test); HMAC verify catches
      a hand-edited middle record; policy `auditLog:"on"` forces it on with
      the pref off. `openspec validate --all` green.
