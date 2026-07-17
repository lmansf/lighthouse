/**
 * Investigations, TS twin (openspec: add-investigations). KEEP IN SYNC with
 * native investigations.rs: same record shape (camelCase on the wire), same
 * versioned envelope `{v: 1, investigations: [...]}` written with the shared
 * atomic writer, same validation (non-empty name, case-insensitive
 * uniqueness across archived records, sanitized traversal-safe folder name),
 * same pins-style id minting, and the same history-posture gate on
 * conversation refs (persistAllowed AND managed policy — either false ⇒
 * silent no-op).
 *
 * Versioning posture (user data, not a cache): `v == 1` loads; an unknown or
 * missing version — or unparseable JSON — loads EMPTY for the session, and
 * the first subsequent write renames the unreadable file to
 * `investigations.json.bak-<epochms>` before writing a fresh v1 envelope.
 * Nothing is silently clobbered.
 *
 * An investigation persists STRUCTURE only. Pin and note membership are
 * DERIVED at read time (pins carry `investigationId`; notes live under the
 * investigation's folder) — §1 returns them empty. Transcripts never touch
 * the engine; a conversation ref is an id the client minted, nothing more.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { stateDir, writeJson } from "./config";
import { listPins } from "./pins";
import { historyAllowed } from "./policy";
import { localModelConfig } from "./profile";
import { listNodes } from "./vault";
import type { ModelCfg } from "./synth";

/** Envelope version this engine reads and writes. */
const STORE_VERSION = 1;

/**
 * Provider posture for every ask inside the investigation: "local-only"
 * forces the private path at the model-config chokepoint (§2 wires it);
 * "default" follows the profile's active provider.
 */
export type InvestigationProviderPolicy = "default" | "local-only";

export interface Investigation {
  /**
   * Engine-minted, stable (pins-style sha, see investigationId): `inv-` +
   * first 12 hex chars of sha1(name + createdMs). NOT derived from the
   * current name — rename keeps the id, and re-creating a same-named
   * investigation later mints a fresh one.
   */
  id: string;
  /** Display name, unique case-insensitively (archived records included). */
  name: string;
  createdMs: number;
  /** Archive hides, never deletes: a visibility flag with no cascade. */
  archived: boolean;
  /** Vault node ids; empty = whole vault. Dangling ids are harmless (§2). */
  scopeFileIds: string[];
  providerPolicy: InvestigationProviderPolicy;
  /** Opaque client Conversation.id values — refs, never transcripts. */
  conversationRefs: string[];
  /**
   * Folder name for exported notes, sanitized (traversal-safe) at CREATION
   * time and never moved by rename — membership = location (§3 derives note
   * refs from it and routes `exportChat` under it; §1 only records it).
   */
  folderName: string;
}

/**
 * Read-time enriched view the `investigations` op returns: the record plus
 * DERIVED memberships (§3) — `pinRefs` from pins.json (the ids of pins
 * carrying `Pin.investigationId == id`), `noteRefs` from the investigation's
 * folder under `Lighthouse Notes/` (a prefix scan of the walk: membership =
 * location). Nothing here is stored on the record — no two-way bookkeeping
 * to drift.
 */
export interface InvestigationView extends Investigation {
  pinRefs: string[];
  noteRefs: string[];
}

function investigationsPath(): string {
  return path.join(stateDir(), "investigations.json");
}

/**
 * A readable v1 envelope's records, or `null` when the text is not one
 * (unknown/missing version, or unparseable JSON — the two read identically,
 * see design.md's versioning posture). PARITY: this twin trusts the records
 * array wholesale once the envelope checks pass; the Rust engine's serde
 * also rejects records with malformed required fields — engine-written files
 * always carry every field, so the twins agree on every file they write.
 */
function parseStore(text: string): Investigation[] | null {
  try {
    const parsed = JSON.parse(text) as { v?: unknown; investigations?: unknown } | null;
    if (parsed && parsed.v === STORE_VERSION && Array.isArray(parsed.investigations)) {
      return parsed.investigations as Investigation[];
    }
  } catch {
    /* fall through — unparseable is unreadable */
  }
  return null;
}

type Loaded =
  | { kind: "records"; records: Investigation[] }
  | { kind: "missing" }
  // Present but not a readable v1 envelope — reads empty for the session;
  // the next write baks the file first (never clobber silently).
  | { kind: "unreadable" };

function load(): Loaded {
  let text: string;
  try {
    text = fs.readFileSync(investigationsPath(), "utf8");
  } catch {
    return { kind: "missing" };
  }
  const records = parseStore(text);
  return records ? { kind: "records", records } : { kind: "unreadable" };
}

/**
 * All investigations, creation order. A missing store reads empty; an
 * unreadable one reads empty FOR THE SESSION (see save's bak-on-write).
 * Archived records are included — the caller filters (archive hides in the
 * nav, never in the store).
 */
export function listInvestigations(): Investigation[] {
  const loaded = load();
  return loaded.kind === "records" ? loaded.records : [];
}

/**
 * Enrich one record for the wire (§3): memberships are DERIVED at read time,
 * never stored. `pinRefs` = ids of pins whose `investigationId` is this
 * record's id (pins.json is the source of truth, oldest first); `noteRefs` =
 * file ids under `Lighthouse Notes/<folderName>/` (a prefix scan of the
 * cached walk — membership = location, so a note moved out of the folder
 * simply stops being a member). An unusable stored folder name (tampered
 * store) derives NO notes rather than scanning a wrong prefix. PARITY:
 * investigations.rs::view.
 */
export function investigationView(record: Investigation): InvestigationView {
  const pinRefs = listPins()
    .filter((p) => p.investigationId === record.id)
    .map((p) => p.id);
  const folder = notesFolderSegment(record);
  let noteRefs: string[] = [];
  if (folder) {
    const prefix = `Lighthouse Notes/${folder}/`;
    noteRefs = listNodes()
      .filter((n) => n.kind === "file" && n.id.startsWith(prefix))
      .map((n) => n.id);
  }
  return { ...record, pinRefs, noteRefs };
}

/** Every record, enriched for the `{op:"investigations", action:"list"}` op. */
export function investigationsListing(): InvestigationView[] {
  return listInvestigations().map(investigationView);
}

function save(records: Investigation[]): void {
  const target = investigationsPath();
  // Versioning posture: an unreadable file (unknown/missing version, corrupt
  // JSON) is preserved as a `.bak-<epochms>` sibling before the fresh v1
  // write — a downgrade or corruption never silently clobbers newer data.
  // Rename, falling back to copy, both best-effort (mirrors investigations.rs).
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
  writeJson(target, { v: STORE_VERSION, investigations: records });
}

/**
 * Traversal-safe folder name from a display name: path separators (`/`, `\`)
 * stripped, whitespace runs collapsed to single spaces, and a name that is
 * empty or only dots after that (`.`, `..`, `...`) falls back to
 * "Investigation" — the result can never name a parent or nest directories.
 */
function sanitizeFolderName(name: string): string {
  const collapsed = name
    .replace(/[/\\]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
  if (!collapsed || /^\.+$/.test(collapsed)) return "Investigation";
  return collapsed;
}

/**
 * The record's notes-folder SEGMENT, re-validated AT USE (§3): §1's
 * sanitizer guarantees a safe single segment at creation, but the store is a
 * file on disk — a hand-edited `folderName` must not become a write path.
 * `null` when the stored value is unusable: empty, multi-segment (any `/` or
 * `\`), dots-only (`.`/`..`), or the reserved G6 `Chats` segment
 * (case-insensitive) — `Lighthouse Notes/Chats/` means auto-exported
 * conversation notes (recall classifies by that prefix and the save-chats
 * opt-out purges the whole folder), and an investigation folder must never
 * alias it. PARITY: investigations.rs::notes_folder_segment.
 */
function notesFolderSegment(record: Investigation): string | null {
  const folder = record.folderName.trim();
  if (
    !folder ||
    folder.includes("/") ||
    folder.includes("\\") ||
    /^\.+$/.test(folder) ||
    folder.toLowerCase() === "chats"
  ) {
    return null;
  }
  return folder;
}

/**
 * Resolve the `exportChat` destination for an investigation (§3):
 * `Lighthouse Notes/<stored folderName>` — the ONLY way a note reaches an
 * investigation subfolder. The folder is resolved ENGINE-SIDE from the
 * store, never taken from the client, and the segment is re-validated at
 * use (see `notesFolderSegment`), so the write-artifact allowlist extends to
 * exactly the folders of known investigations and nothing else. Errors are
 * human-readable and byte-identical to the Rust twin
 * (investigations.rs::notes_subdir).
 */
export function investigationNotesSubdir(investigationId: string): string {
  const id = investigationId.trim();
  const record = listInvestigations().find((r) => r.id === id);
  if (!record) throw new Error("investigation not found");
  const folder = notesFolderSegment(record);
  if (!folder) throw new Error("investigation folder name is not usable");
  return `Lighthouse Notes/${folder}`;
}

/**
 * Stable engine-minted id (pins-style sha, like pinId): `inv-` + first 12
 * hex chars of sha1(name + createdMs). Deterministic for a given
 * (name, creation instant) and independent of later renames.
 */
function investigationId(name: string, createdMs: number): string {
  return `inv-${crypto.createHash("sha1").update(`${name}${createdMs}`).digest("hex").slice(0, 12)}`;
}

/**
 * Case-insensitive name collision test, optionally excluding one record
 * (rename may keep — or case-change — its own name).
 */
function nameTaken(records: Investigation[], name: string, excludingId?: string): boolean {
  const wanted = name.toLowerCase();
  return records.some((r) => r.id !== excludingId && r.name.toLowerCase() === wanted);
}

/**
 * Create an investigation. The name must be non-empty and unique
 * case-insensitively (archived records count); empty scope means the whole
 * vault. The notes folder name is fixed HERE, at creation — rename never
 * moves notes. Throws with a human-readable reason.
 */
export function createInvestigation(
  name: string,
  scopeFileIds: string[],
  providerPolicy: InvestigationProviderPolicy,
): Investigation {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("an investigation needs a name");
  const records = listInvestigations();
  if (nameTaken(records, trimmed)) {
    throw new Error(`an investigation named "${trimmed}" already exists`);
  }
  const createdMs = Date.now();
  const inv: Investigation = {
    id: investigationId(trimmed, createdMs),
    name: trimmed,
    createdMs,
    archived: false,
    // Keep scope ids as given (dangling ids are fine downstream), minus
    // empty-string noise.
    scopeFileIds: scopeFileIds.filter((s) => s.trim() !== ""),
    providerPolicy,
    conversationRefs: [],
    folderName: sanitizeFolderName(trimmed),
  };
  records.push(inv);
  save(records);
  return { ...inv };
}

/**
 * Rename in place — same uniqueness rule as create (a case change of the
 * record's own name is allowed). `folderName` is deliberately UNCHANGED:
 * membership = location, and rename moves nothing (design.md).
 */
export function renameInvestigation(id: string, newName: string): Investigation {
  const trimmed = newName.trim();
  if (!trimmed) throw new Error("an investigation needs a name");
  const records = listInvestigations();
  if (nameTaken(records, trimmed, id)) {
    throw new Error(`an investigation named "${trimmed}" already exists`);
  }
  const rec = records.find((r) => r.id === id);
  if (!rec) throw new Error("investigation not found");
  rec.name = trimmed;
  save(records);
  return { ...rec };
}

/**
 * Set the archive flag — a visibility toggle ONLY. Nothing cascades: pins,
 * notes, scope, and conversation refs stay on disk untouched, and
 * unarchiving restores the investigation fully.
 */
export function setInvestigationArchived(id: string, archived: boolean): Investigation {
  const records = listInvestigations();
  const rec = records.find((r) => r.id === id);
  if (!rec) throw new Error("investigation not found");
  rec.archived = archived;
  save(records);
  return { ...rec };
}

/**
 * Record a conversation ref (an opaque client Conversation.id). History
 * posture WINS (design.md): the write happens only when the client's
 * `persistAllowed` verdict is true AND the managed policy allows history —
 * either false ⇒ a silent no-op returning the record unchanged, while
 * structure fields (name, scope, policy, archived) persist regardless. Refs
 * dedupe. `&&` short-circuits, so with `persistAllowed` false the policy
 * layer is never even consulted — the same fail-toward-privacy default as
 * the ask path's cache controls.
 */
export function addInvestigationConversationRef(
  id: string,
  conversationId: string,
  persistAllowed: boolean,
): Investigation {
  const ref = conversationId.trim();
  if (!ref) throw new Error("conversationId required");
  const records = listInvestigations();
  const rec = records.find((r) => r.id === id);
  if (!rec) throw new Error("investigation not found");
  if (!(persistAllowed && historyAllowed())) {
    return { ...rec }; // silent no-op — posture wins
  }
  if (!rec.conversationRefs.includes(ref)) {
    rec.conversationRefs.push(ref);
    save(records);
  }
  return { ...rec };
}

// --- Fork + export (openspec: add-automation §4) ----------------------------

/**
 * Fork an investigation into a fresh line of inquiry. Load the parent and mint
 * a FRESH record — new createdMs, new investigationId(newName, createdMs), new
 * sanitizeFolderName (its own id and its own EMPTY notes folder) — copying
 * ONLY the parent's STRUCTURE: scopeFileIds, providerPolicy (a fork of a
 * `local-only` line stays `local-only`), and conversationRefs. Derived
 * membership is DELIBERATELY not duplicated (module doc): pins carry a single
 * investigationId and notes live in ONE folder (membership = location), so a
 * fork is a new line seeded with the parent's scope + conversation context,
 * never a clone of another investigation's members. `newName` is trimmed,
 * non-empty, and unique case-insensitively (archived records count) — the
 * create rule; the fork is NOT archived. Throws with a human-readable reason
 * (blank/duplicate name, missing parent) and persists nothing on failure.
 * PARITY: investigations.rs::fork (same order, same id minting, structure-only
 * copy).
 */
export function forkInvestigation(id: string, newName: string): Investigation {
  const trimmed = newName.trim();
  if (!trimmed) throw new Error("an investigation needs a name");
  const records = listInvestigations();
  const parent = records.find((r) => r.id === id);
  if (!parent) throw new Error("investigation not found");
  if (nameTaken(records, trimmed)) {
    throw new Error(`an investigation named "${trimmed}" already exists`);
  }
  const createdMs = Date.now();
  const inv: Investigation = {
    id: investigationId(trimmed, createdMs),
    name: trimmed,
    createdMs,
    archived: false,
    // Structure only — the parent's scope, policy, and conversation context
    // seed the branch; derived membership (pins/notes) is NOT duplicated.
    scopeFileIds: [...parent.scopeFileIds],
    providerPolicy: parent.providerPolicy,
    conversationRefs: [...parent.conversationRefs],
    folderName: sanitizeFolderName(trimmed),
  };
  records.push(inv);
  save(records);
  return { ...inv };
}

/**
 * Render an investigation to a standalone markdown document — the exportable
 * artifact, reusing the briefings render idiom (`# title`, then `## `
 * sections). The document states the investigation's STRUCTURE and DERIVED
 * membership: name, created time (UTC), archive state, provider policy, scope
 * files (or "whole vault" when empty), conversation refs, the derived pin
 * list, and the derived note list. Conversation refs render by their opaque id
 * — `title (id)` only when the optional `titles` map supplies a non-empty one
 * — and NO transcript text is ever embedded, because the engine deliberately
 * never stores transcripts (module doc): a ref is a pointer, not content.
 * Throws when the id is unknown; nothing is written (a PURE render — the WRITE
 * composes investigationNotesSubdir + writeArtifact at the op). KEEP
 * BYTE-IDENTICAL with investigations.rs::export_markdown /
 * render_investigation_markdown.
 */
export function exportMarkdown(id: string, titles?: Record<string, string>): string {
  const record = listInvestigations().find((r) => r.id === id.trim());
  if (!record) throw new Error("investigation not found");
  return renderInvestigationMarkdown(investigationView(record), titles);
}

/** The byte-pinned render literal (twinned in investigations.rs). Pure — takes
 *  an already-derived view so the render is testable without a store. */
function renderInvestigationMarkdown(
  view: InvestigationView,
  titles?: Record<string, string>,
): string {
  const d = new Date(view.createdMs);
  const p = (n: number) => String(n).padStart(2, "0");
  const created = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(
    d.getUTCHours(),
  )}:${p(d.getUTCMinutes())} UTC`;
  const status = view.archived ? "Archived" : "Active";

  let out = `# ${view.name}\n`;
  out += `\n- Created: ${created}\n- Status: ${status}\n- Provider policy: ${view.providerPolicy}\n`;

  out += "\n## Scope\n\n";
  if (view.scopeFileIds.length === 0) {
    out += "- Whole vault\n";
  } else {
    for (const f of view.scopeFileIds) out += `- ${f}\n`;
  }

  out += "\n## Conversations\n\n";
  if (view.conversationRefs.length === 0) {
    out += "_No conversations._\n";
  } else {
    for (const c of view.conversationRefs) {
      const t = titles ? titles[c] : undefined;
      out += t ? `- ${t} (${c})\n` : `- ${c}\n`;
    }
  }

  out += "\n## Pins\n\n";
  if (view.pinRefs.length === 0) {
    out += "_No pins._\n";
  } else {
    for (const pinId of view.pinRefs) out += `- ${pinId}\n`;
  }

  out += "\n## Notes\n\n";
  if (view.noteRefs.length === 0) {
    out += "_No notes._\n";
  } else {
    for (const n of view.noteRefs) out += `- ${n}\n`;
  }

  return out;
}

// --- Ask-context resolution (§2) --------------------------------------------

/**
 * The pure scope + policy decision for one ask, over an already-loaded
 * record. PARITY: investigations.rs::resolve_scope_and_policy — identical
 * precedence, tested identically in both engines.
 *
 * - No record (`investigationId` absent, or naming nothing in the store) →
 *   passthrough: the request's attachments, no forced-local.
 * - Request attachments non-empty → **they win** (most-specific-wins, the
 *   same precedence philosophy as curation rules); scope is NOT intersected.
 * - Scope non-empty and request attachments empty → attachments := scope,
 *   passed through UNFILTERED — dangling ids (files deleted since scoping)
 *   are harmless because downstream candidate selection ignores unknown ids
 *   and the skip-note honesty machinery counts drops.
 * - An empty scope resolves to empty attachments — the whole vault, exactly
 *   as an attachment-less ask does today.
 * - Archived records resolve like live ones (asking inside an archived
 *   investigation is allowed; archive only hides it from the nav).
 * - `local-only` policy → `forceLocal` true, regardless of how the
 *   attachments resolved.
 */
export function resolveScopeAndPolicy(
  record: Investigation | undefined,
  attachmentFileIds: string[],
): [string[], boolean] {
  if (!record) return [attachmentFileIds, false];
  const attachments =
    attachmentFileIds.length === 0 ? [...record.scopeFileIds] : attachmentFileIds;
  return [attachments, record.providerPolicy === "local-only"];
}

/**
 * Resolve an ask's effective attachments + model config + recall preference.
 * Entry points call this at the SAME chokepoint where `modelConfig()` is
 * consulted today — the identical depth at which the managed policy layer
 * participates in provider resolution (`modelConfig()` → llm-time
 * `providerAllowed`). A `local-only` investigation swaps the resolved config
 * to the local provider HERE, before the pipeline ever sees it: no cloud
 * transport is constructed, `originOf(cfg)` reports "device" and
 * `isCloudProvider` false (the provenance stamp is accurate with no further
 * code), and local-only-marked files stay readable (the private model may
 * read them). The llm-layer `providerAllowed` belt stays untouched beneath;
 * managed `forceLocalOnly` composes — most-restrictive wins because both act
 * on the same cfg.
 *
 * The third element (§3) is the investigation's `conversationRefs`, for the
 * pipeline's recall preference: where a recall cue boosts conversation
 * notes, notes belonging to these conversations get `INVESTIGATION_BOOST` on
 * top — preference, not exclusion. Empty when no (or an unknown)
 * investigation rides the ask. Caller: app/api/chat/route.ts (PARITY:
 * investigations.rs::resolve_ask_context ⇄ routes.rs chat_post /
 * commands.rs chat_ask).
 */
export function resolveAskContext(
  investigationId: string | undefined,
  attachmentFileIds: string[],
  cfg: ModelCfg,
): [string[], ModelCfg, string[]] {
  const id = investigationId?.trim();
  const record = id ? listInvestigations().find((r) => r.id === id) : undefined;
  const [attachments, forceLocal] = resolveScopeAndPolicy(record, attachmentFileIds);
  return [
    attachments,
    forceLocal ? localModelConfig() : cfg,
    record ? [...record.conversationRefs] : [],
  ];
}
