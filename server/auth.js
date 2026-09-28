import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';

const N = 16384, R = 8, P = 1, KEYLEN = 32;

const scryptAsync = (pw, salt, n, r, p) => new Promise((resolve, reject) => {
  scrypt(pw, salt, KEYLEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
});

export async function hashPassword(pw) {
  const salt = randomBytes(16);
  const key = await scryptAsync(pw, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64');
  const key = await scryptAsync(pw, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p));
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// Für unbekannte Benutzernamen trotzdem rechnen, damit die Antwortzeit nichts verrät
let dummyHash = null;
export async function burnTime(pw) {
  dummyHash ||= await hashPassword('dummy-password');
  await verifyPassword(pw, dummyHash);
}

export const newToken = () => randomBytes(32).toString('base64url');
export const hashToken = token => createHash('sha256').update(token).digest('hex');

export const USERNAME_RE = /^[\p{L}\p{N}._-]{3,32}$/u;
export function checkUsername(name) {
  if (typeof name !== 'string' || !USERNAME_RE.test(name.trim())) {
    return 'Benutzername: 3–32 Zeichen, nur Buchstaben, Zahlen, Punkt, Binde- und Unterstrich.';
  }
  return null;
}
export function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Das Passwort braucht mindestens 8 Zeichen.';
  if (pw.length > 200) return 'Das Passwort ist zu lang.';
  return null;
}

// Einfache Sperre gegen Passwort-Raten: zu viele Fehlversuche pro Schlüssel im Zeitfenster
export class RateLimiter {
  constructor({ max, windowMs }) { this.max = max; this.windowMs = windowMs; this.hits = new Map(); }
  blocked(key, now = Date.now()) {
    const h = this.hits.get(key);
    if (!h || h.reset <= now) return 0;
    return h.count >= this.max ? Math.ceil((h.reset - now) / 1000) : 0;
  }
  fail(key, now = Date.now()) {
    const h = this.hits.get(key);
    if (!h || h.reset <= now) this.hits.set(key, { count: 1, reset: now + this.windowMs });
    else h.count++;
  }
  clear(key) { this.hits.delete(key); }
  prune(now = Date.now()) { for (const [k, h] of this.hits) if (h.reset <= now) this.hits.delete(k); }
}
