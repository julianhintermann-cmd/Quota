// Wann welche Push-Mitteilung fällig ist. Jede Mitteilung geht höchstens einmal raus (push_sent).
import { periodKeyOf, periodBounds, periodStats, addMonths, addDays, money, monthName, dayLabel } from './period.js';

export const DEFAULT_PREFS = { budget: true, remind: null, review: true, due: true };
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function parsePrefs(body) {
  if (!body || typeof body !== 'object') return null;
  const out = {};
  for (const k of ['budget', 'review', 'due']) {
    if (k in body) { if (typeof body[k] !== 'boolean') return null; out[k] = body[k]; }
  }
  if ('remind' in body) {
    if (body.remind !== null && !(typeof body.remind === 'string' && TIME_RE.test(body.remind))) return null;
    out.remind = body.remind;
  }
  return out;
}

const pad = n => String(n).padStart(2, '0');
export const localDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hhmm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const plusHours = (t, h) => `${pad(Math.min(23, Number(t.slice(0, 2)) + h))}:${t.slice(3)}`;
const EVERY = { 3: 'vierteljährlich', 12: 'jährlich' };

export function createNotifier({ db, sendToUser, log = console, now = () => new Date() }) {
  const prefsOf = userId => ({ ...DEFAULT_PREFS, ...(db.getPushPrefs(userId) || {}) });
  const settingsOf = data => ({ startDay: (data.settings && data.settings.startDay) || 25, currency: (data.settings && data.settings.currency) || 'CHF' });

  // Nach jeder Änderung: 80 % bzw. 100 % des Budgets der laufenden Periode erreicht?
  async function budgetCheck(userId) {
    if (!prefsOf(userId).budget || !db.pushSubs(userId).length) return false;
    const data = db.getData(userId), { startDay, currency } = settingsOf(data);
    const day = localDay(now()), key = periodKeyOf(day, startDay);
    const st = periodStats(data, key, startDay);
    if (!st.limit || st.spent < st.limit * 0.8) return false;
    const what = st.budget != null ? 'Budget' : 'Einkommen';
    if (st.spent >= st.limit) {
      const first = db.markSent(userId, `budget100:${key}`);
      db.markSent(userId, `budget80:${key}`);
      if (!first) return false;
      const over = Math.round((st.spent - st.limit) * 100) / 100;
      return sendToUser(userId, {
        title: `${what} für ${monthName(key)} aufgebraucht`,
        body: over > 0 ? `Du liegst ${money(over, currency)} darüber, die Periode läuft noch bis zum ${dayLabel(st.end)}.` : `Bis zum ${dayLabel(st.end)} ist nichts mehr übrig.`,
        url: '/', tag: `budget-${key}`,
      });
    }
    if (!db.markSent(userId, `budget80:${key}`)) return false;
    const left = Math.round((st.limit - st.spent) * 100) / 100;
    const days = Math.max(1, Math.round((new Date(`${st.end}T12:00:00Z`) - new Date(`${day}T12:00:00Z`)) / 864e5) + 1);
    return sendToUser(userId, {
      title: `${Math.floor(st.spent / st.limit * 100)} % vom ${what} ausgegeben`,
      body: `Noch ${money(left, currency)} bis zum ${dayLabel(st.end)}, das sind ${money(left / days, currency)} pro Tag.`,
      url: '/', tag: `budget-${key}`,
    });
  }

  async function forUser(userId, d) {
    const prefs = prefsOf(userId), day = localDay(d), t = hhmm(d);
    // Erinnerung am Abend, nur wenn heute noch nichts erfasst wurde (höchstens 3 Stunden nach der Zeit)
    if (prefs.remind && t >= prefs.remind && t <= plusHours(prefs.remind, 3)) {
      const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      if (!db.expensesSince(userId, midnight) && db.markSent(userId, `remind:${day}`)) {
        await sendToUser(userId, { title: 'Schon alles erfasst?', body: 'Heute ist noch keine Ausgabe eingetragen. Ein Tipp aufs Plus genügt.', url: '/?add=1', tag: 'remind' });
      }
    }
    // Am Lohntag ab 9 Uhr: Rückblick auf die abgeschlossene Periode
    if (prefs.review && t >= '09:00' && db.markSent(userId, `reviewcheck:${day}`)) {
      const data = db.getData(userId), { startDay, currency } = settingsOf(data);
      const key = periodKeyOf(day, startDay), prev = addMonths(key, -1);
      if (periodBounds(key, startDay)[0] === day) {
        const st = periodStats(data, prev, startDay);
        if ((st.count || st.limit != null) && db.markSent(userId, `review:${prev}`)) {
          const rest = st.limit != null ? Math.round((st.limit - st.spent) * 100) / 100 : null;
          await sendToUser(userId, {
            title: `Dein Rückblick auf ${monthName(prev)}`,
            body: rest == null ? `${money(st.spent, currency)} ausgegeben. Schau dir an, wohin dein Geld ging.`
              : rest >= 0 ? `${money(rest, currency)} sind übrig geblieben. Schau dir an, wohin dein Geld ging.`
                : `${money(-rest, currency)} über dem Budget. Schau dir an, wohin dein Geld ging.`,
            url: `/?review=${prev}`, tag: `review-${prev}`,
          });
        }
      }
    }
    // Ab 18 Uhr: vierteljährliche und jährliche Fixkosten, die morgen fällig sind
    if (prefs.due && t >= '18:00' && db.markSent(userId, `duecheck:${day}`)) {
      const data = db.getData(userId), { currency } = settingsOf(data), tomorrow = addDays(day, 1);
      const due = ((data.months[tomorrow.slice(0, 7)] || {}).expenses || []).filter(e => e.date === tomorrow && e.every > 1);
      const fresh = due.filter(e => db.markSent(userId, `due:${e.id}`));
      if (fresh.length === 1) {
        const e = fresh[0];
        await sendToUser(userId, { title: `Morgen fällig: ${e.title || 'Fixkosten'}`, body: `${money(e.amt, currency)} · ${EVERY[e.every]}`, url: '/', tag: `due-${e.id}` });
      } else if (fresh.length > 1) {
        const sum = fresh.reduce((a, e) => a + e.amt, 0);
        await sendToUser(userId, {
          title: `Morgen fällig: ${fresh.length} Fixkosten`, body: `${fresh.map(e => e.title || 'Fixkosten').join(', ')} · zusammen ${money(sum, currency)}`, url: '/', tag: `due-${tomorrow}`,
        });
      }
    }
  }

  // Jede Minute: für alle Personen mit eingeschalteten Mitteilungen prüfen
  async function tick() {
    const d = now();
    for (const userId of db.pushUsers()) {
      try { await forUser(userId, d); } catch (e) { log.error(`Mitteilungen für Benutzer ${userId}:`, e.message || e); }
    }
  }
  return { tick, budgetCheck, prefsOf };
}
