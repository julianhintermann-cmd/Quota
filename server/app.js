import http from 'node:http';
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { join, extname } from 'node:path';
import { openDatabase, CATEGORIES, CURRENCIES } from './db.js';
import {
  hashPassword, verifyPassword, burnTime, newToken, hashToken, checkUsername, checkPassword, RateLimiter,
} from './auth.js';
import { analyzeReceipt, listVisionModels, AiError, DEFAULT_MODEL } from './ai.js';
import { verifyRegistration, verifyAssertion, ChallengeStore, challengeOf, WebAuthnError } from './webauthn.js';
import { createFx, FxError, FX_SOURCES } from './fx.js';
import { loadVapid, sendPush, okEndpoint } from './push.js';
import { createNotifier, parsePrefs, DEFAULT_PREFS } from './notify.js';
import { periodKeyOf, periodStats, addMonths, money as fmtMoney, monthName, dayLabel } from './period.js';
import { systemPrompt, listFreeModels, openChat, parseMessages } from './assistant.js';

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
  '.js': 'text/javascript; charset=utf-8',
};

// Standardkategorien (Namen für Export und KI) und die erlaubten Symbole für eigene Kategorien/Sparziele
const DEFAULT_CATS = [
  { id: 'essen', n: 'Essen & Trinken', ic: 'essen' }, { id: 'einkauf', n: 'Einkauf', ic: 'einkauf' },
  { id: 'wohnen', n: 'Wohnen', ic: 'wohnen' }, { id: 'mobil', n: 'Mobilität', ic: 'mobil' },
  { id: 'freizeit', n: 'Freizeit', ic: 'freizeit' }, { id: 'gesund', n: 'Gesundheit', ic: 'gesund' },
  { id: 'abos', n: 'Abos', ic: 'abos' }, { id: 'sonst', n: 'Sonstiges', ic: 'sonst' },
];
export const APP_VERSION = '4.0';
export const ICONS = [
  ...CATEGORIES, 'geschenk', 'reisen', 'auto', 'kind', 'tier', 'sport', 'bildung', 'technik', 'kleidung', 'haushalt',
  'versicherung', 'steuern', 'spende', 'sparen', 'handy', 'musik', 'pflanze', 'bar', 'werkzeug', 'arbeit', 'ziel',
];
const CAT_ID_RE = /^[a-z0-9_]{1,24}$/;
const RECEIPT_RE = /^[a-f0-9]{24}$/;
const GOAL_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const CUR_RE = /^[A-Z]{3}$/;
const IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const MAX_IMAGE = 6 * 1024 * 1024;

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
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
      cat: typeof e.cat === 'string' && CAT_ID_RE.test(e.cat) ? e.cat : 'sonst',
      rep: !!e.rep,
      ts: Number.isFinite(e.ts) ? Math.max(0, Math.trunc(e.ts)) : 0,
      rc: typeof e.rc === 'string' && RECEIPT_RE.test(e.rc) ? e.rc : null,
      fx: parseFx(e.fx),
      every: e.rep && (e.every === 3 || e.every === 12) ? e.every : undefined,
      trip: typeof e.trip === 'string' && GOAL_ID_RE.test(e.trip) ? e.trip : null,
    });
  }
  return { income, budget, expenses: [...byId.values()] };
}
// Bezahlt in Fremdwährung: Originalbetrag und Kurs (amt ist bereits umgerechnet)
function parseFx(fx) {
  if (!fx || typeof fx !== 'object' || typeof fx.cur !== 'string' || !CUR_RE.test(fx.cur)) return null;
  const amt = money(fx.amt);
  const rate = fx.rate;
  if (amt === undefined || typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0 || rate > 1e7) return null;
  return { cur: fx.cur, amt, rate: Number(rate.toPrecision(8)) };
}
function parseCategories(list) {
  if (list === null) return null;
  if (!Array.isArray(list) || !list.length || list.length > 40) return undefined;
  const seen = new Set(), out = [];
  for (const c of list) {
    if (!c || typeof c.id !== 'string' || !CAT_ID_RE.test(c.id) || seen.has(c.id)) return undefined;
    const n = typeof c.n === 'string' ? c.n.trim().slice(0, 24) : '';
    if (!n || !ICONS.includes(c.ic)) return undefined;
    seen.add(c.id); out.push({ id: c.id, n, ic: c.ic });
  }
  return seen.has('sonst') ? out : undefined;
}
// Favoriten fürs Erfassen: Text, Betrag, Kategorie, optional Währung
function parseFavorites(list) {
  if (list === null) return null;
  if (!Array.isArray(list) || list.length > 12) return undefined;
  const out = [];
  for (const f of list) {
    if (!f || typeof f !== 'object') return undefined;
    const t = typeof f.t === 'string' ? f.t.trim().slice(0, 40) : '';
    const a = money(f.a);
    if (!t || !a || typeof f.id !== 'string' || !ID_RE.test(f.id)) return undefined;
    const o = { id: f.id, t, a, c: typeof f.c === 'string' && CAT_ID_RE.test(f.c) ? f.c : 'sonst' };
    if (typeof f.cur === 'string' && CUR_RE.test(f.cur)) o.cur = f.cur;
    out.push(o);
  }
  return out.length ? out : null;
}
function parseSettings(body) {
  if (!body || !CURRENCIES.includes(body.currency)) return null;
  if (!Number.isInteger(body.startDay) || body.startDay < 1 || body.startDay > 28) return null;
  const s = { currency: body.currency, startDay: body.startDay };
  if ('categories' in body) {
    const cats = parseCategories(body.categories);
    if (cats === undefined) return null;
    s.categories = cats;
  }
  if ('favorites' in body) {
    const favs = parseFavorites(body.favorites);
    if (favs === undefined) return null;
    s.favorites = favs;
  }
  return s;
}
// Reise: Name, Zeitraum (höchstens ein Jahr), optional Budget in der Reisewährung
function parseTrip(body, id) {
  if (!body || !GOAL_ID_RE.test(id)) return null;
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 40) : '';
  if (!name || typeof body.start !== 'string' || !DATE_RE.test(body.start) || typeof body.end !== 'string' || !DATE_RE.test(body.end)) return null;
  if (body.end < body.start || (new Date(body.end) - new Date(body.start)) / DAY > 366) return null;
  const budget = body.budget == null ? null : money(body.budget);
  if (budget === undefined || budget === 0) return null;
  if (typeof body.cur !== 'string' || !CUR_RE.test(body.cur)) return null;
  const rate = typeof body.rate === 'number' && Number.isFinite(body.rate) && body.rate > 0 && body.rate < 1e7 ? Number(body.rate.toPrecision(8)) : null;
  return { id, name, start: body.start, end: body.end, budget, cur: body.cur, rate, icon: ICONS.includes(body.icon) ? body.icon : 'reisen' };
}
// Kurzer Gerätename aus dem User-Agent, z.B. „iPhone · Safari“
export function deviceLabel(ua) {
  const s = String(ua || '');
  const os = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? (/Mobile/.test(s) ? 'Android-Handy' : 'Android-Tablet')
    : /Macintosh|Mac OS X/.test(s) ? 'Mac' : /Windows/.test(s) ? 'Windows' : /CrOS/.test(s) ? 'Chromebook' : /Linux/.test(s) ? 'Linux' : '';
  const br = /Edg\//.test(s) ? 'Edge' : /OPR\/|Opera/.test(s) ? 'Opera' : /Firefox\/|FxiOS/.test(s) ? 'Firefox' : /CriOS|Chrome\//.test(s) ? 'Chrome'
    : /Safari\//.test(s) ? 'Safari' : /node|curl|undici/i.test(s) ? 'Programm' : '';
  return [os, br].filter(Boolean).join(' · ') || 'Unbekanntes Gerät';
}
function parseGoal(body, id) {
  if (!body || !GOAL_ID_RE.test(id)) return null;
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 40) : '';
  const target = money(body.target);
  if (!name || !target) return null;
  if (body.deadline != null && (typeof body.deadline !== 'string' || !DATE_RE.test(body.deadline))) return null;
  const icon = ICONS.includes(body.icon) ? body.icon : 'ziel';
  return { id, name, target, deadline: body.deadline || null, icon };
}
function parseGoalEntry(body) {
  if (!body || typeof body.id !== 'string' || !GOAL_ID_RE.test(body.id)) return null;
  const amt = typeof body.amt === 'number' && Number.isFinite(body.amt) && body.amt !== 0 && Math.abs(body.amt) <= MAX_AMOUNT
    ? Math.round(body.amt * 100) / 100 : null;
  if (!amt || typeof body.date !== 'string' || !DATE_RE.test(body.date)) return null;
  return { id: body.id, amt, date: body.date, note: typeof body.note === 'string' ? body.note.trim().slice(0, 60) : '' };
}
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function imageType(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
const csvCell = v => { const s = String(v ?? ''); return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

/* ---------- HTTP-Helfer ---------- */
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Die Datei ist zu gross.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
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
  appUrl = null, aiKey = null, aiModel = null, openrouterUrl = 'https://openrouter.ai/api/v1', fxSources = FX_SOURCES,
  pushContact = null, pushEndpointOk = okEndpoint, pushFetch = fetch,
}) {
  const db = openDatabase(dataDir);
  const receiptDir = join(dataDir, 'receipts');
  mkdirSync(receiptDir, { recursive: true });
  const offlineHtml = existsSync(join(publicDir, 'offline.html')) ? readFileSync(join(publicDir, 'offline.html'), 'utf8') : null;
  const indexTpl = readFileSync(join(publicDir, 'index.html'), 'utf8');
  const loginHtml = readFileSync(join(publicDir, 'login.html'), 'utf8');
  if (!indexTpl.includes(ME_PLACEHOLDER)) throw new Error('index.html: Platzhalter für den Benutzer fehlt');

  // Öffentliche Dateien (Icons, Manifest): ohne Anmeldung abrufbar, weil iOS und Android sie
  // beim Hinzufügen zum Home-Bildschirm holen. iOS fragt zusätzlich feste Pfade im Wurzelverzeichnis ab.
  const statics = new Map();
  const addStatic = (url, file, cache = 'public, max-age=86400') => {
    const type = STATIC_TYPES[extname(file)];
    if (type && existsSync(file)) statics.set(url, { type, body: readFileSync(file), cache });
  };
  const iconDir = join(publicDir, 'icons');
  if (existsSync(iconDir)) for (const f of readdirSync(iconDir)) addStatic(`/icons/${f}`, join(iconDir, f));
  const jsDir = join(publicDir, 'js');
  if (existsSync(jsDir)) for (const f of readdirSync(jsDir)) addStatic(`/js/${f}`, join(jsDir, f), 'no-cache');
  addStatic('/sw.js', join(publicDir, 'sw.js'), 'no-cache');
  addStatic('/manifest.webmanifest', join(publicDir, 'manifest.webmanifest'));
  addStatic('/apple-touch-icon.png', join(iconDir, 'apple-touch-icon.png'));
  addStatic('/apple-touch-icon-precomposed.png', join(iconDir, 'apple-touch-icon.png'));
  addStatic('/favicon.ico', join(iconDir, 'favicon.ico'));

  const loginLimiter = new RateLimiter({ max: 10, windowMs: 15 * 60 * 1000 });
  const ipLimiter = new RateLimiter({ max: 50, windowMs: 15 * 60 * 1000 });
  const uploadLimiter = new RateLimiter({ max: 60, windowMs: 60 * 60 * 1000 });
  const challenges = new ChallengeStore();
  const aiBusy = new Set();
  const fx = createFx({ sources: fxSources, today: () => localDay(), log });
  const chatBusy = new Set();

  /* Push-Mitteilungen */
  const vapid = loadVapid(db);
  const pushSubject = pushContact || (appUrl && appUrl.startsWith('https://') ? appUrl : 'https://github.com/julianhintermann-cmd/Quota');
  // Schickt an alle Geräte der Person; gibt die Anzahl zugestellter zurück (Gründe fürs Scheitern in .why)
  async function sendToUser(userId, message) {
    let ok = 0;
    sendToUser.why = null;
    for (const sub of db.pushSubs(userId)) {
      try {
        const status = await sendPush(sub, message, { vapid, subject: pushSubject, fetchImpl: pushFetch, topic: message.topic || null });
        if (status === 404 || status === 410) { db.deletePushSub(sub.endpoint); sendToUser.why = 'gone'; log.info(`Push-Abo abgelaufen (${sub.device || 'Gerät'}), entfernt`); }
        else if (status >= 200 && status < 300) ok++;
        else { sendToUser.why = 'rejected'; log.error(`Push an ${new URL(sub.endpoint).host}: HTTP ${status}`); }
      } catch (e) { sendToUser.why = 'network'; log.error(`Push fehlgeschlagen: ${e.message}`); }
    }
    return ok;
  }
  const notifier = createNotifier({ db, sendToUser, log });

  /* Quota-Assistent: Gratis-Modelle von OpenRouter, Liste 6 Stunden zwischengespeichert */
  const chat = {
    model: () => db.getConfig('chat_model', ''),
    limit: () => Number(db.getConfig('chat_daily_limit', '30')),
    cache: { at: 0, list: null },
    async models() {
      if (!this.cache.list || Date.now() - this.cache.at > 6 * 3600e3) {
        try { this.cache = { at: Date.now(), list: (await listFreeModels({ baseUrl: openrouterUrl })).map(m => m.id) }; }
        catch (e) { if (!this.cache.list) throw e; }
      }
      const pick = this.model();
      return pick ? [pick, ...this.cache.list.filter(id => id !== pick)] : this.cache.list;
    },
  };
  function chatStatus(user) {
    const used = db.chatUsage(user.id, localDay());
    const limit = user.is_admin ? null : chat.limit();
    return { enabled: !!ai.key(), limit, used, remaining: limit == null ? null : Math.max(0, limit - used) };
  }
  // Kurzfassung der eigenen Zahlen für den Assistenten (nur wenn die Person das einschaltet)
  function financeSummary(userId) {
    const data = db.getData(userId), st0 = data.settings || {};
    const sd = st0.startDay || 25, cur = st0.currency || 'CHF', m = v => fmtMoney(v, cur);
    const names = Object.fromEntries(userCategories(userId).map(c => [c.id, c.n]));
    const catLine = byCat => Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, v]) => `${names[c] || 'Sonstiges'} ${m(v)}`).join(', ') || 'keine';
    const day = localDay(), key = periodKeyOf(day, sd), now = periodStats(data, key, sd), prev = periodStats(data, addMonths(key, -1), sd);
    const lines = [
      `Heute: ${day}. Laufende Periode ${monthName(key)} (${now.start} bis ${now.end}).`,
      `Einkommen: ${now.income != null ? m(now.income) : 'nicht eingetragen'}. Budget: ${now.budget != null ? m(now.budget) : 'nicht eingetragen'}.`,
      `Ausgegeben (inkl. geplanter Fixkosten): ${m(now.spent)} in ${now.count} Ausgaben, davon Fixkosten ${m(now.fixed)}.`
        + (now.limit != null ? ` Verbleibend: ${m(now.limit - now.spent)}.` : ''),
      `Nach Kategorie: ${catLine(now.byCat)}.`,
      `Vorperiode ${monthName(prev.key)}: ausgegeben ${m(prev.spent)}${prev.limit != null ? ` bei Grenze ${m(prev.limit)}` : ''}; nach Kategorie: ${catLine(prev.byCat)}.`,
    ];
    const fixed = new Map();
    for (const mo of Object.values(data.months)) for (const e of mo.expenses) if (e.rep) {
      const k = `${(e.title || '').toLowerCase()}|${e.cat}|${e.every || 1}`;
      if (!fixed.has(k) || fixed.get(k).date < e.date) fixed.set(k, e);
    }
    const every = { 1: 'monatlich', 3: 'vierteljährlich', 12: 'jährlich' };
    if (fixed.size) lines.push(`Fixkosten: ${[...fixed.values()].slice(0, 15).map(e => `${e.title || names[e.cat]} ${m(e.amt)} ${every[e.every || 1]}`).join(', ')}.`);
    if (data.goals.length) lines.push(`Sparziele: ${data.goals.map(g => `${g.name} ${m(g.entries.reduce((a, x) => a + x.amt, 0))} von ${m(g.target)}${g.deadline ? ` bis ${g.deadline}` : ''}`).join('; ')}.`);
    if (data.trips.length) lines.push(`Reisen: ${data.trips.slice(0, 5).map(t => `${t.name} ${t.start} bis ${t.end}${t.budget ? `, Budget ${fmtMoney(t.budget, t.cur)}` : ''}`).join('; ')}.`);
    const recent = Object.values(data.months).flatMap(mo => mo.expenses).filter(e => e.date <= day).sort((a, b) => b.date.localeCompare(a.date) || b.ts - a.ts).slice(0, 12);
    if (recent.length) lines.push(`Letzte Ausgaben: ${recent.map(e => `${e.date} ${e.title || names[e.cat]} ${m(e.amt)}${e.fx ? ` (${fmtMoney(e.fx.amt, e.fx.cur)})` : ''}`).join('; ')}.`);
    return lines.join('\n');
  }

  /* KI-Einstellungen: Umgebungsvariable hat Vorrang vor dem in der App hinterlegten Schlüssel */
  const ai = {
    key: () => aiKey || db.getConfig('openrouter_key'),
    model: () => aiModel || db.getConfig('openrouter_model') || DEFAULT_MODEL,
    limit: () => Number(db.getConfig('ai_daily_limit', '3')),
  };
  function aiStatus(user) {
    const used = db.aiUsage(user.id, localDay());
    const limit = user.is_admin ? null : ai.limit();
    return { enabled: !!ai.key(), limit, used, remaining: limit == null ? null : Math.max(0, limit - used) };
  }
  const userCategories = userId => {
    const s = db.getSettings(userId);
    return s && Array.isArray(s.categories) ? s.categories : DEFAULT_CATS;
  };
  const receiptFile = (id, mime) => join(receiptDir, id + (IMAGE_TYPES[mime] || '.bin'));

  /* Passkeys: erwartete Herkunft und Domain (rpId) */
  function passkeyContext(req) {
    const host = String(req.headers.host || '');
    const origins = new Set([`https://${host}`, `http://${host}`]);
    let rpId = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (appUrl) { const u = new URL(appUrl); origins.add(u.origin); rpId = u.hostname; }
    return { origins, rpId };
  }
  const withOrigin = (ctx, clientDataJSON) => {
    try {
      const o = JSON.parse(Buffer.from(String(clientDataJSON || ''), 'base64url').toString('utf8')).origin;
      return ctx.origins.has(o) ? o : '-';
    } catch { return '-'; }
  };
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
    if (!row.last_seen || now - row.last_seen > 5 * 60e3) db.seenSession(sid, deviceLabel(req.headers['user-agent']));
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
    db.createSession(hashToken(token), userId, Date.now() + SESSION_DAYS * DAY, deviceLabel(req.headers['user-agent']));
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

    if (p === '/api/auth/passkey/options' && m === 'POST') {
      const { rpId } = passkeyContext(req);
      return sendJson(res, 200, { challenge: challenges.issue({ type: 'auth' }), rpId });
    }
    if (p === '/api/auth/passkey' && m === 'POST') {
      const ip = clientIp(req);
      const wait = ipLimiter.blocked(ip);
      if (wait) throw new HttpError(429, `Zu viele Versuche. Bitte in ${Math.ceil(wait / 60)} Min. erneut versuchen.`);
      const body = await readJson(req);
      const fail = msg => { ipLimiter.fail(ip); throw new HttpError(401, msg); };
      const ch = challengeOf(body.clientDataJSON);
      const issued = ch && challenges.take(ch);
      if (!issued || issued.type !== 'auth') fail('Anmeldung abgelaufen. Bitte nochmals versuchen.');
      const stored = typeof body.id === 'string' ? db.getPasskey(body.id) : null;
      if (!stored) fail('Dieser Passkey ist hier nicht (mehr) eingerichtet.');
      const ctx = passkeyContext(req);
      try {
        const r = verifyAssertion(body, stored, { challenge: ch, origin: withOrigin(ctx, body.clientDataJSON), rpId: ctx.rpId });
        db.usePasskey(stored.id, r.signCount);
      } catch (e) {
        if (e instanceof WebAuthnError) fail(e.message);
        throw e;
      }
      startSession(req, res, stored.user_id);
      return sendJson(res, 200, { user: publicUser({ id: stored.user_id, username: stored.username, is_admin: stored.is_admin }) });
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

    /* Angemeldete Geräte */
    if (p === '/api/sessions' && m === 'GET') {
      return sendJson(res, 200, { sessions: db.listSessions(user.id).map(s => ({
        id: s.id, device: s.device, createdAt: s.createdAt, lastSeen: s.lastSeen, current: s.hash === user.sid,
      })) });
    }
    if (p === '/api/sessions' && m === 'DELETE') {
      db.deleteOtherSessions(user.id, user.sid);
      closeStreams(user.id, s => s.sid !== user.sid);
      return sendJson(res, 200, { ok: true });
    }
    const sm = p.match(/^\/api\/sessions\/([a-f0-9]{16})$/);
    if (sm && m === 'DELETE') {
      if (user.sid.startsWith(sm[1])) throw new HttpError(400, 'Dieses Gerät meldest du über „Abmelden“ ab.');
      const gone = db.deleteSessionById(user.id, sm[1]);
      closeStreams(user.id, s => gone.includes(s.sid));
      return sendJson(res, 200, { ok: true, removed: gone.length });
    }

    if (p === '/api/events' && m === 'GET') return openStream(req, res, user, url);
    if (p === '/api/data' && m === 'GET') return sendJson(res, 200, db.getData(user.id));
    if (p === '/api/settings' && m === 'PUT') {
      const s = parseSettings(await readJson(req));
      if (!s) throw new HttpError(400, 'Ungültige Einstellungen.');
      db.putSettings(user.id, s);
      broadcast(user.id, cid, { kind: 'settings', data: db.getSettings(user.id) });
      return sendJson(res, 200, { ok: true });
    }

    /* Sparziele */
    const gm = p.match(/^\/api\/goals\/([^/]+)(?:\/entries(?:\/([^/]+))?)?$/);
    if (gm) {
      const [, gid, eid] = gm;
      const isEntries = p.includes('/entries');
      if (!isEntries && m === 'PUT') {
        const g = parseGoal(await readJson(req), gid);
        if (!g) throw new HttpError(400, 'Ungültiges Sparziel.');
        if (!db.hasGoal(user.id, gid) && db.listGoals(user.id).length >= 50) throw new HttpError(400, 'Höchstens 50 Sparziele.');
        db.putGoal(user.id, g);
      } else if (!isEntries && m === 'DELETE') {
        db.deleteGoal(user.id, gid);
      } else if (isEntries && !eid && m === 'POST') {
        if (!db.hasGoal(user.id, gid)) throw new HttpError(404, 'Sparziel nicht gefunden.');
        const e = parseGoalEntry(await readJson(req));
        if (!e) throw new HttpError(400, 'Ungültiger Betrag.');
        try { db.addGoalEntry(user.id, gid, e); }
        catch (x) { if (/UNIQUE/.test(x.message)) throw new HttpError(409, 'Schon gespeichert.'); throw x; }
      } else if (isEntries && eid && m === 'DELETE') {
        db.deleteGoalEntry(user.id, gid, eid);
      } else throw new HttpError(404, 'Nicht gefunden.');
      const goals = db.listGoals(user.id);
      broadcast(user.id, cid, { kind: 'goals', data: goals });
      return sendJson(res, 200, { goals });
    }

    /* Reisen */
    const tm = p.match(/^\/api\/trips\/([^/]+)$/);
    if (tm) {
      const tid = tm[1];
      if (m === 'PUT') {
        const t = parseTrip(await readJson(req), tid);
        if (!t) throw new HttpError(400, 'Ungültige Reise.');
        if (!db.hasTrip(user.id, tid) && db.listTrips(user.id).length >= 100) throw new HttpError(400, 'Höchstens 100 Reisen.');
        db.putTrip(user.id, t);
      } else if (m === 'DELETE') {
        for (const k of db.deleteTrip(user.id, tid)) broadcast(user.id, null, { kind: 'month', key: k, data: db.getMonth(user.id, k) });
      } else throw new HttpError(405, 'Methode nicht erlaubt.');
      const trips = db.listTrips(user.id);
      broadcast(user.id, cid, { kind: 'trips', data: trips });
      return sendJson(res, 200, { trips });
    }

    /* Push-Mitteilungen */
    if (p === '/api/push' && m === 'GET') {
      return sendJson(res, 200, { key: vapid.publicKey, prefs: notifier.prefsOf(user.id), devices: db.pushSubs(user.id).length });
    }
    if (p === '/api/push/subscribe' && m === 'POST') {
      const body = await readJson(req);
      const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
      const keys = body.keys || {};
      if (endpoint.length > 1000 || !pushEndpointOk(endpoint)) throw new HttpError(400, 'Dieser Push-Dienst wird nicht unterstützt.');
      const ok = k => typeof k === 'string' && /^[A-Za-z0-9_-]+={0,2}$/.test(k);
      if (!ok(keys.p256dh) || !ok(keys.auth) || Buffer.from(keys.p256dh, 'base64url').length !== 65 || Buffer.from(keys.auth, 'base64url').length !== 16) {
        throw new HttpError(400, 'Ungültiges Push-Abo.');
      }
      if (db.pushSubs(user.id).length >= 20) throw new HttpError(400, 'Höchstens 20 Geräte mit Mitteilungen.');
      db.addPushSub(user.id, { endpoint, p256dh: keys.p256dh, auth: keys.auth, device: deviceLabel(req.headers['user-agent']) });
      if (!db.getPushPrefs(user.id)) db.putPushPrefs(user.id, DEFAULT_PREFS);
      return sendJson(res, 201, { prefs: notifier.prefsOf(user.id), devices: db.pushSubs(user.id).length });
    }
    if (p === '/api/push/unsubscribe' && m === 'POST') {
      const body = await readJson(req);
      if (typeof body.endpoint === 'string') db.deleteUserPushSub(user.id, body.endpoint);
      return sendJson(res, 200, { devices: db.pushSubs(user.id).length });
    }
    if (p === '/api/push/prefs' && m === 'PUT') {
      const prefs = parsePrefs(await readJson(req));
      if (!prefs) throw new HttpError(400, 'Ungültige Einstellung.');
      db.putPushPrefs(user.id, { ...notifier.prefsOf(user.id), ...prefs });
      return sendJson(res, 200, { prefs: notifier.prefsOf(user.id) });
    }
    if (p === '/api/push/test' && m === 'POST') {
      if (uploadLimiter.blocked('push:' + user.id)) throw new HttpError(429, 'Bitte kurz warten.');
      uploadLimiter.fail('push:' + user.id);
      const sent = await sendToUser(user.id, { title: 'Quota', body: 'So sehen Mitteilungen von Quota aus. 👋', url: '/', tag: 'test' });
      if (!sent) {
        const why = sendToUser.why;
        throw new HttpError(502, why === 'network' ? 'Der Server erreicht den Push-Dienst nicht. Hat der Container Internetzugang?'
          : why === 'rejected' ? 'Der Push-Dienst hat die Mitteilung abgelehnt. Details stehen im Log des Containers.'
            : 'Das Abo ist abgelaufen. Schalte Mitteilungen auf diesem Gerät aus und wieder ein.');
      }
      return sendJson(res, 200, { sent });
    }

    /* Quota-Assistent */
    if (p === '/api/assistant' && m === 'GET') return sendJson(res, 200, chatStatus(user));
    if (p === '/api/assistant' && m === 'POST') {
      const body = await readJson(req);
      const messages = parseMessages(body.messages);
      if (!messages) throw new HttpError(400, 'Ungültige Nachricht.');
      const key = ai.key();
      if (!key) throw new HttpError(409, 'Der Assistent ist noch nicht eingerichtet. Ein Admin trägt dafür unter Einstellungen → KI einen OpenRouter-Schlüssel ein.');
      const st = chatStatus(user);
      if (st.remaining === 0) throw new HttpError(429, `Heute sind keine Nachrichten mehr übrig (${st.limit} pro Tag).`);
      if (chatBusy.has(user.id)) throw new HttpError(429, 'Der Assistent antwortet gerade noch.');
      chatBusy.add(user.id);
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      try {
        const settings = db.getSettings(user.id) || {};
        const system = systemPrompt({
          version: APP_VERSION, username: user.username, isAdmin: !!user.is_admin,
          currency: settings.currency || 'CHF', startDay: settings.startDay || 25, summary: body.withData === true ? financeSummary(user.id) : null,
        });
        let open;
        try { open = await openChat({ apiKey: key, models: await chat.models(), system, messages, baseUrl: openrouterUrl, signal: abort.signal }); }
        catch (e) { if (e instanceof AiError) throw new HttpError(e.status === 499 ? 400 : e.status, e.message); throw e; }
        db.chatCount(user.id, localDay());
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
        res.write(JSON.stringify({ model: open.model }) + '\n');
        try {
          for await (const d of open.stream) res.write(JSON.stringify({ d }) + '\n');
          res.end(JSON.stringify({ done: true, ...chatStatus(user) }) + '\n');
        } catch (e) {
          res.end(JSON.stringify({ error: e instanceof AiError ? e.message : 'Die Antwort wurde unterbrochen.' }) + '\n');
        }
        return;
      } finally { chatBusy.delete(user.id); }
    }

    /* Wechselkurse (für Ausgaben in Fremdwährung) */
    if (p === '/api/fx' && m === 'GET') {
      const qp = url.searchParams;
      try {
        const r = await fx.rate(String(qp.get('from') || '').toUpperCase(), String(qp.get('to') || '').toUpperCase(), qp.get('date') || null);
        return sendJson(res, 200, r, { 'Cache-Control': 'private, max-age=600' });
      } catch (e) {
        if (e instanceof FxError) throw new HttpError(e.status, e.message);
        throw e;
      }
    }

    /* Belegfotos und KI-Erkennung */
    if (p === '/api/ai' && m === 'GET') return sendJson(res, 200, aiStatus(user));
    if (p === '/api/receipts' && m === 'POST') {
      if (uploadLimiter.blocked(String(user.id))) throw new HttpError(429, 'Zu viele Fotos in kurzer Zeit.');
      const buf = await readRaw(req, MAX_IMAGE);
      const mime = imageType(buf);
      if (!mime) throw new HttpError(400, 'Das ist kein unterstütztes Bild (JPEG, PNG oder WebP).');
      uploadLimiter.fail(String(user.id));
      const id = randomBytes(12).toString('hex');
      writeFileSync(receiptFile(id, mime), buf);
      db.addReceipt(user.id, id, mime, buf.length);
      return sendJson(res, 201, { id });
    }
    const rm = p.match(/^\/api\/receipts\/([a-f0-9]{24})(\/analyze)?$/);
    if (rm) {
      const r = db.getReceipt(user.id, rm[1]);
      if (!r) throw new HttpError(404, 'Beleg nicht gefunden.');
      if (!rm[2] && m === 'GET') {
        const body = readFileSync(receiptFile(r.id, r.mime));
        res.writeHead(200, { 'Content-Type': r.mime, 'Content-Length': body.length, 'Cache-Control': 'private, max-age=604800' });
        return res.end(body);
      }
      if (rm[2] && m === 'POST') {
        // Optional schärferes Foto nur fürs Auslesen; abgelegt bleibt die kleine Fassung
        const sharp = await readRaw(req, MAX_IMAGE);
        const sharpMime = sharp.length ? imageType(sharp) : null;
        if (sharp.length && !sharpMime) throw new HttpError(400, 'Das ist kein unterstütztes Bild (JPEG, PNG oder WebP).');
        if (r.analysis) return sendJson(res, 200, { result: r.analysis, ...aiStatus(user) });
        const key = ai.key();
        if (!key) throw new HttpError(409, 'Die KI-Belegerkennung ist nicht eingerichtet.');
        const st = aiStatus(user);
        if (st.remaining === 0) throw new HttpError(429, `Heute sind keine KI-Analysen mehr übrig (${st.limit} pro Tag).`);
        if (aiBusy.has(user.id)) throw new HttpError(429, 'Es läuft bereits eine Analyse.');
        aiBusy.add(user.id);
        try {
          const result = await analyzeReceipt({
            apiKey: key, model: ai.model(),
            image: sharpMime ? sharp : readFileSync(receiptFile(r.id, r.mime)), mime: sharpMime || r.mime,
            categories: userCategories(user.id), baseUrl: openrouterUrl,
          });
          db.aiCount(user.id, localDay());
          db.setReceiptAnalysis(user.id, r.id, result);
          return sendJson(res, 200, { result, ...aiStatus(user) });
        } catch (e) {
          if (e instanceof AiError) throw new HttpError(e.status, e.message);
          throw e;
        } finally { aiBusy.delete(user.id); }
      }
    }

    /* Export */
    if ((p === '/api/export.csv' || p === '/api/export.json') && m === 'GET') {
      const data = db.getData(user.id);
      const day = localDay();
      if (p.endsWith('.json')) {
        const body = JSON.stringify({ app: 'Quota', version: 2, exportedAt: new Date().toISOString(), user: user.username, ...data }, null, 2);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
          'Content-Disposition': `attachment; filename="quota-sicherung-${day}.json"` });
        return res.end(body);
      }
      const names = Object.fromEntries(userCategories(user.id).map(c => [c.id, c.n]));
      const currency = (data.settings && data.settings.currency) || 'CHF';
      const rows = Object.values(data.months).flatMap(mo => mo.expenses)
        .sort((a, b) => a.date.localeCompare(b.date) || a.ts - b.ts)
        .map(e => [e.date, e.title, names[e.cat] || names.sonst || 'Sonstiges', e.amt.toFixed(2), currency, e.rep ? 'ja' : 'nein',
          e.fx ? e.fx.amt.toFixed(2) : '', e.fx ? e.fx.cur : '', e.fx ? String(e.fx.rate) : ''].map(csvCell).join(';'));
      const csv = '\ufeff' + ['Datum;Titel;Kategorie;Betrag;Währung;Monatlich;Originalbetrag;Originalwährung;Kurs', ...rows].join('\r\n') + '\r\n';
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="quota-ausgaben-${day}.csv"` });
      return res.end(csv);
    }

    /* Passkeys verwalten */
    if (p === '/api/passkeys' && m === 'GET') return sendJson(res, 200, { passkeys: db.listPasskeys(user.id) });
    if (p === '/api/passkeys/options' && m === 'POST') {
      const { rpId } = passkeyContext(req);
      return sendJson(res, 200, {
        challenge: challenges.issue({ type: 'reg', userId: user.id }), rpId,
        userId: Buffer.from(`mb-user-${user.id}`).toString('base64url'), username: user.username,
        exclude: db.listPasskeys(user.id).map(k => k.id),
      });
    }
    if (p === '/api/passkeys' && m === 'POST') {
      const body = await readJson(req);
      const ch = challengeOf(body.clientDataJSON);
      const issued = ch && challenges.take(ch);
      if (!issued || issued.type !== 'reg' || issued.userId !== user.id) throw new HttpError(400, 'Einrichtung abgelaufen. Bitte nochmals versuchen.');
      const ctx = passkeyContext(req);
      let k;
      try { k = verifyRegistration(body, { challenge: ch, origin: withOrigin(ctx, body.clientDataJSON), rpId: ctx.rpId }); }
      catch (e) { if (e instanceof WebAuthnError) throw new HttpError(400, e.message); throw e; }
      const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 40) : 'Passkey';
      try { db.addPasskey(user.id, { ...k, name }); }
      catch (e) { if (/UNIQUE|PRIMARY/.test(e.message)) throw new HttpError(409, 'Dieser Passkey ist schon eingerichtet.'); throw e; }
      log.info(`Passkey eingerichtet: ${user.username} (${name})`);
      return sendJson(res, 201, { passkeys: db.listPasskeys(user.id) });
    }
    const pm = p.match(/^\/api\/passkeys\/([A-Za-z0-9_-]{16,1024})$/);
    if (pm && m === 'DELETE') {
      db.deletePasskey(user.id, pm[1]);
      return sendJson(res, 200, { passkeys: db.listPasskeys(user.id) });
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
        notifier.budgetCheck(user.id).catch(e => log.error('Budgetwarnung:', e.message || e));
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
      if (p === '/api/admin/ai') {
        if (m === 'PUT') {
          const body = await readJson(req);
          if ('key' in body) {
            if (body.key === null || body.key === '') db.delConfig('openrouter_key');
            else if (typeof body.key === 'string' && /^[A-Za-z0-9_\-:.]{10,300}$/.test(body.key.trim())) db.setConfig('openrouter_key', body.key.trim());
            else throw new HttpError(400, 'Das sieht nicht nach einem OpenRouter-Schlüssel aus.');
          }
          if ('model' in body) {
            if (!body.model) db.delConfig('openrouter_model');
            else if (typeof body.model === 'string' && /^[A-Za-z0-9._\-\/:]{3,120}$/.test(body.model.trim())) db.setConfig('openrouter_model', body.model.trim());
            else throw new HttpError(400, 'Ungültiger Modellname.');
          }
          if ('limit' in body) {
            if (!Number.isInteger(body.limit) || body.limit < 0 || body.limit > 50) throw new HttpError(400, 'Das Tageslimit muss zwischen 0 und 50 liegen.');
            db.setConfig('ai_daily_limit', body.limit);
          }
          if ('chatModel' in body) {
            if (!body.chatModel) db.delConfig('chat_model');
            else if (typeof body.chatModel === 'string' && /^[A-Za-z0-9._\-\/:]{3,120}:free$/.test(body.chatModel.trim())) db.setConfig('chat_model', body.chatModel.trim());
            else throw new HttpError(400, 'Für den Assistenten gehen nur Gratis-Modelle (Name endet auf „:free“).');
          }
          if ('chatLimit' in body) {
            if (!Number.isInteger(body.chatLimit) || body.chatLimit < 0 || body.chatLimit > 500) throw new HttpError(400, 'Das Tageslimit muss zwischen 0 und 500 liegen.');
            db.setConfig('chat_daily_limit', body.chatLimit);
          }
        } else if (m !== 'GET') throw new HttpError(405, 'Methode nicht erlaubt.');
        const key = ai.key();
        return sendJson(res, 200, {
          hasKey: !!key, keyHint: key ? `…${key.slice(-4)}` : null, fromEnv: !!aiKey,
          model: ai.model(), modelFromEnv: !!aiModel, defaultModel: DEFAULT_MODEL, limit: ai.limit(),
          chatModel: chat.model() || null, chatLimit: chat.limit(),
        });
      }
      if (p === '/api/admin/ai/free-models' && m === 'GET') {
        try { return sendJson(res, 200, { models: await listFreeModels({ baseUrl: openrouterUrl }) }); }
        catch (e) { if (e instanceof AiError) throw new HttpError(e.status, e.message); throw e; }
      }
      if (p === '/api/admin/ai/models' && m === 'GET') {
        try { return sendJson(res, 200, { models: await listVisionModels({ baseUrl: openrouterUrl }) }); }
        catch (e) { if (e instanceof AiError) throw new HttpError(e.status, e.message); throw e; }
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
        const headers = { 'Content-Type': file.type, 'Content-Length': file.body.length, 'Cache-Control': file.cache };
        if (p === '/sw.js') headers['Service-Worker-Allowed'] = '/';
        res.writeHead(200, headers);
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
      if (p === '/offline' && offlineHtml) return sendHtml(req, res, offlineHtml);
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
  // Belegfotos ohne zugehörige Ausgabe nach 3 Tagen löschen, ebenso Dateien ohne Datenbankeintrag
  function cleanReceipts(olderThan = Date.now() - 3 * DAY) {
    let n = 0;
    for (const r of db.orphanReceipts(olderThan)) {
      try { unlinkSync(receiptFile(r.id, r.mime)); } catch { /* schon weg */ }
      db.deleteReceipt(r.id); n++;
    }
    const ids = db.receiptIds();
    for (const f of readdirSync(receiptDir)) {
      if (!ids.has(f.split('.')[0])) { try { unlinkSync(join(receiptDir, f)); n++; } catch { /* egal */ } }
    }
    db.aiPurge(localDay(new Date(Date.now() - 7 * DAY)));
    return n;
  }
  const timers = [
    setInterval(() => { for (const set of streams.values()) for (const s of set) s.res.write(': ping\n\n'); }, 25_000),
    setInterval(() => {
      db.purgeSessions(); loginLimiter.prune(); ipLimiter.prune(); uploadLimiter.prune(); challenges.prune();
      db.purgeSent(Date.now() - 400 * DAY); db.chatPurge(localDay(new Date(Date.now() - 7 * DAY)));
      try { cleanReceipts(); } catch (e) { log.error('Aufräumen der Belege fehlgeschlagen:', e); }
    }, 60 * 60 * 1000),
  ];
  timers.push(setInterval(() => { notifier.tick().catch(e => log.error('Mitteilungen:', e)); }, 60_000));
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

  return { server, db, close, runBackup, cleanReceipts, notifier, sendToUser, vapid };
}
