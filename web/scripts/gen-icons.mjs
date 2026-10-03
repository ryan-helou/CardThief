// Monochrome mark: a tilted trading card with a spark. No emoji.
import sharp from "sharp";
import { mkdirSync } from "node:fs";

const svg = (pad) => `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#2A1840"/>
  <g transform="translate(${pad / 2},${pad / 2}) scale(${(512 - pad) / 512})" fill="none" stroke="#F3EEF9" stroke-linecap="round" stroke-linejoin="round">
    <g transform="rotate(-12 256 270)">
      <rect x="166" y="120" width="180" height="252" rx="18" stroke-width="22"/>
      <circle cx="256" cy="230" r="46" stroke-width="20"/>
      <path d="M210 230 H302" stroke-width="20"/>
    </g>
    <path d="M372 112 l12 30 30 12 -30 12 -12 30 -12 -30 -30 -12 30 -12z" fill="#F3EEF9" stroke-width="6"/>
  </g>
</svg>`;

mkdirSync("public/icons", { recursive: true });
for (const [name, size, pad] of [["icon-192", 192, 0], ["icon-512", 512, 0], ["maskable-512", 512, 110], ["apple-touch-icon", 180, 0]]) {
  await sharp(Buffer.from(svg(pad))).resize(size, size).png().toFile(`public/icons/${name}.png`);
  console.log("wrote", name);
}
