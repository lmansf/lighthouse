/**
 * Briefings, TS twin (openspec: add-briefings). KEEP IN SYNC with native
 * briefings.rs: same shapes (camelCase on the wire), same briefings.json store
 * idiom (load-or-empty on corruption, atomic temp+rename), same cap, same
 * title-stable id, same `due` scheduling math.
 *
 * PARITY: composing a report re-runs each pin's SQL through DataFusion, which
 * lives in the Rust engine only. This dev twin has no query engine, so `run`
 * composes from each pin's last known summary (or a note that the pin was
 * removed) — CRUD and the pure `due` decision are byte-identical.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { stateDir } from "./config";
import { listPins } from "./pins";

/** A working set of briefings, not a reporting suite. */
export const MAX_BRIEFINGS = 20;

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

export type Cadence = "manual" | "daily" | "weekly";

export interface Briefing {
  id: string;
  title: string;
  pinIds: string[];
  cadence: Cadence;
  lastRunMs?: number;
  createdMs: number;
}

export interface BriefingSection {
  question: string;
  markdown: string;
  error?: string;
}

export interface BriefingReport {
  id: string;
  title: string;
  generatedMs: number;
  sections: BriefingSection[];
}

function briefingsPath(): string {
  return path.join(stateDir(), "briefings.json");
}

/** All briefings, oldest first. A missing or corrupt store reads as empty. */
export function listBriefings(): Briefing[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(briefingsPath(), "utf8")) as {
      briefings?: Briefing[];
    };
    return Array.isArray(parsed.briefings) ? parsed.briefings : [];
  } catch {
    return [];
  }
}

function save(briefings: Briefing[]): void {
  const target = briefingsPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ briefings }, null, 2));
  fs.renameSync(tmp, target);
}

/** Stable id from the (lowercased) title — re-saving the same title replaces. */
function briefingId(title: string): string {
  return `brief-${crypto.createHash("sha1").update(title.toLowerCase()).digest("hex").slice(0, 12)}`;
}

function intervalMs(cadence: Cadence): number | null {
  return cadence === "daily" ? DAY_MS : cadence === "weekly" ? WEEK_MS : null;
}

/** Create or replace a briefing. Throws with a human-readable reason on bad input. */
export function addBriefing(title: string, pinIds: string[], cadence: Cadence): Briefing {
  const t = title.trim();
  if (!t) throw new Error("a briefing needs a title");
  const ids = pinIds.filter((p) => p.trim());
  if (ids.length === 0) throw new Error("a briefing needs at least one pinned question");
  const briefings = listBriefings();
  const id = briefingId(t);
  const existing = briefings.find((b) => b.id === id);
  const kept = briefings.filter((b) => b.id !== id);
  if (kept.length >= MAX_BRIEFINGS) {
    throw new Error(`briefing limit reached (${MAX_BRIEFINGS}) — remove one first`);
  }
  const briefing: Briefing = {
    id,
    title: t,
    pinIds: ids,
    cadence,
    createdMs: existing?.createdMs ?? Date.now(),
  };
  if (existing?.lastRunMs !== undefined) briefing.lastRunMs = existing.lastRunMs;
  kept.push(briefing);
  save(kept);
  return briefing;
}

/** Remove a briefing by id (idempotent). */
export function removeBriefing(id: string): void {
  save(listBriefings().filter((b) => b.id !== id));
}

function markRun(id: string): void {
  const briefings = listBriefings();
  const b = briefings.find((x) => x.id === id);
  if (b) {
    b.lastRunMs = Date.now();
    save(briefings);
  }
}

/**
 * Briefings due to regenerate at `now`: a scheduled briefing never run, or one
 * whose cadence interval has elapsed. Pure (mirrors briefings.rs `due`).
 */
export function dueBriefings(now: number): string[] {
  return listBriefings()
    .filter((b) => {
      const interval = intervalMs(b.cadence);
      if (interval === null) return false;
      return b.lastRunMs === undefined || now - b.lastRunMs >= interval;
    })
    .map((b) => b.id);
}

/**
 * Compose a briefing report. PARITY: this engine can't re-run SQL, so each
 * section carries the pin's last known summary (or a removed-pin note); the
 * Rust engine re-executes the queries for a live report. Returns null for an
 * unknown id.
 */
export function runBriefing(id: string): BriefingReport | null {
  const briefing = listBriefings().find((b) => b.id === id);
  if (!briefing) return null;
  const pins = listPins();
  const sections: BriefingSection[] = briefing.pinIds.map((pid) => {
    const pin = pins.find((p) => p.id === pid);
    if (!pin) {
      return {
        question: `(removed pin ${pid})`,
        markdown: "",
        error: "this pinned question was removed",
      };
    }
    return {
      question: pin.question,
      markdown: pin.lastSummary ?? "",
      error: pin.lastSummary ? undefined : "no computed result yet (open on the desktop app)",
    };
  });
  markRun(id);
  return { id: briefing.id, title: briefing.title, generatedMs: Date.now(), sections };
}
