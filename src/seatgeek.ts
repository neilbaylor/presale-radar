/**
 * SeatGeek, as a second source:
 *  1. Shows Ticketmaster doesn't sell (AXS, Dice, box office...) still show up,
 *     because SeatGeek lists resale for most events.
 *  2. Resale watch: SeatGeek's event stats include the lowest listed price, so we
 *     can tell you when a sold-out show has seats at or under face value.
 *
 * SeatGeek only exposes the cheapest price and the listing count per event,
 * not individual seats, so an alert means "go look now", not a guarantee.
 */
import type { Ctx, EventRow, NormalizedEvent } from './types.js';
import { getAllFollows, interest, now, userEventMap } from './db.js';
import { upsertEvent, type Change } from './sync.js';
import { enqueue } from './notify.js';
import { demoSeatGeek } from './demo.js';
import { sleep } from './util.js';
import { canSpend, spend } from './budget.js';

const ROOT = 'https://api.seatgeek.com/2/';
let lastCall = 0;

export function seatgeekEnabled(ctx: Ctx): boolean {
  return !!ctx.cfg.seatgeekClientId || ctx.cfg.demo;
}

async function sgGet(ctx: Ctx, path: string, params: Record<string, string | number | undefined>): Promise<any> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v));
  if (ctx.cfg.demo) return demoSeatGeek(path, qs, now(ctx));
  if (!(await canSpend(ctx, 'seatgeek'))) throw new Error('SeatGeek daily budget used up');
  await spend(ctx, 'seatgeek');
  qs.set('client_id', ctx.cfg.seatgeekClientId!);
  const wait = lastCall + 300 - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  const res = await fetch(`${ROOT}${path}?${qs}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`SeatGeek ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------- matching

const STOP = new Set(['the', 'at', 'and', 'with', 'presents', 'tour', 'live', 'in', 'concert', 'of', 'a', 'an', 'world', 'north', 'american', 'tickets']);

export function nameTokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/&/g, ' and ')
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 2 && !STOP.has(w)),
  );
}

/** Overlap coefficient: 1 when the shorter name's words all appear in the longer one. */
export function similarity(a: string, b: string): number {
  const A = nameTokens(a);
  const B = nameTokens(b);
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / Math.min(A.size, B.size);
}

function sgMiles(km: number) {
  return `${Math.max(5, Math.round(km * 0.621))}mi`;
}

export async function lookupVenue(ctx: Ctx, name: string): Promise<string | null> {
  const data = await sgGet(ctx, 'venues', { q: name, lat: ctx.cfg.homeLat, lon: ctx.cfg.homeLon, range: sgMiles(ctx.cfg.radiusKm), per_page: 10 });
  const best = (data?.venues ?? [])
    .map((v: any) => ({ id: String(v.id), score: similarity(name, v.name) }))
    .sort((a: any, b: any) => b.score - a.score)[0];
  return best && best.score >= 0.67 ? best.id : null;
}

export async function lookupPerformer(ctx: Ctx, name: string): Promise<string | null> {
  const data = await sgGet(ctx, 'performers', { q: name, per_page: 10 });
  const list = data?.performers ?? [];
  const exact = list.find((p: any) => [...nameTokens(p.name)].join(' ') === [...nameTokens(name)].join(' '));
  if (exact) return String(exact.id);
  const best = list.map((p: any) => ({ id: String(p.id), score: similarity(name, p.name) })).sort((a: any, b: any) => b.score - a.score)[0];
  return best && best.score >= 0.9 ? best.id : null;
}

export interface SgEvent {
  id: string;
  title: string;
  url: string | null;
  localDate: string | null;
  startUtc: number | null;
  venueName: string;
  city: string | null;
  performers: string[];
  low: number | null;
  count: number | null;
}

export function normalizeSg(e: any): SgEvent {
  const tbd = !!e.datetime_tbd || !!e.date_tbd;
  const stats = e.stats ?? {};
  return {
    id: String(e.id),
    title: e.title ?? e.short_title ?? '',
    url: e.url ?? null,
    localDate: !tbd && e.datetime_local ? String(e.datetime_local).slice(0, 10) : null,
    startUtc: !tbd && e.datetime_utc ? Date.parse(`${String(e.datetime_utc).replace(/Z?$/, '')}Z`) : null,
    venueName: e.venue?.name ?? '',
    city: e.venue?.city ?? null,
    performers: (e.performers ?? []).sort((a: any, b: any) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0)).map((p: any) => p.name),
    low: typeof stats.lowest_price === 'number' ? stats.lowest_price : null,
    count: typeof stats.listing_count === 'number' ? stats.listing_count : null,
  };
}

/**
 * Find the Ticketmaster show a SeatGeek event refers to: same date, same
 * venue, and (when there are several that night) the closest name.
 */
export function pickMatch(
  sg: SgEvent,
  candidates: Pick<EventRow, 'id' | 'name' | 'venue_id' | 'venue_name' | 'attraction_names'>[],
  venueId: string | null,
): string | null {
  const atVenue = venueId ? candidates.filter((c) => c.venue_id === venueId) : candidates.filter((c) => similarity(c.venue_name ?? '', sg.venueName) >= 0.6);
  if (!atVenue.length) return null;
  const scored = atVenue
    .map((c) => {
      const names = [c.name, ...(c.attraction_names ?? [])];
      const perf = Math.max(0, ...sg.performers.flatMap((p) => names.map((n) => similarity(p, n))), ...names.map((n) => similarity(sg.title, n)));
      return { id: c.id, perf };
    })
    .sort((a, b) => b.perf - a.perf);
  if (atVenue.length === 1 && (venueId || scored[0].perf >= 0.5)) return scored[0].id;
  return scored[0].perf >= 0.5 ? scored[0].id : null;
}

// ---------------------------------------------------------------- sync

interface SgSource {
  type: 'venue' | 'artist';
  id: string; // Ticketmaster id
  name: string;
  sg_id: string | null;
  sg_lookup_at: number | null;
  sg_synced: number | null;
}

async function dueSgSources(ctx: Ctx, limit: number): Promise<SgSource[]> {
  const cutoff = now(ctx) - ctx.cfg.syncIntervalMin * 60_000;
  return ctx.db.query<SgSource>(
    `SELECT * FROM (
       SELECT 'venue' AS type, v.id, v.name, v.sg_id, v.sg_lookup_at, v.sg_synced FROM venues v
        WHERE EXISTS (SELECT 1 FROM user_venues uv WHERE uv.venue_id = v.id)
       UNION ALL
       SELECT 'artist' AS type, a.id, a.name, a.sg_id, a.sg_lookup_at, a.sg_synced FROM artists a
        WHERE EXISTS (SELECT 1 FROM user_artists ua WHERE ua.artist_id = a.id AND ua.mode = 'follow')
     ) s
     WHERE (sg_id IS NOT NULL AND (sg_synced IS NULL OR sg_synced < $1))
        OR (sg_id IS NULL AND (sg_lookup_at IS NULL OR sg_lookup_at < $2))
     ORDER BY sg_synced ASC NULLS FIRST LIMIT $3`,
    [cutoff, now(ctx) - 7 * 86_400_000, limit],
  );
}

export async function syncSeatGeek(ctx: Ctx): Promise<{ sources: number; matched: number; added: number; changes: Change[]; errors: string[] }> {
  const out = { sources: 0, matched: 0, added: 0, changes: [] as Change[], errors: [] as string[] };
  if (!seatgeekEnabled(ctx)) return out;
  for (const src of await dueSgSources(ctx, 60)) {
    const table = src.type === 'venue' ? 'venues' : 'artists';
    try {
      let sgId = src.sg_id;
      if (!sgId) {
        sgId = src.type === 'venue' ? await lookupVenue(ctx, src.name) : await lookupPerformer(ctx, src.name);
        await ctx.db.query(`UPDATE ${table} SET sg_id = $1, sg_lookup_at = $2 WHERE id = $3`, [sgId, now(ctx), src.id]);
        if (!sgId) continue;
      }
      const r = await syncOne(ctx, { ...src, sg_id: sgId });
      out.matched += r.matched;
      out.added += r.added;
      out.changes.push(...r.changes);
      out.sources++;
      await ctx.db.query(`UPDATE ${table} SET sg_synced = $1 WHERE id = $2`, [now(ctx), src.id]);
    } catch (err: any) {
      out.errors.push(`${src.name}: ${String(err?.message ?? err).slice(0, 120)}`);
      await ctx.db.query(`UPDATE ${table} SET sg_synced = $1 WHERE id = $2`, [now(ctx), src.id]);
    }
  }
  return out;
}

async function syncOne(ctx: Ctx, src: SgSource & { sg_id: string }) {
  const t = now(ctx);
  const params: Record<string, string | number | undefined> = {
    per_page: 100,
    'datetime_utc.gte': new Date(t).toISOString().slice(0, 19),
    sort: 'datetime_utc.asc',
  };
  if (src.type === 'venue') {
    params['venue.id'] = src.sg_id;
    if (ctx.cfg.musicOnly) params['taxonomies.name'] = 'concert';
  } else {
    params['performers.id'] = src.sg_id;
    Object.assign(params, { lat: ctx.cfg.homeLat, lon: ctx.cfg.homeLon, range: sgMiles(ctx.cfg.radiusKm) });
  }
  const data = await sgGet(ctx, 'events', params);
  const events: SgEvent[] = (data?.events ?? []).map(normalizeSg);
  const followedArtists = await ctx.db.query<{ id: string; name: string }>('SELECT id, name FROM artists');
  const result = { matched: 0, added: 0, changes: [] as Change[] };

  for (const sg of events) {
    if (!sg.localDate) continue;
    const already = await ctx.db.one<{ id: string }>('SELECT id FROM events WHERE sg_id = $1', [sg.id]);
    let tmId = already?.id ?? null;
    if (!tmId) {
      const candidates = await ctx.db.query<EventRow>(
        `SELECT id, name, venue_id, venue_name, attraction_names FROM events WHERE local_date = $1 AND source = 'ticketmaster'`,
        [sg.localDate],
      );
      tmId = pickMatch(sg, candidates, src.type === 'venue' ? src.id : null);
    }
    if (tmId) {
      await ctx.db.query('UPDATE events SET sg_id = $1, sg_url = $2, resale_low = $3, resale_count = $4, resale_at = $5 WHERE id = $6', [
        sg.id, sg.url, sg.low, sg.count, t, tmId,
      ]);
      result.matched++;
      continue;
    }
    // A show Ticketmaster doesn't sell: add it, credited to the venue or artist we searched for.
    const attraction = src.type === 'artist'
      ? { ids: [src.id], names: [src.name, ...sg.performers.filter((p) => similarity(p, src.name) < 1)] }
      : (() => {
          const known = sg.performers.map((p) => followedArtists.find((a) => similarity(a.name, p) === 1)).filter(Boolean) as { id: string; name: string }[];
          return { ids: known.map((k) => k.id), names: sg.performers.length ? sg.performers : [sg.title] };
        })();
    const event: NormalizedEvent = {
      id: `sg:${sg.id}`,
      name: sg.title,
      url: sg.url,
      image: null,
      localDate: sg.localDate,
      localTime: null,
      startUtc: sg.startUtc,
      venueId: src.type === 'venue' ? src.id : null,
      venueName: sg.venueName,
      city: sg.city,
      attractionIds: attraction.ids,
      attractionNames: attraction.names,
      status: 'onsale',
      priceMin: null,
      priceMax: null,
      currency: null,
    };
    const existed = await ctx.db.one('SELECT 1 FROM events WHERE id = $1', [event.id]);
    result.changes.push(...(await upsertEvent(ctx, event, [], src.sg_synced === null)));
    await ctx.db.query(`UPDATE events SET source = 'seatgeek', sg_id = $1, sg_url = $2, resale_low = $3, resale_count = $4, resale_at = $5 WHERE id = $6`, [
      sg.id, sg.url, sg.low, sg.count, t, event.id,
    ]);
    if (!existed) {
      result.added++;
      // On a first (silent) sync, these shows already existed: don't flag them as new to current followers.
      if (src.sg_synced === null) {
        const followers = src.type === 'venue'
          ? 'SELECT user_id FROM user_venues WHERE venue_id = $2'
          : "SELECT user_id FROM user_artists WHERE artist_id = $2 AND mode = 'follow'";
        await ctx.db.query(
          `INSERT INTO user_events (user_id, event_id, seen, updated_at) SELECT f.user_id, $1, TRUE, $3 FROM (${followers}) f
           ON CONFLICT (user_id, event_id) DO UPDATE SET seen = TRUE`,
          [event.id, src.id, t],
        );
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------- resale watch

/** Who's watching resale for a show. Automatic = you get reminders for it and its public on-sale has passed. */
export function isWatching(
  ue: { resale_watch?: boolean | null; got_tickets?: boolean } | undefined,
  level: string,
  publicSaleStarted: boolean,
): boolean {
  if (ue?.got_tickets || ue?.resale_watch === false) return false;
  if (ue?.resale_watch === true) return true;
  return level === 'remind' && publicSaleStarted;
}

/** Whether a new lowest price deserves a ping, given the last price we pinged about. */
export function shouldAlert(low: number | null, target: number | null, lastAlerted: number | null): boolean {
  if (low === null || target === null || low > target) return false;
  if (lastAlerted === null) return true;
  return low <= lastAlerted - Math.max(10, lastAlerted * 0.1);
}

export async function checkResale(ctx: Ctx): Promise<{ refreshed: number; alerts: number }> {
  if (!seatgeekEnabled(ctx)) return { refreshed: 0, alerts: 0 };
  const t = now(ctx);
  const events = await ctx.db.query<EventRow & { public_started: boolean }>(
    `SELECT e.*, EXISTS (SELECT 1 FROM sales s WHERE s.event_id = e.id AND s.kind = 'public' AND s.start_utc < $1) OR e.source = 'seatgeek' AS public_started
       FROM events e
      WHERE e.sg_id IS NOT NULL AND e.start_utc > $1 AND COALESCE(e.status, '') NOT IN ('canceled', 'postponed')`,
    [t],
  );
  if (!events.length) return { refreshed: 0, alerts: 0 };
  const [follows, ue] = await Promise.all([getAllFollows(ctx), userEventMap(ctx, events.map((e) => e.id))]);

  const watchers = new Map<string, number[]>();
  for (const e of events)
    for (const [uid, f] of follows) {
      const state = ue.get(`${uid}:${e.id}`);
      if (isWatching(state, interest(e, state, f).level, e.public_started)) watchers.set(e.id, [...(watchers.get(e.id) ?? []), uid]);
    }

  let refreshed = 0;
  let alerts = 0;
  for (const e of events) {
    const uids = watchers.get(e.id);
    if (!uids?.length) continue;
    // Fresher checks as the show gets close: prices fall in the last couple of days.
    const every = e.start_utc! - t < 48 * 3_600_000 ? 10 : 30;
    if (!e.resale_at || t - e.resale_at >= every * 60_000) {
      if (refreshed >= 40) continue;
      try {
        const sg = normalizeSg(await sgGet(ctx, `events/${e.sg_id}`, {}));
        await ctx.db.query('UPDATE events SET resale_low = $1, resale_count = $2, resale_at = $3, sg_url = COALESCE($4, sg_url) WHERE id = $5', [sg.low, sg.count, t, sg.url, e.id]);
        e.resale_low = sg.low;
        e.resale_count = sg.count;
        refreshed++;
      } catch (err) {
        console.error('[resale]', err);
        continue;
      }
    }
    for (const uid of uids) {
      const state = ue.get(`${uid}:${e.id}`);
      const target = state?.resale_target ?? e.price_min ?? null;
      const last = state?.resale_alerted ?? null;
      const low = e.resale_low ?? null;
      // Price went well back up: allow a fresh alert next time it dips.
      if (last !== null && low !== null && target !== null && low > target * 1.2) {
        await ctx.db.query('UPDATE user_events SET resale_alerted = NULL WHERE user_id = $1 AND event_id = $2', [uid, e.id]);
        continue;
      }
      if (!shouldAlert(low, target, last)) continue;
      const who = e.attraction_names[0] ?? e.name;
      const face = e.price_min ? ` (face from $${Math.round(e.price_min)})` : '';
      const queued = await enqueue(ctx, uid, {
        type: 'resale_deal',
        priority: e.start_utc! - t < 24 * 3_600_000 ? 'urgent' : 'instant',
        dedupeKey: `resale:${e.id}:${Math.round(low!)}`,
        eventId: e.id,
        title: `${who}: resale from $${Math.round(low!)}`,
        body: `${e.venue_name ?? ''}${face} · ${e.resale_count ?? 'a few'} listing${e.resale_count === 1 ? '' : 's'} on SeatGeek. Cheapest seats go fast.`,
        url: `/#/show/${encodeURIComponent(e.id)}`,
      });
      await ctx.db.query(
        `INSERT INTO user_events (user_id, event_id, resale_alerted, updated_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, event_id) DO UPDATE SET resale_alerted = $3`,
        [uid, e.id, low, t],
      );
      if (queued) alerts++;
    }
  }
  return { refreshed, alerts };
}
