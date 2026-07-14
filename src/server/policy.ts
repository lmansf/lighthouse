/**
 * Managed policy (openspec: add-managed-policy) — the dev twin of
 * native/crates/lighthouse-core/src/policy.rs (KEEP IN SYNC). Parses the
 * same machine-scope policy.json and enforces the engine-shared keys:
 * providers, telemetry, chat history. PARITY: widgetHotkeys / ocr /
 * notifications / vaultRoots are desktop-shell concerns and are parsed but
 * not enforced here (the web twin has no hook/OCR/notifications/vault
 * chooser). Unlike the Rust side, the LIGHTHOUSE_POLICY_FILE override is
 * honored unconditionally — this engine IS the dev tool.
 *
 * States mirror the Rust semantics: absent ⇒ unrestricted; valid ⇒ set keys
 * apply; malformed/unknown-version ⇒ fail closed (local-only providers,
 * telemetry + history off) and report the error state.
 */
import fs from "node:fs";
import path from "node:path";

export interface PolicyFile {
  v?: number;
  allowedProviders?: string[];
  forceLocalOnly?: boolean;
  telemetry?: string;
  chatHistory?: string;
  widgetHotkeys?: string;
  ocr?: string;
  notifications?: string;
  auditLog?: string;
  vaultRoots?: string[];
}

type PolicyState =
  | { kind: "absent" }
  | { kind: "active"; policy: PolicyFile }
  | { kind: "malformed" };

function machinePolicyPath(): string {
  if (process.platform === "win32") {
    const base = process.env.ProgramData?.trim() || "C:\\ProgramData";
    return path.join(base, "Lighthouse", "policy.json");
  }
  if (process.platform === "darwin") {
    return "/Library/Application Support/Lighthouse/policy.json";
  }
  return "/etc/lighthouse/policy.json";
}

function policyPath(): string {
  const override = process.env.LIGHTHOUSE_POLICY_FILE?.trim();
  return override || machinePolicyPath();
}

let cached: PolicyState | null = null;

function load(): PolicyState {
  const file = policyPath();
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { kind: "absent" };
  }
  try {
    const parsed = JSON.parse(text) as PolicyFile;
    if (parsed.v !== undefined && parsed.v !== 1) {
      console.error(`[policy] MALFORMED: unsupported version ${parsed.v} in ${file} — failing closed`);
      return { kind: "malformed" };
    }
    return { kind: "active", policy: parsed };
  } catch (e) {
    console.error(`[policy] MALFORMED: ${String(e)} in ${file} — failing closed (local-only, telemetry/history off)`);
    return { kind: "malformed" };
  }
}

function state(): PolicyState {
  if (!cached) cached = load();
  return cached;
}

/** Test seam: drop the cache so the next access reloads. */
export function resetPolicyForTests(): void {
  cached = null;
}

export function policyPresent(): boolean {
  return state().kind !== "absent";
}

export function policyError(): boolean {
  return state().kind === "malformed";
}

/** Mirror of policy.rs provider_allowed — intersection when both keys set. */
export function providerAllowed(providerId: string): boolean {
  const s = state();
  if (s.kind === "absent") return true;
  if (s.kind === "malformed") return providerId === "local";
  const p = s.policy;
  if (p.forceLocalOnly === true && providerId !== "local") return false;
  if (Array.isArray(p.allowedProviders)) return p.allowedProviders.includes(providerId);
  return true;
}

export function telemetryAllowed(): boolean {
  const s = state();
  if (s.kind === "malformed") return false;
  return !(s.kind === "active" && s.policy.telemetry === "off");
}

export function historyAllowed(): boolean {
  const s = state();
  if (s.kind === "malformed") return false;
  return !(s.kind === "active" && s.policy.chatHistory === "off");
}

/** True when an org policy forces the local audit log on (`auditLog: "on"`).
 *  Only an ACTIVE policy forces it — a malformed/absent policy does not (PARITY:
 *  audit_forced_on() in policy.rs). */
export function auditForcedOn(): boolean {
  const s = state();
  return s.kind === "active" && s.policy.auditLog === "on";
}

/** The {op:"policy"} payload — byte-shape mirror of policy.rs snapshot(). */
export function policySnapshot(): unknown {
  const s = state();
  const active = s.kind === "active" ? s.policy : undefined;
  const allowedProviders = (() => {
    if (s.kind === "malformed") return ["local"];
    if (!active) return null;
    if (active.forceLocalOnly === true) {
      const base = ["local"];
      return Array.isArray(active.allowedProviders)
        ? base.filter((b) => active.allowedProviders!.includes(b))
        : base;
    }
    return active.allowedProviders ?? null;
  })();
  return {
    present: s.kind !== "absent",
    error: s.kind === "malformed",
    locks: {
      allowedProviders,
      telemetryOff: !telemetryAllowed(),
      chatHistoryOff: !historyAllowed(),
      // PARITY: parsed for the snapshot, enforced only by the desktop shell.
      widgetHotkeysOff: active?.widgetHotkeys === "off",
      ocrOff: active?.ocr === "off",
      notificationsOff: active?.notifications === "off",
      auditLogOn: active?.auditLog === "on",
      vaultRoots: active?.vaultRoots ?? null,
    },
  };
}
