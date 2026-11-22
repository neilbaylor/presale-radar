/**
 * Pulls shows from Ticketmaster, stores them once (shared by everyone),
 * works out what changed, and fans each change out to the people who care,
 * at a priority that matches how much they care.
 */
import type { Ctx, EventRow, NormalizedEvent, NormalizedSale, SaleRow, Source } from './types.js';
import { fetchEventsForSource, normalizeEvent, TmError } from './tm.js';
import { getAllFollows, interest, markSourceSynced, now, userEventMap, type Follows } from './db.js';
import { enqueue, type Priority } from './notify.js';
import { formatDate, formatWhen } from './util.js';

const NOTABLE_STATUS = new Set(['canceled', 'postponed', 'rescheduled']);
const STATUS_LABEL: Record<string, string> = { canceled: 'Cancelled', postponed: 'Postponed', rescheduled: 'Rescheduled' };

export function headliner(e: { attractionNames?: string[]; attraction_names?: string[]; name: string }): string {
  return (e.attractionNames ?? e.attraction_names ?? [])[0] ?? e.name;
}

export type Change =
  | { type: 'new_show'; event: NormalizedEvent; sales: NormalizedSale[] }
  | { type: 'new_sale'; event: NormalizedEvent; sale: NormalizedSale }
  | { type: 'time_change'; event: NormalizedEvent; sale: NormalizedSale; oldStart: number }
  | { type: 'status_change'; event: NormalizedEvent; status: string };

/** Insert or update one event and its sales; return what changed. */
export async function upsertEvent(ctx: Ctx, event: NormalizedEvent, sales: NormalizedSale[], silent: boolean): Promise<Change[]> {
  const t = now(ctx);
  return ctx.db.tx(async (db) => {
    const existing = await db.one<EventRow>('SELECT status FROM events WHERE id = $1', [event.id]);
    await db.query(
      `INSERT INTO events (id, name, url, image, local_date, local_time, start_utc, venue_id, venue_name, city,
                           attraction_ids, attraction_names, status, price_min, price_max, currency, first_seen, last_seen)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)
       ON CONFLICT (id) DO UPDATE SET
         name = excluded.name, url = excluded.url, image = COALESCE(excluded.image, events.image),
         local_date = excluded.local_date, local_time = excluded.local_time, start_utc = excluded.start_utc,
         venue_id = excluded.venue_id, venue_name = excluded.venue_name, city = excluded.city,
         attraction_ids = excluded.attraction_ids, attraction_names = excluded.attraction_names,
         status = excluded.status, price_min = excluded.price_min, price_max = excluded.price_max,
         currency = excluded.currency, last_seen = excluded.last_seen`,
      [
        event.id, event.name, event.url, event.image, event.localDate, event.localTime, event.startUtc,
        event.venueId, event.venueName, event.city, event.attractionIds, event.attractionNames,
        event.status, event.priceMin, event.priceMax, event.currency, t,
      ],
    );

    const changes: Change[] = [];
    const upcoming = event.startUtc === null || event.startUtc > t;
    if (!existing && !silent && upcoming) changes.push({ type: 'new_show', event, sales });
    if (existing && !silent && upcoming && event.status && event.status !== existing.status && NOTABLE_STATUS.has(event.status))
      changes.push({ type: 'status_change', event, status: event.status });

    const old = new Map((await db.query<SaleRow>('SELECT * FROM sales WHERE event_id = $1', [event.id])).map((s) => [s.id, s]));
    for (const s of sales) {
      const prev = old.get(s.id);
      await db.query(
        `INSERT INTO sales (id, event_id, kind, name, description, url, start_utc, end_utc, start_tbd, requirement, removed)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,FALSE)
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name, description = excluded.description, url = excluded.url,
           start_utc = excluded.start_utc, end_utc = excluded.end_utc, start_tbd = excluded.start_tbd,
           requirement = excluded.requirement, removed = FALSE`,
        [s.id, s.eventId, s.kind, s.name, s.description, s.url, s.startUtc, s.endUtc, s.startTbd, s.requirement],
      );
      const future = s.startUtc !== null && s.startUtc > t;
      if (!existing || silent || !future) continue;
      if (!prev || prev.removed) changes.push({ type: 'new_sale', event, sale: s });
      else if (prev.start_utc !== null && Math.abs(prev.start_utc - s.startUtc!) > 60_000)
        changes.push({ type: 'time_change', event, sale: s, oldStart: prev.start_utc });
    }
    // Presales Ticketmaster stopped listing. Only trust that while it still lists some sales.
    if (sales.length) {
      const keep = new Set(sales.map((s) => s.id));
      const gone = [...old.values()].filter((s) => !keep.has(s.id) && !s.removed).map((s) => s.id);
      if (gone.length) await db.query('UPDATE sales SET removed = TRUE WHERE id = ANY($1::text[])', [gone]);
    }
    return changes;
  });
}

/**
 * Decide, per person, whether a change is worth a push now, in the evening
 * digest, or only in the app.
 */
export function priorityFor(change: Change, level: 'remind' | 'feed', gotTickets: boolean, t: number): Priority | null {
  if (gotTickets) return change.type === 'status_change' ? 'instant' : null;
  switch (change.type) {
    case 'new_show':
      return level === 'remind' ? 'instant' : 'digest';
    case 'new_sale': {
      const soon = change.sale.startUtc! - t < 72 * 3_600_000;
      return level === 'remind' ? (soon ? 'instant' : 'digest') : 'digest';
    }
    case 'time_change': {
      if (level !== 'remind') return 'silent';
      return change.sale.startUtc! - t < 24 * 3_600_000 ? 'urgent' : 'instant';
    }
    case 'status_change':
      return level === 'remind' ? 'instant' : 'digest';
  }
}

function describe(change: Change, tz: string, t: number): { title: string; body: string; dedupe: string; saleId?: string } {
  const e = change.event;
  const who = headliner(e);
  const where = e.venueName ?? 'a venue near you';
  switch (change.type) {
    case 'new_show': {
      const next = change.sales.filter((s) => s.startUtc && s.startUtc > t).sort((a, b) => a.startUtc! - b.startUtc!)[0];
      const when = next ? `${next.kind === 'public' ? 'On sale' : next.name} ${formatWhen(next.startUtc!, tz)}.` : 'Tickets on sale now.';
      return { title: `New show: ${who} at ${where}`, body: `${formatDate(e.localDate)}. ${when}`, dedupe: `new_show:${e.id}` };
    }
    case 'new_sale':
      return {
        title: change.sale.kind === 'public' ? `On-sale date set: ${who}` : `New presale: ${who}`,
        body: `${change.sale.kind === 'public' ? 'Public on-sale' : change.sale.name} ${formatWhen(change.sale.startUtc!, tz)} · ${where}`,
        dedupe: `new_sale:${change.sale.id}`,
        saleId: change.sale.id,
      };
    case 'time_change':
      return {
        title: `Time changed: ${who} ${change.sale.kind === 'public' ? 'on-sale' : change.sale.name}`,
        body: `Now ${formatWhen(change.sale.startUtc!, tz)} (was ${formatWhen(change.oldStart, tz)}) · ${where}`,
        dedupe: `time:${change.sale.id}:${change.sale.startUtc}`,
        saleId: change.sale.id,
      };
    case 'status_change':
      return {
        title: `${STATUS_LABEL[change.status]}: ${who}`,
        body: `${where}, ${formatDate(e.localDate)}.`,
        dedupe: `status:${e.id}:${change.status}:${e.localDate}`,
      };
  }
}

export async function fanOut(ctx: Ctx, changes: Change[], follows?: Map<number, Follows>): Promise<number> {
  if (!changes.length) return 0;
  const t = now(ctx);
  const all = follows ?? (await getAllFollows(ctx));
  const users = await ctx.db.query<{ id: number; prefs: any }>('SELECT id, prefs FROM users');
  const ue = await userEventMap(ctx, [...new Set(changes.map((c) => c.event.id))]);
  let queued = 0;
  for (const u of users) {
    const id = Number(u.id);
    const f = all.get(id);
    if (!f) continue;
    const tz = u.prefs?.timeZone || ctx.cfg.timeZone;
    for (const c of changes) {
      const state = ue.get(`${id}:${c.event.id}`);
      const { level } = interest({ venue_id: c.event.venueId, attraction_ids: c.event.attractionIds }, state, f);
      if (level === 'hidden') continue;
      const priority = priorityFor(c, level, !!state?.got_tickets, t);
      if (!priority) continue;
      const d = describe(c, tz, t);
      if (
        await enqueue(ctx, id, {
          type: c.type,
          priority,
          dedupeKey: d.dedupe,
          eventId: c.event.id,
          saleId: d.saleId,
          artistId: c.event.attractionIds[0] ?? null,
          title: d.title,
          body: d.body,
        })
      )
        queued++;
    }
  }
  return queued;
}

export interface SyncResult {
  source: string;
  events: number;
  changes: Change[];
  error?: string;
}

export async function syncSource(ctx: Ctx, source: Source): Promise<SyncResult> {
  const label = `${source.type}:${source.name}`;
  try {
    const raw = await fetchEventsForSource(ctx.cfg, source, ctx.cfg.musicOnly);
    const changes: Change[] = [];
    let count = 0;
    for (const item of raw) {
      if (!item?.id || !item?.name) continue;
      const { event, sales } = normalizeEvent(item);
      changes.push(...(await upsertEvent(ctx, event, sales, source.lastSynced === null)));
      count++;
    }
    await markSourceSynced(ctx, source, null);
    return { source: label, events: count, changes };
  } catch (err: any) {
    const message = String(err?.message ?? err);
    await markSourceSynced(ctx, source, message.slice(0, 300));
    if (err instanceof TmError && (err.status === 401 || err.status === 0)) throw err; // bad or missing key: stop the run
    return { source: label, events: 0, changes: [], error: message };
  }
}
