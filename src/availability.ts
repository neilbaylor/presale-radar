/**
 * Sold-out watch. Uses Ticketmaster's Inventory Status API (approval
 * required; set TM_INVENTORY_API_KEY once Ticketmaster grants access).
 * When a sold-out show you care about has tickets again, you get an urgent push.
 */
import type { Ctx } from './types.js';
import { getAllFollows, interest, now, userEventMap } from './db.js';
import { enqueue } from './notify.js';
import { demoAvailability } from './demo.js';
import { sleep } from './util.js';

const AVAILABLE = new Set(['TICKETS_AVAILABLE', 'FEW_TICKETS_LEFT']);
const BATCH = 20;
const MAX_EVENTS_PER_TICK = 100;

export function inventoryEnabled(ctx: Ctx): boolean {
  return !!ctx.cfg.inventoryApiKey || ctx.cfg.demo;
}

async function fetchStatuses(ctx: Ctx, ids: string[]): Promise<Map<string, { status: string; resale: string | null }>> {
  const out = new Map<string, { status: string; resale: string | null }>();
  if (ctx.cfg.demo) {
    for (const id of ids) out.set(id, demoAvailability(id, now(ctx)));
    return out;
  }
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const url = `https://app.ticketmaster.com/inventory-status/v1/availability?events=${chunk.map(encodeURIComponent).join(',')}&apikey=${ctx.cfg.inventoryApiKey}`;
    let res = await fetch(url, { method: 'POST', headers: { accept: 'application/json' } });
    if (res.status === 405) res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`Inventory Status HTTP ${res.status}`);
    const data: any = await res.json();
    const list: any[] = Array.isArray(data) ? data : data?.events ?? data?.items ?? [];
    for (const item of list) {
      const id = item.eventId ?? item.id ?? item.event;
      if (id && item.status) out.set(String(id), { status: String(item.status), resale: item.resaleStatus ?? null });
    }
    await sleep(250);
  }
  return out;
}

/** Shows someone wants reminders for, already past their public on-sale, not bought yet. */
async function watchedEvents(ctx: Ctx): Promise<{ id: string; name: string; attraction_names: string[]; venue_name: string | null; availability: string | null }[]> {
  const t = now(ctx);
  const rows = await ctx.db.query<any>(
    `SELECT e.id, e.name, e.venue_id, e.attraction_ids, e.attraction_names, e.venue_name, e.availability
       FROM events e
      WHERE e.start_utc > $1 AND COALESCE(e.status, '') NOT IN ('canceled', 'postponed')
        AND EXISTS (SELECT 1 FROM sales s WHERE s.event_id = e.id AND s.kind = 'public' AND s.start_utc < $1)
      ORDER BY e.availability = 'TICKETS_NOT_AVAILABLE' DESC NULLS LAST, e.availability_at ASC NULLS FIRST
      LIMIT 500`,
    [t],
  );
  if (!rows.length) return [];
  const [follows, ue] = await Promise.all([getAllFollows(ctx), userEventMap(ctx, rows.map((r: any) => r.id))]);
  return rows
    .filter((e: any) =>
      [...follows.entries()].some(([uid, f]) => {
        const s = ue.get(`${uid}:${e.id}`);
        return !s?.got_tickets && s?.watch_soldout !== false && interest(e, s, f).level === 'remind';
      }),
    )
    .slice(0, MAX_EVENTS_PER_TICK);
}

export async function checkAvailability(ctx: Ctx): Promise<{ checked: number; released: number }> {
  if (!inventoryEnabled(ctx)) return { checked: 0, released: 0 };
  const events = await watchedEvents(ctx);
  if (!events.length) return { checked: 0, released: 0 };
  const statuses = await fetchStatuses(ctx, events.map((e) => e.id));
  const t = now(ctx);
  const released: typeof events = [];
  for (const e of events) {
    const s = statuses.get(e.id);
    if (!s) continue;
    if (e.availability === 'TICKETS_NOT_AVAILABLE' && AVAILABLE.has(s.status)) released.push(e);
    await ctx.db.query('UPDATE events SET availability = $1, resale_status = $2, availability_at = $3 WHERE id = $4', [s.status, s.resale, t, e.id]);
  }
  if (released.length) await notifyReleased(ctx, released.map((e) => ({ ...e, status: statuses.get(e.id)!.status })));
  return { checked: statuses.size, released: released.length };
}

async function notifyReleased(ctx: Ctx, events: { id: string; name: string; attraction_names: string[]; venue_name: string | null; status: string }[]) {
  const t = now(ctx);
  const window = Math.floor(t / (3 * 3_600_000)); // at most one "tickets back" per show every 3 hours
  const follows = await getAllFollows(ctx);
  const ue = await userEventMap(ctx, events.map((e) => e.id));
  const full = await ctx.db.query<any>('SELECT id, venue_id, attraction_ids FROM events WHERE id = ANY($1::text[])', [events.map((e) => e.id)]);
  for (const e of events) {
    const row = full.find((r: any) => r.id === e.id);
    for (const [uid, f] of follows) {
      const s = ue.get(`${uid}:${e.id}`);
      if (s?.got_tickets || s?.watch_soldout === false || interest(row, s, f).level !== 'remind') continue;
      await enqueue(ctx, uid, {
        type: 'tickets_back',
        priority: 'urgent',
        dedupeKey: `back:${e.id}:${window}`,
        eventId: e.id,
        title: `Tickets back: ${e.attraction_names[0] ?? e.name}`,
        body: `${e.venue_name ?? ''} · ${e.status === 'FEW_TICKETS_LEFT' ? 'A few just opened up' : 'Seats were released'}. Move fast.`,
        url: `/#/show/${encodeURIComponent(e.id)}`,
      });
    }
  }
}
