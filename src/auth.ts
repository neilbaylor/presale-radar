/**
 * Accounts: the first person to open the app creates the owner account;
 * everyone else joins with an invite link. Sessions are long-lived cookies
 * so the home-screen app stays signed in.
 */
import { scrypt, randomBytes, timingSafeEqual as nodeEqual } from 'node:crypto';
import type { Ctx } from './types.js';
import { now } from './db.js';
import { hmac, randomToken, sha256, timingSafeEqual } from './util.js';

export const SESSION_COOKIE = 'pr_session';
export const SESSION_DAYS = 400;
const INVITE_DAYS = 7;

// ---------------------------------------------------------------- passwords

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt);
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const key = await scryptAsync(password, Buffer.from(salt, 'base64url'));
  const expected = Buffer.from(hash, 'base64url');
  return key.length === expected.length && nodeEqual(key, expected);
}

export function validateSignup(input: { name?: unknown; email?: unknown; password?: unknown }): { name: string; email: string; password: string } | string {
  const name = String(input.name ?? '').trim().slice(0, 60);
  const email = String(input.email ?? '').trim().toLowerCase().slice(0, 200);
  const password = String(input.password ?? '');
  if (!name) return 'Enter your name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Enter a valid email.';
  if (password.length < 8) return 'Use at least 8 characters for your password.';
  return { name, email, password };
}

// ---------------------------------------------------------------- users

export async function userCount(ctx: Ctx): Promise<number> {
  const r = await ctx.db.one<{ n: number }>('SELECT COUNT(*)::int AS n FROM users');
  return r?.n ?? 0;
}

export async function createUser(ctx: Ctx, input: { name: string; email: string; password: string }, role: 'owner' | 'member'): Promise<number> {
  const row = await ctx.db.one<{ id: number }>(
    `INSERT INTO users (name, email, pw_hash, role, calendar_token, created_at, prefs)
     VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb) RETURNING id`,
    [input.name, input.email, await hashPassword(input.password), role, randomToken(18), now(ctx)],
  );
  return Number(row!.id);
}

export async function login(ctx: Ctx, email: string, password: string): Promise<number | null> {
  const row = await ctx.db.one<{ id: number; pw_hash: string }>('SELECT id, pw_hash FROM users WHERE email = $1', [email.trim().toLowerCase()]);
  if (!row) {
    await hashPassword(password); // same timing whether or not the email exists
    return null;
  }
  return (await verifyPassword(password, row.pw_hash)) ? Number(row.id) : null;
}

// ---------------------------------------------------------------- sessions

export async function createSession(ctx: Ctx, userId: number, userAgent: string | null): Promise<string> {
  const token = randomToken(32);
  const t = now(ctx);
  await ctx.db.query(
    'INSERT INTO sessions (token_hash, user_id, created_at, last_seen, expires_at, user_agent) VALUES ($1,$2,$3,$3,$4,$5)',
    [await sha256(token), userId, t, t + SESSION_DAYS * 86_400_000, userAgent?.slice(0, 200) ?? null],
  );
  return token;
}

/** Look up a session and slide its expiry forward (at most once a day). */
export async function sessionUser(ctx: Ctx, token: string | undefined | null): Promise<number | null> {
  if (!token) return null;
  const hash = await sha256(token);
  const t = now(ctx);
  const row = await ctx.db.one<{ user_id: number; last_seen: number; expires_at: number }>(
    'SELECT user_id, last_seen, expires_at FROM sessions WHERE token_hash = $1',
    [hash],
  );
  if (!row || row.expires_at < t) return null;
  if (t - row.last_seen > 86_400_000) {
    await ctx.db.query('UPDATE sessions SET last_seen = $1, expires_at = $2 WHERE token_hash = $3', [t, t + SESSION_DAYS * 86_400_000, hash]);
  }
  return Number(row.user_id);
}

export async function destroySession(ctx: Ctx, token: string | undefined | null): Promise<void> {
  if (token) await ctx.db.query('DELETE FROM sessions WHERE token_hash = $1', [await sha256(token)]);
}

// ---------------------------------------------------------------- invites

export async function createInvite(ctx: Ctx, createdBy: number, note: string | null): Promise<{ token: string; expiresAt: number }> {
  const token = randomToken(18);
  const t = now(ctx);
  const expiresAt = t + INVITE_DAYS * 86_400_000;
  await ctx.db.query('INSERT INTO invites (token_hash, created_by, note, created_at, expires_at) VALUES ($1,$2,$3,$4,$5)', [
    await sha256(token),
    createdBy,
    note?.slice(0, 80) ?? null,
    t,
    expiresAt,
  ]);
  return { token, expiresAt };
}

export async function checkInvite(ctx: Ctx, token: string): Promise<{ inviter: string } | null> {
  const row = await ctx.db.one<{ name: string }>(
    `SELECT u.name FROM invites i JOIN users u ON u.id = i.created_by
      WHERE i.token_hash = $1 AND i.used_by IS NULL AND i.expires_at > $2`,
    [await sha256(token), now(ctx)],
  );
  return row ? { inviter: row.name } : null;
}

export async function useInvite(ctx: Ctx, token: string, userId: number): Promise<boolean> {
  const rows = await ctx.db.query(
    'UPDATE invites SET used_by = $1, used_at = $2 WHERE token_hash = $3 AND used_by IS NULL AND expires_at > $2 RETURNING token_hash',
    [userId, now(ctx), await sha256(token)],
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------- login throttle

const attempts = new Map<string, { n: number; reset: number }>();

/** At most 10 failed sign-ins per 15 minutes per address. */
export function throttled(key: string, t = Date.now()): boolean {
  const a = attempts.get(key);
  return !!a && a.reset > t && a.n >= 10;
}

export function recordFailure(key: string, t = Date.now()): void {
  const a = attempts.get(key);
  if (!a || a.reset < t) attempts.set(key, { n: 1, reset: t + 15 * 60_000 });
  else a.n++;
}

// ---------------------------------------------------------------- notification buttons

function actionMessage(userId: number, action: string, eventId: string, artistId?: string | null) {
  return `act:${userId}:${action}:${eventId}:${artistId ?? ''}`;
}

/** URL a notification button calls. Signed, so it works without a session cookie. */
export async function actionUrl(ctx: Ctx, userId: number, action: string, eventId: string, artistId?: string | null): Promise<string> {
  const sig = (await hmac(ctx.secret, actionMessage(userId, action, eventId, artistId))).slice(0, 26);
  const qs = new URLSearchParams({ u: String(userId), a: action, e: eventId, s: sig });
  if (artistId) qs.set('x', artistId);
  return `/api/act?${qs}`;
}

export async function verifyAction(ctx: Ctx, userId: number, action: string, eventId: string, artistId: string | null, sig: string): Promise<boolean> {
  const expected = (await hmac(ctx.secret, actionMessage(userId, action, eventId, artistId))).slice(0, 26);
  return timingSafeEqual(expected, sig);
}
