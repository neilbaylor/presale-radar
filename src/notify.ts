/**
 * The calm notification layer. Everything that happens is written to a user's
 * activity log with a priority; this module decides if and when it becomes a push.
 *
 *   urgent  - pushed immediately, even in quiet hours (sale in 15 min, seats released)
 *   instant - pushed soon, outside quiet hours, at most one push an hour (merged)
 *   digest  - one evening roundup ("Tomorrow: 2 presales · 3 new shows")
 *   silent  - only visible in the app
 */
import type { Ctx, PushMessage, User } from './types.js';
import { getUsers, getUser, now, getFollows, interest, userEventMap } from './db.js';
import { pushToUser } from './push.js';
import { actionUrl } from './auth.js';
import { formatTime } from './util.js';

export type Priority = 'urgent' | 'instant' | 'digest' | 'silent';

export interface Item {
  type: string;
  priority: Priority;
  dedupeKey: string;
  eventId?: string | null;
  saleId?: string | null;
  artistId?: string | null;
  title: string;
  body?: string | null;
  url?: string | null;
}

const HOURLY_CAP_MS = 60 * 60_000;
const INSTANT_MAX_AGE_MS = 18 * 3_600_000;

export function localParts(ms: number, timeZone: string): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms))
    .reduce<Record<string, string>>((acc, p) => ((acc[p.type] = p.value), acc), {});
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 };
}

export function inQuietHours(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start > end ? hour >= start || hour < end : hour >= start && hour < end;
}

/** Record something for a user. Urgent items are pushed right away. Returns false if it was a duplicate. */
export async function enqueue(ctx: Ctx, userId: number, item: Item): Promise<boolean> {
  const url = item.url ?? (item.saleId ? `/#/go/${encodeURIComponent(item.saleId)}` : item.eventId ? `/#/show/${encodeURIComponent(item.eventId)}` : '/#/');
  const rows = await ctx.db.query<{ id: number }>(
    `INSERT INTO activity (user_id, ts, type, priority, dedupe_key, event_id, sale_id, title, body, url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (user_id, dedupe_key) DO NOTHING RETURNING id`,
    [userId, now(ctx), item.type, item.priority, item.dedupeKey, item.eventId ?? null, item.saleId ?? null, item.title, item.body ?? null, url],
  );
  if (!rows.length) return false;
  if (item.priority === 'urgent') {
    await pushToUser(ctx, userId, { title: item.title, body: item.body ?? '', url, tag: item.saleId ?? item.eventId ?? item.type, urgent: true }, 'high');
    await ctx.db.query('UPDATE activity SET pushed_at = $1 WHERE id = $2', [now(ctx), rows[0].id]);
  }
  return true;
}

interface Pending {
  id: number;
  ts: number;
  type: string;
  priority: Priority;
  event_id: string | null;
  sale_id: string | null;
  title: string;
  body: string | null;
  url: string | null;
}

async function markPushed(ctx: Ctx, user: User, ids: number[]) {
  const t = now(ctx);
  if (ids.length) await ctx.db.query('UPDATE activity SET pushed_at = $1 WHERE id = ANY($2::bigint[])', [t, ids]);
  await ctx.db.query('UPDATE users SET last_push_at = $1 WHERE id = $2', [t, user.id]);
}

/** Buttons on a single new-show push: hide it or mute the artist without opening the app. */
async function showActions(ctx: Ctx, userId: number, eventId: string): Promise<PushMessage['actions']> {
  const ev = await ctx.db.one<{ attraction_ids: string[] }>('SELECT attraction_ids FROM events WHERE id = $1', [eventId]);
  const actions = [{ action: 'dismiss', title: 'Not interested', url: await actionUrl(ctx, userId, 'dismiss', eventId) }];
  const artistId = ev?.attraction_ids?.[0];
  if (artistId) actions.push({ action: 'mute', title: 'Mute artist', url: await actionUrl(ctx, userId, 'mute', eventId, artistId) });
  return actions;
}

async function deliverInstant(ctx: Ctx, user: User, t: number): Promise<number> {
  const pending = await ctx.db.query<Pending>(
    `SELECT id, ts, type, priority, event_id, sale_id, title, body, url FROM activity
      WHERE user_id = $1 AND priority = 'instant' AND pushed_at IS NULL AND ts > $2 ORDER BY ts`,
    [user.id, t - INSTANT_MAX_AGE_MS],
  );
  if (!pending.length) return 0;
  if (user.last_push_at && t - user.last_push_at < HOURLY_CAP_MS) return 0;

  let message: PushMessage;
  if (pending.length === 1) {
    const p = pending[0];
    message = {
      title: p.title,
      body: p.body ?? '',
      url: p.url ?? '/#/',
      tag: p.sale_id ?? p.event_id ?? p.type,
      actions: p.type === 'new_show' && p.event_id ? await showActions(ctx, user.id, p.event_id) : undefined,
    };
  } else {
    message = {
      title: `${pending.length} updates`,
      body: pending.slice(0, 4).map((p) => p.title).join('\n') + (pending.length > 4 ? `\n+${pending.length - 4} more` : ''),
      url: '/#/activity',
      tag: 'updates',
    };
  }
  await pushToUser(ctx, user.id, message);
  await markPushed(ctx, user, pending.map((p) => p.id));
  return 1;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Sales you care about that start tomorrow (your local date). */
async function tomorrowsSales(ctx: Ctx, user: User, t: number) {
  const { date: today } = localParts(t, user.prefs.timeZone);
  const rows = await ctx.db.query<{ id: string; name: string; kind: string; start_utc: number; event_id: string; venue_id: string | null; attraction_ids: string[]; attraction_names: string[]; ename: string }>(
    `SELECT s.id, s.name, s.kind, s.start_utc, s.event_id, e.venue_id, e.attraction_ids, e.attraction_names, e.name AS ename
       FROM sales s JOIN events e ON e.id = s.event_id
      WHERE s.removed = FALSE AND s.start_utc BETWEEN $1 AND $2
        AND COALESCE(e.status, '') NOT IN ('canceled', 'postponed')
      ORDER BY s.start_utc`,
    [t, t + 48 * 3_600_000],
  );
  if (!rows.length) return [];
  const [follows, ue] = await Promise.all([getFollows(ctx, user.id), userEventMap(ctx, rows.map((r) => r.event_id))]);
  return rows.filter((r) => {
    const { date } = localParts(r.start_utc, user.prefs.timeZone);
    if (date <= today) return false;
    const diffDays = (Date.parse(date) - Date.parse(today)) / 86_400_000;
    if (diffDays !== 1) return false;
    const u = ue.get(`${user.id}:${r.event_id}`);
    return !u?.got_tickets && interest(r, u, follows).level === 'remind';
  });
}

async function deliverDigest(ctx: Ctx, user: User, t: number, force = false): Promise<number> {
  const { date, hour } = localParts(t, user.prefs.timeZone);
  if (!force && (hour < user.prefs.digestHour || user.last_digest === date)) return 0;
  if (!force && inQuietHours(hour, user.prefs.quietStart, user.prefs.quietEnd)) return 0;

  const items = await ctx.db.query<Pending>(
    `SELECT id, ts, type, priority, event_id, sale_id, title, body, url FROM activity
      WHERE user_id = $1 AND priority IN ('instant', 'digest') AND pushed_at IS NULL ORDER BY ts`,
    [user.id],
  );
  const tomorrow = await tomorrowsSales(ctx, user, t);
  await ctx.db.query('UPDATE users SET last_digest = $1 WHERE id = $2', [date, user.id]);
  if (!items.length && !tomorrow.length) return 0;

  const lines: string[] = [];
  for (const s of tomorrow.slice(0, 3)) {
    const who = s.attraction_names[0] ?? s.ename;
    lines.push(`${formatTime(s.start_utc, user.prefs.timeZone)} · ${who} (${s.kind === 'public' ? 'on-sale' : s.name})`);
  }
  if (tomorrow.length > 3) lines.push(`+${tomorrow.length - 3} more tomorrow`);
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.type, (counts.get(i.type) ?? 0) + 1);
  const summary: string[] = [];
  if (counts.get('new_show')) summary.push(plural(counts.get('new_show')!, 'new show'));
  if (counts.get('new_sale')) summary.push(plural(counts.get('new_sale')!, 'new presale'));
  if (counts.get('code_found')) summary.push(plural(counts.get('code_found')!, 'code found', 'codes found'));
  const other = items.length - (counts.get('new_show') ?? 0) - (counts.get('new_sale') ?? 0) - (counts.get('code_found') ?? 0);
  if (other > 0) summary.push(plural(other, 'other update'));
  if (summary.length) lines.push(summary.join(' · '));
  if (tomorrow.length) lines.push('Sign in to Ticketmaster tonight so you’re ready.');

  await pushToUser(ctx, user.id, {
    title: tomorrow.length ? `Tomorrow: ${plural(tomorrow.length, 'sale')} for you` : 'Your evening roundup',
    body: lines.join('\n'),
    url: tomorrow.length ? '/#/' : '/#/activity',
    tag: 'digest',
  });
  await markPushed(ctx, user, items.map((i) => i.id));
  return 1;
}

/** Called every tick: release instant pushes and evening digests when allowed. */
export async function deliver(ctx: Ctx): Promise<{ instant: number; digests: number }> {
  const t = now(ctx);
  const out = { instant: 0, digests: 0 };
  for (const user of await getUsers(ctx)) {
    const { hour } = localParts(t, user.prefs.timeZone);
    if (inQuietHours(hour, user.prefs.quietStart, user.prefs.quietEnd)) continue;
    out.digests += await deliverDigest(ctx, user, t);
    const fresh = (await getUser(ctx, user.id))!; // digest may have just pushed
    out.instant += await deliverInstant(ctx, fresh, t);
  }
  return out;
}

/** For the "send me a test" button and previewing the digest. */
export async function previewDigest(ctx: Ctx, userId: number): Promise<number> {
  const user = await getUser(ctx, userId);
  return user ? deliverDigest(ctx, user, now(ctx), true) : 0;
}
