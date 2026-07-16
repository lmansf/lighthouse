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
import { historyAllowed } from "./policy";
import { localModelConfig } from "./profile";
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
   * time and never moved by rename — membership = location (§4 derives note
   * refs from it; §1 only records it).
   */
  folderName: string;
}

/**
 * Read-time enriched view the `investigations` op returns: the record plus
 * DERIVED memberships. §1 returns them empty — §3 derives `pinRefs` from
 * pins.json (`Pin.investigationId`), §4 derives `noteRefs` from the
 * investigation's folder under `Lighthouse Notes/`.
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

/** Enrich one record for the wire (empty derived memberships in §1). */
export function investigationView(record: Investigation): InvestigationView {
  return { ...record, pinRefs: [], noteRefs: [] };
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
 * Resolve an ask's effective attachments + model config. Entry points call
 * this at the SAME chokepoint where `modelConfig()` is consulted today — the
 * identical depth at which the managed policy layer participates in provider
 * resolution (`modelConfig()` → llm-time `providerAllowed`). A `local-only`
 * investigation swaps the resolved config to the local provider HERE, before
 * the pipeline ever sees it: no cloud transport is constructed,
 * `originOf(cfg)` reports "device" and `isCloudProvider` false (the
 * provenance stamp is accurate with no further code), and local-only-marked
 * files stay readable (the private model may read them). The llm-layer
 * `providerAllowed` belt stays untouched beneath; managed `forceLocalOnly`
 * composes — most-restrictive wins because both act on the same cfg.
 * Caller: app/api/chat/route.ts (PARITY: investigations.rs::
 * resolve_ask_context ⇄ routes.rs chat_post / commands.rs chat_ask).
 */
export function resolveAskContext(
  investigationId: string | undefined,
  attachmentFileIds: string[],
  cfg: ModelCfg,
): [string[], ModelCfg] {
  const id = investigationId?.trim();
  const record = id ? listInvestigations().find((r) => r.id === id) : undefined;
  const [attachments, forceLocal] = resolveScopeAndPolicy(record, attachmentFileIds);
  return [attachments, forceLocal ? localModelConfig() : cfg];
}
