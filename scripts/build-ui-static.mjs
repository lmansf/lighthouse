/**
 * Build the UI as a static export for the Tauri desktop shell (Phase 4).
 *
 * `next build` with `output: "export"` refuses to build the dynamic API
 * routes — which is exactly right: inside the shell those live in Rust and
 * every /api call rides IPC (src/shell/tauriTransport.ts). So this script
 * temporarily sets `app/api` aside, exports the UI, copies it into the shell
 * crate's `ui-dist/`, drops the `.lighthouse-ui` marker the shell checks for
 * IPC mode, and always restores `app/api` — even when the build fails.
 *
 *   node scripts/build-ui-static.mjs
 */
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiDir = path.join(root, "app", "api");
// Outside app/ — anything under app/ (dot-named or not) is still routed.
const apiAside = path.join(root, ".api-excluded-during-export");
const exportDir = path.join(root, ".next-export");
const outDir = path.join(root, "out");
const uiDist = path.join(root, "native", "crates", "lighthouse-desktop", "ui-dist");

if (existsSync(apiAside)) {
  // A previous run died between rename and restore — put it back first.
  if (existsSync(apiDir)) rmSync(apiAside, { recursive: true, force: true });
  else renameSync(apiAside, apiDir);
}

if (!existsSync(apiDir)) {
  console.error("app/api not found — run from the repo root");
  process.exit(1);
}

renameSync(apiDir, apiAside);
let failed = false;
try {
  execSync(`"${process.execPath}" node_modules/next/dist/bin/next build`, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, LIGHTHOUSE_STATIC_EXPORT: "1" },
  });
} catch {
  failed = true;
} finally {
  renameSync(apiAside, apiDir);
}
if (failed) {
  console.error("static export failed; app/api restored");
  process.exit(1);
}

// Where the export landed: `out/` for a default distDir; a custom distDir
// receives the exported site directly.
const exported = existsSync(path.join(outDir, "index.html"))
  ? outDir
  : existsSync(path.join(exportDir, "index.html"))
    ? exportDir
    : path.join(exportDir, "out");
if (!existsSync(path.join(exported, "index.html"))) {
  console.error(`no exported index.html under ${exported}`);
  process.exit(1);
}

rmSync(uiDist, { recursive: true, force: true });
mkdirSync(uiDist, { recursive: true });
cpSync(exported, uiDist, { recursive: true });
// The marker the shell's `has_bundled_ui` checks to enter IPC mode (non-dot
// name — dotfiles can be skipped by asset embedding).
writeFileSync(
  path.join(uiDist, "lighthouse-ui.json"),
  JSON.stringify({ builtAt: new Date().toISOString() }),
);
rmSync(exportDir, { recursive: true, force: true });
rmSync(outDir, { recursive: true, force: true });
console.log(`static UI exported to ${path.relative(root, uiDist)} (IPC mode armed)`);
