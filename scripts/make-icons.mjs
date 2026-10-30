// Makes every Syntaz icon from the one logo, src/app/icon.svg (the violet-to-pink rounded square with a white
// "S" and a spark): Chrome extension PNGs, Windows .ico, macOS .icns and the setup window's PNGs.
// Chrome draws the SVG at each size, so every icon matches the logo exactly.
// Run from the project folder: node scripts/make-icons.mjs   (needs Chrome; set NOVA_TEST_CHROME_BIN if it isn't found)
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chrome = [process.env.NOVA_TEST_CHROME_BIN, "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => p && existsSync(p));
if (!chrome) throw new Error("Chrome not found: set NOVA_TEST_CHROME_BIN");
const svg = readFileSync(path.join(root, "src", "app", "icon.svg"), "utf8");
const { default: puppeteer } = await import("puppeteer-core");
const browser = await puppeteer.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage();

/** The logo as a PNG of `size` px; `margin` (share of the size) leaves room around it (macOS icon grid). */
async function png(size, margin = 0) {
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
  const inner = Math.round(size * (1 - 2 * margin));
  const off = Math.round((size - inner) / 2);
  await page.setContent(`<html><body style="margin:0;background:transparent"><img style="position:absolute;left:${off}px;top:${off}px;width:${inner}px;height:${inner}px" src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}"></body></html>`);
  await page.waitForFunction(() => document.querySelector("img").complete);
  return Buffer.from(await page.screenshot({ type: "png", omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }));
}
const save = (buf, ...parts) => {
  const file = path.join(root, ...parts);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, buf);
};

for (const s of [16, 32, 48, 128]) save(await png(s), "chrome-extension", "icons", `nova-${s}.png`);
for (const s of [256, 512]) save(await png(s), "setup", "assets", `nova-${s}.png`);

// Windows .ico with PNG entries (Windows Vista and later).
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icoImages = [];
for (const s of icoSizes) icoImages.push(await png(s));
const header = Buffer.alloc(6 + 16 * icoSizes.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(icoSizes.length, 4);
let offset = header.length;
icoSizes.forEach((s, i) => {
  const e = 6 + 16 * i;
  header.writeUInt8(s % 256, e);
  header.writeUInt8(s % 256, e + 1);
  header.writeUInt16LE(1, e + 4);
  header.writeUInt16LE(32, e + 6);
  header.writeUInt32LE(icoImages[i].length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += icoImages[i].length;
});
save(Buffer.concat([header, ...icoImages]), "setup", "assets", "nova.ico");

// macOS .icns with PNG entries; the artwork uses Apple's grid (about 10% margin, like other Mac apps).
const types = [["icp4", 16], ["icp5", 32], ["icp6", 64], ["ic07", 128], ["ic08", 256], ["ic09", 512], ["ic10", 1024]];
const parts = [];
for (const [kind, s] of types) {
  const blob = await png(s, 0.1);
  const head = Buffer.alloc(8);
  head.write(kind, 0, "ascii");
  head.writeUInt32BE(blob.length + 8, 4);
  parts.push(head, blob);
}
const body = Buffer.concat(parts);
const icnsHead = Buffer.alloc(8);
icnsHead.write("icns", 0, "ascii");
icnsHead.writeUInt32BE(body.length + 8, 4);
save(Buffer.concat([icnsHead, body]), "setup", "assets", "nova.icns");
await browser.close();
console.log("icons written");
