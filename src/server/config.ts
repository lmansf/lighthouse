/**
 * Server-side configuration for the local-first vault.
 *
 * Everything is stored on the local filesystem so RAG Vault runs as a standalone
 * app with no cloud database. The vault is a plain directory of the user's files;
 * derived state (inclusion flags, profile, future index) lives in a hidden
 * `.rag-vault/` subfolder beside the documents.
 */
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

/** Absolute path to the vault directory holding the user's documents. */
export function vaultDir(): string {
  const fromEnv = process.env.VAULT_DIR?.trim();
  const dir = fromEnv
    ? path.resolve(fromEnv.replace(/^~(?=$|\/|\\)/, os.homedir()))
    : path.join(process.cwd(), "vault");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Hidden state directory for inclusion flags, profile, and indexes. */
export function stateDir(): string {
  const dir = path.join(vaultDir(), ".rag-vault");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const STATE_FILE = "state.json";
export const PROFILE_FILE = "profile.json";

export function statePath(): string {
  return path.join(stateDir(), STATE_FILE);
}

export function profilePath(): string {
  return path.join(stateDir(), PROFILE_FILE);
}

/** The single logical source id for the local vault folder. */
export const VAULT_SOURCE_ID = "vault";

/** Read a JSON file, returning `fallback` if it is missing or unparseable. */
export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Write a JSON file atomically (write-temp-then-rename) to avoid torn reads. */
export function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}
