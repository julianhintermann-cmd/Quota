// Passkeys (WebAuthn): Face ID, Touch ID, Windows Hello, Android-Fingerabdruck …
// Der Browser liefert bei der Registrierung den öffentlichen Schlüssel direkt als SPKI
// (response.getPublicKey()); beim Anmelden prüfen wir die Signatur damit. Keine Fremdpakete nötig.
import { createHash, createPublicKey, verify, randomBytes, timingSafeEqual } from 'node:crypto';

export const ALGS = { ES256: -7, RS256: -257, EdDSA: -8 };
const sha256 = buf => createHash('sha256').update(buf).digest();
const b64u = s => Buffer.from(String(s || ''), 'base64url');

export const newChallenge = () => randomBytes(32).toString('base64url');

export class WebAuthnError extends Error {}

function parseAuthData(buf) {
  if (buf.length < 37) throw new WebAuthnError('Authenticator-Daten unvollständig.');
  const flags = buf[32];
  return { rpIdHash: buf.subarray(0, 32), up: !!(flags & 0x01), uv: !!(flags & 0x04), signCount: buf.readUInt32BE(33) };
}

function checkClientData(clientDataJSON, type, { challenge, origin }) {
  let cd;
  try { cd = JSON.parse(b64u(clientDataJSON).toString('utf8')); } catch { throw new WebAuthnError('Ungültige Client-Daten.'); }
  if (cd.type !== type) throw new WebAuthnError('Falscher Vorgang.');
  const got = b64u(cd.challenge), want = b64u(challenge);
  if (!got.length || got.length !== want.length || !timingSafeEqual(got, want)) throw new WebAuthnError('Challenge stimmt nicht.');
  if (cd.origin !== origin) throw new WebAuthnError(`Herkunft stimmt nicht (${cd.origin}).`);
}

function checkAuthData(ad, rpId) {
  if (!timingSafeEqual(ad.rpIdHash, sha256(rpId))) throw new WebAuthnError('Passkey gehört zu einer anderen Adresse.');
  if (!ad.up || !ad.uv) throw new WebAuthnError('Gerät hat die Person nicht bestätigt (Face ID/PIN).');
}

function keyFor(spkiB64, alg) {
  const key = createPublicKey({ key: Buffer.from(spkiB64, 'base64'), format: 'der', type: 'spki' });
  const ok = (alg === ALGS.ES256 && key.asymmetricKeyType === 'ec')
    || (alg === ALGS.RS256 && key.asymmetricKeyType === 'rsa')
    || (alg === ALGS.EdDSA && key.asymmetricKeyType === 'ed25519');
  if (!ok) throw new WebAuthnError('Schlüsseltyp wird nicht unterstützt.');
  return key;
}

// Registrierung: gibt den zu speichernden Schlüssel zurück
export function verifyRegistration(body, { challenge, origin, rpId }) {
  if (!body || typeof body.id !== 'string' || !/^[A-Za-z0-9_-]{16,1024}$/.test(body.id)) throw new WebAuthnError('Ungültige Passkey-ID.');
  checkClientData(body.clientDataJSON, 'webauthn.create', { challenge, origin });
  const ad = parseAuthData(b64u(body.authenticatorData));
  checkAuthData(ad, rpId);
  const alg = Number(body.alg);
  if (!Object.values(ALGS).includes(alg)) throw new WebAuthnError('Algorithmus wird nicht unterstützt.');
  const spki = b64u(body.publicKey);
  if (spki.length < 32 || spki.length > 2048) throw new WebAuthnError('Ungültiger Schlüssel.');
  const publicKey = spki.toString('base64');
  keyFor(publicKey, alg); // wirft, wenn der Schlüssel nicht passt
  return { id: body.id, publicKey, alg, signCount: ad.signCount };
}

// Anmeldung: prüft Signatur und Zähler, gibt den neuen Zählerstand zurück
export function verifyAssertion(body, stored, { challenge, origin, rpId }) {
  checkClientData(body.clientDataJSON, 'webauthn.get', { challenge, origin });
  const authData = b64u(body.authenticatorData);
  const ad = parseAuthData(authData);
  checkAuthData(ad, rpId);
  const data = Buffer.concat([authData, sha256(b64u(body.clientDataJSON))]);
  const key = keyFor(stored.public_key, stored.alg);
  const ok = verify(stored.alg === ALGS.EdDSA ? null : 'sha256', data, key, b64u(body.signature));
  if (!ok) throw new WebAuthnError('Signatur ungültig.');
  // Zähler: nur prüfen, wenn das Gerät einen führt (Apple-Passkeys melden immer 0)
  if ((ad.signCount || stored.sign_count) && ad.signCount <= stored.sign_count) throw new WebAuthnError('Passkey wurde möglicherweise kopiert.');
  return { signCount: ad.signCount };
}

// Einmalige Challenges mit Ablaufzeit (im Speicher)
export class ChallengeStore {
  constructor(ttlMs = 5 * 60 * 1000) { this.ttl = ttlMs; this.map = new Map(); }
  issue(data) {
    this.prune();
    const c = newChallenge();
    this.map.set(c, { ...data, exp: Date.now() + this.ttl });
    return c;
  }
  take(challenge) {
    const v = this.map.get(challenge);
    this.map.delete(challenge);
    return v && v.exp > Date.now() ? v : null;
  }
  prune() { const now = Date.now(); for (const [k, v] of this.map) if (v.exp <= now) this.map.delete(k); }
}

// Liest die Challenge aus clientDataJSON, damit wir die passende gespeicherte finden
export function challengeOf(clientDataJSON) {
  try { return JSON.parse(b64u(clientDataJSON).toString('utf8')).challenge || null; } catch { return null; }
}
