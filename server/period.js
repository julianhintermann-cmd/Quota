// Lohnperioden auf dem Server (gleiche Regeln wie in der App): Ein Schlüssel "2026-09" steht für den
// Zeitraum ab dem Lohntag im September bis zum Tag davor im Oktober. Ausgaben liegen nach Kalendermonat.

const pad = n => String(n).padStart(2, '0');
const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m = 1..12

export function addMonths(key, n) {
  const [y, m] = key.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
}
export function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function periodKeyOf(day, startDay) {
  const key = day.slice(0, 7);
  return Number(day.slice(8)) >= startDay ? key : addMonths(key, -1);
}
export function periodBounds(key, startDay) {
  const [y, m] = key.split('-').map(Number);
  const start = `${key}-${pad(startDay)}`;
  if (startDay === 1) return [start, `${key}-${pad(dim(y, m))}`];
  return [start, `${addMonths(key, 1)}-${pad(startDay - 1)}`];
}

// Zahlen einer Lohnperiode aus den Daten von db.getData()
export function periodStats(data, key, startDay) {
  const [start, end] = periodBounds(key, startDay);
  const m = data.months[key] || { income: null, budget: null, expenses: [] };
  const list = [...(m.expenses || []), ...(startDay > 1 ? ((data.months[addMonths(key, 1)] || {}).expenses || []) : [])]
    .filter(e => e.date >= start && e.date <= end);
  const r2 = v => Math.round(v * 100) / 100;
  const byCat = {};
  for (const e of list) byCat[e.cat] = r2((byCat[e.cat] || 0) + e.amt);
  const spent = r2(list.reduce((a, e) => a + e.amt, 0));
  const limit = m.budget != null ? m.budget : m.income;
  return {
    key, start, end, income: m.income, budget: m.budget, limit, spent, count: list.length,
    fixed: r2(list.filter(e => e.rep).reduce((a, e) => a + e.amt, 0)), byCat, expenses: list,
  };
}

// Betrag wie in der App: "CHF 1’234.50"
export function money(v, currency = 'CHF') {
  const neg = v < 0, [i, d] = Math.abs(v).toFixed(2).split('.');
  return `${neg ? '−' : ''}${currency} ${i.replace(/\B(?=(\d{3})+(?!\d))/g, '’')}.${d}`;
}
export const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
export const monthName = key => MONTHS[Number(key.slice(5)) - 1];
export const dayLabel = day => `${Number(day.slice(8))}. ${MONTHS[Number(day.slice(5, 7)) - 1]}`;
