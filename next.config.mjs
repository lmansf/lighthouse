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
};

export default nextConfig;
