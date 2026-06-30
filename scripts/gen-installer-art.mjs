// =============================================================================
//  Generates the branded NSIS installer artwork for Lighthouse.
//
//  Output: build/installerSidebar.bmp and build/uninstallerSidebar.bmp - the
//  164x314 welcome/finish sidebar shown by the electron-builder NSIS (assisted)
//  installer. Drawn in the Forerunner palette (cool steel canvas, sea-sky blue
//  beacon, brass/gold glints) so the installer reads as the same product as the
//  app shell (see src/shell/theme.ts).
//
//  NSIS sidebars must be BMP. Sharp can rasterize the SVG but cannot write BMP,
//  so we pull raw RGB pixels and encode a 24-bit (uncompressed) BMP by hand.
//
//  Run: npm run installer:art   (installs sharp --no-save, like `npm run icons`)
// =============================================================================
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- Forerunner palette (mirrors src/shell/theme.ts) -------------------------
const STEEL_TOP = "#EAEEF2"; // app canvas (light steel)
const STEEL_MID = "#DFE5EB"; // raised steel
const STEEL_BOT = "#C7D0DA"; // deeper steel (foot of the panel)
const SLATE = "#1A2531"; // cool slate (tower, ink)
const BLUE = "#1A7AC0"; // primary sea-sky blue (beacon light)
const BLUE_DEEP = "#114F80"; // deep brand blue (bands, base)
const BRASS = "#E2B453"; // brass glint (lantern glow, rays)
const SURFACE = "#FFFFFF"; // soft white (tower body)

const WIDTH = 164;
const HEIGHT = 314;

// A Forerunner-tinted lighthouse scene: cool steel sky with a faint blue beacon
// glow, brass light rays, a slate-and-white tower, and a deeper steel foot with
// a brass waterline. Imagery only - NSIS draws the welcome title text over it.
export const sidebarSvg = `
<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${STEEL_TOP}"/>
      <stop offset="0.62" stop-color="${STEEL_MID}"/>
      <stop offset="1" stop-color="${STEEL_BOT}"/>
    </linearGradient>
    <radialGradient id="beacon" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="${BLUE}" stop-opacity="0.55"/>
      <stop offset="0.55" stop-color="${BLUE}" stop-opacity="0.14"/>
      <stop offset="1" stop-color="${BLUE}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="lamp" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="${BRASS}" stop-opacity="1"/>
      <stop offset="1" stop-color="${BRASS}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="sea" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#9FB4C6"/>
      <stop offset="1" stop-color="#8AA2B7"/>
    </linearGradient>
    <clipPath id="tower"><polygon points="66,236 73,118 91,118 98,236"/></clipPath>
  </defs>

  <!-- cool steel sky -->
  <rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="url(#sky)"/>

  <!-- beacon glow -->
  <circle cx="82" cy="96" r="92" fill="url(#beacon)"/>

  <!-- brass light rays sweeping out from the lamp -->
  <g fill="${BRASS}" opacity="0.28">
    <polygon points="82,96 -20,66 -20,126"/>
    <polygon points="82,96 184,66 184,126"/>
    <polygon points="82,96 8,-6 52,-6"/>
    <polygon points="82,96 112,-6 156,-6"/>
  </g>

  <!-- sea / waterline at the foot -->
  <path d="M0,250 C40,242 60,250 82,250 C104,250 124,242 164,250 L164,314 L0,314 Z" fill="url(#sea)"/>
  <path d="M0,250 C40,242 60,250 82,250 C104,250 124,242 164,250" fill="none" stroke="${BRASS}" stroke-width="2" opacity="0.7"/>
  <!-- foamy ring -->
  <ellipse cx="48" cy="276" rx="26" ry="5" fill="none" stroke="#FFFFFF" stroke-width="2" opacity="0.5"/>
  <ellipse cx="120" cy="290" rx="20" ry="4" fill="none" stroke="#FFFFFF" stroke-width="2" opacity="0.4"/>

  <!-- tower base -->
  <polygon points="58,250 106,250 100,236 64,236" fill="${BLUE_DEEP}"/>

  <!-- tower body (white) -->
  <polygon points="66,236 73,118 91,118 98,236" fill="${SURFACE}"/>
  <!-- sea-sky blue bands -->
  <g clip-path="url(#tower)">
    <rect x="58" y="150" width="48" height="20" fill="${BLUE}"/>
    <rect x="58" y="188" width="48" height="20" fill="${BLUE}"/>
  </g>
  <polygon points="66,236 73,118 91,118 98,236" fill="none" stroke="#AFC0D2" stroke-width="1.5"/>

  <!-- gallery platform -->
  <rect x="69" y="110" width="26" height="9" rx="3" fill="${SLATE}"/>

  <!-- lantern room -->
  <rect x="73" y="82" width="18" height="30" rx="3" fill="${SLATE}"/>
  <circle cx="82" cy="96" r="20" fill="url(#lamp)"/>
  <circle cx="82" cy="96" r="7.5" fill="${BRASS}"/>
  <circle cx="82" cy="96" r="7.5" fill="none" stroke="#FFFFFF" stroke-width="1" opacity="0.8"/>

  <!-- slate dome cap + finial -->
  <path d="M70,83 Q82,66 94,83 Z" fill="${SLATE}"/>
  <circle cx="82" cy="64" r="3.5" fill="${BLUE_DEEP}"/>
</svg>`;

/** Encode a top-to-bottom RGB buffer as a 24-bit (BI_RGB) BMP. */
function encodeBmp(rgb, width, height) {
  const rowStride = width * 3;
  const pad = (4 - (rowStride % 4)) % 4;
  const paddedStride = rowStride + pad;
  const pixelBytes = paddedStride * height;
  const fileHeader = 14;
  const infoHeader = 40;
  const offset = fileHeader + infoHeader;
  const buf = Buffer.alloc(offset + pixelBytes);

  // BITMAPFILEHEADER
  buf.write("BM", 0, "ascii");
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(offset, 10);
  // BITMAPINFOHEADER
  buf.writeUInt32LE(infoHeader, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22); // positive => bottom-up
  buf.writeUInt16LE(1, 26); // planes
  buf.writeUInt16LE(24, 28); // bpp
  buf.writeUInt32LE(0, 30); // BI_RGB
  buf.writeUInt32LE(pixelBytes, 34);
  buf.writeInt32LE(2835, 38); // 72 DPI
  buf.writeInt32LE(2835, 42);

  // pixels: BMP is BGR and bottom-up
  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y) * rowStride;
    let dst = offset + y * paddedStride;
    for (let x = 0; x < width; x++) {
      const s = srcRow + x * 3;
      buf[dst++] = rgb[s + 2]; // B
      buf[dst++] = rgb[s + 1]; // G
      buf[dst++] = rgb[s]; // R
    }
  }
  return buf;
}

export async function renderBmp(svg, outPath) {
  const { data, info } = await sharp(Buffer.from(svg))
    .resize(WIDTH, HEIGHT, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const bmp = encodeBmp(data, info.width, info.height);
  writeFileSync(outPath, bmp);
  console.log(`wrote ${outPath} (${bmp.length} bytes)`);
}

// Only generate when run directly (so the SVG can be imported for previews/tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await renderBmp(sidebarSvg, join(root, "build", "installerSidebar.bmp"));
  await renderBmp(sidebarSvg, join(root, "build", "uninstallerSidebar.bmp"));
  console.log("installer artwork done.");
}
