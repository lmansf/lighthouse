/**
 * Install-global encrypted store for provider API keys (Rust twin:
 * `native/crates/lighthouse-core/src/secrets.rs` — KEEP IN SYNC, the two
 * engines read the same files).
 *
 * Keys used to live as plaintext inside `profile.json`, which (a) was wiped
 * by sign-out, (b) rode along into cloud-synced vault backups in older
 * layouts, and (c) sat readable on disk. They now live here: one
 * `secrets.json` in the install-global app state dir (see config.appStateDir
 * — survives vault switches and sign-out), each key sealed with AES-256-GCM
 * under a per-install random secret (`secret.key`, created on first use).
 * Sealed layout is iv | tag | ciphertext, base64 — the same shape the license
 * module uses, so both engines stay token-compatible.
 *
 * Threat model, honestly: the sealing secret sits beside the ciphertext, so
 * this protects against casual disk/backup/cloud-sync inspection — not
 * against malware running as the user. That matches the app's posture for
 * connector OAuth tokens; an OS-keychain upgrade can slot in behind this API
 * later without changing callers.
 */
import crypto from "node:crypto";
import path from "node:path";
import { appStateDir, readJson, writeJson } from "./config";

const secretsPath = () => path.join(appStateDir(), "secrets.json");
const secretFile = () => path.join(appStateDir(), "secret.key");

interface SecretsFile {
  v: number;
  /** provider-id → base64(iv | tag | ciphertext) of the raw key string. */
  keys: Record<string, string>;
}

const EMPTY: SecretsFile = { v: 1, keys: {} };

/**
 * The per-install sealing secret: 32 random bytes, base64, created once.
 * Stored as a JSON string so writeJson's 0600 + atomic-rename treatment (and
 * the Rust twin's read_json) apply unchanged.
 */
function machineSecret(): string {
  const existing = readJson<string | null>(secretFile(), null);
  if (existing) return existing;
  const s = crypto.randomBytes(32).toString("base64");
  writeJson(secretFile(), s);
  return s;
}

function sealingKey(): Buffer {
  // Node scryptSync defaults (N=16384, r=8, p=1) — same as the Rust twin.
  return crypto.scryptSync(machineSecret(), "lighthouse-secrets-v1", 32);
}

function seal(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", sealingKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

function open(token: string): string | null {
  try {
    const buf = Buffer.from(token, "base64");
    if (buf.length < 28) return null;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", sealingKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Store (or, with an empty key, remove) a provider's API key. Plaintext never
 * touches disk; a garbled store entry simply reads back as unkeyed.
 */
export function setProviderKey(providerId: string, key: string): void {
  const f = { ...EMPTY, ...readJson<SecretsFile>(secretsPath(), EMPTY) };
  const trimmed = key.trim();
  if (!trimmed) {
    delete f.keys[providerId];
  } else {
    f.keys[providerId] = seal(trimmed);
  }
  writeJson(secretsPath(), { ...f, v: 1 });
}

/** The stored key for a provider, if one is saved and intact. */
export function getProviderKey(providerId: string): string | null {
  const f = readJson<SecretsFile>(secretsPath(), EMPTY);
  const token = f.keys?.[providerId];
  if (!token) return null;
  const k = open(token);
  return k ? k : null;
}
