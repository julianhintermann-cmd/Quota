// Erzeugt die App-Icons (Home-Bildschirm, Android, Browser-Tab) aus einer SVG-Vorlage.
// Aufruf: node tools/build-icons.mjs   (benötigt Playwright mit Chromium)
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = (() => {
  try { return require('playwright'); } catch { return require(process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright'); }
})();

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(out, { recursive: true });

// Farben wie die Übersichtskarte der App (--hero / --hero-text)
const BG = '#111112', FG = '#F4F4F1';
// Geldbörse aus der App (24er-Raster, Symbol "i-wallet")
const WALLET = `<path d="M4 8a2.5 2.5 0 0 1 2.5-2.5H17a1.5 1.5 0 0 1 1.5 1.5v1"/>
  <rect x="4" y="8" width="16.5" height="11.5" rx="2.5"/><path d="M15.5 13.75h1.5"/>`;

/**
 * @param rounded  abgerundete Kachel mit transparentem Rand (sonst randlos, iOS/Android runden selbst)
 * @param glyph    Breite der Geldbörse relativ zur Kachel
 * @param stroke   Strichstärke im 24er-Raster
 */
function svg({ rounded = false, glyph = 0.52, stroke = 1.5 } = {}) {
  const S = 1024, w = 16.5, h = 14, cx = 4 + w / 2, cy = 5.5 + h / 2;
  const k = (S * glyph) / w;
  const r = rounded ? S * 0.225 : 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}">
  <defs>
    <radialGradient id="hl" cx="1" cy="0" r="1.15">
      <stop offset="0" stop-color="#fff" stop-opacity=".13"/>
      <stop offset=".62" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="tile"><rect width="${S}" height="${S}" rx="${r}"/></clipPath>
  </defs>
  <g clip-path="url(#tile)">
    <rect width="${S}" height="${S}" fill="${BG}"/>
    <rect width="${S}" height="${S}" fill="url(#hl)"/>
  </g>
  <g transform="translate(${S / 2} ${S / 2}) scale(${k}) translate(${-cx} ${-cy})"
     fill="none" stroke="${FG}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">
    ${WALLET}
  </g>
</svg>`;
}

const variants = [
  { file: 'apple-touch-icon.png', size: 180, opts: {} },
  { file: 'icon-192.png', size: 192, opts: { rounded: true } },
  { file: 'icon-512.png', size: 512, opts: { rounded: true } },
  { file: 'icon-maskable-512.png', size: 512, opts: { glyph: 0.45 } },
  { file: 'favicon-32.png', size: 32, opts: { rounded: true, glyph: 0.66, stroke: 2.1 } },
  { file: 'favicon-16.png', size: 16, opts: { rounded: true, glyph: 0.7, stroke: 2.4 } },
];

writeFileSync(join(out, 'icon.svg'), svg({ rounded: true }));
writeFileSync(join(out, 'favicon.svg'), svg({ rounded: true, glyph: 0.66, stroke: 2.1 }));

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
const png = {};
for (const v of variants) {
  await page.setViewportSize({ width: v.size, height: v.size });
  const body = svg(v.opts).replace('<svg ', `<svg width="${v.size}" height="${v.size}" `);
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${body}</body></html>`);
  png[v.file] = await page.screenshot({ omitBackground: !!v.opts.rounded, clip: { x: 0, y: 0, width: v.size, height: v.size } });
  writeFileSync(join(out, v.file), png[v.file]);
}
await browser.close();

// favicon.ico mit 16er- und 32er-PNG (ICO darf PNG-Daten enthalten)
const imgs = [[16, png['favicon-16.png']], [32, png['favicon-32.png']]];
const head = Buffer.alloc(6 + 16 * imgs.length);
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(imgs.length, 4);
let offset = head.length;
imgs.forEach(([size, data], i) => {
  const e = 6 + 16 * i;
  head.writeUInt8(size, e); head.writeUInt8(size, e + 1); head.writeUInt8(0, e + 2); head.writeUInt8(0, e + 3);
  head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
  head.writeUInt32LE(data.length, e + 8); head.writeUInt32LE(offset, e + 12);
  offset += data.length;
});
writeFileSync(join(out, 'favicon.ico'), Buffer.concat([head, ...imgs.map(([, d]) => d)]));
console.log('Icons geschrieben nach', out);
