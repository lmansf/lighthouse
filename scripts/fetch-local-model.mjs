/**
 * Fetch the bundled offline model assets into `resources/llm/` so the packaged
 * desktop app ships a private, on-device LLM with ZERO end-user setup (issue #24,
 * "Local model"). The Tauri bundler copies `resources/llm/` into the installer
 * via the `bundle.resources` entry in tauri.conf.json; at runtime the desktop
 * shell spawns `llama-server` against it and the engine streams from it.
 * Nothing here ships in git — the files are large and licensed
 * separately, so they're fetched at build time on the machine that runs
 * `npm run dist`.
 *
 *   npm run fetch:model            # fetch for the current OS into resources/llm/
 *   npm run fetch:model -- --force # re-download even if present
 *
 * What it fetches:
 *   1. `llama-server` (+ its shared libraries) — llama.cpp, MIT-licensed. The
 *      right per-OS asset is resolved from the ggml-org/llama.cpp GitHub release:
 *      the VULKAN build on Windows/Linux (GPU offload with a dynamic CPU
 *      fallback in the same archive — runs fine on GPU-less machines), the
 *      default arm64 build (Metal) on macOS. See pickAsset().
 *   2. The nomic embedding GGUF (nomic-ai/nomic-embed-text-v1.5, Apache-2.0)
 *      into `resources/embed/` for B2 hybrid search.
 *   3. The ocrs OCR models (robertknight/ocrs-models, ~12 MB) into
 *      `resources/ocr/`, reading text in images + scanned PDFs on device. The
 *      ocrs project is MIT/Apache-2.0; its models are trained exclusively on
 *      openly-licensed data — HierText (CC-BY-SA 4.0) — attributed here.
 *
 * It does NOT fetch the private model weights: Mistral-7B-Instruct-v0.3 is ~4.2 GB,
 * well past NSIS's (and GitHub's) 2 GB limit, so it can't be bundled. The app
 * downloads it on demand instead (opt-in "＋" in the model picker → app/api/model
 * → the user's data dir). See src/server/localModel.ts.
 *
 * All default assets are PINNED to a specific version/revision and verified
 * against a committed SHA-256 (see ASSET_SHA256 below); the build fails closed on
 * any missing or mismatched digest, so a compromised CDN / mutated upstream / MITM
 * can't slip a tampered binary into the installer. Run
 * `npm run fetch:model -- --record` to (re)compute digests when bumping a version,
 * then paste the printed values into ASSET_SHA256 and commit.
 *
 * Overridable via env (all optional):
 *   LLAMACPP_VERSION   override the pinned llama.cpp release tag
 *   GITHUB_TOKEN       lifts the unauthenticated GitHub API rate limit
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import https from "node:https";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(root, "resources", "llm");
const force = process.argv.includes("--force");
const platform = process.platform; // win32 | darwin | linux

const LLAMACPP_API = "https://api.github.com/repos/ggml-org/llama.cpp/releases";

// --- Pinned, integrity-verified build assets --------------------------------
// Each default asset is pinned to a specific version/revision AND a SHA-256.
// Bump the version + digest together: GitHub release digests come from the
// release API's asset `digest` field, and anything else from `--record`. Keys
// are the asset filenames the pickers resolve for the platforms the release
// pipeline builds (Windows x64, macOS arm64).
const LLAMACPP_VERSION = "b9859"; // ggml-org/llama.cpp release tag
// Our own mirror of every HF-hosted asset (release tag in THIS repo,
// populated by the mirror-hf-assets workflow): the embedding GGUF. Tried
// before HF, whose CDN 403-stormed for hours on
// 2026-07-13 and blocked four consecutive release builds. The same pinned
// SHA-256 verifies both sources, so the mirror is tamper-evident and the
// fallback order is purely about availability. In --record mode upstream is
// tried first instead: new pins must be computed from the source of truth,
// never from a stale mirror.
const HF_MIRROR_TAG = "hf-assets-1";
const HF_MIRROR_BASE = `https://github.com/lmansf/lighthouse/releases/download/${HF_MIRROR_TAG}`;
// B2 hybrid search: the bundled embedding model (Apache-2.0), served by the
// SAME llama-server binary above with `--embedding` on a second port. Bundled
// in the installer (+~137 MB) so semantic search works with zero setup; lives
// in resources/embed/ — NEVER resources/llm/, where model discovery would
// mistake it for an installed chat model.
const EMBED_REPO = "nomic-ai/nomic-embed-text-v1.5-GGUF"; // Hugging Face repo
// Pinned repo commit (recorded by the asset-digests workflow; re-record when
// bumping). Empty = not yet pinned: the normal path fails closed and
// `--record` resolves the current main, prints it, and computes the digest.
const EMBED_REVISION = "0188c9bf409793f810680a5a431e7b899c46104c";
const EMBED_FILE = "nomic-embed-text-v1.5.Q8_0.gguf";
const ASSET_SHA256 = {
  // Vulkan builds (preferred on win/linux): GPU offload with a dynamic CPU
  // fallback backend in the same archive. Digests from the release API's
  // asset `digest` field, same source as the entries below.
  "llama-b9859-bin-win-vulkan-x64.zip": "5e7794aa22ba34c8e223934b0b3e14cd441612f26e9f06a4a0e5f47b9e7f577b",
  "llama-b9859-bin-ubuntu-vulkan-x64.tar.gz": "8968e8b74ca1fdafe51013560eff42bdaf99872a58918c3085f1e1dd77ddc7c1",
  // CPU fallbacks (used only if a release lacks a Vulkan asset for the OS).
  "llama-b9859-bin-win-cpu-x64.zip": "c9aa80f233a7d1749341860f11723b912d4cfd6eec19434c3d00bba0abc9f85c",
  "llama-b9859-bin-ubuntu-x64.tar.gz": "7a434a404669534ee67f2e53363109053a54c3ee13f487cbc17a3455ac5930f4",
  "llama-b9859-bin-macos-arm64.tar.gz": "21e720ac103d28d7585a52b8023fb86fc0736c90ad92c1e75053207630e90df6",
  // OCR (add-ocr-perception): the ocrs detection + recognition models. Not on
  // a versioned host — pinned by digest, mirror-first (repo release) with the
  // ocrs S3 bucket as upstream.
  "text-detection.rten": "f15cfb56bd02c4bf478a20343986504a1f01e1665c2b3a0ad66340f054b1b5ca",
  "text-recognition.rten": "e484866d4cce403175bd8d00b128feb08ab42e208de30e42cd9889d8f1735a6e",
  // B2 embedding model (see EMBED_* above) — one GGUF for all three OS builds.
  "nomic-embed-text-v1.5.Q8_0.gguf": "3e24342164b3d94991ba9692fdc0dd08e3fd7362e0aacc396a9a5c54a544c3b7",
};
// `--record` recomputes and prints digests (to bootstrap a version bump) instead
// of enforcing them; the normal path fails closed on any missing/mismatched hash.
const RECORD = process.argv.includes("--record");
const recorded = {};

/** GET that follows redirects across hosts and resolves with the response. */
function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "user-agent": "lighthouse-build", ...headers } }, (res) => {
      const { statusCode, headers: h } = res;
      if (statusCode >= 300 && statusCode < 400 && h.location) {
        res.resume();
        const next = new URL(h.location, url);
        // Don't forward credentials (e.g. the GitHub bearer token) across hosts.
        const sameHost = next.host === new URL(url).host;
        const fwd = sameHost
          ? headers
          : Object.fromEntries(Object.entries(headers).filter(([k]) => !/^authorization$/i.test(k)));
        resolve(get(next.toString(), fwd));
        return;
      }
      if (statusCode !== 200) {
        res.resume();
        reject(new Error(`GET ${url} → ${statusCode}`));
        return;
      }
      resolve(res);
    });
    req.on("error", reject);
  });
}

async function getJson(url) {
  const res = await get(url, process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {});
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Stream a download to disk with a coarse progress line, verifying its SHA-256.
 * Writes to a `.part` temp file and renames into place only after the byte count
 * matches content-length AND the digest matches the pinned value, so an
 * interrupted OR tampered download never lands as a "complete" file.
 *
 * `assetName` keys into ASSET_SHA256. A missing or mismatched digest is a hard
 * failure (fail closed) — except under `--record`, which records the computed
 * digest so a maintainer can pin it.
 */
async function download(url, outPath, label, assetName) {
  const expected = ASSET_SHA256[assetName]?.trim().toLowerCase();
  if (!expected && !RECORD) {
    throw new Error(
      `${label}: no pinned SHA-256 for "${assetName}". Run \`npm run fetch:model -- --record\` ` +
        `to compute it, add it to ASSET_SHA256 in scripts/fetch-local-model.mjs, and commit.`,
    );
  }
  const res = await get(url);
  const total = Number(res.headers["content-length"] || 0);
  const tmpPath = `${outPath}.part`;
  const hash = createHash("sha256");
  let seen = 0;
  let lastPct = -1;
  try {
    await new Promise((resolve, reject) => {
      const out = createWriteStream(tmpPath);
      res.on("data", (c) => {
        seen += c.length;
        hash.update(c);
        if (total) {
          const pct = Math.floor((seen / total) * 100);
          if (pct !== lastPct && pct % 5 === 0) {
            process.stdout.write(`\r  ${label}: ${pct}% (${(seen / 1e6).toFixed(0)}/${(total / 1e6).toFixed(0)} MB)`);
            lastPct = pct;
          }
        }
      });
      res.pipe(out);
      out.on("finish", () => out.close(resolve));
      out.on("error", reject);
      res.on("error", reject);
    });
    if (total && seen !== total) {
      throw new Error(`${label}: incomplete download (${seen}/${total} bytes)`);
    }
    const got = hash.digest("hex");
    if (expected) {
      if (got !== expected) {
        throw new Error(`${label}: SHA-256 mismatch for "${assetName}"\n  expected ${expected}\n  got      ${got}`);
      }
    } else {
      recorded[assetName] = got; // --record
      process.stdout.write(`\r  [record] ${assetName}: ${got}\n`);
    }
  } catch (e) {
    rmSync(tmpPath, { force: true });
    throw e;
  }
  renameSync(tmpPath, outPath);
}

/**
 * Try the mirror then the upstream URL until one downloads AND verifies;
 * rethrow the last failure only if every source fails. Digest pinning in
 * download() makes the order a pure availability choice — a wrong or tampered
 * mirror can only ever fail closed, never substitute bytes. Under --record the
 * order flips to upstream-first: new pins come from the source of truth.
 */
async function downloadWithFallback(mirrorUrl, upstreamUrl, outPath, label, assetName) {
  const urls = RECORD ? [upstreamUrl, mirrorUrl] : [mirrorUrl, upstreamUrl];
  let lastErr;
  for (const url of urls) {
    try {
      return await download(url, outPath, label, assetName);
    } catch (err) {
      lastErr = err;
      console.log(`\n  ${label}: source failed (${String(err?.message || err).split("\n")[0]}); trying next`);
    }
  }
  throw lastErr;
  process.stdout.write(`\r  ${label}: done (${(seen / 1e6).toFixed(0)} MB)            \n`);
}

/**
 * Pick the llama.cpp release asset matching this OS — prefer the VULKAN build
 * on Windows/Linux, falling back to the plain CPU build when the release has
 * no Vulkan asset for this OS/arch.
 *
 * Why Vulkan is safe to bundle: current llama.cpp release archives are built
 * with dynamic backend loading — the Vulkan archive also carries the CPU
 * backend, and llama-server enumerates usable devices at startup, running
 * fully on CPU when no Vulkan driver/device exists. On machines WITH any GPU
 * (including Intel/AMD iGPUs) prompt processing and generation run 3–20×
 * faster with `-ngl` offload (set by the desktop supervisor, which also
 * disables offload persistently if a broken driver crashes the server —
 * see supervise.rs). macOS arm64 builds carry Metal by default; no change.
 */
function pickAsset(assets) {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const os = platform === "win32" ? "win" : platform === "darwin" ? "macos" : "ubuntu";
  const candidates = assets
    .map((a) => a.name)
    // Windows ships .zip; macOS/Linux ship .tar.gz on current llama.cpp releases.
    .filter((n) => /\.(zip|tar\.gz|tgz)$/i.test(n) && n.includes(os))
    // Exclude driver-stack-specific builds we can't assume end users have
    // (CUDA/ROCm/SYCL/OpenVINO need vendor runtimes; Vulkan is OS-generic).
    .filter((n) => !/cuda|hip|rocm|sycl|kompute|openvino|s390x/i.test(n));
  // macOS assets are arch-tagged; win/linux x64 builds usually are too.
  const byArch = candidates.filter((n) => n.includes(arch));
  const pool = byArch.length ? byArch : candidates;
  const ranked = pool.sort((a, b) => score(b) - score(a));
  const name = ranked[0];
  if (!name) throw new Error(`no llama.cpp asset for ${os}/${arch} in this release`);
  return assets.find((a) => a.name === name);
}
function score(name) {
  let s = 0;
  if (/vulkan/i.test(name)) s += 200; // GPU-capable with built-in CPU fallback
  if (/cpu/i.test(name)) s += 100;
  if (/avx2/i.test(name)) s += 50;
  if (/x64|amd64/i.test(name)) s += 5;
  return s;
}

/**
 * Extract a release archive using the OS's own tooling (no deps). Current
 * llama.cpp releases ship Windows as .zip and macOS/Linux as .tar.gz, so handle
 * both: `tar` (present on Windows 10+, macOS, and Linux) unpacks .tar.gz, while
 * .zip uses Expand-Archive on Windows and `unzip` elsewhere.
 */
function extract(archivePath, outDir) {
  const isTar = /\.(tar\.gz|tgz)$/i.test(archivePath);
  // PowerShell single-quoted strings escape a literal quote by doubling it.
  // Escape both paths so an archive/asset name containing a `'` can't break out
  // of the quotes and inject arbitrary PowerShell.
  const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const [cmd, cmdArgs] = isTar
    ? ["tar", ["-xzf", archivePath, "-C", outDir]]
    : platform === "win32"
      ? ["powershell", ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -Path ${psQuote(archivePath)} -DestinationPath ${psQuote(outDir)} -Force`]]
      : ["unzip", ["-o", archivePath, "-d", outDir]];
  const r = spawnSync(cmd, cmdArgs, { stdio: "inherit" });
  if (r.status !== 0) {
    throw new Error(
      `extract failed (${cmd} exited ${r.status}).${cmd === "unzip" ? " Install `unzip` and retry." : ""}`,
    );
  }
}

/** Recursively find the directory containing `serverName`, at any depth. */
function findDirWith(dir, serverName) {
  const entries = readdirSync(dir, { withFileTypes: true });
  if (entries.some((e) => e.isFile() && e.name === serverName)) return dir;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const found = findDirWith(join(dir, e.name), serverName);
    if (found) return found;
  }
  return null;
}

/**
 * Flatten whatever nested layout the release zip created, so the binary and its
 * sibling shared libraries sit directly in resources/llm/. Release zips vary
 * (flat, `build/bin/…`, etc.), so search at any depth. Uses renameSync so a
 * failed move throws rather than silently leaving a missing library behind.
 */
function flatten(dir) {
  const serverName = platform === "win32" ? "llama-server.exe" : "llama-server";
  const srcDir = findDirWith(dir, serverName);
  if (!srcDir || srcDir === dir) return; // not found, or already at top level
  for (const f of readdirSync(srcDir, { withFileTypes: true })) {
    // binary + co-located shared libs, plus the SONAME symlinks (e.g.
    // libllama-common.so.0 → libllama-common.so.0.0.NNNN) the .tar.gz ships and
    // the binary resolves at load time via RUNPATH $ORIGIN.
    if (!f.isFile() && !f.isSymbolicLink()) continue;
    renameSync(join(srcDir, f.name), join(dir, f.name));
  }
  // Drop the now-emptied extraction tree the zip created.
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) rmSync(join(dir, e.name), { recursive: true, force: true });
  }
}

/**
 * Fetch the bundled embedding model (B2 hybrid search) into resources/embed/.
 * Platform-independent (one GGUF for all three OS builds), pinned to a repo
 * revision + SHA-256 like everything else. `--record` bootstraps the pins:
 * it resolves the repo's current main commit and computes the digest.
 */
async function fetchEmbed() {
  const embedDest = join(root, "resources", "embed");
  mkdirSync(embedDest, { recursive: true });
  const outPath = join(embedDest, EMBED_FILE);
  if (!force && existsSync(outPath) && statSync(outPath).size > 1e8) {
    console.log(`✓ embedding model already present`);
    return;
  }
  let revision = process.env.EMBED_REVISION?.trim() || EMBED_REVISION;
  if (!revision) {
    if (!RECORD) {
      throw new Error(
        `embedding model: EMBED_REVISION is not pinned. Run \`npm run fetch:model -- --record\`, ` +
          `then paste the printed revision + digest into scripts/fetch-local-model.mjs and commit.`,
      );
    }
    const meta = await getJson(`https://huggingface.co/api/models/${EMBED_REPO}`);
    revision = meta.sha;
    if (!revision) throw new Error(`embedding model: could not resolve ${EMBED_REPO} revision`);
    console.log(`  [record] EMBED_REVISION: ${JSON.stringify(revision)}`);
  }
  const url = `https://huggingface.co/${EMBED_REPO}/resolve/${revision}/${EMBED_FILE}`;
  console.log(`Downloading ${EMBED_FILE} (${EMBED_REPO}@${revision.slice(0, 12)})`);
  // Mirror first, HF second — same pinned digest verifies both (see
  // HF_MIRROR_TAG); under --record the helper flips to upstream-first.
  await downloadWithFallback(`${HF_MIRROR_BASE}/${EMBED_FILE}`, url, outPath, "embedding model", EMBED_FILE);
  console.log(`✓ ${EMBED_FILE}`);
}

/**
 * Fetch the bundled OCR models (add-ocr-perception) into resources/ocr/. Two
 * ~pinned .rten files (detection + recognition); mirror-first (our own release
 * assets, populated by mirror-hf-assets) with the ocrs S3 bucket as upstream —
 * both verify the same digest, so the order is purely about availability.
 */
async function fetchOcr() {
  const ocrDest = join(root, "resources", "ocr");
  mkdirSync(ocrDest, { recursive: true });
  const upstream = "https://ocrs-models.s3-accelerate.amazonaws.com";
  for (const name of ["text-detection.rten", "text-recognition.rten"]) {
    const outPath = join(ocrDest, name);
    if (!force && existsSync(outPath) && statSync(outPath).size > 1e5) {
      console.log(`✓ ${name} already present`);
      continue;
    }
    await downloadWithFallback(`${HF_MIRROR_BASE}/${name}`, `${upstream}/${name}`, outPath, "ocr model", name);
  }
  console.log(`✓ ocr models`);
}

async function main() {
  mkdirSync(dest, { recursive: true });
  const serverName = platform === "win32" ? "llama-server.exe" : "llama-server";
  const serverPath = join(dest, serverName);

  // 1. llama-server binary
  if (!force && existsSync(serverPath)) {
    console.log(`✓ ${serverName} already present`);
  } else {
    const tag = process.env.LLAMACPP_VERSION?.trim() || LLAMACPP_VERSION;
    console.log(`Resolving llama.cpp ${tag} release…`);
    const release = await getJson(`${LLAMACPP_API}/tags/${tag}`);
    const asset = pickAsset(release.assets || []);
    console.log(`Downloading ${asset.name} (${release.tag_name})`);
    const archivePath = join(dest, asset.name);
    await download(asset.browser_download_url, archivePath, "llama-server", asset.name);
    extract(archivePath, dest);
    rmSync(archivePath, { force: true });
    flatten(dest);
    if (!existsSync(serverPath)) throw new Error(`extracted, but ${serverName} not found in ${dest}`);
    console.log(`✓ ${serverName}`);
  }

  // 2. Bundled embedding model for B2 hybrid search (resources/embed/).
  await fetchEmbed();

  // 3. Bundled OCR models for reading images + scanned PDFs (resources/ocr/).
  await fetchOcr();

  if (RECORD && Object.keys(recorded).length) {
    console.log(`\n--record: paste these into ASSET_SHA256 (scripts/fetch-local-model.mjs), then commit:`);
    for (const [k, v] of Object.entries(recorded)) console.log(`  ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
  }

  console.log(`\nBundled llama-server ready in resources/. The private model is`);
  console.log(`downloaded on demand at runtime (not bundled). Run \`npm run dist\` to package.`);
}

main().catch((e) => {
  console.error(`\nfetch-local-model failed: ${e.message}`);
  process.exit(1);
});
