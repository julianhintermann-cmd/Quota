// Version 4: Geräte, Favoriten, Intervalle, Reisen, Push-Mitteilungen, Quota-Assistent
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createECDH, createDecipheriv, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { createApp, deviceLabel } from '../server/app.js';
import { encrypt } from '../server/push.js';
import { createNotifier } from '../server/notify.js';
import { REFUSAL } from '../server/assistant.js';
import { periodBounds, periodKeyOf, money } from '../server/period.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const quiet = { info() {}, error() {} };
let app, base, dir, orFake, orUrl, pushFake, pushUrl;
const orState = { chatCalls: [], failFirst: 0 };
const pushState = { requests: [], status: 201 };

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

before(async () => {
  // Nachgebauter OpenRouter mit Modellliste und Antwort als Datenstrom
  orFake = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (req.url === '/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [
          { id: 'teuer/modell', name: 'Teuer', pricing: { prompt: '0.00001', completion: '0.00003' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
          { id: 'google/gemini-2.5-flash-lite', name: 'Gemini Lite', pricing: { prompt: '0.0000001', completion: '0.0000004' }, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
          { id: 'openai/gpt-4o-mini', name: 'GPT-4o mini', pricing: { prompt: '0.00000015', completion: '0.0000006' }, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
          { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama', context_length: 131072, pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
          { id: 'irgendwas/klein:free', name: 'Klein', context_length: 8000, pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
          { id: 'google/gemini-2.0-flash-exp:free', name: 'Gemini', context_length: 1000000, pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
          { id: 'bild/nur:free', pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'], output_modalities: ['image'] } },
        ] }));
      }
      const j = JSON.parse(body);
      orState.chatCalls.push({ model: j.model, messages: j.messages, stream: j.stream, auth: req.headers.authorization });
      if (orState.failFirst > 0) {
        orState.failFirst--;
        res.writeHead(429, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'rate-limited upstream' } }));
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': OPENROUTER PROCESSING\n\n');
      for (const part of ['Tippe auf ', '**Plus**', ' unten rechts.']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise(r => orFake.listen(0, '127.0.0.1', r));
  orUrl = `http://127.0.0.1:${orFake.address().port}`;

  // Nachgebauter Push-Dienst
  pushFake = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      pushState.requests.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(pushState.status); res.end();
    });
  });
  await new Promise(r => pushFake.listen(0, '127.0.0.1', r));
  pushUrl = `http://127.0.0.1:${pushFake.address().port}`;

  dir = mkdtempSync(join(tmpdir(), 'quota-v4-'));
  app = createApp({ dataDir: dir, publicDir: join(root, 'public'), backupKeep: 0, log: quiet, openrouterUrl: orUrl, pushEndpointOk: u => u.startsWith(pushUrl) });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => {
  await app.close();
  await new Promise(r => orFake.close(r));
  await new Promise(r => pushFake.close(r));
  rmSync(dir, { recursive: true, force: true });
});

function client(ua = 'node') {
  let cookie = '';
  const call = async (method, path, body) => {
    const h = { 'User-Agent': ua };
    if (cookie) h.Cookie = cookie;
    if (method !== 'GET') h['X-Requested-With'] = 'monatsbudget';
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) { const v = set.split(';')[0]; cookie = v.endsWith('=') ? '' : v; }
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* Text */ }
    return { status: res.status, data, text, headers: res.headers };
  };
  return call;
}
const admin = client(MAC_CHROME), anna = client(IPHONE), annaMac = client(MAC_CHROME);
const pad = n => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

test('Einrichtung', async () => {
  assert.equal((await admin('POST', '/api/auth/setup', { username: 'julian', password: 'geheim123' })).status, 201);
  assert.equal((await admin('POST', '/api/admin/users', { username: 'anna', password: 'annas-passwort' })).status, 201);
  assert.equal((await anna('POST', '/api/auth/login', { username: 'anna', password: 'annas-passwort' })).status, 200);
  assert.equal((await annaMac('POST', '/api/auth/login', { username: 'anna', password: 'annas-passwort' })).status, 200);
});

test('Gerätenamen aus dem User-Agent', () => {
  assert.equal(deviceLabel(IPHONE), 'iPhone · Safari');
  assert.equal(deviceLabel(MAC_CHROME), 'Mac · Chrome');
  assert.equal(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0'), 'Windows · Edge');
  assert.equal(deviceLabel('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36'), 'Android-Handy · Chrome');
  assert.equal(deviceLabel(''), 'Unbekanntes Gerät');
});

test('Angemeldete Geräte: auflisten, einzeln und alle anderen abmelden', async () => {
  let r = await anna('GET', '/api/sessions');
  assert.equal(r.status, 200);
  assert.equal(r.data.sessions.length, 2);
  const me = r.data.sessions.find(s => s.current), other = r.data.sessions.find(s => !s.current);
  assert.equal(me.device, 'iPhone · Safari');
  assert.equal(other.device, 'Mac · Chrome');
  assert.match(other.id, /^[a-f0-9]{16}$/);
  assert.ok(!JSON.stringify(r.data).includes('hash'), 'kein Hash nach aussen');
  assert.equal((await anna('DELETE', `/api/sessions/${me.id}`)).status, 400, 'eigene Sitzung nur über Abmelden');
  assert.equal((await admin('DELETE', `/api/sessions/${other.id}`)).data.removed, 0, 'fremde Sitzungen bleiben');
  assert.equal((await anna('DELETE', `/api/sessions/${other.id}`)).status, 200);
  assert.equal((await annaMac('GET', '/api/data')).status, 401, 'Mac ist abgemeldet');
  assert.equal((await anna('GET', '/api/data')).status, 200);
  assert.equal((await annaMac('POST', '/api/auth/login', { username: 'anna', password: 'annas-passwort' })).status, 200);
  assert.equal((await anna('DELETE', '/api/sessions')).status, 200);
  assert.equal((await annaMac('GET', '/api/data')).status, 401);
  assert.equal((await anna('GET', '/api/sessions')).data.sessions.length, 1);
});

test('Favoriten gehören zu den Einstellungen', async () => {
  const favs = [{ id: 'f1', t: 'Kaffee', a: 4.9, c: 'essen' }, { id: 'f2', t: 'Croissant Paris', a: 2.2, c: 'essen', cur: 'EUR' }];
  assert.equal((await anna('PUT', '/api/settings', { currency: 'CHF', startDay: 25, favorites: favs })).status, 200);
  assert.deepEqual((await anna('GET', '/api/data')).data.settings.favorites, favs);
  assert.equal((await anna('PUT', '/api/settings', { currency: 'CHF', startDay: 25 })).status, 200);
  assert.deepEqual((await anna('GET', '/api/data')).data.settings.favorites, favs, 'ohne Angabe bleiben sie');
  assert.equal((await anna('PUT', '/api/settings', { currency: 'CHF', startDay: 25, favorites: [{ id: 'x', t: '', a: 1 }] })).status, 400);
  assert.equal((await anna('PUT', '/api/settings', { currency: 'CHF', startDay: 25, favorites: Array.from({ length: 13 }, (_, i) => ({ id: 'f' + i, t: 'x', a: 1 })) })).status, 400);
  assert.equal((await anna('PUT', '/api/settings', { currency: 'CHF', startDay: 25, favorites: [] })).status, 200);
  assert.equal((await anna('GET', '/api/data')).data.settings.favorites, undefined);
});

test('Fixkosten alle 3 oder 12 Monate, Zuordnung zu Reisen', async () => {
  let r = await anna('PUT', '/api/months/2026-09', { income: 5000, budget: 3000, expenses: [
    { id: 'y1', amt: 890, title: 'Autoversicherung', cat: 'mobil', date: '2026-09-30', rep: true, every: 12, ts: 1 },
    { id: 'q1', amt: 120, title: 'Serafe', cat: 'wohnen', date: '2026-09-28', rep: true, every: 3, ts: 2 },
    { id: 'm1', amt: 1650, title: 'Miete', cat: 'wohnen', date: '2026-09-26', rep: true, ts: 3 },
    { id: 'x1', amt: 5, title: 'Einmalig', cat: 'sonst', date: '2026-09-27', rep: false, every: 12, ts: 4 },
    { id: 't1', amt: 42.3, title: 'Bistro', cat: 'essen', date: '2026-09-27', rep: false, ts: 5, trip: 'paris', fx: { cur: 'EUR', amt: 45, rate: 0.94 } },
  ] });
  assert.equal(r.status, 200);
  const list = (await anna('GET', '/api/data')).data.months['2026-09'].expenses;
  const by = id => list.find(e => e.id === id);
  assert.equal(by('y1').every, 12);
  assert.equal(by('q1').every, 3);
  assert.equal(by('m1').every, undefined);
  assert.equal(by('m1').rep, true);
  assert.equal(by('x1').every, undefined, 'nur bei wiederkehrenden');
  assert.equal(by('t1').trip, 'paris');
});

test('Reisen: anlegen, prüfen, löschen (Ausgaben bleiben)', async () => {
  assert.equal((await anna('PUT', '/api/trips/paris', { name: 'Paris', start: '2026-09-26', end: '2026-09-20', cur: 'EUR' })).status, 400, 'Ende vor Anfang');
  assert.equal((await anna('PUT', '/api/trips/paris', { name: 'Paris', start: '2026-01-01', end: '2027-06-01', cur: 'EUR' })).status, 400, 'länger als ein Jahr');
  assert.equal((await anna('PUT', '/api/trips/paris', { name: 'Paris', start: '2026-09-26', end: '2026-09-30', cur: 'euro' })).status, 400);
  let r = await anna('PUT', '/api/trips/paris', { name: 'Paris', start: '2026-09-26', end: '2026-09-30', budget: 800, cur: 'EUR', rate: 0.94, icon: 'reisen' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.trips, [{ id: 'paris', name: 'Paris', start: '2026-09-26', end: '2026-09-30', budget: 800, cur: 'EUR', rate: 0.94, icon: 'reisen' }]);
  assert.deepEqual((await anna('GET', '/api/data')).data.trips.map(t => t.id), ['paris']);
  assert.deepEqual((await admin('GET', '/api/data')).data.trips, [], 'getrennt pro Person');
  r = await anna('DELETE', '/api/trips/paris');
  assert.deepEqual(r.data.trips, []);
  const e = (await anna('GET', '/api/data')).data.months['2026-09'].expenses.find(x => x.id === 't1');
  assert.ok(e, 'Ausgabe bleibt');
  assert.equal(e.trip, undefined, 'nur die Zuordnung ist weg');
});

/* ---------- Push ---------- */
function device() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, auth, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
}
function decrypt(body, dev) {
  const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  assert.equal(body.readUInt32BE(16), 4096);
  const shared = dev.ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync('sha256', shared, dev.auth, Buffer.concat([Buffer.from('WebPush: info\0'), dev.ecdh.getPublicKey(), asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(-16));
  const pt = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]);
  assert.equal(pt[pt.length - 1], 2, 'Endmarke');
  return JSON.parse(pt.subarray(0, -1).toString('utf8'));
}

test('Push: Verschlüsselung entspricht RFC 8291 (Beispiel aus Anhang A)', () => {
  const as = createECDH('prime256v1');
  as.setPrivateKey(Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'));
  const out = encrypt('When I grow up, I want to be a watermelon', {
    p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  }, { salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'), local: as });
  assert.equal(out.toString('base64url'), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

test('Push: abonnieren, Test senden (VAPID + verschlüsselt), abgelaufene Abos entfernen', async () => {
  let r = await anna('GET', '/api/push');
  assert.equal(Buffer.from(r.data.key, 'base64url').length, 65);
  assert.deepEqual(r.data.prefs, { budget: true, remind: null, review: true, due: true });
  assert.equal(r.data.devices, 0);
  const dev = device();
  assert.equal((await anna('POST', '/api/push/subscribe', { endpoint: 'http://192.168.1.1/hack', keys: dev.keys })).status, 400, 'nur bekannte Push-Dienste');
  assert.equal((await anna('POST', '/api/push/subscribe', { endpoint: pushUrl + '/x', keys: { p256dh: 'kurz', auth: 'kurz' } })).status, 400);
  r = await anna('POST', '/api/push/subscribe', { endpoint: pushUrl + '/anna-iphone', keys: dev.keys });
  assert.equal(r.status, 201);
  assert.equal(r.data.devices, 1);
  pushState.requests = [];
  r = await anna('POST', '/api/push/test');
  assert.equal(r.status, 200);
  assert.equal(pushState.requests.length, 1);
  const q = pushState.requests[0];
  assert.equal(q.url, '/anna-iphone');
  assert.equal(q.headers['content-encoding'], 'aes128gcm');
  assert.ok(Number(q.headers.ttl) > 0);
  const m = q.headers.authorization.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
  assert.ok(m, 'VAPID-Kopfzeile');
  assert.equal(m[4], (await anna('GET', '/api/push')).data.key);
  const claims = JSON.parse(Buffer.from(m[2], 'base64url').toString());
  assert.equal(claims.aud, pushUrl);
  assert.match(claims.sub, /^(mailto:|https:\/\/)/);
  const raw = Buffer.from(m[4], 'base64url');
  const pub = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url')), 'Signatur stimmt');
  assert.deepEqual(decrypt(q.body, dev), { title: 'Quota', body: 'So sehen Mitteilungen von Quota aus. 👋', url: '/', tag: 'test' });

  assert.equal((await anna('PUT', '/api/push/prefs', { remind: '25:00' })).status, 400);
  r = await anna('PUT', '/api/push/prefs', { remind: '20:30', due: false });
  assert.deepEqual(r.data.prefs, { budget: true, remind: '20:30', review: true, due: false });

  pushState.status = 410;
  await app.sendToUser(app.db.userByName('anna').id, { title: 'x', body: 'y' });
  pushState.status = 201;
  assert.equal((await anna('GET', '/api/push')).data.devices, 0, 'vom Push-Dienst gelöschtes Abo ist weg');
});

test('Push: Budgetwarnung bei 80 % und 100 % je einmal pro Periode', async () => {
  const dev = device();
  await anna('POST', '/api/push/subscribe', { endpoint: pushUrl + '/anna-2', keys: dev.keys });
  const day = today(), key = periodKeyOf(day, 25), [start] = periodBounds(key, 25);
  const put = exps => anna('PUT', `/api/months/${key}`, { income: 5000, budget: 1000, expenses: exps.map((a, i) => ({ id: 'b' + i, amt: a, title: 'Test', cat: 'sonst', date: start, rep: false, ts: i })) });
  await put([]);
  const wait = () => new Promise(r => setTimeout(r, 150));
  pushState.requests = [];
  await put([500]); await wait();
  assert.equal(pushState.requests.length, 0, 'unter 80 %');
  await put([500, 320]); await wait();
  assert.equal(pushState.requests.length, 1);
  assert.match(decrypt(pushState.requests[0].body, dev).title, /^82 % vom Budget ausgegeben$/);
  await put([500, 330]); await wait();
  assert.equal(pushState.requests.length, 1, 'nicht doppelt');
  await put([500, 320, 250]); await wait();
  assert.equal(pushState.requests.length, 2);
  const msg = decrypt(pushState.requests[1].body, dev);
  assert.match(msg.title, /Budget für .+ aufgebraucht/);
  assert.match(msg.body, /CHF 70\.00 darüber/);
});

test('Push: Erinnerung, Rückblick am Lohntag, Fixkosten am Vortag', async () => {
  const db = app.db, uid = db.userByName('julian').id, sent = [];
  db.addPushSub(uid, { endpoint: pushUrl + '/julian', p256dh: device().keys.p256dh, auth: 'AAAAAAAAAAAAAAAAAAAAAA', device: 'Test' });
  db.putPushPrefs(uid, { budget: true, remind: '20:00', review: true, due: true });
  await admin('PUT', '/api/settings', { currency: 'CHF', startDay: 25 });
  await admin('PUT', '/api/months/2026-08', { income: 5000, budget: 3000, expenses: [{ id: 'a1', amt: 2680, title: 'Alles', cat: 'sonst', date: '2026-08-26', rep: false, ts: 1 }] });
  await admin('PUT', '/api/months/2026-10', { income: null, budget: null, expenses: [
    { id: 'car', amt: 890, title: 'Autoversicherung', cat: 'mobil', date: '2026-10-02', rep: true, every: 12, ts: 1 },
    { id: 'rent', amt: 1650, title: 'Miete', cat: 'wohnen', date: '2026-10-02', rep: true, ts: 2 },
  ] });
  let now = new Date(2026, 8, 25, 8, 0); // 25. Sept., Lohntag
  const n = createNotifier({ db, sendToUser: async (u, m) => { if (u === uid) sent.push(m); return 1; }, now: () => now, log: quiet });
  await n.tick();
  assert.equal(sent.length, 0, 'vor 9 Uhr nichts');
  now = new Date(2026, 8, 25, 9, 5);
  await n.tick(); await n.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, 'Dein Rückblick auf August');
  assert.equal(sent[0].body, 'CHF 320.00 sind übrig geblieben. Schau dir an, wohin dein Geld ging.');
  assert.equal(sent[0].url, '/?review=2026-08');
  now = new Date(2026, 8, 25, 20, 10);
  await n.tick(); await n.tick();
  assert.equal(sent.length, 2, 'Erinnerung einmal');
  assert.equal(sent[1].title, 'Schon alles erfasst?');
  now = new Date(2026, 9, 1, 18, 30); // 1. Okt.: morgen ist die Autoversicherung fällig, die Miete ist monatlich
  await n.tick();
  const due = sent.find(m => m.title.startsWith('Morgen fällig'));
  assert.deepEqual([due.title, due.body], ['Morgen fällig: Autoversicherung', 'CHF 890.00 · jährlich']);
  await n.tick();
  assert.equal(sent.filter(m => m.title.startsWith('Morgen fällig')).length, 1);
});

test('Beträge in Mitteilungen wie in der App', () => {
  assert.equal(money(1234.5), 'CHF 1’234.50');
  assert.equal(money(-12, 'EUR'), '−EUR 12.00');
  assert.equal(money(1234567.891), 'CHF 1’234’567.89');
});

/* ---------- Quota-Assistent ---------- */
async function ask(c, messages, extra = {}) {
  const r = await c('POST', '/api/assistant', { messages, ...extra });
  if (r.status !== 200) return r;
  const lines = r.text.trim().split('\n').map(l => JSON.parse(l));
  return { status: 200, lines, text: lines.filter(l => l.d).map(l => l.d).join(''), done: lines[lines.length - 1] };
}

test('Assistent: ohne Schlüssel aus, günstiges Modell, Antwort als Strom', async () => {
  let r = await anna('GET', '/api/assistant');
  assert.deepEqual(r.data, { enabled: false, limit: 30, used: 0, remaining: 30 });
  assert.equal((await ask(anna, [{ role: 'user', content: 'Hallo' }])).status, 409);
  await admin('PUT', '/api/admin/ai', { key: 'sk-or-v1-testschluessel1234' });
  assert.equal((await admin('PUT', '/api/admin/ai', { chatModel: 'kein gültiger name' })).status, 400);
  r = await admin('GET', '/api/admin/ai/chat-models');
  assert.deepEqual(r.data.models.map(m => m.id), ['google/gemini-2.5-flash-lite', 'openai/gpt-4o-mini', 'teuer/modell'], 'günstigste zuerst, ohne Gratis- und Bildmodelle');
  assert.deepEqual([r.data.models[0].price, r.data.models[0].priceOut].map(v => Math.round(v * 100) / 100), [0.1, 0.4], 'Preise pro 1 Mio. Tokens');
  assert.equal((await anna('GET', '/api/admin/ai/chat-models')).status, 403);
  assert.equal((await admin('GET', '/api/admin/ai')).data.chatDefault, 'google/gemini-2.5-flash-lite');

  orState.chatCalls = [];
  r = await ask(anna, [{ role: 'user', content: 'Wie erfasse ich eine Ausgabe?' }]);
  assert.equal(r.status, 200);
  assert.equal(r.lines[0].model, 'google/gemini-2.5-flash-lite');
  assert.equal(r.text, 'Tippe auf **Plus** unten rechts.');
  assert.equal(r.done.done, true);
  assert.equal(r.done.remaining, 29);
  const call = orState.chatCalls[0];
  assert.equal(call.stream, true);
  assert.equal(call.messages[0].role, 'system');
  assert.ok(call.messages[0].content.includes(REFUSAL), 'fester Ablehnungssatz im Auftrag');
  assert.ok(call.messages[0].content.includes('Ausgabe erfassen'), 'Anleitung dabei');
  assert.ok(!call.messages[0].content.includes('Laufende Periode'), 'ohne Zahlen');
  assert.deepEqual(call.messages.slice(1), [{ role: 'user', content: 'Wie erfasse ich eine Ausgabe?' }]);
});

test('Assistent: eigene Zahlen nur auf Wunsch, Ausweichmodell, Tageslimit, Prüfung', async () => {
  orState.chatCalls = [];
  let r = await ask(anna, [{ role: 'user', content: 'Wie viel habe ich übrig?' }], { withData: true });
  assert.equal(r.status, 200);
  assert.match(orState.chatCalls[0].messages[0].content, /Laufende Periode .+Budget: CHF 1’000\.00/s);
  orState.chatCalls = []; orState.failFirst = 1;
  r = await ask(anna, [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }]);
  assert.equal(r.lines[0].model, 'openai/gpt-4o-mini', 'springt aufs nächste Modell');
  assert.deepEqual(orState.chatCalls.map(c => c.model), ['google/gemini-2.5-flash-lite', 'openai/gpt-4o-mini']);
  assert.equal(orState.chatCalls[1].messages.length, 4);
  assert.equal((await ask(anna, [{ role: 'assistant', content: 'b' }])).status, 400, 'zuletzt muss die Person schreiben');
  assert.equal((await ask(anna, [])).status, 400);
  await admin('PUT', '/api/admin/ai', { chatLimit: 3, chatModel: 'teuer/modell' });
  orState.chatCalls = [];
  r = await ask(admin, [{ role: 'user', content: 'x' }]);
  assert.equal(orState.chatCalls[0].model, 'teuer/modell', 'vom Admin gewählt');
  assert.equal(r.done.remaining, null, 'Admin ohne Limit');
  assert.equal((await ask(anna, [{ role: 'user', content: 'x' }])).status, 429, 'Anna hat 3 von 3 gebraucht');
  assert.equal((await admin('GET', '/api/admin/ai')).data.chatLimit, 3);
});
