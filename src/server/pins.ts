/**
 * Pinned questions, TS twin (openspec: add-pinned-questions). KEEP IN SYNC
 * with native pins.rs: same Pin shape (camelCase on the wire), same
 * pins.json store idiom (load-or-empty on corruption), same cap and
 * re-pin-replaces semantics.
 *
 * PARITY: rechecks re-run the pinned SQL through DataFusion, which lives in
 * the desktop engine only — the dev server implements CRUD and answers
 * recheck requests with "no changes", leaving summaries as of pin time.
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
}

function pinsPath(): string {
  return path.join(stateDir(), "pins.json");
}

/** All pins, oldest first. A missing or corrupt store reads as empty. */
export function listPins(): Pin[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(pinsPath(), "utf8")) as { pins?: Pin[] };
    return Array.isArray(parsed.pins) ? parsed.pins : [];
  } catch {
    return [];
  }
}

function save(pins: Pin[]): void {
  fs.mkdirSync(path.dirname(pinsPath()), { recursive: true });
  fs.writeFileSync(pinsPath(), JSON.stringify({ pins }, null, 2));
}

/** Stable id from the pinned SQL — re-pinning the same query replaces. */
function pinId(sql: string): string {
  return `pin-${crypto.createHash("sha1").update(sql).digest("hex").slice(0, 12)}`;
}

/** Add (or replace) a pin. Fails past the cap with a human-readable reason. */
export function addPin(question: string, sql: string, fileIds: string[]): Pin {
  const q = question.trim();
  const s = sql.trim();
  if (!q || !s) throw new Error("a pin needs the question and its SQL");
  const pins = listPins();
  const id = pinId(s);
  const kept = pins.filter((p) => p.id !== id);
  if (kept.length >= MAX_PINS) {
    throw new Error(`pin limit reached (${MAX_PINS}) — remove one in the pins dialog first`);
  }
  const pin: Pin = { id, question: q, sql: s, fileIds, createdMs: Date.now() };
  kept.push(pin);
  save(kept);
  return pin;
}

/** Remove a pin by id (idempotent). */
export function removePin(id: string): void {
  save(listPins().filter((p) => p.id !== id));
}
