// Wechselkurse ohne Schlüssel und ohne zusätzliche Pakete.
// 1. EZB-Referenzkurse über Frankfurter (rund 30 Hauptwährungen, Werktage)
// 2. Für alle anderen Währungen oder wenn 1. nicht antwortet: fawazahmed0/currency-api (täglich, 150+ Währungen)
// Beide Quellen liefern eine Tabelle zur Basis EUR, daraus wird jedes Paar über Kreuz gerechnet.

export const FX_SOURCES = {
  ecb: 'https://api.frankfurter.dev/v1',
  alt: ['https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@{day}/v1', 'https://{day}.currency-api.pages.dev/v1'],
};
const CODE_RE = /^[A-Z]{3}$/;
const DAY_RE = /^\d{4}-\d\d-\d\d$/;
const FIRST_DAY = '1999-01-04'; // erster EZB-Referenzkurs
const LATEST_TTL = 3 * 3600e3; // aktuelle Kurse höchstens 3 Stunden zwischenspeichern
const MAX_TABLES = 400;

export class FxError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function createFx({ sources = FX_SOURCES, fetchImpl = fetch, today, now = Date.now, log = console, timeoutMs = 8000 } = {}) {
  const tables = new Map(); // "ecb:2026-09-27" → { at, date, rates }
  const inflight = new Map();
  const upstream = []; // Zeitpunkte der Abrufe, gegen Missbrauch begrenzt

  async function getJson(url) {
    const t = now();
    while (upstream.length && upstream[0] < t - 600e3) upstream.shift();
    if (upstream.length >= 120) throw new FxError(429, 'Zu viele Kursabfragen, bitte kurz warten.');
    upstream.push(t);
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.json();
  }

  // Tabelle 1 EUR = x Währung, Schlüssel in Grossbuchstaben
  const loaders = {
    async ecb(day) {
      const j = await getJson(`${sources.ecb}/${day}?base=EUR`);
      if (!j || typeof j.rates !== 'object') throw new Error('Frankfurter: unerwartete Antwort');
      return { date: DAY_RE.test(j.date) ? j.date : null, rates: { ...clean(j.rates), EUR: 1 } };
    },
    async alt(day) {
      let last;
      for (const tpl of sources.alt) {
        try {
          const j = await getJson(`${tpl.replace('{day}', day)}/currencies/eur.json`);
          if (!j || typeof j.eur !== 'object') throw new Error('currency-api: unerwartete Antwort');
          return { date: DAY_RE.test(j.date) ? j.date : null, rates: { ...clean(j.eur), EUR: 1 } };
        } catch (e) { last = e; }
      }
      throw last || new Error('currency-api: keine Adresse');
    },
  };

  async function table(src, day) {
    const key = `${src}:${day}`;
    const hit = tables.get(key);
    const fresh = hit && (day !== 'latest' || now() - hit.at < LATEST_TTL);
    if (fresh) return hit;
    if (inflight.has(key)) return inflight.get(key);
    const p = loaders[src](day).then(t => {
      const v = { ...t, at: now() };
      tables.delete(key); tables.set(key, v);
      while (tables.size > MAX_TABLES) tables.delete(tables.keys().next().value);
      return v;
    }).catch(e => {
      if (hit) { log.error(`Wechselkurse (${src}): ${e.message} – verwende gespeicherte Kurse`); return hit; }
      throw e;
    }).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  // Kurs für 1 Einheit "from" in "to" am Tag "date" (leer oder heute/Zukunft: aktueller Kurs)
  async function rate(from, to, date) {
    if (!CODE_RE.test(from) || !CODE_RE.test(to)) throw new FxError(400, 'Unbekannte Währung.');
    if (date != null && date !== '' && (!DAY_RE.test(date) || date < FIRST_DAY)) throw new FxError(400, 'Ungültiges Datum.');
    const day = !date || date >= today() ? 'latest' : date;
    if (from === to) return { from, to, rate: 1, date: day === 'latest' ? today() : day, source: null };
    let missing = null, failed = false;
    for (const src of ['ecb', 'alt']) {
      let t;
      try { t = await table(src, day); }
      catch (e) { if (e instanceof FxError) throw e; log.error(`Wechselkurse (${src}): ${e.message}`); failed = true; continue; }
      const a = t.rates[from], b = t.rates[to];
      if (a && b) return { from, to, rate: round(b / a), date: t.date || (day === 'latest' ? today() : day), source: src === 'ecb' ? 'EZB' : 'currency-api' };
      missing = a ? to : from;
    }
    // Nur wenn alle Quellen geantwortet haben, fehlt die Währung wirklich
    if (missing && !failed) throw new FxError(404, `Für ${missing} gibt es ${day === 'latest' ? 'keinen Kurs' : 'an diesem Tag keinen Kurs'}.`);
    throw new FxError(502, 'Die Wechselkurse sind gerade nicht erreichbar.');
  }

  return { rate, _tables: tables };
}

function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const code = k.toUpperCase();
    if (CODE_RE.test(code) && typeof v === 'number' && Number.isFinite(v) && v > 0) out[code] = v;
  }
  return out;
}
// 6 signifikante Stellen reichen für jeden Betrag im Haushaltsbudget
const round = v => Number(v.toPrecision(6));
