// Belegscanner: public/js/scan.js mit künstlichen Fotos (heller Beleg auf dunklem Tisch)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = {};
ctx.globalThis = ctx;
vm.runInNewContext(readFileSync(new URL('../public/js/scan.js', import.meta.url), 'utf8'), ctx);
const S = ctx.DocScan;

// Punkt im Viereck (konvex, im Uhrzeigersinn)
const inside = (q, x, y) => q.every((p, i) => { const n = q[(i + 1) % 4]; return (n.x - p.x) * (y - p.y) - (n.y - p.y) * (x - p.x) >= 0; });
// Bild mit Hintergrundfarbe, hellem Viereck (Beleg) und dunklen Textzeilen darauf
function photo(w, h, quad, { bg = [70, 58, 48], paper = [238, 236, 230], noise = 12 } = {}) {
  const px = new Uint8ClampedArray(w * h * 4);
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let c = bg;
      if (quad && inside(quad, x + 0.5, y + 0.5)) {
        c = paper;
        // Textzeilen: Position im geraden Beleg über die Umkehrung abschätzen (grob über Anteil entlang der Kanten)
        // Textzeilen (3 Pixel hoch, Buchstaben mit Lücken) quer über den Beleg, auch bis an den Rand
        if (y % 7 < 3 && (x * 7 + y) % 5 < 3) c = [40, 40, 40];
      }
      const o = (y * w + x) * 4, n = (rnd() - 0.5) * noise;
      px[o] = c[0] + n; px[o + 1] = c[1] + n; px[o + 2] = c[2] + n; px[o + 3] = 255;
    }
  }
  return px;
}
const near = (a, b, tol) => Math.hypot(a.x - b.x, a.y - b.y) <= tol;

test('Findet einen schräg liegenden Beleg und seine vier Ecken', () => {
  const w = 300, h = 400;
  const truth = [{ x: 95, y: 40 }, { x: 225, y: 60 }, { x: 205, y: 370 }, { x: 70, y: 350 }];
  const q = S.findQuad(photo(w, h, truth), w, h);
  assert.ok(q, 'Beleg gefunden');
  q.forEach((p, i) => assert.ok(near(p, truth[i], 10), `Ecke ${i}: ${JSON.stringify(p)} statt ${JSON.stringify(truth[i])}`));
  const out = S.outSize(q, 1600);
  assert.ok(out.h > out.w * 2, `Hochformat wie ein Kassenzettel (${out.w}×${out.h})`);
});

test('Gerade liegender Beleg in der Mitte', () => {
  const w = 360, h = 480, truth = [{ x: 100, y: 60 }, { x: 260, y: 60 }, { x: 260, y: 430 }, { x: 100, y: 430 }];
  const q = S.findQuad(photo(w, h, truth), w, h);
  assert.ok(q);
  q.forEach((p, i) => assert.ok(near(p, truth[i], 8), `Ecke ${i}`));
});

test('Kein Zuschnitt, wenn kein Beleg klar erkennbar ist', () => {
  assert.equal(S.findQuad(photo(200, 200, null), 200, 200), null, 'nur Tisch');
  // Heller Tisch: die helle Fläche berührt den ganzen Rand
  const white = photo(200, 260, [{ x: 50, y: 40 }, { x: 150, y: 40 }, { x: 150, y: 220 }, { x: 50, y: 220 }], { bg: [230, 230, 228], paper: [245, 245, 245] });
  assert.equal(S.findQuad(white, 200, 260), null, 'weisser Hintergrund');
  // Beleg füllt fast das ganze Bild: nichts zuzuschneiden
  const full = photo(200, 260, [{ x: 2, y: 2 }, { x: 198, y: 2 }, { x: 198, y: 258 }, { x: 2, y: 258 }]);
  assert.equal(S.findQuad(full, 200, 260), null, 'füllt das Bild');
  // Winziger heller Fleck
  const tiny = photo(300, 300, [{ x: 140, y: 140 }, { x: 160, y: 140 }, { x: 160, y: 160 }, { x: 140, y: 160 }]);
  assert.equal(S.findQuad(tiny, 300, 300), null, 'zu klein');
});

test('Homographie bildet das Rechteck genau auf die Ecken ab', () => {
  const q = [{ x: 12, y: 30 }, { x: 240, y: 18 }, { x: 260, y: 400 }, { x: 5, y: 380 }];
  const H = S.homography(q, 100, 300);
  [[0, 0], [100, 0], [100, 300], [0, 300]].forEach(([u, v], i) => {
    const p = S.mapPoint(H, u, v);
    assert.ok(near(p, q[i], 1e-6), `Ecke ${i}`);
  });
});

test('Entzerren: gerades Rechteck ergibt dasselbe Bild, Viereck wird ausgeschnitten', () => {
  const w = 40, h = 30, src = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = (y * w + x) * 4; src[o] = x * 6; src[o + 1] = y * 8; src[o + 2] = 100; src[o + 3] = 255; }
  const same = S.warp(src, w, h, [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }], w, h);
  let maxDiff = 0;
  for (let i = 0; i < same.length; i++) maxDiff = Math.max(maxDiff, Math.abs(same[i] - src[i]));
  assert.ok(maxDiff <= 1, `gleiches Bild (Abweichung ${maxDiff})`);
  // Rechte Hälfte ausschneiden: erstes Pixel links oben entspricht Spalte 20
  const half = S.warp(src, w, h, [{ x: 20, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }, { x: 20, y: 30 }], 20, 30);
  assert.ok(Math.abs(half[0] - 20 * 6) <= 2, `Rotwert ${half[0]}`);
  assert.equal(half[3], 255);
});
