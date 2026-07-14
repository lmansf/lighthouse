/**
 * Usage click-logging (desktop side) — best-effort UI telemetry.
 *
 * Mirrors the launch ping (see license.ts `pingLaunch`): click events captured
 * in the renderer are buffered to a local JSONL ring-buffer under the vault
 * state dir, then batch-published to the hosted license Edge Function
 * (`op: "events"`) during startup — after the launch ping — and purged on
 * success (see license.ts `publishUsageEvents`). Nothing here may ever break a
 * launch: every path is best-effort and swallows its own errors.
 *
 * Consent: capture is OFF by default (opted out). The user must explicitly opt
 * in at registration (OnboardingPanel); the flag is persisted in `usage.json`
 * and a trial mint resets it to the opted-out default (license.ts `startTrial`),
 * so a new trial never silently re-enables capture. While opted out nothing is
 * captured, buffered, or published, and any buffered events are dropped.
 *
 * Privacy: only coarse labels are recorded (a control's text/aria-label or the
 * coarse folder/file kind) — never file/folder names, field values, file
 * contents, or secrets. Each label is length-capped on both ends of the wire.
 */
import fs from "node:fs";
import path from "node:path";
import { stateDir, readJson, writeJson } from "./config";
import { telemetryAllowed } from "./policy";

/** Coarse bucket for a captured interaction. Mirrors the renderer's capture hook. */
export type UsageEventType = "folder" | "file" | "toggle" | "button" | "link" | "nav" | "other";

const EVENT_TYPES: readonly UsageEventType[] = [
  "folder",
  "file",
  "toggle",
  "button",
  "link",
  "nav",
  "other",
];

export interface UsageEvent {
  /** ISO-8601 timestamp the interaction occurred. */
  at: string;
  type: UsageEventType;
  /** Coarse label/name of the touched control (no values/contents). */
  label: string;
}

// Ring-buffer caps — keep the MOST RECENT actions, trim the oldest on write.
const MAX_EVENTS = 5000;
const MAX_BYTES = 1_000_000; // ~1MB
const MAX_LABEL = 200; // labels are names, not content — clamp hard

const eventsPath = () => path.join(stateDir(), "usage-events.jsonl");
const consentPath = () => path.join(stateDir(), "usage.json");

interface UsageConsent {
  /** When true the user opted OUT — capture/buffer/publish are all disabled. */
  optOut?: boolean;
}

/** Whether the user has opted OUT of usage logging. Default is opted OUT:
 *  capture stays off until the user explicitly opts in (optOut === false).
 *  A managed `telemetry: "off"` policy reads as permanently opted out —
 *  this one gate locks capture (append), publish, and the UI toggle state. */
export function isUsageOptedOut(): boolean {
  if (!telemetryAllowed()) return true;
  return readJson<UsageConsent>(consentPath(), {}).optOut !== false;
}

/**
 * Persist the consent flag. Opting out also drops any buffered-but-unpublished
 * events, so nothing already captured leaks out on the next launch.
 */
export function setUsageOptOut(optOut: boolean): void {
  writeJson(consentPath(), { optOut } satisfies UsageConsent);
  if (optOut) clearUsageBuffer();
}

/** Reset consent to the default (opted OUT). Called when a trial is minted so a
 *  new trial never silently re-enables capture; the user's explicit choice is
 *  persisted afterward by the onboarding flow. */
export function resetUsageConsent(): void {
  writeJson(consentPath(), { optOut: true } satisfies UsageConsent);
}

/** Drop the local buffer (best-effort). */
function clearUsageBuffer(): void {
  try {
    fs.rmSync(eventsPath(), { force: true });
  } catch {
    /* best-effort */
  }
}

/** Write text atomically (temp-then-rename) to avoid torn reads. */
let writeCounter = 0;
function writeTextAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${writeCounter++}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

/** Coerce one untrusted event from the renderer, or null if unusable. */
function sanitize(raw: unknown): UsageEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const type = EVENT_TYPES.includes(e.type as UsageEventType) ? (e.type as UsageEventType) : "other";
  const label = typeof e.label === "string" ? e.label.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL) : "";
  if (!label) return null;
  const at = typeof e.at === "string" && !Number.isNaN(Date.parse(e.at)) ? e.at : new Date().toISOString();
  return { at, type, label };
}

/**
 * Append captured events to the local buffer, then trim to the ring-buffer cap
 * (keep the most recent by count and by size). No-op when opted out. Tolerates
 * a pre-existing partial last line by reparsing what it can.
 */
export function appendUsageEvents(events: unknown[]): void {
  if (isUsageOptedOut()) return;
  const incoming = events.map(sanitize).filter((e): e is UsageEvent => e !== null);
  if (!incoming.length) return;
  try {
    const existing = readBufferLines();
    let lines = [...existing, ...incoming.map((e) => JSON.stringify(e))];
    if (lines.length > MAX_EVENTS) lines = lines.slice(lines.length - MAX_EVENTS);
    // Enforce the byte cap by dropping the oldest lines until under the limit.
    let text = lines.join("\n") + "\n";
    while (text.length > MAX_BYTES && lines.length > 1) {
      lines = lines.slice(1);
      text = lines.join("\n") + "\n";
    }
    writeTextAtomic(eventsPath(), text);
  } catch {
    /* a full buffer is best-effort — never surface to the caller */
  }
}

/** Read the raw buffer as lines (empty/partial lines dropped). */
function readBufferLines(): string[] {
  try {
    return fs
      .readFileSync(eventsPath(), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => {
        try {
          JSON.parse(l);
          return true;
        } catch {
          return false; // tolerate a torn/partial line
        }
      });
  } catch {
    return []; // missing buffer
  }
}

/** The parsed buffer plus the line count, so a successful publish can purge it. */
export function readUsageBuffer(): { events: UsageEvent[]; lineCount: number } {
  const lines = readBufferLines();
  const events = lines
    .map((l) => {
      try {
        return sanitize(JSON.parse(l));
      } catch {
        return null;
      }
    })
    .filter((e): e is UsageEvent => e !== null);
  return { events, lineCount: lines.length };
}

/**
 * Purge the first `publishedLineCount` lines (the oldest, just published),
 * preserving any events appended since the read. New events only ever append at
 * the end, so dropping the leading lines is safe.
 */
export function purgeUsageBuffer(publishedLineCount: number): void {
  if (publishedLineCount <= 0) return;
  try {
    const lines = readBufferLines();
    const remaining = lines.slice(publishedLineCount);
    if (remaining.length === 0) clearUsageBuffer();
    else writeTextAtomic(eventsPath(), remaining.join("\n") + "\n");
  } catch {
    /* best-effort */
  }
}
