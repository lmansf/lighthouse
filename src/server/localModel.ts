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
 *
 * Downloads are RESUMABLE: the stream lands in a `<model>.part` file which is
 * KEPT when the transfer is interrupted, fails, or is paused (DELETE
 * /api/model while a download is in flight = pause). The next install sends
 * `Range: bytes=<size>-` and appends the remainder (HTTP 206); servers that
 * ignore Range (HTTP 200) restart from zero. Integrity stays strict — there
 * is no upstream digest, so the checks are: a `.part` prefix must carry the
 * GGUF magic to be resumed at all, and the completed file must match the
 * advertised byte count and the magic exactly, or it is deleted rather than
 * ever renamed into place as a "ready" model.
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
import { recordEgress, PURPOSE_MODEL_DOWNLOAD } from "./egress";

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
  /** Bytes of a kept-for-resume `.part` on disk (status "absent"/"error" after
   *  an interrupted, failed, or paused download) — lets the UI offer "Resume
   *  download" instead of a from-scratch "Install". */
  partialBytes?: number;
}

// One download at a time, tracked in module state so GET /api/model can report
// progress while POST /api/model runs it in the background.
let progress: Progress = { status: "absent", received: 0, total: 0 };
// Pause/resume seams: requestUninstall() during a download flags a pause and
// tears the transfer down via `abortInFlight` (the `.part` survives for a
// Range resume); `generation` fences a torn-down download's async callbacks
// off the module state once a NEWER download starts, so pause → quick resume
// can never interleave a stale "error" over fresh progress.
let pauseRequested = false;
let abortInFlight: ((err: Error) => void) | null = null;
let generation = 0;

/** The on-disk resume artifact: downloads stream into `<model file>.part`. */
function partPath(): string {
  return `${join(modelsDir(), MODEL_FILE)}.part`;
}

/** Size of the `.part` on disk (0 when none) — a cheap stat, for status calls. */
function partialSize(): number {
  try {
    return statSync(partPath()).size;
  } catch {
    return 0;
  }
}

/**
 * Bytes safe to resume from. A `.part` is only trusted when its prefix carries
 * the GGUF magic — anything else (junk, a sub-magic stub) is discarded here so
 * a corrupt partial can never poison the resumed file. This is the cheap first
 * gate; the completed file is size- and magic-checked AGAIN before the rename.
 */
function resumableBytes(): number {
  const tmp = partPath();
  const size = partialSize();
  if (size >= 4 && isGgufFile(tmp)) return size;
  if (size > 0) rmSync(tmp, { force: true });
  return 0;
}

/** Current model state; reports "ready" the moment an installed model is present. */
export function modelStatus(): Progress {
  if (uninstallPending()) return { status: "uninstalling", received: 0, total: 0 };
  if (progress.status === "downloading") return progress;
  if (installedModel()) return { status: "ready", received: 0, total: 0 };
  // No usable model. A leftover file may still exist (corrupt/partial/wrong .gguf
  // from an older install) — surface it as removable so the user can clear it.
  // A kept `.part` from an interrupted/paused download is surfaced too
  // (partialBytes), so the UI can offer to RESUME instead of starting over.
  const removable = hasModelFile();
  const partialBytes = partialSize() || undefined;
  if (progress.status === "error") return { ...progress, removable, partialBytes };
  return { status: "absent", received: 0, total: 0, removable, partialBytes };
}

/**
 * Request removal of the installed model. The `.gguf` is likely memory-mapped
 * (locked) by a running llama-server, which only the desktop shell can stop - so
 * we drop a marker it watches: the shell stops the server, deletes the weights, and
 * clears the marker. Lets the user free the ~4.2 GB or re-test a fresh install.
 *
 * While a download is IN FLIGHT this doubles as "pause": there are no weights
 * to remove yet, so the transfer is torn down and the `.part` is KEPT — the
 * next install resumes it via an HTTP Range request (the UI labels the
 * affordance "Pause" in that state). A paused `.part` is cleared only by a
 * REAL uninstall (alongside the weights/marker), never by a repeated DELETE on
 * its own — a rapid second click must not silently discard gigabytes of
 * resumable progress.
 */
export function requestUninstall(): Progress {
  if (progress.status === "downloading") {
    pauseRequested = true;
    abortInFlight?.(new Error("download paused"));
    progress = { status: "absent", received: 0, total: 0 };
    return { ...progress, partialBytes: partialSize() || undefined };
  }
  // Clear ANY model file, not just a valid one — a corrupt/partial/wrong leftover
  // is exactly what a user needs to remove to get back to a clean install.
  if (!hasModelFile() && !uninstallPending()) {
    return { status: "absent", received: 0, total: 0, partialBytes: partialSize() || undefined };
  }
  // A real uninstall clears a stray/paused `.part` too. Unlike the weights it
  // is never mmap'd by llama-server, so it can be removed directly here — no
  // shell handshake needed.
  rmSync(partPath(), { force: true });
  try {
    writeFileSync(join(modelsDir(), UNINSTALL_MARKER), String(Date.now()));
  } catch {
    /* best-effort; the poll will reflect reality */
  }
  progress = { status: "absent", received: 0, total: 0 }; // clear any prior error
  return { status: "uninstalling", received: 0, total: 0 };
}

/**
 * Kick off the one-time model download if it isn't already present or running.
 * Fire-and-forget: returns immediately with the "downloading" state while the
 * transfer proceeds in the background (module state carries progress) — which
 * is what lets onboarding start the download and keep walking through setup.
 * A kept `.part` from an earlier attempt is resumed via HTTP Range.
 */
export function startDownload(): Progress {
  if (progress.status === "downloading") return progress;
  if (installedModel()) return { status: "ready", received: 0, total: 0 };
  pauseRequested = false;
  const gen = ++generation; // fences a paused predecessor's callbacks off module state
  progress = { status: "downloading", received: 0, total: 0 };
  void download()
    .then(() => {
      if (gen !== generation) return; // superseded by a newer download — not ours to report
      progress = { status: "ready", received: 0, total: 0 };
    })
    .catch((err) => {
      if (gen !== generation) return; // superseded by a newer download — not ours to report
      if (pauseRequested) {
        // Not a failure: the user paused. The `.part` stays for a Range resume.
        pauseRequested = false;
        progress = { status: "absent", received: 0, total: 0 };
        return;
      }
      progress = {
        status: "error",
        received: progress.received,
        total: progress.total,
        error: err instanceof Error ? err.message : String(err),
      };
    });
  return progress;
}

/** GET that follows redirects across hosts (HF resolve → CDN), resolving the
 *  response. Extra headers (the resume `Range`) are carried across redirects.
 *  200 (full), 206 (Range honored) and 416 (range unsatisfiable — the caller
 *  discards the partial and restarts) all resolve; anything else rejects. */
function get(
  url: string,
  headers: Record<string, string> = {},
  redirects = 5,
): Promise<import("node:http").IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "user-agent": "lighthouse-app", ...headers } }, (res) => {
      const { statusCode, headers: resHeaders } = res;
      if (statusCode && statusCode >= 300 && statusCode < 400 && resHeaders.location) {
        res.resume();
        if (redirects <= 0) {
          reject(new Error(`too many redirects fetching ${url}`));
          return;
        }
        resolve(get(new URL(resHeaders.location, url).toString(), headers, redirects - 1));
        return;
      }
      if (statusCode !== 200 && statusCode !== 206 && statusCode !== 416) {
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
 *
 * Resume protocol: an existing GGUF-prefixed `.part` is continued with
 * `Range: bytes=<size>-`. HTTP 206 appends from that offset (progress reflects
 * the resumed offset immediately); HTTP 200 means the server ignored the Range,
 * so the `.part` is truncated and the transfer restarts from zero; HTTP 416
 * means the `.part` is at/past the asset's size (or the asset changed) — it is
 * discarded and a fresh request made. On failure the `.part` is KEPT for a
 * later resume; it is deleted only when integrity is in doubt (junk prefix,
 * 416, overshoot, or a completed file that is not a valid GGUF model).
 */
async function download(): Promise<void> {
  const dest = join(modelsDir(), MODEL_FILE);
  const tmp = partPath();
  let offset = resumableBytes();
  if (offset > 0) {
    // Reflect the resumed offset immediately — before the first byte arrives —
    // so a resumed download never appears to restart at zero.
    progress = { status: "downloading", received: offset, total: 0 };
  }

  recordEgress(MODEL_URL, PURPOSE_MODEL_DOWNLOAD);
  let res = await get(MODEL_URL, offset > 0 ? { range: `bytes=${offset}-` } : {});
  if (res.statusCode === 416) {
    // Range not satisfiable: the .part is at/past the asset's size, or the
    // asset changed underneath us. Either way it can't be trusted — discard
    // it and fetch from zero.
    res.resume();
    rmSync(tmp, { force: true });
    offset = 0;
    res = await get(MODEL_URL);
    if (res.statusCode === 416) {
      res.resume();
      throw new Error(`GET ${MODEL_URL} → 416`);
    }
  }
  if (pauseRequested) {
    // Paused while connecting (nothing streamed yet): stop before writing.
    res.destroy();
    throw new Error("download paused");
  }

  let total: number;
  if (res.statusCode === 206) {
    // The server honored the Range: strictly verify it resumed at OUR offset
    // (appending a mismatched slice would corrupt the file), and take the full
    // size from Content-Range ("bytes <start>-<end>/<total>").
    const contentRange = String(res.headers["content-range"] || "");
    if (offset === 0 || !contentRange.startsWith(`bytes ${offset}-`)) {
      res.destroy();
      throw new Error(
        `resume failed: server returned a mismatched range (${contentRange || "no content-range"})`,
      );
    }
    const m = /\/(\d+)\s*$/.exec(contentRange);
    total = m ? Number(m[1]) : offset + Number(res.headers["content-length"] || 0);
  } else {
    // 200: the full body — no .part, or the server ignored the Range (some
    // hosts do). Restart from zero (the "w" open below truncates) so resumed
    // bytes are never appended twice.
    offset = 0;
    total = Number(res.headers["content-length"] || 0);
  }
  if (!total) {
    res.destroy();
    throw new Error("download unverifiable: server did not report a Content-Length");
  }
  progress = { status: "downloading", received: offset, total };
  try {
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(tmp, { flags: offset > 0 ? "a" : "w" });
      // Deterministic teardown on EVERY failure: destroy both ends so the fd
      // closes (an open fd blocks rename/reopen on Windows) and the .part is
      // quiescent for a later resume. Doubles as the pause abort seam.
      const fail = (err: unknown) => {
        res.destroy();
        out.destroy();
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      abortInFlight = fail;
      res.on("data", (chunk: Buffer) => {
        progress = { status: "downloading", received: progress.received + chunk.length, total };
      });
      res.pipe(out);
      out.on("finish", () => out.close(() => resolve()));
      out.on("error", fail);
      res.on("error", fail);
    });
  } finally {
    abortInFlight = null;
  }
  // Integrity is size- and magic-based (there is no upstream digest). Too
  // SHORT is an interruption — keep the `.part` so the next install resumes.
  // Anything else wrong (overshoot, not a GGUF) is corruption — a corrupt part
  // must never become a ready model, so delete it and start fresh next time.
  const size = statSync(tmp).size;
  if (size < total) throw new Error(`incomplete download (${size}/${total} bytes)`);
  if (size > total) {
    rmSync(tmp, { force: true });
    throw new Error(`download corrupted (${size}/${total} bytes) — removed; installing again starts fresh`);
  }
  if (!isGgufFile(tmp)) {
    rmSync(tmp, { force: true });
    throw new Error("download corrupted (not a valid GGUF model file) — removed; installing again starts fresh");
  }
  renameSync(tmp, dest);
}
