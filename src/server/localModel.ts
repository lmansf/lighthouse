/**
 * Optional, on-demand download of the private local model.
 *
 * The private model (Mistral-7B-Instruct-v0.3 Q4_K_M, ~4.2 GB) is too large to
 * bundle in the installer - NSIS installers and GitHub release assets are both
 * capped at 2 GB. So it isn't shipped; instead the user opts in from the model
 * picker (the "＋" next to the private model) and we fetch it once, from Hugging
 * Face, into their data directory. Only public model weights are fetched - no
 * user data ever leaves the machine, preserving the local-first promise.
 *
 * The desktop shell (native/crates/lighthouse-desktop) watches the models
 * directory and starts `llama-server` against the file as soon as it lands,
 * so the private model becomes usable without a restart.
 */
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import https from "node:https";
import { resourcesDir } from "./config";

/** Hugging Face GGUF for the bundled private model (overridable for self-hosters). */
const MODEL_URL =
  process.env.LIGHTHOUSE_LOCAL_MODEL_URL?.trim() ||
  "https://huggingface.co/bartowski/Mistral-7B-Instruct-v0.3-GGUF/resolve/main/Mistral-7B-Instruct-v0.3-Q4_K_M.gguf";
const MODEL_FILE = process.env.LIGHTHOUSE_LOCAL_MODEL_FILE?.trim() || "Mistral-7B-Instruct-v0.3-Q4_K_M.gguf";
/** A real model is hundreds of MB; guards against counting a stub/partial as ready. */
const MIN_BYTES = 1e8;

/** Marker file the desktop shell watches to perform an uninstall (see requestUninstall). */
const UNINSTALL_MARKER = ".uninstall";

/**
 * Where NEW downloads are written. In the packaged app the desktop shell sets
 * LIGHTHOUSE_MODELS_DIR to `<userData>/models` (writable, survives updates); in
 * dev we fall back to `resources/llm` so a locally fetched model still works.
 */
export function modelsDir(): string {
  const dir = process.env.LIGHTHOUSE_MODELS_DIR?.trim() || join(resourcesDir(), "llm");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Every directory a usable model might sit in - the download target plus the
 * bundled `resources/llm` (where an older Lighthouse could have left one). This
 * MUST match the shell's model discovery (supervise.rs) so the picker's "installed" state
 * agrees with what llama-server actually runs; otherwise a leftover model looks
 * uninstalled (a dead "＋") even though the local model works.
 */
function searchDirs(): string[] {
  const download = process.env.LIGHTHOUSE_MODELS_DIR?.trim() || join(resourcesDir(), "llm");
  return [...new Set([download, join(resourcesDir(), "llm")])];
}

/**
 * Absolute path to a present, USABLE `.gguf` in any search dir, or null. A file
 * only counts if it's non-trivial in size AND begins with the GGUF magic — so a
 * corrupt / wrong / half-written leftover from an older install is treated as
 * "not installed" (the picker offers a fresh install instead of a dead
 * "Installed", and llama-server is never handed junk). Must match main.js
 * `findModel()`.
 */
function installedModel(): string | null {
  for (const dir of searchDirs()) {
    try {
      for (const n of readdirSync(dir)) {
        if (!n.toLowerCase().endsWith(".gguf")) continue;
        const p = join(dir, n);
        if (statSync(p).size > MIN_BYTES && isGgufFile(p)) return p;
      }
    } catch {
      /* dir may not exist yet */
    }
  }
  return null;
}

/** True if the file starts with the GGUF magic ("GGUF") — a real model file, not
 *  a stray/corrupt/wrong file that merely happens to be large. */
/** True if ANY `.gguf` exists in a search dir — a real model OR a stale/corrupt/
 *  wrong leftover from an older install. Used so uninstall can always clear one,
 *  even when it isn't a usable model. */
function hasModelFile(): boolean {
  for (const dir of searchDirs()) {
    try {
      if (readdirSync(dir).some((n) => n.toLowerCase().endsWith(".gguf"))) return true;
    } catch {
      /* dir may not exist yet */
    }
  }
  return false;
}

function isGgufFile(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(4);
    readSync(fd, buf, 0, 4, 0);
    return buf.toString("latin1") === "GGUF";
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** True while an uninstall has been requested but main.js hasn't finished it. */
function uninstallPending(): boolean {
  return existsSync(join(modelsDir(), UNINSTALL_MARKER));
}

export type ModelStatus = "ready" | "absent" | "downloading" | "uninstalling" | "error";

interface Progress {
  status: ModelStatus;
  /** Bytes downloaded so far and the total, when a download is in flight. */
  received: number;
  total: number;
  error?: string;
  /** True when a `.gguf` file exists that uninstall would remove — including a
   *  corrupt/partial/wrong leftover that isn't a usable model (status "absent"),
   *  so the UI can always offer to clear it. */
  removable?: boolean;
}

// One download at a time, tracked in module state so GET /api/model can report
// progress while POST /api/model runs it in the background.
let progress: Progress = { status: "absent", received: 0, total: 0 };

/** Current model state; reports "ready" the moment an installed model is present. */
export function modelStatus(): Progress {
  if (uninstallPending()) return { status: "uninstalling", received: 0, total: 0 };
  if (progress.status === "downloading") return progress;
  if (installedModel()) return { status: "ready", received: 0, total: 0 };
  // No usable model. A leftover file may still exist (corrupt/partial/wrong .gguf
  // from an older install) — surface it as removable so the user can clear it.
  const removable = hasModelFile();
  if (progress.status === "error") return { ...progress, removable };
  return { status: "absent", received: 0, total: 0, removable };
}

/**
 * Request removal of the installed model. The `.gguf` is likely memory-mapped
 * (locked) by a running llama-server, which only the desktop shell can stop - so
 * we drop a marker it watches: the shell stops the server, deletes the weights, and
 * clears the marker. Lets the user free the ~4.2 GB or re-test a fresh install.
 */
export function requestUninstall(): Progress {
  // Clear ANY model file, not just a valid one — a corrupt/partial/wrong leftover
  // is exactly what a user needs to remove to get back to a clean install.
  if (!hasModelFile() && !uninstallPending()) {
    return { status: "absent", received: 0, total: 0 };
  }
  try {
    writeFileSync(join(modelsDir(), UNINSTALL_MARKER), String(Date.now()));
  } catch {
    /* best-effort; the poll will reflect reality */
  }
  progress = { status: "absent", received: 0, total: 0 }; // clear any prior error
  return { status: "uninstalling", received: 0, total: 0 };
}

/** Kick off the one-time model download if it isn't already present or running. */
export function startDownload(): Progress {
  if (progress.status === "downloading") return progress;
  if (installedModel()) return { status: "ready", received: 0, total: 0 };
  progress = { status: "downloading", received: 0, total: 0 };
  void download()
    .then(() => {
      progress = { status: "ready", received: 0, total: 0 };
    })
    .catch((err) => {
      progress = {
        status: "error",
        received: progress.received,
        total: progress.total,
        error: err instanceof Error ? err.message : String(err),
      };
    });
  return progress;
}

/** GET that follows redirects across hosts (HF resolve → CDN), resolving the response. */
function get(url: string, redirects = 5): Promise<import("node:http").IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "user-agent": "lighthouse-app" } }, (res) => {
      const { statusCode, headers } = res;
      if (statusCode && statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();
        if (redirects <= 0) {
          reject(new Error(`too many redirects fetching ${url}`));
          return;
        }
        resolve(get(new URL(headers.location, url).toString(), redirects - 1));
        return;
      }
      if (statusCode !== 200) {
        res.resume();
        reject(new Error(`GET ${url} → ${statusCode}`));
        return;
      }
      resolve(res);
    });
    req.setTimeout(30_000, () => req.destroy(new Error(`request timed out fetching ${url}`)));
    req.on("error", reject);
  });
}

/**
 * Stream the model to a `.part` temp file, updating `progress`, and rename into
 * place only once the full byte count arrives - so an interrupted download never
 * leaves a truncated file that later looks "installed".
 */
async function download(): Promise<void> {
  const dest = join(modelsDir(), MODEL_FILE);
  const tmp = `${dest}.part`;
  const res = await get(MODEL_URL);
  const total = Number(res.headers["content-length"] || 0);
  if (!total) {
    res.destroy();
    throw new Error("download unverifiable: server did not report a Content-Length");
  }
  progress = { status: "downloading", received: 0, total };
  try {
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(tmp);
      res.on("data", (chunk: Buffer) => {
        progress = { status: "downloading", received: progress.received + chunk.length, total };
      });
      res.pipe(out);
      out.on("finish", () => out.close(() => resolve()));
      out.on("error", reject);
      res.on("error", reject);
    });
    if (progress.received !== total) {
      throw new Error(`incomplete download (${progress.received}/${total} bytes)`);
    }
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  renameSync(tmp, dest);
}
