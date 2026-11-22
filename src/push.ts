/**
 * Web Push (RFC 8030) with VAPID (RFC 8292) and aes128gcm payload
 * encryption (RFC 8188 / RFC 8291), using only WebCrypto so it runs on Workers.
 */
import type { Config, Ctx, PushMessage } from './types.js';
import { b64urlDecode, b64urlEncode, concat, enc, type Bytes } from './util.js';

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string; // base64url, 65-byte uncompressed P-256 point
  auth: string; // base64url, 16 bytes
}

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, length: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

/** Encrypt a payload for one subscription. `opts` exists for deterministic tests. */
export async function encryptPayload(
  payload: Bytes,
  sub: { p256dh: string; auth: string },
  opts: { salt?: Bytes; localKeys?: CryptoKeyPair } = {},
): Promise<Bytes> {
  const uaPublic = b64urlDecode(sub.p256dh);
  const authSecret = b64urlDecode(sub.auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('Bad subscription keys');

  const localKeys =
    opts.localKeys ??
    ((await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair);
  const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', localKeys.publicKey)) as ArrayBuffer);

  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey } as any, localKeys.privateKey, 256),
  );

  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  // Single record: plaintext followed by the 0x02 "last record" delimiter.
  const padded = concat(payload, new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded));

  const recordSize = 4096;
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, recordSize);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

async function importVapidKey(publicKey: string, privateKey: string): Promise<CryptoKey> {
  const pub = b64urlDecode(publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID_PUBLIC_KEY must be a 65-byte uncompressed P-256 key');
  return crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x: b64urlEncode(pub.slice(1, 33)), y: b64urlEncode(pub.slice(33, 65)), d: privateKey, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

export async function vapidJwt(audience: string, subject: string, publicKey: string, privateKey: string, now = Date.now()): Promise<string> {
  const key = await importVapidKey(publicKey, privateKey);
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64urlEncode(enc.encode(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const unsigned = `${header}.${claims}`;
  // WebCrypto returns the raw r||s signature, which is exactly what JWS ES256 wants.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(unsigned));
  return `${unsigned}.${b64urlEncode(sig)}`;
}

export type SendResult = { ok: true } | { ok: false; gone: boolean; status: number };

export async function sendPush(cfg: Config, sub: PushSubscriptionKeys, message: PushMessage, urgency: 'normal' | 'high' = 'normal'): Promise<SendResult> {
  if (!cfg.vapidPublicKey || !cfg.vapidPrivateKey) throw new Error('VAPID keys are not configured');
  const body = await encryptPayload(enc.encode(JSON.stringify(message)), sub);
  const audience = new URL(sub.endpoint).origin;
  const jwt = await vapidJwt(audience, cfg.vapidSubject, cfg.vapidPublicKey, cfg.vapidPrivateKey);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      TTL: urgency === 'high' ? '900' : '86400',
      Urgency: urgency,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      Authorization: `vapid t=${jwt}, k=${cfg.vapidPublicKey}`,
    },
    body,
  });
  if (res.ok) return { ok: true };
  return { ok: false, gone: res.status === 404 || res.status === 410, status: res.status };
}

export type Sender = (cfg: Config, sub: PushSubscriptionKeys, message: PushMessage, urgency: 'normal' | 'high') => Promise<SendResult>;

/** Swappable so tests and demo mode can capture pushes instead of sending them. */
export const pushTransport: { send: Sender; log: { userId: number; message: PushMessage; urgency: string }[] | null } = {
  send: sendPush,
  log: null,
};

/** Send to every device a user has registered. Drops subscriptions the push service says are gone. */
export async function pushToUser(ctx: Ctx, userId: number, message: PushMessage, urgency: 'normal' | 'high' = 'normal'): Promise<number> {
  pushTransport.log?.push({ userId, message, urgency });
  if (!ctx.cfg.vapidPublicKey || !ctx.cfg.vapidPrivateKey) return 0;
  const subs = await ctx.db.query<PushSubscriptionKeys>('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1', [userId]);
  let delivered = 0;
  for (const sub of subs) {
    try {
      const r = await pushTransport.send(ctx.cfg, sub, message, urgency);
      if (r.ok) {
        delivered++;
        await ctx.db.query('UPDATE push_subscriptions SET failures = 0 WHERE endpoint = $1', [sub.endpoint]);
      } else if (r.gone || (await bumpFailures(ctx, sub.endpoint)) >= 20) {
        await ctx.db.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint]);
      }
    } catch (err) {
      console.error('[push] send failed', err);
    }
  }
  return delivered;
}

async function bumpFailures(ctx: Ctx, endpoint: string): Promise<number> {
  const row = await ctx.db.one<{ failures: number }>(
    'UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = $1 RETURNING failures',
    [endpoint],
  );
  return row?.failures ?? 0;
}
