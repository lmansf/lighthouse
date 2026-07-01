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
 * electron/main.js watches the models directory and starts `llama-server`
 * against the file as soon as it lands, so the private model becomes usable
 * without a restart.
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
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

/**
 * Where the model lives. In the packaged app electron/main.js sets
 * LIGHTHOUSE_MODELS_DIR to `<userData>/models` (writable, survives updates);
 * in dev we fall back to `resources/llm` so a locally fetched model still works.
 */
export function modelsDir(): string {
  const dir = process.env.LIGHTHOUSE_MODELS_DIR?.trim() || join(resourcesDir(), "llm");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Absolute path to a present, non-trivial `.gguf`, or null if none is installed. */
function installedModel(): string | null {
  try {
    const f = readdirSync(modelsDir()).find(
      (n) => n.toLowerCase().endsWith(".gguf") && statSync(join(modelsDir(), n)).size > MIN_BYTES,
    );
    return f ? join(modelsDir(), f) : null;
  } catch {
    return null; // no models directory yet
  }
}

export type ModelStatus = "ready" | "absent" | "downloading" | "error";

interface Progress {
  status: ModelStatus;
  /** Bytes downloaded so far and the total, when a download is in flight. */
  received: number;
  total: number;
  error?: string;
}

// One download at a time, tracked in module state so GET /api/model can report
// progress while POST /api/model runs it in the background.
let progress: Progress = { status: "absent", received: 0, total: 0 };

/** Current model state; reports "ready" the moment an installed model is present. */
export function modelStatus(): Progress {
  if (progress.status === "downloading") return progress;
  if (installedModel()) return { status: "ready", received: 0, total: 0 };
  if (progress.status === "error") return progress;
  return { status: "absent", received: 0, total: 0 };
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
