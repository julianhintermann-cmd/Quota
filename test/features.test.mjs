import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createApp } from '../server/app.js';
import { openDatabase } from '../server/db.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const quiet = { info() {}, error() {} };
let app, base, dir, fake, fakeUrl;
const fakeState = { status: 200, content: null, calls: 0, lastBody: null };

before(async () => {
  // Nachgebauter OpenRouter-Server
  fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (req.url === '/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [
          { id: 'teuer/vision', name: 'Teuer', architecture: { input_modalities: ['text', 'image'] }, pricing: { prompt: '0.00001' } },
          { id: 'nur/text', name: 'Text', architecture: { input_modalities: ['text'] }, pricing: { prompt: '0' } },
          { id: 'guenstig/vision', name: 'Günstig', architecture: { input_modalities: ['image', 'text'] }, pricing: { prompt: '0.0000001' } },
        ] }));
      }
      fakeState.calls++;
      fakeState.lastBody = JSON.parse(body);
      fakeState.lastAuth = req.headers.authorization;
      res.writeHead(fakeState.status, { 'Content-Type': 'application/json' });
      if (fakeState.status !== 200) return res.end(JSON.stringify({ error: { message: 'kaputt' } }));
      res.end(JSON.stringify({ model: fakeState.lastBody.model, choices: [{ message: { content: fakeState.content } }] }));
    });
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  fakeUrl = `http://127.0.0.1:${fake.address().port}`;

  dir = mkdtempSync(join(tmpdir(), 'monatsbudget-features-'));
  app = createApp({ dataDir: dir, publicDir: join(root, 'public'), backupKeep: 0, log: quiet, openrouterUrl: fakeUrl });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => {
  await app.close();
  await new Promise(r => fake.close(r));
  rmSync(dir, { recursive: true, force: true });
});

function client() {
  let cookie = '';
  const call = async (method, path, body, { headers = {}, raw } = {}) => {
    const h = { ...headers };
    if (cookie) h.Cookie = cookie;
    if (method !== 'GET') h['X-Requested-With'] = 'monatsbudget';
    if (body !== undefined && !raw) h['Content-Type'] = 'application/json';
    const res = await fetch(base + path, { method, headers: h, body: raw || (body !== undefined ? JSON.stringify(body) : undefined), redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) { const v = set.split(';')[0]; cookie = v.endsWith('=') ? '' : v; }
    const buf = Buffer.from(await res.arrayBuffer());
    let data = buf.toString('utf8');
    try { data = JSON.parse(data); } catch { /* Text/Binär */ }
    return { status: res.status, data, buf, headers: res.headers };
  };
  call.cookie = () => cookie;
  return call;
}
const admin = client(), anna = client();
const jpeg = (n = 200) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, 7)]);

test('Einrichtung', async () => {
  assert.equal((await admin('POST', '/api/auth/setup', { username: 'julian', password: 'geheim123' })).status, 201);
  assert.equal((await admin('POST', '/api/admin/users', { username: 'anna', password: 'annas-passwort' })).status, 201);
  assert.equal((await anna('POST', '/api/auth/login', { username: 'anna', password: 'annas-passwort' })).status, 200);
});

test('Migration: ältere Datenbank bekommt die neuen Spalten', () => {
  const d = mkdtempSync(join(tmpdir(), 'monatsbudget-alt-'));
  const old = new DatabaseSync(join(d, 'monatsbudget.db'));
  old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, pw_hash TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE settings (user_id INTEGER PRIMARY KEY, currency TEXT NOT NULL, start_day INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE months (user_id INTEGER NOT NULL, month TEXT NOT NULL, income INTEGER, budget INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, month));
    CREATE TABLE expenses (user_id INTEGER NOT NULL, id TEXT NOT NULL, month TEXT NOT NULL, date TEXT NOT NULL, amount INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '', category TEXT NOT NULL, monthly INTEGER NOT NULL DEFAULT 0, ts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, id));
    INSERT INTO users VALUES (1, 'alt', 'x', 1, 0);
    INSERT INTO settings VALUES (1, 'EUR', 1, 0);
    INSERT INTO months VALUES (1, '2025-01', 100000, NULL, 0);
    INSERT INTO expenses VALUES (1, 'e1', '2025-01', '2025-01-05', 1250, 'Alt', 'essen', 0, 1);`);
  old.close();
  const db = openDatabase(d);
  const data = db.getData(1);
  assert.deepEqual(data.settings, { currency: 'EUR', startDay: 1 });
  assert.equal(data.months['2025-01'].expenses[0].amt, 12.5);
  assert.deepEqual(data.goals, []);
  db.close();
  rmSync(d, { recursive: true, force: true });
});

test('Eigene Kategorien: speichern, prüfen, beibehalten, zurücksetzen', async () => {
  const cats = [{ id: 'essen', n: 'Essen', ic: 'essen' }, { id: 'u_velo', n: 'Velo', ic: 'sport' }, { id: 'sonst', n: 'Rest', ic: 'sonst' }];
  let r = await admin('PUT', '/api/settings', { currency: 'CHF', startDay: 25, categories: cats });
  assert.equal(r.status, 200);
  r = await admin('GET', '/api/data');
  assert.deepEqual(r.data.settings.categories, cats);
  for (const bad of [
    [{ id: 'essen', n: 'Essen', ic: 'essen' }],
    [{ id: 'sonst', n: 'Rest', ic: 'unbekannt' }],
    [{ id: 'Böse', n: 'X', ic: 'sonst' }, { id: 'sonst', n: 'Rest', ic: 'sonst' }],
    [{ id: 'sonst', n: '', ic: 'sonst' }],
    [{ id: 'sonst', n: 'A', ic: 'sonst' }, { id: 'sonst', n: 'B', ic: 'sonst' }],
  ]) assert.equal((await admin('PUT', '/api/settings', { currency: 'CHF', startDay: 25, categories: bad })).status, 400, JSON.stringify(bad));
  r = await admin('PUT', '/api/settings', { currency: 'EUR', startDay: 25 });
  assert.equal(r.status, 200);
  r = await admin('GET', '/api/data');
  assert.equal(r.data.settings.currency, 'EUR');
  assert.deepEqual(r.data.settings.categories, cats, 'ohne "categories" bleiben sie erhalten');
  await admin('PUT', '/api/settings', { currency: 'CHF', startDay: 25, categories: null });
  r = await admin('GET', '/api/data');
  assert.equal(r.data.settings.categories, undefined, 'null = wieder Standard');
  await admin('PUT', '/api/settings', { currency: 'CHF', startDay: 25, categories: cats });
});

test('Sparziele: anlegen, einzahlen, auszahlen, löschen; getrennt pro Person', async () => {
  let r = await admin('PUT', '/api/goals/ferien', { name: 'Ferien Japan', target: 3000, deadline: '2027-06-30', icon: 'reisen' });
  assert.equal(r.status, 200);
  r = await admin('POST', '/api/goals/ferien/entries', { id: 'e1', amt: 500, date: '2026-09-25', note: 'Lohn' });
  assert.equal(r.status, 200);
  r = await admin('POST', '/api/goals/ferien/entries', { id: 'e2', amt: -50.5, date: '2026-09-28' });
  assert.equal(r.status, 200);
  assert.equal((await admin('POST', '/api/goals/ferien/entries', { id: 'e2', amt: 1, date: '2026-09-28' })).status, 409, 'doppelte ID');
  const g = r.data.goals[0];
  assert.deepEqual([g.name, g.target, g.deadline, g.icon], ['Ferien Japan', 3000, '2027-06-30', 'reisen']);
  assert.deepEqual(g.entries.map(e => e.amt), [500, -50.5]);
  for (const bad of [{ name: '', target: 10 }, { name: 'X', target: 0 }, { name: 'X', target: 10, deadline: '30.06.2027' }]) {
    assert.equal((await admin('PUT', '/api/goals/neu', bad)).status, 400);
  }
  assert.equal((await admin('POST', '/api/goals/ferien/entries', { id: 'e3', amt: 0, date: '2026-09-28' })).status, 400);
  assert.equal((await anna('POST', '/api/goals/ferien/entries', { id: 'x', amt: 5, date: '2026-09-28' })).status, 404, 'fremdes Ziel');
  assert.deepEqual((await anna('GET', '/api/data')).data.goals, []);
  r = await admin('DELETE', '/api/goals/ferien/entries/e2');
  assert.deepEqual(r.data.goals[0].entries.map(e => e.id), ['e1']);
  await admin('PUT', '/api/goals/velo', { name: 'Velo', target: 1200 });
  r = await admin('DELETE', '/api/goals/ferien');
  assert.deepEqual(r.data.goals.map(x => x.id), ['velo']);
  const rows = app.db.listGoals(1);
  assert.equal(rows.length, 1);
});

test('Belege: hochladen, nur selbst abrufen, Prüfung von Format und Grösse', async () => {
  const img = jpeg();
  let r = await admin('POST', '/api/receipts', undefined, { raw: img, headers: { 'Content-Type': 'image/jpeg' } });
  assert.equal(r.status, 201);
  const id = r.data.id;
  assert.match(id, /^[a-f0-9]{24}$/);
  r = await admin('GET', `/api/receipts/${id}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/jpeg');
  assert.ok(r.buf.equals(img));
  assert.equal((await anna('GET', `/api/receipts/${id}`)).status, 404, 'fremder Beleg');
  assert.equal((await admin('POST', '/api/receipts', undefined, { raw: Buffer.from('%PDF-1.4 hallo') })).status, 400);
  const huge = Buffer.concat([jpeg(), Buffer.alloc(7 * 1024 * 1024)]);
  const big = await admin('POST', '/api/receipts', undefined, { raw: huge }).catch(() => ({ status: 413 }));
  assert.equal(big.status, 413);
});

test('KI: ohne Schlüssel aus, Admin trägt ihn ein, Ergebnis wird geprüft übernommen', async () => {
  const up = await anna('POST', '/api/receipts', undefined, { raw: jpeg() });
  let r = await anna('GET', '/api/ai');
  assert.deepEqual(r.data, { enabled: false, limit: 3, used: 0, remaining: 3 });
  assert.equal((await anna('POST', `/api/receipts/${up.data.id}/analyze`)).status, 409);
  assert.equal((await anna('GET', '/api/admin/ai')).status, 403, 'nur Admin');
  assert.equal((await admin('PUT', '/api/admin/ai', { key: 'x' })).status, 400);
  r = await admin('PUT', '/api/admin/ai', { key: 'sk-or-v1-testschluessel1234', model: 'guenstig/vision' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.data.hasKey, r.data.keyHint, r.data.model], [true, '…1234', 'guenstig/vision']);
  assert.ok(!JSON.stringify(r.data).includes('testschluessel'), 'Schlüssel wird nie zurückgegeben');

  fakeState.content = 'Hier: ```json\n{"amount": "23,45", "currency": "chf", "date": "2026-09-27", "merchant": "Coop Pronto Basel Bahnhof", "category": "essen"}\n```';
  r = await anna('POST', `/api/receipts/${up.data.id}/analyze`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.result, { amount: 23.45, currency: 'CHF', date: '2026-09-27', merchant: 'Coop Pronto Basel Bahnhof', category: 'essen', model: 'guenstig/vision' });
  assert.equal(r.data.remaining, 2);
  assert.equal(fakeState.lastAuth, 'Bearer sk-or-v1-testschluessel1234');
  assert.equal(fakeState.lastBody.model, 'guenstig/vision');
  assert.match(fakeState.lastBody.messages[0].content[1].image_url.url, /^data:image\/jpeg;base64,/);
  // Nochmals derselbe Beleg: gespeichertes Ergebnis, zählt nicht
  const calls = fakeState.calls;
  r = await anna('POST', `/api/receipts/${up.data.id}/analyze`);
  assert.equal(r.data.remaining, 2);
  assert.equal(fakeState.calls, calls);
});

test('KI: 3 Analysen pro Tag für Benutzer, Admin unbegrenzt, Fehler zählen nicht', async () => {
  fakeState.content = '{"amount": 5, "currency": "CHF", "date": null, "merchant": "Bäckerei", "category": "gibtsnicht"}';
  const up = async c => (await c('POST', '/api/receipts', undefined, { raw: jpeg() })).data.id;
  fakeState.status = 401;
  let r = await anna('POST', `/api/receipts/${await up(anna)}/analyze`);
  assert.equal(r.status, 502);
  assert.match(r.data.error, /Schlüssel ist ungültig/);
  fakeState.status = 200;
  assert.equal((await anna('GET', '/api/ai')).data.remaining, 2, 'Fehler zählt nicht');
  r = await anna('POST', `/api/receipts/${await up(anna)}/analyze`);
  assert.equal(r.data.result.category, null, 'unbekannte Kategorie wird verworfen');
  r = await anna('POST', `/api/receipts/${await up(anna)}/analyze`);
  assert.equal(r.data.remaining, 0);
  r = await anna('POST', `/api/receipts/${await up(anna)}/analyze`);
  assert.equal(r.status, 429);
  assert.match(r.data.error, /keine KI-Analysen mehr/);
  for (let i = 0; i < 4; i++) assert.equal((await admin('POST', `/api/receipts/${await up(admin)}/analyze`)).status, 200);
  assert.equal((await admin('GET', '/api/ai')).data.remaining, null);
  r = await admin('PUT', '/api/admin/ai', { limit: 5 });
  assert.equal(r.data.limit, 5);
  assert.equal((await anna('GET', '/api/ai')).data.remaining, 2);
  r = await admin('GET', '/api/admin/ai/models');
  assert.deepEqual(r.data.models.map(m => m.id), ['guenstig/vision', 'teuer/vision'], 'nur Bildmodelle, günstigste zuerst');
});

test('Belege: verknüpfte bleiben, verwaiste werden aufgeräumt', async () => {
  const keep = (await admin('POST', '/api/receipts', undefined, { raw: jpeg() })).data.id;
  const drop = (await admin('POST', '/api/receipts', undefined, { raw: jpeg() })).data.id;
  const r = await admin('PUT', '/api/months/2026-09', { income: 5000, budget: null, expenses: [
    { id: 'm1', amt: 12, title: 'Mit Beleg', cat: 'essen', date: '2026-09-27', rep: false, ts: 1, rc: keep },
    { id: 'm2', amt: 3, title: 'Falsche ID', cat: 'essen', date: '2026-09-27', rep: false, ts: 2, rc: '../../etc/passwd' },
  ] });
  assert.equal(r.status, 200);
  const data = (await admin('GET', '/api/data')).data.months['2026-09'].expenses;
  assert.equal(data.find(e => e.id === 'm1').rc, keep);
  assert.equal(data.find(e => e.id === 'm2').rc, undefined);
  app.cleanReceipts(Date.now() + 1000);
  assert.equal((await admin('GET', `/api/receipts/${keep}`)).status, 200);
  assert.equal((await admin('GET', `/api/receipts/${drop}`)).status, 404);
  assert.ok(readdirSync(join(dir, 'receipts')).some(f => f.startsWith(keep)));
  assert.ok(!readdirSync(join(dir, 'receipts')).some(f => f.startsWith(drop)));
});

test('Export: CSV für Excel und JSON-Sicherung', async () => {
  let r = await admin('GET', '/api/export.csv');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="quota-ausgaben-\d{4}-\d\d-\d\d\.csv"/);
  const text = r.buf.toString('utf8');
  assert.equal(text.charCodeAt(0), 0xfeff, 'BOM für Excel');
  const lines = text.slice(1).trim().split('\r\n');
  assert.equal(lines[0], 'Datum;Titel;Kategorie;Betrag;Währung;Monatlich');
  assert.ok(lines.includes('2026-09-27;Mit Beleg;Essen;12.00;CHF;nein'), lines.join('\n'));
  r = await admin('GET', '/api/export.json');
  assert.equal(r.data.app, 'Quota');
  assert.equal(r.data.months['2026-09'].income, 5000);
  assert.deepEqual(r.data.goals.map(g => g.id), ['velo']);
  assert.equal((await client()('GET', '/api/export.csv')).status, 401);
});

/* ---------- Passkeys mit simuliertem Gerät ---------- */
const sha = b => createHash('sha256').update(b).digest();
const b64u = b => Buffer.from(b).toString('base64url');
function device(type) {
  const { publicKey, privateKey } = type === 'rsa' ? generateKeyPairSync('rsa', { modulusLength: 2048 })
    : type === 'ed' ? generateKeyPairSync('ed25519') : generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const alg = type === 'rsa' ? -257 : type === 'ed' ? -8 : -7;
  return { id: b64u(Buffer.from(`credential-${type}-${Math.random()}`)), publicKey, privateKey, alg, count: 0 };
}
function authData(rpId, flags, count) {
  const b = Buffer.alloc(37);
  sha(rpId).copy(b, 0); b[32] = flags; b.writeUInt32BE(count, 33);
  return b;
}
async function register(c, dev, { origin } = {}) {
  const o = (await c('POST', '/api/passkeys/options')).data;
  const cd = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: o.challenge, origin: origin || base }));
  return c('POST', '/api/passkeys', {
    id: dev.id, clientDataJSON: b64u(cd), authenticatorData: b64u(authData(o.rpId, 0x45, 0)),
    publicKey: b64u(dev.publicKey.export({ format: 'der', type: 'spki' })), alg: dev.alg, name: 'Testgerät',
  });
}
async function assertion(dev, { origin, rpId, flags = 0x05, count, challenge, tamper } = {}) {
  const o = (await client()('POST', '/api/auth/passkey/options')).data;
  const cd = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: challenge || o.challenge, origin: origin || base }));
  const ad = authData(rpId || o.rpId, flags, count ?? dev.count);
  const data = Buffer.concat([ad, sha(cd)]);
  let sig = sign(dev.alg === -8 ? null : 'sha256', data, dev.privateKey);
  if (tamper) sig = Buffer.from(sig.map((x, i) => (i === 10 ? x ^ 1 : x)));
  return { id: dev.id, clientDataJSON: b64u(cd), authenticatorData: b64u(ad), signature: b64u(sig), userHandle: null };
}

test('Passkeys: einrichten und damit anmelden (ES256, RS256, Ed25519)', async () => {
  for (const type of ['ec', 'rsa', 'ed']) {
    const dev = device(type);
    const r = await register(anna, dev);
    assert.equal(r.status, 201, `${type}: ${JSON.stringify(r.data)}`);
    const c = client();
    const res = await c('POST', '/api/auth/passkey', await assertion(dev));
    assert.equal(res.status, 200, `${type}: ${JSON.stringify(res.data)}`);
    assert.equal(res.data.user.username, 'anna');
    assert.equal((await c('GET', '/api/me')).data.user.username, 'anna');
  }
  const list = (await anna('GET', '/api/passkeys')).data.passkeys;
  assert.equal(list.length, 3);
  assert.equal(list[0].name, 'Testgerät');
  assert.ok(list[0].lastUsed > 0);
});

test('Passkeys: Angriffe und Fehler werden abgewiesen', async () => {
  const dev = device('ec');
  assert.equal((await register(anna, dev, { origin: 'https://evil.example' })).status, 400, 'fremde Herkunft bei Einrichtung');
  assert.equal((await register(anna, dev)).status, 201);
  assert.equal((await register(anna, dev)).status, 409, 'doppelt');
  const tries = [
    ['fremde Herkunft', { origin: 'https://evil.example' }],
    ['fremde Domain', { rpId: 'evil.example' }],
    ['ohne Face ID/PIN', { flags: 0x01 }],
    ['manipulierte Signatur', { tamper: true }],
    ['erfundene Challenge', { challenge: b64u(Buffer.alloc(32, 1)) }],
  ];
  for (const [name, opt] of tries) {
    const r = await client()('POST', '/api/auth/passkey', await assertion(dev, opt));
    assert.equal(r.status, 401, name);
  }
  // Challenge kann nur einmal verwendet werden
  const a = await assertion(dev, { count: 5 });
  assert.equal((await client()('POST', '/api/auth/passkey', a)).status, 200);
  assert.equal((await client()('POST', '/api/auth/passkey', a)).status, 401, 'Wiederholung');
  // Zähler darf nicht zurückgehen
  assert.equal((await client()('POST', '/api/auth/passkey', await assertion(dev, { count: 3 }))).status, 401, 'Zähler zurück');
  assert.equal((await client()('POST', '/api/auth/passkey', await assertion(dev, { count: 6 }))).status, 200);
  // Gelöschter Passkey funktioniert nicht mehr, fremde Passkeys kann man nicht löschen
  assert.equal((await admin('DELETE', `/api/passkeys/${dev.id}`)).data.passkeys.length, 0);
  assert.equal((await client()('POST', '/api/auth/passkey', await assertion(dev, { count: 7 }))).status, 200, 'Admin konnte Annas Passkey nicht löschen');
  await anna('DELETE', `/api/passkeys/${dev.id}`);
  assert.equal((await client()('POST', '/api/auth/passkey', await assertion(dev, { count: 8 }))).status, 401);
});

test('Offline-Seite und Service Worker sind öffentlich', async () => {
  let r = await fetch(base + '/sw.js');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('service-worker-allowed'), '/');
  assert.match(r.headers.get('content-type'), /javascript/);
  r = await fetch(base + '/offline');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Der Server scheint nicht erreichbar zu sein/);
  // Skripte der App (Bank-Import) und Vorschau gewählter Fotos (blob:) im CSP
  r = await fetch(base + '/js/bankcsv.js');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /BankCSV/);
  r = await fetch(base + '/login');
  assert.match(r.headers.get('content-security-policy'), /img-src 'self' data: blob:/);
});
