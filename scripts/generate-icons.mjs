/**
 * Regenerates the PWA icons in public/icons from an inline SVG ("FB" on basketball orange).
 * Letters are drawn as paths, so no fonts are needed. Run: node scripts/generate-icons.mjs
 * (uses `sharp`, which ships with Next.js).
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#ea580c"/>
  <g fill="none" stroke="#ffffff" stroke-width="38" stroke-linecap="square" stroke-linejoin="miter">
    <path d="M150 150 V362 M150 150 H252 M150 250 H236"/>
    <path d="M292 150 V362 M292 150 H334 A50 50 0 0 1 334 250 H292 M292 250 H350 A56 56 0 0 1 350 362 H292"/>
  </g>
</svg>`;

const outDir = path.resolve("public/icons");
fs.mkdirSync(outDir, { recursive: true });
const sizes = { "icon-192.png": 192, "icon-512.png": 512, "apple-touch-icon.png": 180 };
for (const [name, size] of Object.entries(sizes)) {
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(path.join(outDir, name));
  console.log("wrote", path.join("public/icons", name));
}
