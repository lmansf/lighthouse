/**
 * Rasterize the Lighthouse SVG sources into every raster icon the desktop
 * build needs — including the Tauri bundle set under
 * native/crates/lighthouse-desktop/icons/, which earlier releases derived
 * by hand.
 *
 *   build/icon.svg  (1024² Beam mark master)
 *     -> build/icon.png                                    1024² brand master
 *     -> assets/icon.png                                   512² window icon (legacy)
 *     -> build/icon.ico                                    16–256 multi-res (app + NSIS)
 *     -> native/crates/lighthouse-desktop/icons/icon.png   1024² (Tauri bundle)
 *     -> native/crates/lighthouse-desktop/icons/icon.ico   (same bytes as build/icon.ico)
 *     -> native/crates/lighthouse-desktop/icons/icon.icns  32–1024 (see below)
 *   build/tray.svg  (monochrome template variant — black + alpha only)
 *     -> native/crates/lighthouse-desktop/icons/tray-template.png
 *        44² macOS menubar template image (22 pt @2x), compiled into the
 *        desktop binary via include_bytes! in main.rs. (The Electron-era
 *        assets/tray.png output is gone — nothing referenced it.)
 *
 * .icns is written by hand because iconutil is macOS-only: the container is
 * an 8-byte header ("icns" + u32BE total length) followed by chunks of
 * 4-char type + u32BE chunk length (incl. its own 8-byte header) + payload.
 * For the modern types (ic07–ic14) the payload is simply a PNG, so no other
 * encoding is involved; ic11/ic12/ic07/ic08/ic09/ic10 cover
 * 32/64/128/256/512/1024 px. (The previously committed icns had the same
 * shape — a lone PNG-bearing ic10 chunk.)
 *
 * Run: `npm run icons` (installs sharp / png-to-ico on demand via --no-save).
 * The generated files are committed so end users never need sharp.
 */
import sharp from "sharp";
import pngToIcoModule from "png-to-ico";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const pngToIco = pngToIcoModule.default || pngToIcoModule;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tauriIcons = "native/crates/lighthouse-desktop/icons";
mkdirSync(join(root, "assets"), { recursive: true });
mkdirSync(join(root, tauriIcons), { recursive: true });

const buf = (svg, size) =>
  sharp(join(root, svg))
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

async function render(svg, out, size) {
  writeFileSync(join(root, out), await buf(svg, size));
  console.log(`  ✓ ${out} (${size}×${size})`);
}

await render("build/icon.svg", "build/icon.png", 1024); // brand-art master
await render("build/icon.svg", `${tauriIcons}/icon.png`, 1024); // Tauri bundle
await render("build/icon.svg", "assets/icon.png", 512);  // window icon (legacy)
await render("build/tray.svg", `${tauriIcons}/tray-template.png`, 44); // macOS menubar template

// Windows multi-resolution .ico for the app + NSIS installer (and the same
// bytes again for the Tauri bundle set).
const sizes = [16, 24, 32, 48, 64, 128, 256];
const ico = await pngToIco(await Promise.all(sizes.map((s) => buf("build/icon.svg", s))));
writeFileSync(join(root, "build/icon.ico"), ico);
console.log(`  ✓ build/icon.ico (${sizes.join(",")})`);
writeFileSync(join(root, `${tauriIcons}/icon.ico`), ico);
console.log(`  ✓ ${tauriIcons}/icon.ico (${sizes.join(",")})`);

// macOS .icns for the Tauri bundle — hand-rolled PNG-in-icns container.
const icnsChunk = (type, payload) => {
  const header = Buffer.alloc(8);
  header.write(type, 0, "ascii");
  header.writeUInt32BE(payload.length + 8, 4);
  return Buffer.concat([header, payload]);
};
const icnsTypes = [
  ["ic11", 32],   // 16pt @2x
  ["ic12", 64],   // 32pt @2x
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024], // 512pt @2x
];
const chunks = [];
for (const [type, size] of icnsTypes) {
  chunks.push(icnsChunk(type, await buf("build/icon.svg", size)));
}
const icnsBody = Buffer.concat(chunks);
const icnsHeader = Buffer.alloc(8);
icnsHeader.write("icns", 0, "ascii");
icnsHeader.writeUInt32BE(icnsBody.length + 8, 4);
writeFileSync(join(root, `${tauriIcons}/icon.icns`), Buffer.concat([icnsHeader, icnsBody]));
console.log(`  ✓ ${tauriIcons}/icon.icns (${icnsTypes.map(([, s]) => s).join(",")})`);
console.log("icons generated.");
