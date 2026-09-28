import http from 'node:http';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, extname } from 'node:path';
import { openDatabase, CATEGORIES, CURRENCIES } from './db.js';
import {
  hashPassword, verifyPassword, burnTime, newToken, hashToken, checkUsername, checkPassword, RateLimiter,
} from './auth.js';

const DAY = 864e5;
const SESSION_DAYS = 90;
const COOKIE = 'mb_session';
const MAX_BODY = 1024 * 1024;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_AMOUNT = 1e9;
const ME_PLACEHOLDER = '<script id="me" type="application/json">null</script>';
const STATIC_TYPES = {
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/* ---------- Eingaben prüfen ---------- */
function money(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_AMOUNT) return undefined;
  return Math.round(v * 100) / 100;
}
function parseMonthDoc(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const income = body.income == null ? null : money(body.income);
  const budget = body.budget == null ? null : money(body.budget);
  if (income === undefined || budget === undefined) return null;
  const list = body.expenses == null ? [] : body.expenses;
  if (!Array.isArray(list) || list.length > 5000) return null;
  const byId = new Map();
  for (const e of list) {
    if (!e || typeof e !== 'object') return null;
    const amt = money(e.amt);
    if (amt === undefined) return null;
    if (typeof e.id !== 'string' || !ID_RE.test(e.id)) return null;
    if (typeof e.date !== 'string' || !DATE_RE.test(e.date)) return null;
    byId.set(e.id, {
      id: e.id, amt, date: e.date,
      title: typeof e.title === 'string' ? e.title.slice(0, 40) : '',
      cat: CATEGORIES.includes(e.cat) ? e.cat : 'sonst',
      rep: !!e.rep,
      ts: Number.isFinite(e.ts) ? Math.max(0, Math.trunc(e.ts)) : 0,
    });
  }
  return { income, budget, expenses: [...byId.values()] };
}
function parseSettings(body) {
  if (!body || !CURRENCIES.includes(body.currency)) return null;
  if (!Number.isInteger(body.startDay) || body.startDay < 1 || body.startDay > 28) return null;
  return { currency: body.currency, startDay: body.startDay };
}

/* ---------- HTTP-Helfer ---------- */
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Zu viele Daten auf einmal.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!size) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Ungültiges JSON.')); }
    });
    req.on('error', reject);
  });
}
function sendJson(res, status, obj, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}
function sendHtml(req, res, html, status = 200) {
  const headers = {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': CSP, Vary: 'Accept-Encoding',
  };
  let body = Buffer.from(html);
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) { body = gzipSync(body); headers['Content-Encoding'] = 'gzip'; }
  headers['Content-Length'] = body.length;
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}
function redirect(res, to) { res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' }); res.end(); }
const publicUser = u => ({ id: u.id, username: u.username, admin: !!u.is_admin });

export function createApp({
  dataDir, publicDir, backupDir = join(dataDir, 'backups'), backupKeep = 14,
  cookieSecure = 'auto', trustProxy = false, log = console,
}) {
  const db = openDatabase(dataDir);
  const indexTpl = readFileSync(join(publicDir, 'index.html'), 'utf8');
  const loginHtml = readFileSync(join(publicDir, 'login.html'), 'utf8');
  if (!indexTpl.includes(ME_PLACEHOLDER)) throw new Error('index.html: Platzhalter für den Benutzer fehlt');

  // Öffentliche Dateien (Icons, Manifest): ohne Anmeldung abrufbar, weil iOS und Android sie
  // beim Hinzufügen zum Home-Bildschirm holen. iOS fragt zusätzlich feste Pfade im Wurzelverzeichnis ab.
  const statics = new Map();
  const addStatic = (url, file) => {
    const type = STATIC_TYPES[extname(file)];
    if (type && existsSync(file)) statics.set(url, { type, body: readFileSync(file) });
  };
  const iconDir = join(publicDir, 'icons');
  if (existsSync(iconDir)) for (const f of readdirSync(iconDir)) addStatic(`/icons/${f}`, join(iconDir, f));
  addStatic('/manifest.webmanifest', join(publicDir, 'manifest.webmanifest'));
  addStatic('/apple-touch-icon.png', join(iconDir, 'apple-touch-icon.png'));
  addStatic('/apple-touch-icon-precomposed.png', join(iconDir, 'apple-touch-icon.png'));
  addStatic('/favicon.ico', join(iconDir, 'favicon.ico'));

  const loginLimiter = new RateLimiter({ max: 10, windowMs: 15 * 60 * 1000 });
  const ipLimiter = new RateLimiter({ max: 50, windowMs: 15 * 60 * 1000 });
  const streams = new Map(); // userId -> Set<{ res, cid, sid }>

  const clientIp = req => (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim())
    || req.socket.remoteAddress || '';
  const isSecure = req => cookieSecure === 'true'
    || (cookieSecure === 'auto' && (req.socket.encrypted || (trustProxy && req.headers['x-forwarded-proto'] === 'https')));

  function sessionCookie(req, token, maxAgeSec) {
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${isSecure(req) ? '; Secure' : ''}`;
  }

  // Liefert den angemeldeten Benutzer oder null. Verlängert laufende Sitzungen automatisch.
  function authenticate(req, res) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token || token.length > 100) return null;
    const sid = hashToken(token);
    const row = db.sessionUser(sid);
    if (!row) return null;
    const now = Date.now();
    if (row.expires_at < now) { db.deleteSession(sid); return null; }
    if (row.expires_at - now < (SESSION_DAYS / 2) * DAY) {
      db.extendSession(sid, now + SESSION_DAYS * DAY);
      res.setHeader('Set-Cookie', sessionCookie(req, token, SESSION_DAYS * 86400));
    }
    return { id: row.id, username: row.username, is_admin: row.is_admin, sid };
  }

  function createUser(username, pwHash, isAdmin) {
    try { return db.createUser(username, pwHash, isAdmin); }
    catch (e) {
      if (/UNIQUE constraint failed/.test(e.message)) throw new HttpError(409, 'Dieser Benutzername ist schon vergeben.');
      throw e;
    }
  }

  function startSession(req, res, userId) {
    const token = newToken();
    db.createSession(hashToken(token), userId, Date.now() + SESSION_DAYS * DAY);
    res.setHeader('Set-Cookie', sessionCookie(req, token, SESSION_DAYS * 86400));
  }

  /* ---------- Live-Sync (Server-Sent Events) ---------- */
  function broadcast(userId, origin, msg) {
    const set = streams.get(userId);
    if (!set) return;
    const line = `data: ${JSON.stringify({ ...msg, origin })}\n\n`;
    for (const s of set) s.res.write(line);
  }
  function closeStreams(userId, filter = () => true) {
    for (const s of streams.get(userId) || []) if (filter(s)) s.res.end();
  }
  function openStream(req, res, user, url) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    res.write('retry: 5000\n\n');
    const entry = { res, cid: String(url.searchParams.get('cid') || '').slice(0, 64), sid: user.sid };
    if (!streams.has(user.id)) streams.set(user.id, new Set());
    streams.get(user.id).add(entry);
    req.on('close', () => {
      const set = streams.get(user.id);
      if (set) { set.delete(entry); if (!set.size) streams.delete(user.id); }
    });
  }

  /* ---------- API ---------- */
  async function api(req, res, url, user) {
    const { pathname: p } = url;
    const m = req.method;
    const cid = String(req.headers['x-client-id'] || '').slice(0, 64);

    if (m !== 'GET' && m !== 'HEAD') {
      // Schutz gegen Cross-Site-Requests: eigener Header (erzwingt Preflight) und gleiche Herkunft
      if (req.headers['x-requested-with'] !== 'monatsbudget') throw new HttpError(403, 'Anfrage abgelehnt.');
      const origin = req.headers.origin;
      if (origin) {
        let host = null;
        try { host = new URL(origin).host; } catch { /* z.B. "null" */ }
        if (host !== req.headers.host) throw new HttpError(403, 'Anfrage abgelehnt.');
      }
    }

    /* Öffentlich */
    if (p === '/api/auth/status' && m === 'GET') {
      return sendJson(res, 200, {
        setup: db.countUsers() === 0,
        registration: db.getConfig('registration', 'closed') === 'open',
        user: user ? publicUser(user) : null,
      });
    }
    if ((p === '/api/auth/setup' || p === '/api/auth/register') && m === 'POST') {
      const body = await readJson(req);
      const setup = p === '/api/auth/setup';
      if (setup && db.countUsers() > 0) throw new HttpError(409, 'Die Einrichtung ist bereits abgeschlossen.');
      if (!setup && db.getConfig('registration', 'closed') !== 'open') throw new HttpError(403, 'Registrierung ist deaktiviert.');
      const username = String(body.username || '').trim();
      const err = checkUsername(username) || checkPassword(body.password);
      if (err) throw new HttpError(400, err);
      if (db.userByName(username)) throw new HttpError(409, 'Dieser Benutzername ist schon vergeben.');
      const pwHash = await hashPassword(body.password);
      if (setup && db.countUsers() > 0) throw new HttpError(409, 'Die Einrichtung ist bereits abgeschlossen.');
      const id = createUser(username, pwHash, setup);
      startSession(req, res, id);
      log.info(`Konto erstellt: ${username}${setup ? ' (Admin)' : ''}`);
      return sendJson(res, 201, { user: publicUser(db.userById(id)) });
    }
    if (p === '/api/auth/login' && m === 'POST') {
      const body = await readJson(req);
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      const ip = clientIp(req), key = `${ip}|${username.toLowerCase()}`;
      const wait = loginLimiter.blocked(key) || ipLimiter.blocked(ip);
      if (wait) throw new HttpError(429, `Zu viele Versuche. Bitte in ${Math.ceil(wait / 60)} Min. erneut versuchen.`);
      const u = username ? db.userByName(username) : null;
      const ok = u ? await verifyPassword(password, u.pw_hash) : (await burnTime(password), false);
      if (!ok) {
        loginLimiter.fail(key); ipLimiter.fail(ip);
        throw new HttpError(401, 'Benutzername oder Passwort falsch.');
      }
      loginLimiter.clear(key);
      startSession(req, res, u.id);
      return sendJson(res, 200, { user: publicUser(u) });
    }

    /* Ab hier nur angemeldet */
    if (!user) throw new HttpError(401, 'Nicht angemeldet.');

    if (p === '/api/auth/logout' && m === 'POST') {
      db.deleteSession(user.sid);
      closeStreams(user.id, s => s.sid === user.sid);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
    }
    if (p === '/api/me' && m === 'GET') return sendJson(res, 200, { user: publicUser(user) });
    if (p === '/api/me/password' && m === 'POST') {
      const body = await readJson(req);
      const u = db.userById(user.id);
      if (!(await verifyPassword(String(body.current || ''), u.pw_hash))) throw new HttpError(400, 'Das aktuelle Passwort stimmt nicht.');
      const err = checkPassword(body.next);
      if (err) throw new HttpError(400, err);
      db.setPassword(user.id, await hashPassword(body.next));
      db.deleteOtherSessions(user.id, user.sid);
      closeStreams(user.id, s => s.sid !== user.sid);
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/events' && m === 'GET') return openStream(req, res, user, url);
    if (p === '/api/data' && m === 'GET') return sendJson(res, 200, db.getData(user.id));
    if (p === '/api/settings' && m === 'PUT') {
      const s = parseSettings(await readJson(req));
      if (!s) throw new HttpError(400, 'Ungültige Einstellungen.');
      db.putSettings(user.id, s);
      broadcast(user.id, cid, { kind: 'settings', data: s });
      return sendJson(res, 200, { ok: true });
    }
    const mm = p.match(/^\/api\/months\/([^/]+)$/);
    if (mm) {
      const key = mm[1];
      if (!MONTH_RE.test(key)) throw new HttpError(400, 'Ungültiger Monat.');
      if (m === 'PUT') {
        const doc = parseMonthDoc(await readJson(req));
        if (!doc) throw new HttpError(400, 'Ungültige Daten.');
        const moved = db.putMonth(user.id, key, doc);
        broadcast(user.id, cid, { kind: 'month', key, data: db.getMonth(user.id, key) });
        for (const k of moved) broadcast(user.id, cid, { kind: 'month', key: k, data: db.getMonth(user.id, k) });
        return sendJson(res, 200, { ok: true });
      }
      if (m === 'DELETE') {
        db.deleteMonth(user.id, key);
        broadcast(user.id, cid, { kind: 'month', key, data: null });
        return sendJson(res, 200, { ok: true });
      }
    }

    /* Verwaltung (nur Admin) */
    if (p.startsWith('/api/admin/')) {
      if (!user.is_admin) throw new HttpError(403, 'Nur für Administratoren.');
      if (p === '/api/admin/users' && m === 'GET') {
        return sendJson(res, 200, {
          users: db.listUsers().map(u => ({ ...publicUser(u), createdAt: u.created_at, expenses: u.expenses, self: u.id === user.id })),
        });
      }
      if (p === '/api/admin/users' && m === 'POST') {
        const body = await readJson(req);
        const username = String(body.username || '').trim();
        const err = checkUsername(username) || checkPassword(body.password);
        if (err) throw new HttpError(400, err);
        if (db.userByName(username)) throw new HttpError(409, 'Dieser Benutzername ist schon vergeben.');
        const id = createUser(username, await hashPassword(body.password), false);
        log.info(`Benutzer angelegt: ${username}`);
        return sendJson(res, 201, { user: publicUser(db.userById(id)) });
      }
      const um = p.match(/^\/api\/admin\/users\/(\d+)(\/password)?$/);
      if (um) {
        const id = Number(um[1]);
        const target = db.userById(id);
        if (!target) throw new HttpError(404, 'Benutzer nicht gefunden.');
        if (um[2] && m === 'PUT') {
          const body = await readJson(req);
          const err = checkPassword(body.password);
          if (err) throw new HttpError(400, err);
          db.setPassword(id, await hashPassword(body.password));
          if (id !== user.id) { db.deleteUserSessions(id); closeStreams(id); }
          return sendJson(res, 200, { ok: true });
        }
        if (!um[2] && m === 'DELETE') {
          if (id === user.id) throw new HttpError(400, 'Du kannst dich nicht selbst löschen.');
          closeStreams(id);
          db.deleteUser(id);
          log.info(`Benutzer gelöscht: ${target.username}`);
          return sendJson(res, 200, { ok: true });
        }
      }
      if (p === '/api/admin/config') {
        if (m === 'GET') return sendJson(res, 200, { registration: db.getConfig('registration', 'closed') === 'open' });
        if (m === 'PUT') {
          const body = await readJson(req);
          if (typeof body.registration !== 'boolean') throw new HttpError(400, 'Ungültige Einstellung.');
          db.setConfig('registration', body.registration ? 'open' : 'closed');
          return sendJson(res, 200, { registration: body.registration });
        }
      }
    }
    throw new HttpError(404, 'Nicht gefunden.');
  }

  async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      if (p === '/healthz') {
        db.ping();
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        return res.end('ok\n');
      }
      const file = statics.get(p);
      if (file && (req.method === 'GET' || req.method === 'HEAD')) {
        res.writeHead(200, { 'Content-Type': file.type, 'Content-Length': file.body.length, 'Cache-Control': 'public, max-age=86400' });
        return res.end(req.method === 'HEAD' ? undefined : file.body);
      }
      const user = authenticate(req, res);
      if (p.startsWith('/api/')) {
        await api(req, res, url, user);
        if (req.method !== 'GET' && res.statusCode < 400) changed = true;
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Methode nicht erlaubt.');
      if (p === '/' || p === '/index.html') {
        if (!user) return redirect(res, '/login');
        const me = JSON.stringify(publicUser(user)).replace(/</g, '\\u003c');
        return sendHtml(req, res, indexTpl.replace(ME_PLACEHOLDER, `<script id="me" type="application/json">${me}</script>`));
      }
      if (p === '/login') {
        if (user) return redirect(res, '/');
        return sendHtml(req, res, loginHtml);
      }
      if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
      throw new HttpError(404, 'Nicht gefunden.');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log.error(e);
      if (res.headersSent) return res.end();
      if (p.startsWith('/api/')) return sendJson(res, status, { error: status === 500 ? 'Serverfehler.' : e.message });
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(status === 404 ? 'Nicht gefunden\n' : 'Fehler\n');
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  server.keepAliveTimeout = 65_000;

  /* ---------- Hintergrundaufgaben ---------- */
  // Stündlich prüfen: gab es Änderungen, wird das Backup des Tages aktualisiert
  let changed = true;
  function runBackup() {
    try {
      const f = db.backup(backupDir, backupKeep, { replace: changed });
      changed = false;
      if (f) log.info(`Backup gespeichert: ${f}`);
    } catch (e) { log.error('Backup fehlgeschlagen:', e); }
  }
  const timers = [
    setInterval(() => { for (const set of streams.values()) for (const s of set) s.res.write(': ping\n\n'); }, 25_000),
    setInterval(() => { db.purgeSessions(); loginLimiter.prune(); ipLimiter.prune(); }, 60 * 60 * 1000),
  ];
  if (backupKeep > 0) { timers.push(setInterval(runBackup, 60 * 60 * 1000)); runBackup(); }
  timers.forEach(t => t.unref());

  function close() {
    timers.forEach(clearInterval);
    for (const set of streams.values()) for (const s of set) s.res.end();
    return new Promise(resolve => {
      server.close(() => { db.close(); resolve(); });
      server.closeAllConnections();
    });
  }

  return { server, db, close, runBackup };
}
