/*
 * Envoi de notifications Web Push depuis le Worker, sans service tiers :
 *  - signature VAPID (JWT ES256, RFC 8292) avec la clé privée du Worker (secret VAPID_PRIVATE_JWK) ;
 *  - chiffrement du contenu pour le téléphone (aes128gcm, RFC 8291).
 * Le contenu est déchiffré par le navigateur du joueur ; le service de push (Google, Apple, Mozilla)
 * ne voit qu'un message chiffré.
 */
const te = new TextEncoder();

export const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const concat = (...a) => { const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of a) { out.set(x, o); o += x.length; } return out; };

async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

/** Chiffre `payload` (texte) pour l'abonnement {keys:{p256dh, auth}} — RFC 8291, un seul enregistrement. */
export async function encryptPayload(sub, payload) {
  const uaPublic = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(te.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const plain = concat(te.encode(payload), new Uint8Array([2])); // 0x02 : dernier enregistrement, sans bourrage
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plain));
  const rs = new Uint8Array([0, 0, 16, 0]); // taille d'enregistrement 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

let vapidCache = null;
/** Clés VAPID du Worker : { priv (CryptoKey), pub (base64url, clé publique brute) }. */
export async function vapidKeys(env) {
  if (vapidCache) return vapidCache;
  if (!env.VAPID_PRIVATE_JWK) throw new Error('VAPID_PRIVATE_JWK manquant');
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const priv = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const pub = b64u(concat(new Uint8Array([4]), unb64u(jwk.x), unb64u(jwk.y)));
  vapidCache = { priv, pub };
  return vapidCache;
}

async function vapidAuth(env, endpoint) {
  const { priv, pub } = await vapidKeys(env);
  const aud = new URL(endpoint).origin;
  const header = b64u(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(te.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'https://traque.jeu-traque.workers.dev/' })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, te.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${pub}`;
}

/**
 * Envoie une notification. Renvoie 'ok', 'gone' (abonnement expiré : à oublier) ou 'error'.
 * `msg` : { title, body, tag }.
 */
export async function sendPush(env, sub, msg, ttl = 900) {
  try {
    const body = await encryptPayload(sub, JSON.stringify(msg));
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: await vapidAuth(env, sub.endpoint),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(ttl),
        Urgency: 'high',
      },
      body,
    });
    if (res.status === 404 || res.status === 410) return 'gone';
    return res.ok ? 'ok' : 'error';
  } catch {
    return 'error';
  }
}

/** Vérifie qu'un abonnement reçu d'un téléphone a la bonne forme (adresse https d'un service de push). */
export function validSub(sub) {
  try {
    if (!sub || typeof sub.endpoint !== 'string' || sub.endpoint.length > 1000) return false;
    const u = new URL(sub.endpoint);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && /^(127\.0\.0\.1|localhost)$/.test(u.hostname))) return false;
    return unb64u(sub.keys.p256dh).length === 65 && unb64u(sub.keys.auth).length === 16;
  } catch { return false; }
}
