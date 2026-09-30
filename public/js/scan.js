// Belegscanner wie bei einer Dokumenten-App: findet den hellen Beleg im Foto, bestimmt seine vier Ecken
// und richtet ihn perspektivisch gerade. Läuft ganz im Browser (Canvas-Pixel), ohne Bibliothek.
// Arbeitet auf RGBA-Pixeln (Uint8ClampedArray), damit es sich auch ohne Browser testen lässt.
(function (root) {
  'use strict';

  function toGray(rgba, w, h) {
    const g = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
    return g;
  }
  // Leichte Unschärfe (3×3), damit Rauschen und feine Muster keine Löcher reissen
  function blur(g, w, h) {
    const out = new Uint8Array(g.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= w) continue; s += g[yy * w + xx]; n++; }
        }
        out[y * w + x] = s / n;
      }
    }
    return out;
  }
  // Schwelle nach Otsu: trennt hell (Papier) von dunkel (Hintergrund)
  function otsu(g) {
    const hist = new Float64Array(256);
    for (let i = 0; i < g.length; i++) hist[g[i]]++;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, t = 127;
    for (let i = 0; i < 256; i++) {
      wB += hist[i]; if (!wB) continue;
      const wF = g.length - wB; if (!wF) break;
      sumB += i * hist[i];
      const mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; t = i; }
    }
    return t;
  }
  // Maske schliessen (erst ausdehnen, dann schrumpfen): Textzeilen reissen das Papier nicht mehr in Streifen
  function spread(m, w, h, r, grow) {
    const tmp = new Uint8Array(m.length), out = new Uint8Array(m.length), want = grow ? 1 : 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let hit = 0;
        for (let d = -r; d <= r && !hit; d++) { const xx = x + d; if (xx >= 0 && xx < w && m[y * w + xx] === want) hit = 1; }
        tmp[y * w + x] = grow ? hit : (hit ? 0 : 1);
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let hit = 0;
        for (let d = -r; d <= r && !hit; d++) { const yy = y + d; if (yy >= 0 && yy < h && tmp[yy * w + x] === want) hit = 1; }
        out[y * w + x] = grow ? hit : (hit ? 0 : 1);
      }
    }
    return out;
  }
  const close = (m, w, h, r) => spread(spread(m, w, h, r, true), w, h, r, false);

  // Grösste zusammenhängende helle Fläche (4er-Nachbarschaft)
  function largestComponent(mask, w, h) {
    const label = new Int32Array(w * h), stack = new Int32Array(w * h);
    let bestId = 0, bestSize = 0, id = 0;
    for (let start = 0; start < mask.length; start++) {
      if (!mask[start] || label[start]) continue;
      id++;
      let top = 0, size = 0;
      stack[top++] = start; label[start] = id;
      while (top) {
        const p = stack[--top]; size++;
        const x = p % w, y = (p - x) / w;
        if (x > 0 && mask[p - 1] && !label[p - 1]) { label[p - 1] = id; stack[top++] = p - 1; }
        if (x < w - 1 && mask[p + 1] && !label[p + 1]) { label[p + 1] = id; stack[top++] = p + 1; }
        if (y > 0 && mask[p - w] && !label[p - w]) { label[p - w] = id; stack[top++] = p - w; }
        if (y < h - 1 && mask[p + w] && !label[p + w]) { label[p + w] = id; stack[top++] = p + w; }
      }
      if (size > bestSize) { bestSize = size; bestId = id; }
    }
    return { label, id: bestId, size: bestSize };
  }
  const area = q => Math.abs(q.reduce((a, p, i) => { const n = q[(i + 1) % 4]; return a + p.x * n.y - n.x * p.y; }, 0)) / 2;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  // Ecken des Belegs [oben links, oben rechts, unten rechts, unten links] oder null, wenn keiner klar erkennbar ist
  function findQuad(rgba, w, h) {
    const g = blur(toGray(rgba, w, h), w, h);
    const t = otsu(g);
    let mask = new Uint8Array(w * h);
    for (let i = 0; i < g.length; i++) mask[i] = g[i] > t ? 1 : 0;
    mask = close(mask, w, h, Math.max(2, Math.round(Math.min(w, h) / 90)));
    const { label, id, size } = largestComponent(mask, w, h);
    const total = w * h;
    if (!id || size < total * 0.05) return null; // zu klein: kein Beleg gefunden
    // Berührt die helle Fläche einen grossen Teil des Rands, ist es heller Hintergrund (z.B. weisser Tisch)
    let edge = 0;
    for (let x = 0; x < w; x++) { if (label[x] === id) edge++; if (label[(h - 1) * w + x] === id) edge++; }
    for (let y = 1; y < h - 1; y++) { if (label[y * w] === id) edge++; if (label[y * w + w - 1] === id) edge++; }
    if (edge > (2 * w + 2 * h) * 0.35) return null;
    // Extrempunkte: oben links = kleinstes x+y, unten rechts = grösstes x+y, oben rechts/unten links über x−y
    let tl = null, tr = null, br = null, bl = null, sMin = Infinity, sMax = -Infinity, dMin = Infinity, dMax = -Infinity;
    for (let p = 0; p < total; p++) {
      if (label[p] !== id) continue;
      const x = p % w, y = (p - x) / w, s = x + y, d = x - y;
      if (s < sMin) { sMin = s; tl = { x, y }; }
      if (s > sMax) { sMax = s; br = { x: x + 1, y: y + 1 }; }
      if (d > dMax) { dMax = d; tr = { x: x + 1, y }; }
      if (d < dMin) { dMin = d; bl = { x, y: y + 1 }; }
    }
    const q = [tl, tr, br, bl];
    const qa = area(q);
    // Unplausibel: fast das ganze Bild (nichts zuzuschneiden), zu schmal oder die Fläche füllt die Ecken kaum aus
    if (qa > total * 0.92 || qa < total * 0.05 || size < qa * 0.55) return null;
    if (Math.min(dist(tl, tr), dist(bl, br)) < w * 0.12 || Math.min(dist(tl, bl), dist(tr, br)) < h * 0.12) return null;
    // Knapp 1 % Rand zugeben, damit keine Kante des Belegs abgeschnitten wird
    const cx = (tl.x + tr.x + br.x + bl.x) / 4, cy = (tl.y + tr.y + br.y + bl.y) / 4;
    return q.map(p => ({ x: Math.min(w, Math.max(0, cx + (p.x - cx) * 1.008)), y: Math.min(h, Math.max(0, cy + (p.y - cy) * 1.008)) }));
  }

  // Grösse des geraden Bildes: längere der gegenüberliegenden Kanten, höchstens maxSide
  function outSize(q, maxSide) {
    let w = Math.max(dist(q[0], q[1]), dist(q[3], q[2])), h = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
    const k = Math.min(1, maxSide / Math.max(w, h));
    return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
  }

  // Homographie, die das Rechteck (0,0)-(dw,dh) auf das Viereck q abbildet (8 Unbekannte, Gauss-Verfahren)
  function homography(q, dw, dh) {
    const src = [[0, 0], [dw, 0], [dw, dh], [0, dh]], A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [u, v] = src[i], { x, y } = q[i];
      A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
      A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
    }
    for (let c = 0; c < 8; c++) {
      let piv = c;
      for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
      for (let r = 0; r < 8; r++) {
        if (r === c) continue;
        const f = A[r][c] / A[c][c];
        for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
    }
    return b.map((v, i) => v / A[i][i]);
  }
  const mapPoint = (H, u, v) => { const d = H[6] * u + H[7] * v + 1; return { x: (H[0] * u + H[1] * v + H[2]) / d, y: (H[3] * u + H[4] * v + H[5]) / d }; };

  // Viereck q aus dem Bild src (sw×sh) gerade ziehen: neues RGBA-Bild dw×dh (bilinear abgetastet)
  function warp(src, sw, sh, q, dw, dh) {
    const H = homography(q, dw, dh), out = new Uint8ClampedArray(dw * dh * 4);
    for (let v = 0; v < dh; v++) {
      for (let u = 0; u < dw; u++) {
        const uu = u + 0.5, vv = v + 0.5, d = H[6] * uu + H[7] * vv + 1;
        let x = (H[0] * uu + H[1] * vv + H[2]) / d - 0.5, y = (H[3] * uu + H[4] * vv + H[5]) / d - 0.5;
        x = Math.min(sw - 1, Math.max(0, x)); y = Math.min(sh - 1, Math.max(0, y));
        const x0 = x | 0, y0 = y | 0, x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1), fx = x - x0, fy = y - y0;
        const a = (y0 * sw + x0) * 4, b = (y0 * sw + x1) * 4, c = (y1 * sw + x0) * 4, e = (y1 * sw + x1) * 4, o = (v * dw + u) * 4;
        for (let ch = 0; ch < 3; ch++) {
          const top = src[a + ch] + (src[b + ch] - src[a + ch]) * fx, bot = src[c + ch] + (src[e + ch] - src[c + ch]) * fx;
          out[o + ch] = top + (bot - top) * fy;
        }
        out[o + 3] = 255;
      }
    }
    return out;
  }

  root.DocScan = { findQuad, outSize, homography, mapPoint, warp, otsu };
})(typeof window !== 'undefined' ? window : globalThis);
