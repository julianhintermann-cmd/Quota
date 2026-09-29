import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const quiet = { info() {}, error() {} };
let app, base, dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'monatsbudget-test-'));
  app = createApp({ dataDir: dir, publicDir: join(root, 'public'), backupKeep: 3, log: quiet });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

// Kleiner Client mit Cookie-Speicher, wie ein Browser
function client() {
  let cookie = '';
  const call = async function (method, path, body, { headers = {}, csrf = true } = {}) {
    const h = { ...headers };
    if (cookie) h.Cookie = cookie;
    if (csrf && method !== 'GET') h['X-Requested-With'] = 'monatsbudget';
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) { const v = set.split(';')[0]; cookie = v.endsWith('=') ? '' : v; }
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
  call.cookie = () => cookie;
  return call;
}

const admin = client();
const month = (expenses, extra = {}) => ({ income: 5400, budget: 3200, expenses, ...extra });
const exp = (id, date, amt = 10, extra = {}) => ({ id, amt, title: 'Test', cat: 'einkauf', date, rep: false, ts: 1, ...extra });

test('Einrichtung: erstes Konto wird Admin, danach gesperrt', async () => {
  let r = await admin('GET', '/api/auth/status');
  assert.deepEqual(r.data, { setup: true, registration: false, user: null });
  r = await admin('POST', '/api/auth/setup', { username: 'ju', password: 'geheim123' });
  assert.equal(r.status, 400, 'zu kurzer Name');
  r = await admin('POST', '/api/auth/setup', { username: 'julian', password: 'kurz' });
  assert.equal(r.status, 400, 'zu kurzes Passwort');
  r = await admin('POST', '/api/auth/setup', { username: 'julian', password: 'geheim123' });
  assert.equal(r.status, 201);
  assert.deepEqual(r.data.user, { id: 1, username: 'julian', admin: true });
  assert.match(r.headers.get('set-cookie'), /mb_session=.+; Path=\/; HttpOnly; SameSite=Lax/);
  r = await client()('POST', '/api/auth/setup', { username: 'mallory', password: 'geheim123' });
  assert.equal(r.status, 409);
});

test('Seiten: ohne Anmeldung zum Login, mit Anmeldung die App mit Benutzer', async () => {
  let r = await client()('GET', '/');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/login');
  r = await client()('GET', '/login');
  assert.equal(r.status, 200);
  assert.match(r.data, /<title>Quota<\/title>/);
  r = await admin('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.data, /<script id="me" type="application\/json">\{"id":1,"username":"julian","admin":true\}<\/script>/);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  r = await admin('GET', '/login');
  assert.equal(r.status, 302, 'angemeldet → zur App');
});

test('Login: falsches Passwort, richtiges Passwort, Abmelden', async () => {
  const c = client();
  let r = await c('POST', '/api/auth/login', { username: 'julian', password: 'falsch123' });
  assert.equal(r.status, 401);
  r = await c('POST', '/api/auth/login', { username: 'niemand', password: 'falsch123' });
  assert.equal(r.status, 401);
  r = await c('POST', '/api/auth/login', { username: 'JULIAN', password: 'geheim123' });
  assert.equal(r.status, 200, 'Benutzername ohne Gross/Klein');
  r = await c('GET', '/api/me');
  assert.equal(r.data.user.username, 'julian');
  r = await c('POST', '/api/auth/logout');
  assert.equal(r.status, 200);
  r = await c('GET', '/api/me');
  assert.equal(r.status, 401);
});

test('Daten: Monat speichern, laden, Beträge exakt, löschen', async () => {
  let r = await admin('GET', '/api/data');
  assert.deepEqual(r.data, { settings: null, months: {}, goals: [], trips: [] });
  const doc = month([exp('a1', '2026-09-28', 42.5, { title: 'Migros', rep: true, ts: 1790585035135 }), exp('a2', '2026-09-30', 0.1)]);
  r = await admin('PUT', '/api/months/2026-09', doc);
  assert.equal(r.status, 200);
  r = await admin('GET', '/api/data');
  const m = r.data.months['2026-09'];
  assert.equal(m.income, 5400);
  assert.equal(m.budget, 3200);
  assert.deepEqual(m.expenses.map(e => e.id).sort(), ['a1', 'a2']);
  assert.equal(m.expenses.find(e => e.id === 'a1').rep, true);
  assert.equal(m.expenses.find(e => e.id === 'a1').amt, 42.5);
  assert.equal(m.expenses.find(e => e.id === 'a1').ts, 1790585035135);
  assert.equal(m.expenses.find(e => e.id === 'a2').amt, 0.1);
  // Titel wird auf 40 Zeichen gekürzt, Kategorie mit ungültigen Zeichen wird "sonst", eigene IDs bleiben
  r = await admin('PUT', '/api/months/2026-10', month([exp('b1', '2026-10-02', 5, { title: 'x'.repeat(60), cat: 'Böse <Kategorie>' }),
    exp('b2', '2026-10-03', 6, { cat: 'u_velo' })]));
  assert.equal(r.status, 200);
  r = await admin('GET', '/api/data');
  const b1 = r.data.months['2026-10'].expenses.find(e => e.id === 'b1');
  assert.equal(b1.title.length, 40);
  assert.equal(b1.cat, 'sonst');
  assert.equal(r.data.months['2026-10'].expenses.find(e => e.id === 'b2').cat, 'u_velo');
  r = await admin('DELETE', '/api/months/2026-10');
  assert.equal(r.status, 200);
  r = await admin('GET', '/api/data');
  assert.equal(r.data.months['2026-10'], undefined);
});

test('Daten: Ausgabe in anderen Monat verschieben', async () => {
  await admin('PUT', '/api/months/2026-11', month([exp('m1', '2026-11-05'), exp('m2', '2026-11-06')]));
  // m1 bekommt ein Datum im Dezember: neuer Monat enthält m1, alter Monat verliert m1
  let r = await admin('PUT', '/api/months/2026-12', { income: null, budget: null, expenses: [exp('m1', '2026-12-01')] });
  assert.equal(r.status, 200);
  r = await admin('GET', '/api/data');
  assert.deepEqual(r.data.months['2026-11'].expenses.map(e => e.id), ['m2']);
  assert.deepEqual(r.data.months['2026-12'].expenses.map(e => e.id), ['m1']);
});

test('Daten: ungültige Eingaben werden abgelehnt', async () => {
  const bad = [
    ['/api/months/2026-13', month([])],
    ['/api/months/abc', month([])],
    ['/api/months/2026-09', { income: -5, budget: null, expenses: [] }],
    ['/api/months/2026-09', { income: 'viel', budget: null, expenses: [] }],
    ['/api/months/2026-09', month([exp('x', '28.09.2026')])],
    ['/api/months/2026-09', month([exp('x y', '2026-09-28')])],
    ['/api/months/2026-09', month([exp('x', '2026-09-28', Infinity)])],
    ['/api/months/2026-09', [1, 2, 3]],
    ['/api/settings', { currency: 'BTC', startDay: 25 }],
    ['/api/settings', { currency: 'CHF', startDay: 31 }],
  ];
  for (const [path, body] of bad) {
    const r = await admin('PUT', path, body);
    assert.equal(r.status, 400, `${path} ${JSON.stringify(body)}`);
  }
  const r = await fetch(base + '/api/months/2026-09', {
    method: 'PUT', body: '{kaputt', headers: { 'X-Requested-With': 'monatsbudget', 'Content-Type': 'application/json', Cookie: admin.cookie() },
  });
  assert.equal(r.status, 400, 'kaputtes JSON');
  const r2 = await fetch(base + '/api/months/2026-09', {
    method: 'PUT', body: JSON.stringify({ expenses: [], pad: 'x'.repeat(1100 * 1024) }), headers: { 'X-Requested-With': 'monatsbudget', 'Content-Type': 'application/json', Cookie: admin.cookie() },
  }).catch(e => ({ status: 'abgebrochen' }));
  assert.ok(r2.status === 413 || r2.status === 'abgebrochen', 'zu grosse Anfrage');
});

test('Einstellungen speichern und laden', async () => {
  let r = await admin('PUT', '/api/settings', { currency: 'EUR', startDay: 1 });
  assert.equal(r.status, 200);
  r = await admin('GET', '/api/data');
  assert.deepEqual(r.data.settings, { currency: 'EUR', startDay: 1 });
});

test('CSRF: Änderungen ohne eigenen Header oder von fremder Herkunft werden abgelehnt', async () => {
  let r = await admin('PUT', '/api/settings', { currency: 'CHF', startDay: 25 }, { csrf: false });
  assert.equal(r.status, 403);
  r = await admin('PUT', '/api/settings', { currency: 'CHF', startDay: 25 }, { headers: { Origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
  r = await admin('PUT', '/api/settings', { currency: 'CHF', startDay: 25 }, { headers: { Origin: 'null' } });
  assert.equal(r.status, 403);
  r = await admin('PUT', '/api/settings', { currency: 'CHF', startDay: 25 }, { headers: { Origin: base } });
  assert.equal(r.status, 200);
});

test('Registrierung: standardmässig zu, Admin kann sie öffnen; Daten sind getrennt', async () => {
  const anna = client();
  let r = await anna('POST', '/api/auth/register', { username: 'anna', password: 'annas-passwort' });
  assert.equal(r.status, 403);
  r = await admin('PUT', '/api/admin/config', { registration: true });
  assert.equal(r.status, 200);
  r = await client()('GET', '/api/auth/status');
  assert.equal(r.data.registration, true);
  r = await anna('POST', '/api/auth/register', { username: 'anna', password: 'annas-passwort' });
  assert.equal(r.status, 201);
  assert.equal(r.data.user.admin, false);
  r = await client()('POST', '/api/auth/register', { username: 'ANNA', password: 'annas-passwort' });
  assert.equal(r.status, 409, 'Name schon vergeben');
  r = await anna('GET', '/api/data');
  assert.deepEqual(r.data, { settings: null, months: {}, goals: [], trips: [] }, 'Anna sieht Julians Daten nicht');
  r = await anna('PUT', '/api/months/2026-09', month([exp('a1', '2026-09-01', 99)]));
  assert.equal(r.status, 200, 'gleiche Ausgaben-ID bei anderem Benutzer ist erlaubt');
  r = await admin('GET', '/api/data');
  assert.equal(r.data.months['2026-09'].expenses.find(e => e.id === 'a1').amt, 42.5);
  await admin('PUT', '/api/admin/config', { registration: false });
});

test('Verwaltung: nur für Admins; anlegen, Passwort setzen, löschen', async () => {
  const anna = client();
  await anna('POST', '/api/auth/login', { username: 'anna', password: 'annas-passwort' });
  let r = await anna('GET', '/api/admin/users');
  assert.equal(r.status, 403);
  r = await admin('POST', '/api/admin/users', { username: 'ben', password: 'bens-passwort' });
  assert.equal(r.status, 201);
  r = await admin('GET', '/api/admin/users');
  assert.deepEqual(r.data.users.map(u => [u.username, u.admin, u.self]), [['anna', false, false], ['ben', false, false], ['julian', true, true]]);
  const annaId = r.data.users.find(u => u.username === 'anna').id;
  r = await admin('PUT', `/api/admin/users/${annaId}/password`, { password: 'neues-passwort' });
  assert.equal(r.status, 200);
  r = await anna('GET', '/api/me');
  assert.equal(r.status, 401, 'alte Sitzung ist nach dem Zurücksetzen ungültig');
  r = await anna('POST', '/api/auth/login', { username: 'anna', password: 'neues-passwort' });
  assert.equal(r.status, 200);
  r = await admin('DELETE', '/api/admin/users/1');
  assert.equal(r.status, 400, 'sich selbst löschen geht nicht');
  r = await admin('DELETE', `/api/admin/users/${annaId}`);
  assert.equal(r.status, 200);
  r = await anna('GET', '/api/data');
  assert.equal(r.status, 401, 'gelöschter Benutzer ist abgemeldet');
  r = await admin('GET', '/api/admin/users');
  assert.deepEqual(r.data.users.map(u => u.username), ['ben', 'julian']);
});

test('Passwort ändern: altes Passwort nötig, andere Sitzungen werden beendet', async () => {
  const other = client();
  await other('POST', '/api/auth/login', { username: 'julian', password: 'geheim123' });
  let r = await admin('POST', '/api/me/password', { current: 'falsch', next: 'neu-geheim-456' });
  assert.equal(r.status, 400);
  r = await admin('POST', '/api/me/password', { current: 'geheim123', next: 'neu-geheim-456' });
  assert.equal(r.status, 200);
  r = await admin('GET', '/api/me');
  assert.equal(r.status, 200, 'eigene Sitzung bleibt');
  r = await other('GET', '/api/me');
  assert.equal(r.status, 401, 'andere Sitzung ist beendet');
  r = await client()('POST', '/api/auth/login', { username: 'julian', password: 'neu-geheim-456' });
  assert.equal(r.status, 200);
});

test('Live-Sync: andere Geräte bekommen Änderungen, das eigene nicht', async () => {
  const cookie = admin.cookie();
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/events?cid=geraet-b`, { headers: { Cookie: cookie }, signal: ctrl.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = res.body.getReader();
  const events = [];
  const reading = (async () => {
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) return;
      buf += new TextDecoder().decode(value);
      for (const line of buf.split('\n\n').slice(0, -1)) if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)));
      buf = buf.slice(buf.lastIndexOf('\n\n') + 2);
    }
  })();
  await new Promise(r => setTimeout(r, 100));
  await admin('PUT', '/api/months/2027-01', month([exp('s1', '2027-01-03', 7)]), { headers: { 'X-Client-Id': 'geraet-a' } });
  await admin('PUT', '/api/settings', { currency: 'USD', startDay: 20 }, { headers: { 'X-Client-Id': 'geraet-a' } });
  await new Promise(r => setTimeout(r, 200));
  ctrl.abort();
  await reading;
  assert.equal(events.length, 2);
  assert.deepEqual([events[0].kind, events[0].key, events[0].origin], ['month', '2027-01', 'geraet-a']);
  assert.equal(events[0].data.expenses[0].amt, 7);
  assert.deepEqual(events[1].data, { currency: 'USD', startDay: 20 });
});

test('Schutz vor Passwort-Raten: nach 10 Fehlversuchen gesperrt', async () => {
  const c = client();
  for (let i = 0; i < 10; i++) {
    const r = await c('POST', '/api/auth/login', { username: 'ben', password: 'falsch-' + i });
    assert.equal(r.status, 401);
  }
  let r = await c('POST', '/api/auth/login', { username: 'ben', password: 'bens-passwort' });
  assert.equal(r.status, 429, 'auch das richtige Passwort wird vorerst abgelehnt');
  r = await c('POST', '/api/auth/login', { username: 'julian', password: 'neu-geheim-456' });
  assert.equal(r.status, 200, 'andere Konten sind nicht betroffen');
});

test('Backup: Datei pro Tag, alte werden aufgeräumt', () => {
  const bdir = join(dir, 'backups');
  assert.ok(existsSync(bdir));
  for (const d of ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']) app.db.backup(bdir, 3, { now: new Date(d + 'T12:00:00Z') });
  const files = readdirSync(bdir).sort();
  assert.equal(files.length, 3);
  const now = new Date(), pad = n => String(n).padStart(2, '0');
  assert.equal(files[files.length - 1], `monatsbudget-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.db`);
});

test('Healthcheck', async () => {
  const r = await fetch(base + '/healthz');
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'ok\n');
});

test('Home-Bildschirm: Icons und Manifest sind ohne Anmeldung abrufbar', async () => {
  const pngSize = buf => [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  for (const [path, size] of [['/apple-touch-icon.png', 180], ['/icons/apple-touch-icon.png', 180], ['/icons/icon-192.png', 192],
    ['/icons/icon-512.png', 512], ['/icons/icon-maskable-512.png', 512]]) {
    const r = await fetch(base + path);
    assert.equal(r.status, 200, path);
    assert.equal(r.headers.get('content-type'), 'image/png', path);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.equal(buf.toString('latin1', 1, 4), 'PNG', path);
    assert.deepEqual(pngSize(buf), [size, size], path);
  }
  let r = await fetch(base + '/favicon.ico');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/x-icon');
  r = await fetch(base + '/manifest.webmanifest');
  assert.equal(r.status, 200);
  const m = await r.json();
  assert.equal(m.name, 'Quota');
  assert.equal(m.display, 'standalone');
  for (const icon of m.icons) assert.equal((await fetch(base + icon.src)).status, 200, icon.src);
  r = await fetch(base + '/icons/../server/app.js');
  assert.equal(r.status, 404, 'keine Dateien ausserhalb der Liste');
  const html = (await admin('GET', '/')).data;
  assert.match(html, /<link rel="apple-touch-icon" href="\/apple-touch-icon.png">[\s\S]*<\/head><body>/, 'Icon-Links stehen im <head>');
});
