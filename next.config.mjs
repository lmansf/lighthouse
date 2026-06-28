/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Document parsers ship large/optional sub-deps and dynamic requires (pdfjs,
  // jszip, …). Keep them external so Next requires them from node_modules at
  // runtime instead of trying to bundle them into the server build.
  serverExternalPackages: ["mammoth", "unpdf", "xlsx"],
};

export default nextConfig;
