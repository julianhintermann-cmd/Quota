import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, unlinkSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export const CATEGORIES = ['essen', 'einkauf', 'wohnen', 'mobil', 'freizeit', 'gesund', 'abos', 'sonst'];
export const CURRENCIES = ['CHF', 'EUR', 'USD'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY,
  username   TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  pw_hash    TEXT    NOT NULL,
  is_admin   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS settings (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  currency   TEXT    NOT NULL,
  start_day  INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- Ein Eintrag pro Kalendermonat ("2026-09"): Einkommen und Budget in Rappen/Cent
CREATE TABLE IF NOT EXISTS months (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month      TEXT    NOT NULL,
  income     INTEGER,
  budget     INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, month)
);
-- Jede Ausgabe als eigene Zeile, Betrag in Rappen/Cent
CREATE TABLE IF NOT EXISTS expenses (
  user_id  INTEGER NOT NULL,
  id       TEXT    NOT NULL,
  month    TEXT    NOT NULL,
  date     TEXT    NOT NULL,
  amount   INTEGER NOT NULL,
  title    TEXT    NOT NULL DEFAULT '',
  category TEXT    NOT NULL,
  monthly  INTEGER NOT NULL DEFAULT 0,
  ts       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, month) REFERENCES months(user_id, month) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS expenses_month ON expenses(user_id, month);
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const toCents = v => (v == null ? null : Math.round(v * 100));
const fromCents = v => (v == null ? null : v / 100);

export function openDatabase(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'monatsbudget.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

  const q = {
    countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
    userById: db.prepare('SELECT id, username, pw_hash, is_admin FROM users WHERE id = ?'),
    userByName: db.prepare('SELECT id, username, pw_hash, is_admin FROM users WHERE username = ?'),
    listUsers: db.prepare(`SELECT u.id, u.username, u.is_admin, u.created_at,
        (SELECT COUNT(*) FROM expenses e WHERE e.user_id = u.id) AS expenses
      FROM users u ORDER BY u.username COLLATE NOCASE`),
    insertUser: db.prepare('INSERT INTO users (username, pw_hash, is_admin, created_at) VALUES (?, ?, ?, ?)'),
    deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
    setPassword: db.prepare('UPDATE users SET pw_hash = ? WHERE id = ?'),

    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
    sessionUser: db.prepare(`SELECT s.expires_at, u.id, u.username, u.is_admin
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`),
    extendSession: db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    deleteOtherSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?'),
    deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),

    getSettings: db.prepare('SELECT currency, start_day FROM settings WHERE user_id = ?'),
    putSettings: db.prepare(`INSERT INTO settings (user_id, currency, start_day, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET currency = excluded.currency, start_day = excluded.start_day, updated_at = excluded.updated_at`),

    months: db.prepare('SELECT month, income, budget FROM months WHERE user_id = ? ORDER BY month'),
    month: db.prepare('SELECT month, income, budget FROM months WHERE user_id = ? AND month = ?'),
    expenses: db.prepare('SELECT id, month, date, amount, title, category, monthly, ts FROM expenses WHERE user_id = ? ORDER BY month, ts, id'),
    monthExpenses: db.prepare('SELECT id, month, date, amount, title, category, monthly, ts FROM expenses WHERE user_id = ? AND month = ? ORDER BY ts, id'),
    upsertMonth: db.prepare(`INSERT INTO months (user_id, month, income, budget, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, month) DO UPDATE SET income = excluded.income, budget = excluded.budget, updated_at = excluded.updated_at`),
    movedFrom: db.prepare(`SELECT DISTINCT month FROM expenses
      WHERE user_id = ? AND month <> ? AND id IN (SELECT value FROM json_each(?))`),
    deleteMoved: db.prepare(`DELETE FROM expenses
      WHERE user_id = ? AND month <> ? AND id IN (SELECT value FROM json_each(?))`),
    deleteMonthExpenses: db.prepare('DELETE FROM expenses WHERE user_id = ? AND month = ?'),
    insertExpense: db.prepare(`INSERT INTO expenses (user_id, id, month, date, amount, title, category, monthly, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    deleteMonth: db.prepare('DELETE FROM months WHERE user_id = ? AND month = ?'),

    getConfig: db.prepare('SELECT value FROM config WHERE key = ?'),
    setConfig: db.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  };

  const tx = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  };

  const expenseOut = e => ({
    id: e.id, amt: fromCents(e.amount), title: e.title, cat: e.category, date: e.date, rep: !!e.monthly, ts: e.ts,
  });
  const monthOut = (m, list) => ({ income: fromCents(m.income), budget: fromCents(m.budget), expenses: list.map(expenseOut) });
  const isEmpty = m => m.income == null && m.budget == null && !m.expenses.length;

  return {
    file,
    close: () => db.close(),
    ping: () => db.prepare('SELECT 1 AS ok').get().ok === 1,

    /* ---------- Benutzer ---------- */
    countUsers: () => q.countUsers.get().n,
    userById: id => q.userById.get(id),
    userByName: name => q.userByName.get(name),
    listUsers: () => q.listUsers.all(),
    createUser: (username, pwHash, isAdmin) =>
      Number(q.insertUser.run(username, pwHash, isAdmin ? 1 : 0, Date.now()).lastInsertRowid),
    deleteUser: id => q.deleteUser.run(id).changes > 0,
    setPassword: (id, pwHash) => q.setPassword.run(pwHash, id).changes > 0,

    /* ---------- Sitzungen ---------- */
    createSession: (tokenHash, userId, expiresAt) => q.insertSession.run(tokenHash, userId, expiresAt),
    sessionUser: tokenHash => q.sessionUser.get(tokenHash),
    extendSession: (tokenHash, expiresAt) => q.extendSession.run(expiresAt, tokenHash),
    deleteSession: tokenHash => q.deleteSession.run(tokenHash),
    deleteOtherSessions: (userId, keepHash) => q.deleteOtherSessions.run(userId, keepHash),
    deleteUserSessions: userId => q.deleteUserSessions.run(userId),
    purgeSessions: () => q.purgeSessions.run(Date.now()).changes,

    /* ---------- Einstellungen ---------- */
    getSettings(userId) {
      const s = q.getSettings.get(userId);
      return s ? { currency: s.currency, startDay: s.start_day } : null;
    },
    putSettings: (userId, s) => q.putSettings.run(userId, s.currency, s.startDay, Date.now()),

    /* ---------- Monate und Ausgaben ---------- */
    getData(userId) {
      const byMonth = {};
      for (const e of q.expenses.all(userId)) (byMonth[e.month] ||= []).push(e);
      const months = {};
      for (const m of q.months.all(userId)) {
        const out = monthOut(m, byMonth[m.month] || []);
        if (!isEmpty(out)) months[m.month] = out;
      }
      return { settings: this.getSettings(userId), months };
    },
    getMonth(userId, key) {
      const m = q.month.get(userId, key);
      if (!m) return null;
      const out = monthOut(m, q.monthExpenses.all(userId, key));
      return isEmpty(out) ? null : out;
    },
    // Ersetzt einen Monat vollständig. Gibt die Monate zurück, aus denen Ausgaben hierher verschoben wurden.
    putMonth(userId, key, doc) {
      const ids = JSON.stringify(doc.expenses.map(e => e.id));
      const now = Date.now();
      return tx(() => {
        const moved = q.movedFrom.all(userId, key, ids).map(r => r.month);
        q.deleteMoved.run(userId, key, ids);
        q.upsertMonth.run(userId, key, toCents(doc.income), toCents(doc.budget), now);
        q.deleteMonthExpenses.run(userId, key);
        for (const e of doc.expenses) {
          q.insertExpense.run(userId, e.id, key, e.date, toCents(e.amt), e.title, e.cat, e.rep ? 1 : 0, e.ts);
        }
        return moved;
      });
    },
    deleteMonth: (userId, key) => q.deleteMonth.run(userId, key).changes > 0,

    /* ---------- Konfiguration ---------- */
    getConfig: (key, fallback = null) => { const r = q.getConfig.get(key); return r ? r.value : fallback; },
    setConfig: (key, value) => q.setConfig.run(key, String(value)),

    /* ---------- Backup ---------- */
    // Konsistente Kopie der Datenbank (auch während des Betriebs), eine Datei pro Tag.
    // replace=false: nur anlegen, wenn es für heute noch keine gibt.
    backup(dir, keep, { replace = true, now = new Date() } = {}) {
      mkdirSync(dir, { recursive: true });
      const pad = n => String(n).padStart(2, '0');
      const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const target = join(dir, `monatsbudget-${day}.db`);
      let written = null;
      if (replace || !existsSync(target)) {
        const tmp = `${target}.tmp`;
        if (existsSync(tmp)) unlinkSync(tmp);
        db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
        renameSync(tmp, target);
        written = target;
      }
      const files = readdirSync(dir).filter(f => /^monatsbudget-\d{4}-\d\d-\d\d\.db$/.test(f)).sort();
      for (const f of files.slice(0, Math.max(0, files.length - keep))) unlinkSync(join(dir, f));
      return written;
    },
  };
}
