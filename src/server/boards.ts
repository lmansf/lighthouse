/**
 * Boards, TS twin (openspec: add-boards). KEEP IN SYNC with native
 * boards.rs: same record shape (camelCase on the wire, `investigationId`
 * omitted for global boards), same versioned envelope `{v: 1, boards:
 * [...]}` written with the shared atomic writer, same validation and error
 * strings (per-scope case-insensitive name uniqueness, S|M|L size
 * whitelist, pin ids only checked non-empty — existence deliberately NOT
 * enforced, tombstone-tolerant), same id minting, and the same lazy virtual
 * defaults (`default-global` / `default-<invId>`, createdMs 0 = never
 * persisted) that materialize under their deterministic id on first
 * mutation.
 *
 * Versioning posture (user data, not a cache): `v == 1` loads; an unknown
 * or missing version — or unparseable JSON — loads EMPTY for the session,
 * and the first subsequent write renames the unreadable file to
 * `boards.json.bak-<epochms>` before writing a fresh v1 envelope. Nothing
 * is silently clobbered.
 *
 * PARITY: refreshBoardCards answers from STORED pin state (`live: false`) —
 * analytics/DataFusion is Rust-engine-only (the pins.ts precedent), so the
 * twin never executes SQL; boards.rs::refresh_cards computes live results
 * through the same guarded run_direct path as pin rechecks.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { stateDir, writeJson } from "./config";
import { listInvestigations } from "./investigations";
import { listPins } from "./pins";

/** Envelope version this engine reads and writes. */
const STORE_VERSION = 1;

/** The global default board's deterministic id (see boards.rs). */
export const GLOBAL_DEFAULT_BOARD_ID = "default-global";
/** The global default board's display name. */
export const GLOBAL_DEFAULT_BOARD_NAME = "My board";

/** Card footprint on the responsive grid — the whole whitelist. */
export type BoardCardSize = "S" | "M" | "L";

/**
 * One ordered card: a pin reference plus its size. The pin id is stored as
 * given — dangling-tolerant like scope file ids (an id naming nothing
 * renders as a tombstone; it never corrupts the board).
 */
export interface BoardCardRef {
  pinId: string;
  size: BoardCardSize;
}

export interface Board {
  /**
   * Engine-minted, stable: `board-` + first 12 hex chars of
   * sha1(name \n scope \n createdMs) for created boards (see boardId), or
   * the deterministic `default-…` id for materialized defaults. NOT derived
   * from the current name — rename keeps the id.
   */
  id: string;
  /** Display name, unique case-insensitively WITHIN its scope. */
  name: string;
  /**
   * The investigation this board belongs to; absent = the global scope
   * (mirrors `Pin.investigationId`). Omitted when absent so global boards
   * round-trip byte-identically.
   */
  investigationId?: string;
  /** Ordered card references — order IS the layout order. */
  cards: BoardCardRef[];
  /** Creation instant; 0 on a VIRTUAL default (never persisted yet). */
  createdMs: number;
}

/**
 * One card's answer from the `refreshCards` action. `live` is the engine's
 * mode, uniform across every card of a response: `false` here (stored pin
 * state — PARITY: analytics is Rust-engine-only), `true` on the Rust
 * engines (computed now via run_direct). Absent fields are omitted, so the
 * wire shape stays identical between the engines — this twin fills the
 * stored-state fields, the Rust engine the computed ones.
 */
export interface BoardCardRefresh {
  pinId: string;
  live: boolean;
  /** The pin no longer exists — render the tombstone card ("pin removed"). */
  tombstone?: boolean;
  question?: string;
  /** Rust-engine-only: fresh narration-capped result table. */
  markdown?: string;
  /** Rust-engine-only: chart spec when the result is chartable. */
  chart?: string;
  /** Rust-engine-only: the engine freshness/provenance footer. */
  footer?: string;
  /** Rust-engine-only: full-fidelity digest of the computed result. */
  resultDigest?: string;
  lastRunMs?: number;
  /** Rust-engine-only: run_direct failure, shown staleReason-style. */
  error?: string;
  /** Twin: the pin's stored compact summary, as of the last real recheck. */
  lastSummary?: string;
  /** Twin: the pin's stored digest, as of the last real recheck. */
  lastDigest?: string;
  /** Twin: why the last recheck couldn't run, verbatim from the store. */
  staleReason?: string;
}

function boardsPath(): string {
  return path.join(stateDir(), "boards.json");
}

/**
 * A readable v1 envelope's records, or `null` when the text is not one
 * (unknown/missing version, or unparseable JSON — the two read identically,
 * see the module's versioning posture). PARITY: this twin trusts the
 * records array wholesale once the envelope checks pass; the Rust engine's
 * serde also rejects records with malformed required fields — engine-
 * written files always carry every field, so the twins agree on every file
 * they write.
 */
function parseStore(text: string): Board[] | null {
  try {
    const parsed = JSON.parse(text) as { v?: unknown; boards?: unknown } | null;
    if (parsed && parsed.v === STORE_VERSION && Array.isArray(parsed.boards)) {
      return parsed.boards as Board[];
    }
  } catch {
    /* fall through — unparseable is unreadable */
  }
  return null;
}

type Loaded =
  | { kind: "records"; records: Board[] }
  | { kind: "missing" }
  // Present but not a readable v1 envelope — reads empty for the session;
  // the next write baks the file first (never clobber silently).
  | { kind: "unreadable" };

function load(): Loaded {
  let text: string;
  try {
    text = fs.readFileSync(boardsPath(), "utf8");
  } catch {
    return { kind: "missing" };
  }
  const records = parseStore(text);
  return records ? { kind: "records", records } : { kind: "unreadable" };
}

/**
 * All PERSISTED boards, creation order. A missing store reads empty; an
 * unreadable one reads empty FOR THE SESSION (see save's bak-on-write).
 * Virtual defaults are a read-time synthesis of `listBoards`, never records.
 */
export function listBoardRecords(): Board[] {
  const loaded = load();
  return loaded.kind === "records" ? loaded.records : [];
}

function save(records: Board[]): void {
  const target = boardsPath();
  // Versioning posture: an unreadable file (unknown/missing version, corrupt
  // JSON) is preserved as a `.bak-<epochms>` sibling before the fresh v1
  // write — a downgrade or corruption never silently clobbers newer data.
  // Rename, falling back to copy, both best-effort (mirrors boards.rs).
  if (load().kind === "unreadable") {
    const bak = `${target}.bak-${Date.now()}`;
    try {
      fs.renameSync(target, bak);
    } catch {
      try {
        fs.copyFileSync(target, bak);
      } catch {
        /* best-effort — the write below still lands */
      }
    }
  }
  writeJson(target, { v: STORE_VERSION, boards: records });
}

/**
 * The deterministic id a scope's lazy default carries, virtual or
 * materialized: `default-global` for the global scope, `default-<invId>`
 * for an investigation — so the client can mutate exactly what a listing
 * returned (the first mutation persists the record under this exact id).
 */
export function defaultBoardId(investigationId?: string): string {
  return investigationId ? `default-${investigationId}` : GLOBAL_DEFAULT_BOARD_ID;
}

/**
 * The scope + default display name a never-persisted default id names, or
 * `null` when the id is not a valid virtual default: a scoped default only
 * resolves while its investigation exists (the name comes from it, and the
 * id can only have been obtained from a listing that synthesized it).
 */
function defaultScope(id: string): { scope?: string; name: string } | null {
  if (id === GLOBAL_DEFAULT_BOARD_ID) return { name: GLOBAL_DEFAULT_BOARD_NAME };
  if (!id.startsWith("default-")) return null;
  const inv = listInvestigations().find((r) => r.id === id.slice("default-".length));
  return inv ? { scope: inv.id, name: inv.name } : null;
}

/**
 * A scope's virtual default: deterministic id, empty cards, createdMs 0
 * (= never persisted). Synthesized at read time only — nothing writes.
 * Field order matches the Rust struct so materialized records serialize
 * identically: id, name, investigationId?, cards, createdMs.
 */
function virtualDefault(scope: string | undefined, name: string): Board {
  return {
    id: defaultBoardId(scope),
    name,
    ...(scope ? { investigationId: scope } : {}),
    cards: [],
    createdMs: 0,
  };
}

function cloneBoard(b: Board): Board {
  return { ...b, cards: b.cards.map((c) => ({ ...c })) };
}

/**
 * The `{op:"boards", action:"list"}` read. A given `investigationId`
 * filters to the boards scoped to that investigation; absent — or blank at
 * the dispatch layer — is "all", the `listPins` convention exactly. KEEP IN
 * SYNC with boards.rs::list_for.
 *
 * Lazy defaults ride on top of the persisted records (appended after them,
 * deterministic order): a requested scope with no persisted board yields
 * its virtual default — for "all" that means the global "My board" plus one
 * default per stored investigation that has no board of its own (archived
 * investigations included; the caller filters, exactly as the
 * investigations listing leaves archived records in). An unknown
 * investigation id yields no virtual (there is no record to name it
 * after) — dangling filters simply match nothing, as with pins.
 */
export function listBoards(investigationId?: string): Board[] {
  const records = listBoardRecords();
  if (investigationId !== undefined) {
    const out = records
      .filter((b) => b.investigationId === investigationId)
      .map(cloneBoard);
    if (out.length === 0) {
      const inv = listInvestigations().find((r) => r.id === investigationId);
      if (inv) out.push(virtualDefault(inv.id, inv.name));
    }
    return out;
  }
  const out = records.map(cloneBoard);
  if (!records.some((b) => b.investigationId === undefined)) {
    out.push(virtualDefault(undefined, GLOBAL_DEFAULT_BOARD_NAME));
  }
  for (const inv of listInvestigations()) {
    if (!records.some((b) => b.investigationId === inv.id)) {
      out.push(virtualDefault(inv.id, inv.name));
    }
  }
  return out;
}

/**
 * Stable engine-minted id for a CREATED board: `board-` + first 12 hex
 * chars of sha1(name \n scope \n createdMs). The scope rides in the hash so
 * same-named boards created in different scopes within the same millisecond
 * can't collide; the `board-` prefix keeps minted ids disjoint from the
 * `default-…` namespace. KEEP IN SYNC with boards.rs::board_id.
 */
function boardId(name: string, scope: string | undefined, createdMs: number): string {
  return `board-${crypto
    .createHash("sha1")
    .update(`${name}\n${scope ?? ""}\n${createdMs}`)
    .digest("hex")
    .slice(0, 12)}`;
}

/**
 * Case-insensitive name collision test WITHIN one scope, optionally
 * excluding one record (rename may keep — or case-change — its own name).
 * The global scope and each investigation validate separately: "Ops" may
 * exist globally AND inside an investigation.
 */
function nameTaken(
  records: Board[],
  name: string,
  scope: string | undefined,
  excludingId?: string,
): boolean {
  const wanted = name.toLowerCase();
  return records.some(
    (r) =>
      r.id !== excludingId &&
      r.investigationId === scope &&
      r.name.toLowerCase() === wanted,
  );
}

/**
 * Parse the wire's `cards` value into typed refs — the shared validation
 * front door for `setCards`, so the route rejects with the SAME
 * human-readable reasons the Rust dispatch layers use (KEEP IN SYNC:
 * boards.rs::parse_cards, byte-identical errors). Pin ids are only checked
 * non-empty — existence is deliberately not enforced (tombstone-tolerant).
 */
export function parseBoardCards(value: unknown): BoardCardRef[] {
  if (!Array.isArray(value)) {
    throw new Error("cards must be an array of {pinId, size}");
  }
  return value.map((item) => {
    const raw = (item ?? {}) as { pinId?: unknown; size?: unknown };
    const pinId = typeof raw.pinId === "string" ? raw.pinId.trim() : "";
    if (!pinId) throw new Error("every card needs a pinId");
    if (raw.size !== "S" && raw.size !== "M" && raw.size !== "L") {
      throw new Error('card size must be "S", "M", or "L"');
    }
    return { pinId, size: raw.size };
  });
}

/**
 * Create a board. The name must be non-empty and unique case-insensitively
 * WITHIN its scope; a blank/absent `investigationId` means the global
 * scope. The id is stored as given, dangling-tolerant like a pin's
 * membership. Throws with a human-readable reason. KEEP IN SYNC with
 * boards.rs::create.
 */
export function createBoard(name: string, investigationId?: string): Board {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("a board needs a name");
  const scope = investigationId?.trim() || undefined;
  const records = listBoardRecords();
  if (nameTaken(records, trimmed, scope)) {
    throw new Error(`a board named "${trimmed}" already exists`);
  }
  const createdMs = Date.now();
  const board: Board = {
    id: boardId(trimmed, scope, createdMs),
    name: trimmed,
    ...(scope ? { investigationId: scope } : {}),
    cards: [],
    createdMs,
  };
  records.push(board);
  save(records);
  return cloneBoard(board);
}

/**
 * Rename in place — same per-scope uniqueness rule as create (a case change
 * of the record's own name is allowed). Renaming a VIRTUAL default
 * materializes it under the new name (first mutation persists); the
 * deterministic id is kept, so a rename never invalidates what a listing
 * returned. KEEP IN SYNC with boards.rs::rename.
 */
export function renameBoard(id: string, newName: string): Board {
  const trimmed = newName.trim();
  if (!trimmed) throw new Error("a board needs a name");
  const records = listBoardRecords();
  const rec = records.find((r) => r.id === id);
  if (rec) {
    if (nameTaken(records, trimmed, rec.investigationId, id)) {
      throw new Error(`a board named "${trimmed}" already exists`);
    }
    rec.name = trimmed;
    save(records);
    return cloneBoard(rec);
  }
  // First mutation of a virtual default materializes it — under the NEW
  // name (validated like create), empty cards, the same deterministic id.
  const virtual = defaultScope(id);
  if (!virtual) throw new Error("board not found");
  if (nameTaken(records, trimmed, virtual.scope)) {
    throw new Error(`a board named "${trimmed}" already exists`);
  }
  const board: Board = {
    id,
    name: trimmed,
    ...(virtual.scope ? { investigationId: virtual.scope } : {}),
    cards: [],
    createdMs: Date.now(),
  };
  records.push(board);
  save(records);
  return cloneBoard(board);
}

/**
 * Delete a board record. Deleting a scope's default — materialized or still
 * virtual — is always effectively a RESET: the record (if any) goes, and
 * the next listing synthesizes a fresh empty virtual default for the scope
 * again; a never-persisted virtual id is therefore an Ok no-op. Unknown ids
 * throw ("board not found"). Cards are references, so deletion never
 * touches any pin. KEEP IN SYNC with boards.rs::delete.
 */
export function deleteBoard(id: string): void {
  const records = listBoardRecords();
  const kept = records.filter((r) => r.id !== id);
  if (kept.length !== records.length) {
    save(kept);
    return;
  }
  if (defaultScope(id)) return; // virtual default: nothing persisted
  throw new Error("board not found");
}

/**
 * Replace a board's card list wholesale — the ONE mutation for reorder,
 * resize, add, and remove alike (atomic full-list replace; no per-card
 * deltas to interleave). Pin ids are NOT validated against pins.json
 * (tombstone-tolerant), and removing a card never touches the pin.
 * Targeting a VIRTUAL default id materializes it (first mutation persists)
 * under the scope's default name, validated like create. KEEP IN SYNC with
 * boards.rs::set_cards.
 */
export function setBoardCards(id: string, cards: BoardCardRef[]): Board {
  if (cards.some((c) => !c.pinId.trim())) {
    throw new Error("every card needs a pinId");
  }
  const records = listBoardRecords();
  const rec = records.find((r) => r.id === id);
  if (rec) {
    rec.cards = cards.map((c) => ({ ...c }));
    save(records);
    return cloneBoard(rec);
  }
  const virtual = defaultScope(id);
  if (!virtual) throw new Error("board not found");
  if (nameTaken(records, virtual.name, virtual.scope)) {
    throw new Error(`a board named "${virtual.name}" already exists`);
  }
  const board: Board = {
    id,
    name: virtual.name,
    ...(virtual.scope ? { investigationId: virtual.scope } : {}),
    cards: cards.map((c) => ({ ...c })),
    createdMs: Date.now(),
  };
  records.push(board);
  save(records);
  return cloneBoard(board);
}

/**
 * The `{op:"boards", action:"refreshCards"}` answer, twin edition. PARITY
 * (the pins.ts precedent): analytics/DataFusion is Rust-engine-only, so
 * this twin NEVER executes SQL — each card answers with the pin's STORED
 * state from pins.json (lastSummary/lastDigest/lastRunMs/staleReason, as of
 * the last real recheck), marked `live: false` so the UI labels freshness
 * honestly ("checked <relative>") and offers Ask-again through the normal
 * ask path. Unknown pins answer as tombstones. KEEP IN SYNC with
 * boards.rs::refresh_cards (live: true, computed via run_direct + the
 * shared recheck write-back).
 */
export function refreshBoardCards(pinIds: string[]): BoardCardRefresh[] {
  const pins = listPins();
  return pinIds.map((pinId) => {
    const pin = pins.find((p) => p.id === pinId);
    if (!pin) return { pinId, live: false, tombstone: true };
    return {
      pinId,
      live: false,
      question: pin.question,
      ...(pin.lastRunMs !== undefined ? { lastRunMs: pin.lastRunMs } : {}),
      ...(pin.lastSummary !== undefined ? { lastSummary: pin.lastSummary } : {}),
      ...(pin.lastDigest !== undefined ? { lastDigest: pin.lastDigest } : {}),
      ...(pin.staleReason !== undefined ? { staleReason: pin.staleReason } : {}),
    };
  });
}
