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

/**
 * §39 §5: the running app's version — the state-file guard's reference point.
 * PARITY with config.rs::app_version: npm_package_version (set under npm
 * scripts) wins; otherwise the repo's package.json stamp.
 */
export function appVersion(): string {
  const env = process.env.npm_package_version?.trim();
  if (env) return env;
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const STATE_FILE = "state.json";
export const PROFILE_FILE = "profile.json";

export function statePath(): string {
  return path.join(stateDir(), STATE_FILE);
}

export function profilePath(): string {
  return path.join(stateDir(), PROFILE_FILE);
}

/**
 * Install-global state (license, identity, contact, launch telemetry) that
 * must persist across vault switches. A trial/subscription belongs to the
 * user's install, not to whichever folder happens to be the vault — storing it
 * in-vault meant "Choose vault folder…" re-pointed the engine at a folder with
 * no license and silently signed the user out. Same rule the profile and
 * connector credentials already follow (see connectorsDir). The desktop shell
 * sets LIGHTHOUSE_APP_STATE_DIR to its private data dir; plain web/dev falls
 * back to the in-vault state dir for parity.
 */
export function appStateDir(): string {
  const override = process.env.LIGHTHOUSE_APP_STATE_DIR?.trim();
  if (override) {
    fs.mkdirSync(override, { recursive: true });
    return override;
  }
  return stateDir();
}

/** The single logical source id for the local vault folder. */
export const VAULT_SOURCE_ID = "vault";

/** The logical source id for the Microsoft SharePoint / OneDrive connector. */
export const SHAREPOINT_SOURCE_ID = "sharepoint";

/**
 * Public Microsoft Entra (Azure AD) application client id for the SharePoint
 * connector. This is a *public* PKCE/device-code client — it carries no secret,
 * so shipping it in the app is expected and safe. Overridable via env for
 * self-hosters who register their own app.
 */
export const SHAREPOINT_CLIENT_ID =
  process.env.SHAREPOINT_CLIENT_ID?.trim() || "d25817ff-a0ed-4458-9282-41a18ce6d48a";

/**
 * Entra authority. The base (`/common`) lets any work/school or personal
 * account sign in; the device-code flow appends `/oauth2/v2.0/devicecode` and
 * `/token` to it (see sources/microsoft/auth.ts). Overridable for self-hosters
 * who pin a single tenant.
 */
export const SHAREPOINT_AUTHORITY =
  process.env.SHAREPOINT_AUTHORITY?.trim() || "https://login.microsoftonline.com/common";

/**
 * Native-client redirect URI registered on the Entra app. The device-code flow
 * this connector uses does NOT need a redirect (the user approves in a browser
 * and the app polls for the token), so this is recorded only to mirror the
 * Azure app registration — and for a future interactive (auth-code + PKCE)
 * flow. MSAL's convention for a public desktop client is `msal<clientId>://auth`.
 */
export const SHAREPOINT_REDIRECT_URI =
  process.env.SHAREPOINT_REDIRECT_URI?.trim() || `msal${SHAREPOINT_CLIENT_ID}://auth`;

/**
 * Per-connector state directory (OAuth tokens, mirrored content, inclusion).
 * Lives beside the vault state, never inside the repo or the app bundle.
 */
export function connectorsDir(): string {
  // OAuth refresh/access tokens live here. Prefer a location OUTSIDE the vault:
  // the vault defaults to the user's Documents folder, which is routinely synced
  // to OneDrive/iCloud and swept into backups — a long-lived credential should
  // not ride along. The desktop shell sets LIGHTHOUSE_CONNECTORS_DIR to its
  // private userData dir; plain web/dev falls back to the in-vault path.
  const override = process.env.LIGHTHOUSE_CONNECTORS_DIR?.trim();
  const dir = override || path.join(stateDir(), "connectors");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * True only when running inside the packaged desktop app (the shell sets this).
 * Linking files in place reads arbitrary absolute paths, so it is gated to the
 * desktop build and never exposed by a plain web deployment.
 */
export function isDesktopApp(): boolean {
  return process.env.LIGHTHOUSE_DESKTOP === "1";
}

/**
 * The ONE engine-reported platform signal (iOS field patch 1 §1): the form
 * factor this engine runs on. PARITY: mirrors config.rs::platform_kind, where
 * the value is baked in at compile time (cfg!(target_os)). The TS twin only
 * ever runs in the web dev flow on a computer, so its value is the constant
 * "desktop" — kept as a function (not a literal at call sites) so the twins'
 * capability payloads and platform verdicts (localModel.ts, profile.ts,
 * synth.ts) stay line-parallel with the Rust engine's.
 */
export function platformKind(): "desktop" | "ios" | "android" {
  return "desktop";
}

/**
 * Root of the bundled offline resources (the local model).
 * The desktop shell sets LIGHTHOUSE_RESOURCES_PATH to its bundled resources dir
 * in the packaged app; otherwise we fall back to `./resources` in the repo so it
 * works under `npm run dev`/tests too.
 */
export function resourcesDir(): string {
  return process.env.LIGHTHOUSE_RESOURCES_PATH?.trim() || path.join(process.cwd(), "resources");
}

/** Read a JSON file, returning `fallback` if it is missing or unparseable. */
export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

let writeCounter = 0;

/**
 * Write a JSON file atomically and durably. These files hold private state —
 * OAuth tokens, the model API key, and vault inclusion/reference curation — so:
 *   - create the temp file with owner-only (0600) permissions so it isn't
 *     group/world-readable on POSIX;
 *   - fsync the data before rename and fsync the directory after, so a crash or
 *     power-loss can't leave torn reads or silently lose the just-written state.
 */
export function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.${writeCounter++}.tmp`;
  const data = JSON.stringify(value, null, 2);
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeFileSync(fd, data, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  // Make the rename itself durable. Directory fsync isn't supported everywhere
  // (e.g. Windows), so this is best-effort.
  try {
    const dir = fs.openSync(path.dirname(file), "r");
    try {
      fs.fsyncSync(dir);
    } finally {
      fs.closeSync(dir);
    }
  } catch {
    /* directory fsync unsupported on this platform — the data fsync above still holds */
  }
}
