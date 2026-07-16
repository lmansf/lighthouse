/**
 * Pinned questions, TS twin (openspec: add-pinned-questions). KEEP IN SYNC
 * with native pins.rs: same Pin shape (camelCase on the wire), same
 * pins.json store idiom (load-or-empty on corruption), same cap and
 * re-pin-replaces semantics.
 *
 * PARITY: rechecks re-run the pinned SQL through DataFusion, which lives in
 * the Rust engine only (desktop app + headless server) — this dev twin
 * implements CRUD and answers recheck requests with "no changes", leaving
 * summaries as of pin time.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { stateDir } from "./config";

/** A briefing list, not a dashboard product. */
export const MAX_PINS = 20;

export interface Pin {
  id: string;
  question: string;
  sql: string;
  fileIds: string[];
  createdMs: number;
  lastRunMs?: number;
  lastDigest?: string;
  lastSummary?: string;
  staleReason?: string;
  /**
   * The investigation this pin belongs to (openspec: add-investigations):
   * the SINGLE source of truth for pin membership — the investigation view
   * derives its `pinRefs` from this field at read time. Optional so pins
   * written before the field existed load unchanged and stay uncategorized;
   * omitted when absent so their store round-trips byte-identically.
   */
  investigationId?: string;
}

function pinsPath(): string {
  return path.join(stateDir(), "pins.json");
}

/**
 * All pins, oldest first. A missing or corrupt store reads as empty. With
 * `investigationId` (openspec: add-investigations) the list filters to the
 * pins carrying that investigation; absent = the unchanged "all" behavior.
 * KEEP IN SYNC with pins.rs::list / list_for.
 */
export function listPins(investigationId?: string): Pin[] {
  let pins: Pin[];
  try {
    const parsed = JSON.parse(fs.readFileSync(pinsPath(), "utf8")) as { pins?: Pin[] };
    pins = Array.isArray(parsed.pins) ? parsed.pins : [];
  } catch {
    return [];
  }
  return investigationId === undefined
    ? pins
    : pins.filter((p) => p.investigationId === investigationId);
}

function save(pins: Pin[]): void {
  const target = pinsPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Atomic temp+rename (mirrors pins.rs): a crash mid-write must never leave
  // truncated JSON, because listPins() treats a corrupt store as empty — a
  // direct writeFileSync could wipe every pin on an interrupted write.
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ pins }, null, 2));
  fs.renameSync(tmp, target);
}

/** Stable id from the pinned SQL — re-pinning the same query replaces. */
function pinId(sql: string): string {
  return `pin-${crypto.createHash("sha1").update(sql).digest("hex").slice(0, 12)}`;
}

/**
 * Add (or replace) a pin. Fails past the cap with a human-readable reason.
 * `investigationId` (openspec: add-investigations) records the current
 * investigation on the pin — blank/absent leaves it uncategorized, and a
 * re-pin adopts the NEW ask's investigation (replace semantics, like every
 * other field). Stored as given, dangling-tolerant like scope file ids.
 * KEEP IN SYNC with pins.rs::add.
 */
export function addPin(
  question: string,
  sql: string,
  fileIds: string[],
  investigationId?: string,
): Pin {
  const q = question.trim();
  const s = sql.trim();
  if (!q || !s) throw new Error("a pin needs the question and its SQL");
  const pins = listPins();
  const id = pinId(s);
  const kept = pins.filter((p) => p.id !== id);
  if (kept.length >= MAX_PINS) {
    throw new Error(`pin limit reached (${MAX_PINS}) — remove one in the pins dialog first`);
  }
  const inv = investigationId?.trim();
  const pin: Pin = {
    id,
    question: q,
    sql: s,
    fileIds,
    createdMs: Date.now(),
    ...(inv ? { investigationId: inv } : {}),
  };
  kept.push(pin);
  save(kept);
  return pin;
}

/** Remove a pin by id (idempotent). */
export function removePin(id: string): void {
  save(listPins().filter((p) => p.id !== id));
}
