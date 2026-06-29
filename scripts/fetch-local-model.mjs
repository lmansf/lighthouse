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
 *   2. A small instruct model in GGUF — Qwen2.5-1.5B-Instruct Q4_K_M (~1 GB),
 *      Apache-2.0 (commercial-safe), from Hugging Face.
 *
 * Overridable via env (all optional):
 *   LLAMACPP_VERSION   llama.cpp release tag to pin (default: latest)
 *   LOCAL_MODEL_URL    direct URL to a .gguf to use instead of the default
 *   LOCAL_MODEL_FILE   output filename for the .gguf (default: derived from URL)
 *   GITHUB_TOKEN       lifts the unauthenticated GitHub API rate limit (optional)
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { spawnSync } from "node:child_process";
import https from "node:https";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(root, "resources", "llm");
const force = process.argv.includes("--force");
const platform = process.platform; // win32 | darwin | linux

// Default model: small, commercial-safe, good grounded-RAG quality.
const DEFAULT_MODEL_URL =
  "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf";
const modelUrl = process.env.LOCAL_MODEL_URL?.trim() || DEFAULT_MODEL_URL;
const modelFile = process.env.LOCAL_MODEL_FILE?.trim() || basename(new URL(modelUrl).pathname);

const LLAMACPP_API = "https://api.github.com/repos/ggml-org/llama.cpp/releases";

/** GET that follows redirects across hosts and resolves with the response. */
function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "user-agent": "lighthouse-build", ...headers } }, (res) => {
      const { statusCode, headers: h } = res;
      if (statusCode >= 300 && statusCode < 400 && h.location) {
        res.resume();
        const next = new URL(h.location, url).toString();
        resolve(get(next, headers));
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

/** Stream a download to disk with a coarse progress line. */
async function download(url, outPath, label) {
  const res = await get(url);
  const total = Number(res.headers["content-length"] || 0);
  let seen = 0;
  let lastPct = -1;
  await new Promise((resolve, reject) => {
    const out = createWriteStream(outPath);
    res.on("data", (c) => {
      seen += c.length;
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
  process.stdout.write(`\r  ${label}: done (${(seen / 1e6).toFixed(0)} MB)            \n`);
}

/** Pick the llama.cpp release asset matching this OS — prefer a plain CPU build. */
function pickAsset(assets) {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const os = platform === "win32" ? "win" : platform === "darwin" ? "macos" : "ubuntu";
  const candidates = assets
    .map((a) => a.name)
    .filter((n) => n.endsWith(".zip") && n.includes(os))
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

/** Extract a .zip cross-platform using the OS's own tooling (no deps). */
function unzip(zipPath, outDir) {
  const cmd =
    platform === "win32"
      ? ["powershell", ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -Path '${zipPath}' -DestinationPath '${outDir}' -Force`]]
      : ["unzip", ["-o", zipPath, "-d", outDir]];
  const r = spawnSync(cmd[0], cmd[1], { stdio: "inherit" });
  if (r.status !== 0) {
    throw new Error(
      `extract failed (${cmd[0]} exited ${r.status}). ${platform === "win32" ? "" : "Install `unzip` and retry."}`,
    );
  }
}

/** Flatten any single nested dir the release zip created, so the binary sits in resources/llm/. */
function flatten(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const serverName = platform === "win32" ? "llama-server.exe" : "llama-server";
  if (entries.some((e) => e.isFile() && e.name === serverName)) return; // already at top level
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const sub = join(dir, e.name);
    const inner = readdirSync(sub, { withFileTypes: true });
    if (inner.some((f) => f.isFile() && f.name === serverName)) {
      for (const f of inner) {
        spawnSync(platform === "win32" ? "cmd" : "mv", platform === "win32" ? ["/c", "move", "/y", join(sub, f.name), join(dir, f.name)] : [join(sub, f.name), join(dir, f.name)], { stdio: "ignore" });
      }
      rmSync(sub, { recursive: true, force: true });
      return;
    }
  }
}

async function main() {
  mkdirSync(dest, { recursive: true });
  const serverName = platform === "win32" ? "llama-server.exe" : "llama-server";
  const serverPath = join(dest, serverName);
  const modelPath = join(dest, modelFile);

  // 1. llama-server binary
  if (!force && existsSync(serverPath)) {
    console.log(`✓ ${serverName} already present`);
  } else {
    const tag = process.env.LLAMACPP_VERSION?.trim();
    console.log(`Resolving llama.cpp ${tag || "latest"} release…`);
    const release = await getJson(tag ? `${LLAMACPP_API}/tags/${tag}` : `${LLAMACPP_API}/latest`);
    const asset = pickAsset(release.assets || []);
    console.log(`Downloading ${asset.name} (${release.tag_name})`);
    const zipPath = join(dest, asset.name);
    await download(asset.browser_download_url, zipPath, "llama-server");
    unzip(zipPath, dest);
    rmSync(zipPath, { force: true });
    flatten(dest);
    if (!existsSync(serverPath)) throw new Error(`extracted, but ${serverName} not found in ${dest}`);
    console.log(`✓ ${serverName}`);
  }

  // 2. GGUF weights
  if (!force && existsSync(modelPath) && statSync(modelPath).size > 1e8) {
    console.log(`✓ ${modelFile} already present`);
  } else {
    console.log(`Downloading ${modelFile}`);
    await download(modelUrl, modelPath, "model");
    console.log(`✓ ${modelFile}`);
  }

  console.log(`\nBundled local model ready in resources/llm/. Run \`npm run dist\` to package it.`);
}

main().catch((e) => {
  console.error(`\nfetch-local-model failed: ${e.message}`);
  process.exit(1);
});
