// Web Push ohne zusätzliche Pakete: VAPID (RFC 8292) und verschlüsselte Nachrichten (RFC 8291, aes128gcm).
// Der Server schickt die Nachricht an den Push-Dienst des Browsers (Apple, Google, Mozilla, Microsoft),
// dieser stellt sie dem Gerät zu. Ein Entwicklerkonto braucht es dafür nicht.
import { createECDH, createPrivateKey, generateKeyPairSync, sign, randomBytes, createCipheriv, hkdfSync } from 'node:crypto';

// Nur an bekannte Push-Dienste senden (sonst könnte ein Konto den Server beliebige Adressen aufrufen lassen)
const PUSH_HOSTS = [
  /^web\.push\.apple\.com$/, /\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/,
];
export function okEndpoint(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password && PUSH_HOSTS.some(r => r.test(u.hostname));
  } catch { return false; }
}

// Schlüsselpaar des Servers: einmal erzeugen und in der Datenbank behalten
export function loadVapid(db) {
  let priv = db.getConfig('vapid_private'), pub = db.getConfig('vapid_public');
  if (!priv || !pub) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' });
    priv = privateKey.export({ format: 'pem', type: 'pkcs8' });
    pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
    db.setConfig('vapid_private', priv);
    db.setConfig('vapid_public', pub);
  }
  return { privateKey: createPrivateKey(priv), publicKey: pub };
}

const b64u = v => Buffer.from(v).toString('base64url');
export function vapidJwt(endpoint, vapid, subject, now = Date.now()) {
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key: vapid.privateKey, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${b64u(sig)}`;
}

// Nachricht für ein Gerät verschlüsseln (ein einziger Datensatz, rs = 4096)
export function encrypt(payload, keys, { salt = randomBytes(16), local = null } = {}) {
  const uaPublic = Buffer.from(keys.p256dh, 'base64url');
  const authSecret = Buffer.from(keys.auth, 'base64url');
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16) throw new Error('Ungültige Schlüssel des Geräts');
  const ecdh = local || createECDH('prime256v1');
  if (!local) ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const plain = Buffer.concat([Buffer.from(payload), Buffer.from([2])]); // 0x02 = letzter Datensatz
  if (plain.length + 16 > 4096) throw new Error('Nachricht zu lang');
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const data = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  const head = Buffer.alloc(21);
  salt.copy(head, 0);
  head.writeUInt32BE(4096, 16);
  head[20] = asPublic.length;
  return Buffer.concat([head, asPublic, data]);
}

// Gibt den HTTP-Status des Push-Dienstes zurück (201 = angenommen, 404/410 = Abo gibt es nicht mehr)
export async function sendPush(sub, message, { vapid, subject, ttl = 24 * 3600, urgency = 'normal', topic = null, fetchImpl = fetch }) {
  const body = encrypt(JSON.stringify(message), sub);
  const headers = {
    'Content-Type': 'application/octet-stream', 'Content-Encoding': 'aes128gcm', TTL: String(ttl), Urgency: urgency,
    Authorization: `vapid t=${vapidJwt(sub.endpoint, vapid, subject)}, k=${vapid.publicKey}`,
  };
  if (topic) headers.Topic = topic;
  const res = await fetchImpl(sub.endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
  await res.arrayBuffer().catch(() => null);
  return res.status;
}
