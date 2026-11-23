/** Encrypts small secrets (calendar app passwords) at rest with a key derived from the app secret. */
import type { Ctx } from './types.js';
import { b64urlDecode, b64urlEncode, concat, enc, hmac } from './util.js';

async function key(ctx: Ctx): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(`calendar-secrets:${ctx.secret}`));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(ctx: Ctx, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(ctx), enc.encode(plain)));
  return b64urlEncode(concat(iv, ct));
}

export async function decryptSecret(ctx: Ctx, sealed: string): Promise<string> {
  const bytes = b64urlDecode(sealed);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, await key(ctx), bytes.slice(12));
  return new TextDecoder().decode(pt);
}

/** Signature for links that work without signing in (calendar events, emails). */
export async function linkSig(ctx: Ctx, userId: number, kind: string, id: string): Promise<string> {
  return (await hmac(ctx.secret, `link:${userId}:${kind}:${id}`)).slice(0, 24);
}

export async function linkUrl(ctx: Ctx, base: string, userId: number, kind: 'sale' | 'got' | 'hide', id: string): Promise<string> {
  return `${base}/l/${kind}/${userId}/${encodeURIComponent(id)}/${await linkSig(ctx, userId, kind, id)}`;
}

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * Short, unguessable link for calendar notes ("radar.app/s/k3J9xQ2m").
 * The same user + action + target always gets the same token.
 */
export async function shortLink(ctx: Ctx, base: string, userId: number, kind: 'sale' | 'got' | 'hide', target: string): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const fresh = [...bytes].map((b) => B62[b % 62]).join('');
  const row = await ctx.db.one<{ token: string }>(
    `INSERT INTO short_links (token, user_id, kind, target, created_at) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, kind, target) DO UPDATE SET user_id = excluded.user_id
     RETURNING token`,
    [fresh, userId, kind, target, Date.now()],
  );
  return `${base}/s/${row!.token}`;
}

export async function resolveShortLink(ctx: Ctx, token: string): Promise<{ userId: number; kind: string; target: string } | null> {
  if (!/^[0-9A-Za-z]{6,16}$/.test(token)) return null;
  const row = await ctx.db.one<{ user_id: number; kind: string; target: string }>('SELECT user_id, kind, target FROM short_links WHERE token = $1', [token]);
  return row ? { userId: Number(row.user_id), kind: row.kind, target: row.target } : null;
}
