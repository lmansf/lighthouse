/**
 * Local audit log — the dev twin of native/crates/lighthouse-core/src/audit.rs
 * (openspec: add-audit-log). One JSONL record per answered question, written at
 * the same transport choke point (app/api/chat), recording what the assistant
 * read, which provider answered, and which hosts the answer dialed.
 *
 * PARITY, with one deliberate divergence: the Rust engine chains an HMAC-SHA256
 * across records so tampering is detectable; the TS twin OMITS the chain (it is
 * the web-dev twin, not a security surface — see docs/ts-twin.md / design D6).
 * The record shape, gating, egress-delta approach, and CSV export stay
 * byte-compatible so the same UI renders either engine's log.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { appStateDir } from "./config";
import { readDesktopSettings } from "./settings";
import { auditForcedOn } from "./policy";
import { hostCounts, hostsSince } from "./egress";

export interface AuditRecord {
  ts: number;
  questionSha256: string;
  /** Verbatim question — present ONLY when auditVerbatim is set. */
  question?: string;
  fileIds: string[];
  provider: string;
  /** `["none"]` or the hosts newly contacted answering this question. */
  egress: string[];
  artifacts: string[];
}

/** What the choke point assembles for one answered question. */
export interface AuditInput {
  question: string;
  fileIds: string[];
  provider: string;
  egress: string[];
  artifacts: string[];
}

/** True when a record should be written (setting or managed policy). */
export function auditEnabled(): boolean {
  return readDesktopSettings().auditEnabled === true || auditForcedOn();
}

/** Month-bucketed file under app-state `audit/`, keeping files bounded without a
 *  rotation daemon. The env override lets tests target a scratch file. */
function auditPath(): string {
  const override = process.env.LIGHTHOUSE_AUDIT_FILE;
  if (override && override.trim()) return override;
  return path.join(appStateDir(), "audit", `audit-${monthStamp()}.jsonl`);
}

/** `YYYY-MM` in UTC — byte-identical to the Rust engine's month stamp so both
 *  engines address the same monthly file. */
function monthStamp(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
}

/** Append one record for an answered question. Best-effort and gated: does
 *  nothing when disabled, and a write failure is swallowed (the answer is
 *  already in the user's hands — the log must never fail a question). */
export function appendAudit(input: AuditInput): void {
  if (!auditEnabled()) return;
  const verbatim = readDesktopSettings().auditVerbatim === true;
  const rec: AuditRecord = {
    ts: Date.now(),
    questionSha256: createHash("sha256").update(input.question, "utf8").digest("hex"),
    ...(verbatim ? { question: input.question } : {}),
    fileIds: input.fileIds,
    provider: input.provider,
    egress: input.egress.length > 0 ? input.egress : ["none"],
    artifacts: input.artifacts,
  };
  try {
    const file = auditPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 0600 on create; append is atomic per line for the single-writer dev server.
    fs.appendFileSync(file, JSON.stringify(rec) + "\n", { mode: 0o600 });
  } catch {
    // swallow — never fail an answer over the log
  }
}

/**
 * The choke point's two calls: snapshot the egress baseline before driving the
 * answer, then record the per-question delta once the final chunk lands. Mirrors
 * the Rust AnswerAudit helper. `begin` is unconditional (cheap) so the call site
 * stays simple; `finish` short-circuits in `appendAudit` when disabled.
 */
export function beginAudit(): Map<string, number> {
  return hostCounts();
}

export function finishAudit(
  before: Map<string, number>,
  answer: { question: string; provider: string; fileIds: string[]; artifacts: string[] },
): void {
  appendAudit({
    question: answer.question,
    provider: answer.provider,
    fileIds: answer.fileIds,
    artifacts: answer.artifacts,
    egress: hostsSince(before),
  });
}

function readRecords(): AuditRecord[] {
  try {
    const text = fs.readFileSync(auditPath(), "utf8");
    const out: AuditRecord[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as AuditRecord);
      } catch {
        // skip a corrupt line — the twin makes no integrity claim
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** The most recent `limit` records (newest first) plus the enabled + intact
 *  verdict. The twin has no HMAC chain, so `intact` is always true (PARITY). */
export function recentAudit(limit: number): {
  enabled: boolean;
  intact: boolean;
  records: AuditRecord[];
} {
  const records = readRecords().reverse().slice(0, limit);
  return { enabled: auditEnabled(), intact: true, records };
}

/** Explicit verification. The twin keeps no chain, so it always reports intact
 *  (PARITY — only the Rust engine detects tampering). */
export function verifyActiveAudit(): { intact: boolean; breakAt: number; count: number } {
  return { intact: true, breakAt: -1, count: readRecords().length };
}

/** The full active-month log as CSV — byte-compatible columns with the Rust
 *  engine's export_csv(). */
export function exportCsvAudit(): string {
  let out = "ts,provider,fileIds,egress,artifacts,question\n";
  for (const rec of readRecords()) {
    const row = [
      String(rec.ts),
      csvField(rec.provider ?? ""),
      csvField((rec.fileIds ?? []).join(";")),
      csvField((rec.egress ?? []).join(";")),
      csvField((rec.artifacts ?? []).join(";")),
      csvField(rec.question ?? ""),
    ];
    out += row.join(",") + "\n";
  }
  return out;
}

/** Minimal RFC-4180 field escaping: quote when the value holds a comma, quote,
 *  CR, or LF, doubling any inner quote. */
function csvField(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Test seam: remove the active audit file. */
export function resetAuditForTests(): void {
  try {
    fs.rmSync(auditPath(), { force: true });
  } catch {
    // ignore
  }
}
