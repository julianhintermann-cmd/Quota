// Bankauszüge (CSV) lesen: Schweizer Banken, Neo-Banken und beliebige andere Exporte.
// Läuft im Browser (window.BankCSV) und in Node (Tests), ohne Abhängigkeiten.
(function (root) {
  'use strict';

  class ImportError extends Error {}

  /* ---------- Text ---------- */
  // UTF-8 (mit oder ohne BOM), UTF-16 aus Excel oder Windows-1252 (ältere E-Banking-Exporte)
  function decode(input) {
    if (typeof input === 'string') return input.replace(/^﻿/, '');
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, ''); }
    catch (e) { return new TextDecoder('windows-1252').decode(bytes); }
  }

  // Trennzeichen: das Zeichen, das in den ersten Zeilen am regelmässigsten vorkommt
  function detectDelimiter(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim()).slice(0, 40);
    let best = ';', bestScore = -1;
    for (const d of [';', ',', '\t', '|']) {
      const counts = lines.map(l => countOutsideQuotes(l, d)).filter(n => n > 0);
      if (!counts.length) continue;
      const freq = {};
      counts.forEach(n => { freq[n] = (freq[n] || 0) + 1; });
      const [mode, times] = Object.entries(freq).sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
      const score = times * 10 + Number(mode);
      if (score > bestScore) { best = d; bestScore = score; }
    }
    return best;
  }
  function countOutsideQuotes(line, d) {
    let n = 0, q = false;
    for (const ch of line) { if (ch === '"') q = !q; else if (ch === d && !q) n++; }
    return n;
  }

  function parseCSV(text, delim) {
    const rows = [];
    let row = [], cell = '', q = false, i = 0;
    const n = text.length;
    while (i < n) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i += 2; continue; } q = false; i++; continue; }
        cell += ch; i++; continue;
      }
      if (ch === '"' && cell.trim() === '' ) { q = true; cell = ''; i++; continue; }
      if (ch === '"' && /^=$/.test(cell.trim())) { q = true; cell = ''; i++; continue; } // ="2024-01-31" (PostFinance)
      if (ch === delim) { row.push(cell); cell = ''; i++; continue; }
      if (ch === '\r' || ch === '\n') {
        row.push(cell); rows.push(row); row = []; cell = '';
        if (ch === '\r' && text[i + 1] === '\n') i++;
        i++; continue;
      }
      cell += ch; i++;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.map(r => r.map(c => c.trim())).filter(r => r.some(c => c !== ''));
  }

  /* ---------- Werte ---------- */
  // 1'234.50 · 1’234.50 · 1.234,50 · -12.50 · 12.50- · (12.50) · −12,50 CHF
  function parseAmount(s) {
    if (s == null) return null;
    let t = String(s).trim().replace(/^="?|"$/g, '');
    if (!t) return null;
    let neg = false;
    if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
    // Währung vorne oder hinten (CHF 12.50, 12.50 €); Buchstaben mittendrin heissen: keine Zahl
    t = t.replace(/^[A-Za-z€$£]{1,4}\.?\s*|\s*[A-Za-z€$£]{1,4}\.?$/g, '').replace(/[\s\u00A0\u202F'’ʼ`´]/g, '');
    if (/^[-−–+]/.test(t)) { neg = neg || !/^\+/.test(t); t = t.slice(1); }
    if (/[-−–]$/.test(t)) { neg = true; t = t.slice(0, -1); }
    if (!/^[\d.,]+$/.test(t) || !/\d/.test(t)) return null;
    const lastDot = t.lastIndexOf('.'), lastComma = t.lastIndexOf(',');
    if (lastDot > -1 && lastComma > -1) {
      // Das hintere Zeichen ist das Dezimaltrennzeichen
      t = lastComma > lastDot ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
    } else if (lastComma > -1) {
      const dec = t.length - lastComma - 1;
      t = (t.split(',').length === 2 && dec !== 3) ? t.replace(',', '.') : t.replace(/,/g, '');
    } else if ((t.match(/\./g) || []).length > 1) t = t.replace(/\./g, '');
    const v = Number(t);
    if (!Number.isFinite(v)) return null;
    return neg ? -v : v;
  }

  const pad = n => String(n).padStart(2, '0');
  function validDate(y, m, d) {
    if (y < 100) y += 2000;
    if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1) return null;
    if (d > new Date(y, m, 0).getDate()) return null;
    return `${y}-${pad(m)}-${pad(d)}`;
  }
  // 31.01.2024 · 31.1.24 · 2024-01-31 (auch mit Uhrzeit) · 31/01/2024 · 31-01-2024 · 2024.01.31
  function parseDate(s) {
    if (s == null) return null;
    const t = String(s).trim().replace(/^="?|"$/g, '');
    let m = t.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:$|[\sT])/);
    if (m) return validDate(+m[1], +m[2], +m[3]);
    m = t.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})(?:$|[\s,])/);
    if (m) return validDate(+m[3], +m[2], +m[1]);
    return null;
  }

  /* ---------- Spalten erkennen ---------- */
  const normH = h => String(h || '').toLowerCase().replace(/^="?|"$/g, '').replace(/\s+/g, ' ').trim();
  const DATE_H = ['kaufdatum', 'einkaufsdatum', 'transaktionsdatum', 'transaction date', 'abschlussdatum', 'started date', 'startdatum',
    'date started (utc)', 'completed date', 'datum des abschlusses', 'datum', 'date', 'buchungsdatum', 'booking date', 'booked at', 'buchungstag',
    'date de comptabilisation', 'data', 'valutadatum', 'valuta', 'value date', 'valuta date'];
  const TEXT_H = ['beschreibung1', 'beschreibung 1', 'merchant', 'händler', 'description', 'beschreibung', 'buchungstext', 'avisierungstext', 'text',
    'activity name', 'recipient', 'empfänger', 'zahlungsempfänger', 'payee', 'name', 'details', 'booking text', 'libellé', 'descrizione',
    'mitteilung', 'subject', 'zahlungszweck', 'beschreibung2', 'beschreibung 2', 'payment reference'];
  const AMOUNT_H = h => /^(betrag|amount|credit\/debit amount|einzelbetrag|umsatz|montant|importo|transaction amount|total amount)( ?\(?(in )?[a-z]{3}\)?)?$/.test(h);
  const DEBIT_H = h => /^(belastung|belastungen|lastschrift|soll|debit|debit amount|ausgang|débit|addebito)( ?\(?(in )?[a-z]{3}\)?)?$/.test(h);
  const CREDIT_H = h => /^(gutschrift|gutschriften|haben|credit|credit amount|eingang|crédit|accredito)( ?\(?(in )?[a-z]{3}\)?)?$/.test(h);
  const CUR_H = ['währung', 'whg', 'whg.', 'whr.', 'whr', 'currency', 'debit currency', 'devise', 'valuta (währung)'];
  const STATE_H = ['state', 'status', 'zustand'];
  const TYPE_H = ['type', 'art', 'activity type', 'transaktionstyp', 'typ'];

  function headerScore(row) {
    const h = row.map(normH);
    const date = h.some(x => DATE_H.includes(x)), money = h.some(x => AMOUNT_H(x) || DEBIT_H(x) || CREDIT_H(x));
    const text = h.some(x => TEXT_H.includes(x));
    return date && money ? 2 + (text ? 1 : 0) : 0;
  }

  function guessMap(header, rows) {
    const h = header.map(normH);
    const byList = list => { for (const k of list) { const i = h.indexOf(k); if (i > -1) return i; } return -1; };
    const all = list => list.map(k => h.indexOf(k)).filter(i => i > -1);
    const map = {
      date: byList(DATE_H), dates: all(DATE_H), text: all(TEXT_H),
      amount: h.findIndex(AMOUNT_H), debit: h.findIndex(DEBIT_H), credit: h.findIndex(CREDIT_H),
      currency: byList(CUR_H), state: byList(STATE_H), type: byList(TYPE_H), sign: 'auto',
    };
    // Belastung/Gutschrift gehen vor einer allgemeinen Betragsspalte (ZKB hat beides)
    if (map.debit > -1) map.amount = -1;
    // Die gewählte Datumsspalte muss auch wirklich Daten enthalten
    if (rows.length && map.dates.length) {
      const filled = i => rows.slice(0, 30).filter(r => parseDate(r[i])).length;
      const ok = map.dates.filter(i => filled(i) > 0);
      if (ok.length) { map.dates = ok; map.date = ok[0]; }
    }
    if (!map.text.length) {
      const i = longestTextCol(rows, new Set([map.date, map.amount, map.debit, map.credit]));
      if (i > -1) map.text = [i];
    }
    return map;
  }

  // Ohne Kopfzeile: Spalten anhand der Werte erkennen
  function inferMap(rows) {
    const width = Math.max(...rows.map(r => r.length));
    const sample = rows.slice(0, 50);
    const share = (i, fn) => sample.filter(r => fn(r[i])).length / sample.length;
    let date = -1, amount = -1;
    for (let i = 0; i < width; i++) if (date < 0 && share(i, parseDate) > 0.6) date = i;
    for (let i = 0; i < width; i++) {
      if (i === date || amount > -1) continue;
      if (share(i, v => parseAmount(v) != null && /[.,]\d{2}\)?-?$/.test(String(v).trim())) > 0.6) amount = i;
    }
    if (date < 0 || amount < 0) return null;
    const text = longestTextCol(rows, new Set([date, amount]));
    return { date, dates: [date], text: text > -1 ? [text] : [], amount, debit: -1, credit: -1, currency: -1, state: -1, type: -1, sign: 'auto' };
  }
  function longestTextCol(rows, skip) {
    const width = Math.max(0, ...rows.map(r => r.length));
    let best = -1, bestLen = 0;
    for (let i = 0; i < width; i++) {
      if (skip.has(i)) continue;
      const vals = rows.slice(0, 50).map(r => r[i] || '').filter(v => v && parseAmount(v) == null && !parseDate(v));
      const len = vals.reduce((a, v) => a + v.length, 0) / Math.max(1, rows.length);
      if (len > bestLen) { best = i; bestLen = len; }
    }
    return best;
  }

  const BANKS = [
    ['UBS', (h, t) => h.includes('einzelbetrag') || h.includes('abschlussdatum') || /\bUBS\b/.test(t)],
    ['PostFinance', (h, t) => h.includes('avisierungstext') || /postfinance/i.test(t)],
    ['Raiffeisen', (h, t) => h.includes('booked at') || /raiffeisen/i.test(t)],
    ['Zürcher Kantonalbank', (h, t) => h.includes('zkb-referenz') || /\bZKB\b|Zürcher Kantonalbank/i.test(t)],
    ['Migros Bank', (h, t) => /migros ?bank/i.test(t)],
    ['Revolut', (h, t) => h.includes('started date') || h.includes('startdatum') || /revolut/i.test(t)],
    ['Neon', (h, t) => (h.includes('original amount') && h.includes('subject')) || /\bneon\b/i.test(t)],
    ['Yuh', (h, t) => h.includes('activity type') || /\byuh\b/i.test(t)],
    ['Wise', (h, t) => h.includes('transferwise id') || /\bwise\b/i.test(t)],
    ['Cembra', (h, t) => /cembra/i.test(t)],
    ['Viseca', (h, t) => /viseca|one app/i.test(t)],
  ];

  function read(input) {
    const text = decode(input);
    if (!text.trim()) throw new ImportError('Die Datei ist leer.');
    const delimiter = detectDelimiter(text);
    const all = parseCSV(text, delimiter);
    if (all.length < 1) throw new ImportError('In der Datei wurden keine Zeilen gefunden.');
    let hi = -1;
    for (let i = 0; i < Math.min(all.length, 80); i++) if (headerScore(all[i]) >= 2) { hi = i; break; }
    let header, rows, map;
    if (hi > -1) {
      header = all[hi].map(c => c.replace(/^="?|"$/g, ''));
      rows = all.slice(hi + 1);
      map = guessMap(header, rows);
    } else {
      rows = all.filter(r => r.length > 1);
      map = rows.length ? inferMap(rows) : null;
      if (!map) throw new ImportError('Das sieht nicht nach einem Kontoauszug aus. Es fehlen Datum und Betrag.');
      const width = Math.max(...rows.map(r => r.length));
      header = Array.from({ length: width }, (_, i) => `Spalte ${i + 1}`);
    }
    const preamble = all.slice(0, Math.max(0, hi)).map(r => r.join(' ')).join(' ');
    const h = header.map(normH);
    const bank = (BANKS.find(([, test]) => test(h, preamble + ' ' + header.join(' '))) || ['CSV-Datei'])[0];
    return { bank, delimiter, header, rows, map };
  }

  /* ---------- Buchungstexte kürzen ---------- */
  const lower = /[a-zäöüàéèç]/, upper = /[A-ZÄÖÜÀÉÈÇ]/;
  function titleCase(s) {
    if (lower.test(s) || !upper.test(s)) return s;
    return s.toLowerCase().replace(/(^|[\s\-/&(])([a-zäöüàéèç])/g, (m, a, b) => a + b.toUpperCase())
      .replace(/\b(Ag|Sa|Gmbh|Sbb|Cff|Ffs|Ubs|Zkb|Ikea)\b/g, w => (w === 'Gmbh' ? 'GmbH' : w.toUpperCase()));
  }
  function cleanText(raw) {
    let s = String(raw || '').replace(/^="?|"$/g, '').replace(/\s+/g, ' ').trim();
    const orig = s;
    s = s
      .replace(/\b(twint[- ]?)?(kauf|einkauf|zahlung|bezug|belastung|online[- ]?einkauf|e-commerce)(\/[a-z-]+( [a-z-]+)?)?\s+vom\s+\d{1,2}\.\d{1,2}\.\d{2,4}(\s+\d{1,2}:\d{2}(:\d{2})?)?/gi, ' ')
      .replace(/\b(karten?|card)[- ]?(nr\.?|no\.?|nummer|number)?\s*[:#]?\s*[x*\d][x*\d ]{3,}\d/gi, ' ')
      .replace(/\b(x{2,}|\*{2,})\s?\d{2,4}\b/gi, ' ')
      .replace(/^(einkauf|kauf|zahlung|belastung|lastschrift|kartenzahlung|card payment|purchase|payment)\b[^,;:]{0,60}?(debit|maestro|visa|mastercard|karte|card)[^,;:]*[,;:]\s*/i, '')
      .replace(/\b(visa debit card|debit mastercard|debitkarte|debit card|maestro[- ]?karte|v pay|postfinance card)\b/gi, ' ')
      .replace(/\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/g, ' ')
      .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, ' ')
      .replace(/\b(?=[a-z]*\d)[a-z\d]{10,}\b/gi, ' ')
      .replace(/\s*([;,])\s*(?=[;,]|$)/g, '')
      .replace(/\s*;\s*/g, ', ')
      .replace(/\s+/g, ' ')
      .replace(/^[\s,;:\-–*/]+|[\s,;:\-–*/]+$/g, '');
    if (/^twint\b/i.test(s) && s.length > 8) s = s.replace(/^twint\s*[*:]?\s*/i, '');
    if (s.length < 2) s = orig;
    s = titleCase(s);
    if (s.length > 40) s = s.slice(0, 40).replace(/[\s,;:\-]+\S*$/, '') || s.slice(0, 40);
    return s;
  }
  // "KAUF/DIENSTLEISTUNG VOM 12.01.2024": das eigentliche Kaufdatum steckt im Text
  function dateInText(raw) {
    const m = String(raw || '').match(/\bvom\s+(\d{1,2}\.\d{1,2}\.\d{2,4})/i);
    return m ? parseDate(m[1]) : null;
  }
  const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 864e5);

  const SKIP_STATE = /^(reverted|declined|failed|cancel+ed|rückgängig|abgelehnt|fehlgeschlagen|storniert)/i;
  const PENDING_STATE = /^(pending|ausstehend|in bearbeitung|vorgemerkt)/i;
  const SKIP_TYPE = /^(exchange|umtausch|wechsel|topup|top-up|aufladung|aufladen)$/i;

  /* ---------- Buchungen herausziehen ---------- */
  function extract(parsed, map = parsed.map) {
    const items = [];
    const stats = { rows: 0, income: 0, skipped: 0 };
    const amountCol = map.amount;
    let sign = map.sign || 'auto';
    if (sign === 'auto') {
      if (map.debit > -1 || amountCol < 0) sign = 'neg';
      else {
        const vals = parsed.rows.map(r => parseAmount(r[amountCol])).filter(v => v != null && v !== 0);
        // Nur positive Beträge (z. B. Kreditkartenabrechnung): dann sind das die Ausgaben
        sign = vals.length && !vals.some(v => v < 0) ? 'pos' : 'neg';
      }
    }
    parsed.rows.forEach(r => {
      let date = null;
      for (const i of [map.date, ...(map.dates || [])]) { if (i > -1 && (date = parseDate(r[i]))) break; }
      if (!date) return;
      stats.rows++;
      if (map.state > -1 && SKIP_STATE.test(r[map.state] || '')) { stats.skipped++; return; }
      if (map.type > -1 && SKIP_TYPE.test((r[map.type] || '').trim())) { stats.skipped++; return; }
      let amount = null;
      if (map.debit > -1) {
        const d = parseAmount(r[map.debit]);
        if (d) amount = Math.abs(d);
        else if (map.credit > -1 && parseAmount(r[map.credit])) { stats.income++; return; }
        else if (amountCol > -1) { const v = parseAmount(r[amountCol]); if (v && v < 0) amount = -v; else if (v) { stats.income++; return; } }
      } else if (amountCol > -1) {
        const v = parseAmount(r[amountCol]);
        if (v) {
          if (sign === 'pos' ? v > 0 : v < 0) amount = Math.abs(v);
          else { stats.income++; return; }
        }
      }
      if (!amount) { stats.skipped++; return; }
      let raw = '';
      for (const i of map.text || []) { if (r[i] && r[i].replace(/^="?|"$/g, '').trim()) { raw = r[i]; break; } }
      const inText = dateInText(raw);
      if (inText && dayDiff(date, inText) >= 0 && dayDiff(date, inText) <= 10) date = inText;
      const cur = map.currency > -1 && /^[A-Za-z]{3}$/.test((r[map.currency] || '').trim()) ? r[map.currency].trim().toUpperCase() : null;
      items.push({
        date, amount: Math.round(amount * 100) / 100, text: cleanText(raw), raw: String(raw).replace(/^="?|"$/g, '').trim(), currency: cur,
        pending: map.state > -1 && PENDING_STATE.test(r[map.state] || ''),
      });
    });
    items.sort((a, b) => b.date.localeCompare(a.date));
    return { items, stats, sign };
  }

  const api = { read, extract, decode, detectDelimiter, parseCSV, parseAmount, parseDate, cleanText, ImportError };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BankCSV = api;
})(typeof self !== 'undefined' ? self : this);
