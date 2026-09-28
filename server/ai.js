// Belegerkennung über OpenRouter (https://openrouter.ai): ein Bild rein, Betrag/Händler/Datum/Kategorie raus.
export const DEFAULT_MODEL = 'google/gemini-2.5-flash';

export class AiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function prompt(categories) {
  const list = categories.map(c => `"${c.id}" (${c.n})`).join(', ');
  return `Du liest ein Foto eines Kassenbelegs, einer Quittung oder Rechnung.
Antworte ausschliesslich mit einem JSON-Objekt, ohne weiteren Text:
{"amount": Gesamtbetrag der bezahlt wurde als Zahl (z.B. 23.45), "currency": Währung als ISO-Code (z.B. "CHF"),
 "date": Datum des Einkaufs als "YYYY-MM-DD", "merchant": kurzer Name des Geschäfts (max. 40 Zeichen),
 "category": passendste Kategorie-ID aus dieser Liste: ${list}}
Wenn ein Wert nicht lesbar ist, setze null. Ist es kein Beleg, setze alle Werte auf null.`;
}

// Nimmt die Antwort des Modells und macht daraus geprüfte Werte
export function parseAnswer(text, categories) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) throw new AiError(502, 'Die KI hat keine verwertbare Antwort geliefert.');
  let j;
  try { j = JSON.parse(m[0]); } catch { throw new AiError(502, 'Die KI hat keine verwertbare Antwort geliefert.'); }
  const num = typeof j.amount === 'string' ? Number(j.amount.replace(/['’\s]/g, '').replace(',', '.')) : j.amount;
  const amount = typeof num === 'number' && Number.isFinite(num) && num > 0 && num < 1e7 ? Math.round(num * 100) / 100 : null;
  const currency = typeof j.currency === 'string' && /^[A-Za-z]{3}$/.test(j.currency) ? j.currency.toUpperCase() : null;
  const date = typeof j.date === 'string' && DATE_RE.test(j.date) ? j.date : null;
  const merchant = typeof j.merchant === 'string' && j.merchant.trim() ? j.merchant.trim().slice(0, 40) : null;
  const category = categories.some(c => c.id === j.category) ? j.category : null;
  return { amount, currency, date, merchant, category };
}

const ERRORS = {
  401: 'Der OpenRouter-Schlüssel ist ungültig.',
  402: 'Kein Guthaben mehr bei OpenRouter.',
  403: 'OpenRouter hat die Anfrage abgelehnt.',
  429: 'OpenRouter ist gerade überlastet. Bitte später nochmals versuchen.',
};

export async function analyzeReceipt({ apiKey, model, image, mime, categories, baseUrl = 'https://openrouter.ai/api/v1', timeoutMs = 45_000 }) {
  let res;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/julianhintermann-cmd/Quota',
        'X-Title': 'Monatsbudget',
      },
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        temperature: 0,
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt(categories) },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${image.toString('base64')}` } },
          ],
        }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new AiError(504, e.name === 'TimeoutError' ? 'Die KI hat zu lange gebraucht.' : 'OpenRouter ist nicht erreichbar.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = data && data.error && data.error.message ? ` (${String(data.error.message).slice(0, 160)})` : '';
    throw new AiError(502, (ERRORS[res.status] || `OpenRouter meldet Fehler ${res.status}.`) + detail);
  }
  const msg = data && data.choices && data.choices[0] && data.choices[0].message;
  const content = msg && (Array.isArray(msg.content) ? msg.content.map(p => p.text || '').join('') : msg.content);
  return { ...parseAnswer(content, categories), model: data.model || model || DEFAULT_MODEL };
}

// Öffentliche Modellliste, nur Modelle mit Bildeingabe, günstigste zuerst
export async function listVisionModels({ baseUrl = 'https://openrouter.ai/api/v1', timeoutMs = 15_000 } = {}) {
  let res;
  try { res = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(timeoutMs) }); }
  catch { throw new AiError(504, 'OpenRouter ist nicht erreichbar.'); }
  if (!res.ok) throw new AiError(502, `OpenRouter meldet Fehler ${res.status}.`);
  const data = await res.json().catch(() => ({}));
  return (data.data || [])
    .filter(m => ((m.architecture && m.architecture.input_modalities) || []).includes('image'))
    .map(m => ({ id: m.id, name: m.name || m.id, price: Number((m.pricing && m.pricing.prompt) || 0) * 1e6 }))
    .sort((a, b) => a.price - b.price || a.id.localeCompare(b.id))
    .slice(0, 200);
}
