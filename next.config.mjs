import { readFileSync } from "node:fs";

// Expose the app version to the client (rendered as a subtle badge). Read from
// package.json so it stays in sync with the release version automatically.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Document parsers ship large/optional sub-deps and dynamic requires (pdfjs,
  // jszip, …). Keep them external so Next requires them from node_modules at
  // runtime instead of trying to bundle them into the server build.
  serverExternalPackages: ["mammoth", "unpdf", "xlsx"],
  env: { NEXT_PUBLIC_APP_VERSION: pkg.version },
  // Static export for the Tauri shell (scripts/build-ui-static.mjs): the UI
  // becomes bundled assets and every /api call rides Tauri IPC instead of a
  // local HTTP server. The API routes are set aside by that script for the
  // duration of the export build.
  ...(process.env.LIGHTHOUSE_STATIC_EXPORT === "1"
    ? { output: "export", distDir: ".next-export", images: { unoptimized: true } }
    : {}),
};

export default nextConfig;
