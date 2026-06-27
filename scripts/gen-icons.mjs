/**
 * Rasterize the Lighthouse SVG sources into the PNGs the desktop build needs.
 *
 *   build/icon.svg  -> build/icon.png   (1024² — electron-builder derives the
 *                                         Windows .ico / macOS .icns from it)
 *   build/tray.svg  -> assets/tray.png  (transparent tray/menubar icon)
 *
 * Run: `npm run icons` (after `npm install`, which provides sharp).
 * The generated PNGs are committed so end users never need sharp.
 */
import sharp from "sharp";
import pngToIcoModule from "png-to-ico";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const pngToIco = pngToIcoModule.default || pngToIcoModule;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(join(root, "assets"), { recursive: true });

const buf = (svg, size) =>
  sharp(join(root, svg))
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

async function render(svg, out, size) {
  writeFileSync(join(root, out), await buf(svg, size));
  console.log(`  ✓ ${out} (${size}×${size})`);
}

await render("build/icon.svg", "build/icon.png", 1024); // electron-builder source
await render("build/icon.svg", "assets/icon.png", 512);  // runtime BrowserWindow icon
await render("build/tray.svg", "assets/tray.png", 256);  // tray / menubar

// Windows multi-resolution .ico for the app + NSIS installer.
const sizes = [16, 24, 32, 48, 64, 128, 256];
const ico = await pngToIco(await Promise.all(sizes.map((s) => buf("build/icon.svg", s))));
writeFileSync(join(root, "build/icon.ico"), ico);
console.log(`  ✓ build/icon.ico (${sizes.join(",")})`);
console.log("icons generated.");
