/**
 * Fetch the bundled offline model assets into `resources/llm/` so the packaged
 * desktop app ships a private, on-device LLM with ZERO end-user setup (issue #24,
 * "Local model"). electron-builder copies `resources/llm/` into the installer via
 * the `extraResources` entry in package.json; at runtime `electron/main.js`'s
 * `startLocalLlm()` spawns `llama-server` on 127.0.0.1:8080 and `src/server/llm.ts`
 * streams from it. Nothing here ships in git — the files are large and licensed
 * separately, so they're fetched at build time on the machine that runs
 * `npm run dist`.
 *
 *   npm run fetch:model            # fetch for the current OS into resources/llm/
 *   npm run fetch:model -- --force # re-download even if present
 *
 * What it fetches:
 *   1. `llama-server` (+ its shared libraries) — llama.cpp, MIT-licensed. The
 *      right per-OS asset is resolved from the ggml-org/llama.cpp GitHub release
 *      (a CPU build, for broad compatibility — no GPU/driver assumptions).
 *   2. Piper (rhasspy/piper, MIT) + a neural voice (en_US-lessac-medium, ~63 MB,
 *      MIT/CC0) into `resources/tts/`, powering on-device read-aloud TTS.
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
 *   PIPER_VERSION      override the pinned piper release tag
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
// release API's asset `digest` field, the HF voice digest from its LFS oid, and
// anything else from `--record`. Keys are the asset filenames the pickers resolve
// for the platforms the release pipeline builds (Windows x64, macOS arm64).
const LLAMACPP_VERSION = "b9859"; // ggml-org/llama.cpp release tag
const PIPER_VERSION = "2023.11.14-2"; // rhasspy/piper release tag
const VOICE_REVISION = "e21c7de8d4eab79b902f0d61e662b3f21664b8d2"; // rhasspy/piper-voices commit
const ASSET_SHA256 = {
  "llama-b9859-bin-win-cpu-x64.zip": "c9aa80f233a7d1749341860f11723b912d4cfd6eec19434c3d00bba0abc9f85c",
  "llama-b9859-bin-macos-arm64.tar.gz": "21e720ac103d28d7585a52b8023fb86fc0736c90ad92c1e75053207630e90df6",
  "piper_windows_amd64.zip": "f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea",
  "piper_macos_aarch64.tar.gz": "6b1eb03b3735946cb35216e063e7eebcc33a6bbf5dd96ec0217959bf1cdcb0cc",
  "en_US-lessac-medium.onnx": "5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f",
  "en_US-lessac-medium.onnx.json": "efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0",
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
  process.stdout.write(`\r  ${label}: done (${(seen / 1e6).toFixed(0)} MB)            \n`);
}

/** Pick the llama.cpp release asset matching this OS — prefer a plain CPU build. */
function pickAsset(assets) {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const os = platform === "win32" ? "win" : platform === "darwin" ? "macos" : "ubuntu";
  const candidates = assets
    .map((a) => a.name)
    // Windows ships .zip; macOS/Linux ship .tar.gz on current llama.cpp releases.
    .filter((n) => /\.(zip|tar\.gz|tgz)$/i.test(n) && n.includes(os))
    // exclude GPU/driver-specific builds — bundle a portable CPU build
    .filter((n) => !/cuda|hip|vulkan|sycl|kompute/i.test(n));
  // macOS assets are arch-tagged; win/linux x64 CPU builds usually are too.
  const byArch = candidates.filter((n) => n.includes(arch));
  const pool = byArch.length ? byArch : candidates;
  // Prefer an explicit "cpu" build, else broadest instruction set (avx2 > others).
  const ranked = pool.sort((a, b) => score(b) - score(a));
  const name = ranked[0];
  if (!name) throw new Error(`no llama.cpp asset for ${os}/${arch} in this release`);
  return assets.find((a) => a.name === name);
}
function score(name) {
  let s = 0;
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

/** Pick the Piper release asset matching this OS/arch (zip on Windows, tar.gz else). */
function pickPiperAsset(assets) {
  const os = platform === "win32" ? "windows" : platform === "darwin" ? "macos" : "linux";
  // Piper asset arch tags: windows→amd64, linux→x86_64/aarch64, macos→x64/aarch64.
  const arch =
    process.arch === "arm64"
      ? "aarch64"
      : os === "windows"
        ? "amd64"
        : os === "macos"
          ? "x64"
          : "x86_64";
  const names = assets
    .map((a) => a.name)
    .filter((n) => /\.(zip|tar\.gz|tgz)$/i.test(n) && n.toLowerCase().includes(os));
  const byArch = names.filter((n) => n.toLowerCase().includes(arch));
  const name = (byArch[0] || names[0]);
  if (!name) throw new Error(`no piper asset for ${os}/${arch} in this release`);
  return assets.find((a) => a.name === name);
}

/** Move everything from `srcDir` up into `dir`, then remove the empty `srcDir`. */
function moveUp(srcDir, dir) {
  for (const f of readdirSync(srcDir, { withFileTypes: true })) {
    renameSync(join(srcDir, f.name), join(dir, f.name));
  }
  rmSync(srcDir, { recursive: true, force: true });
}

/** Flatten Piper's archive (it unpacks into a `piper/` subfolder) into `dir`. */
function flattenPiper(dir, piperName) {
  if (existsSync(join(dir, piperName))) return; // already at top level
  const srcDir = findDirWith(dir, piperName);
  if (srcDir && srcDir !== dir) moveUp(srcDir, dir);
}

/**
 * Fetch Piper + a neural voice into resources/tts/ for on-device read-aloud TTS.
 * Mirrors the llama-server flow: resolve the per-OS release asset, extract, and
 * flatten so `piper(.exe)` and its libraries sit directly in resources/tts/.
 */
async function fetchTts() {
  const ttsDest = join(root, "resources", "tts");
  mkdirSync(ttsDest, { recursive: true });
  const piperName = platform === "win32" ? "piper.exe" : "piper";
  const piperPath = join(ttsDest, piperName);

  // 1. Piper binary (+ libraries, espeak-ng-data)
  if (!force && existsSync(piperPath)) {
    console.log(`✓ ${piperName} already present`);
  } else {
    const piperTag = process.env.PIPER_VERSION?.trim() || PIPER_VERSION;
    console.log(`Resolving piper ${piperTag} release…`);
    const release = await getJson(`https://api.github.com/repos/rhasspy/piper/releases/tags/${piperTag}`);
    const asset = pickPiperAsset(release.assets || []);
    console.log(`Downloading ${asset.name} (${release.tag_name})`);
    const archivePath = join(ttsDest, asset.name);
    await download(asset.browser_download_url, archivePath, "piper", asset.name);
    extract(archivePath, ttsDest);
    rmSync(archivePath, { force: true });
    flattenPiper(ttsDest, piperName);
    if (!existsSync(piperPath)) throw new Error(`extracted, but ${piperName} not found in ${ttsDest}`);
    console.log(`✓ ${piperName}`);
  }

  // 2. Voice model (.onnx) + its config (.onnx.json) — a clear, natural US voice.
  const voiceBase =
    `https://huggingface.co/rhasspy/piper-voices/resolve/${VOICE_REVISION}/en/en_US/lessac/medium/en_US-lessac-medium`;
  const onnxPath = join(ttsDest, "en_US-lessac-medium.onnx");
  const jsonPath = join(ttsDest, "en_US-lessac-medium.onnx.json");
  if (!force && existsSync(onnxPath) && statSync(onnxPath).size > 1e6) {
    console.log(`✓ voice already present`);
  } else {
    await download(`${voiceBase}.onnx`, onnxPath, "voice", "en_US-lessac-medium.onnx");
    await download(`${voiceBase}.onnx.json`, jsonPath, "voice-config", "en_US-lessac-medium.onnx.json");
    console.log(`✓ voice en_US-lessac-medium`);
  }
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

  // 2. Local neural TTS (Piper + voice) for on-device read-aloud.
  await fetchTts();

  if (RECORD && Object.keys(recorded).length) {
    console.log(`\n--record: paste these into ASSET_SHA256 (scripts/fetch-local-model.mjs), then commit:`);
    for (const [k, v] of Object.entries(recorded)) console.log(`  ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
  }

  console.log(`\nBundled llama-server + TTS ready in resources/. The private model is`);
  console.log(`downloaded on demand at runtime (not bundled). Run \`npm run dist\` to package.`);
}

main().catch((e) => {
  console.error(`\nfetch-local-model failed: ${e.message}`);
  process.exit(1);
});
