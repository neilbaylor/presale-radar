/**
 * Venue websites as a source. Most venue sites embed their listings as
 * schema.org Event data (JSON-LD) for search engines, often with the on-sale
 * time; some publish an .ics feed. Either way we can read shows Ticketmaster
 * doesn't sell (Dice, box office, Eventbrite) and on-sale times.
 */
import type { Ctx, NormalizedEvent, NormalizedSale } from './types.js';
import { now } from './db.js';
import { fetchPage } from './codes.js';
import { nameTokens, pickMatch } from './seatgeek.js';
import { fanOut, upsertEvent, type Change } from './sync.js';
import { zonedToUtc } from './textdates.js';
import { sha256, slugify } from './util.js';

export interface PageEvent {
  name: string;
  performers: string[];
  startUtc: number | null;
  localDate: string | null;
  venueName: string | null;
  url: string | null;
  onsaleUtc: number | null;
  soldOut: boolean;
  priceMin: number | null;
}

/** ISO date-time; without an offset it's taken as local time at the venue. */
export function parseIsoLocal(s: string | undefined | null, timeZone: string): { utc: number | null; localDate: string | null } {
  if (!s) return { utc: null, localDate: null };
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?/);
  if (!m) return { utc: null, localDate: null };
  const [, y, mo, d, h, mi, , zone] = m;
  const localDate = `${y}-${mo}-${d}`;
  if (h === undefined) return { utc: zonedToUtc(+y, +mo - 1, +d, 20, 0, timeZone), localDate };
  if (zone) {
    const iso = `${y}-${mo}-${d}T${h}:${mi}:00${zone === 'Z' ? 'Z' : zone.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')}`;
    return { utc: Date.parse(iso), localDate };
  }
  return { utc: zonedToUtc(+y, +mo - 1, +d, +h, +mi, timeZone), localDate };
}

function asArray<T>(v: T | T[] | undefined | null): T[] {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

function typeIs(o: any, re: RegExp): boolean {
  return asArray(o?.['@type']).some((t: any) => re.test(String(t)));
}

/** Every schema.org Event in a page's JSON-LD, however it's nested. */
export function extractJsonLdEvents(html: string, timeZone: string): PageEvent[] {
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const found: any[] = [];
  const visit = (o: any, depth = 0) => {
    if (!o || typeof o !== 'object' || depth > 6) return;
    if (Array.isArray(o)) return o.forEach((x) => visit(x, depth + 1));
    if (typeIs(o, /Event$/) && o.startDate) found.push(o);
    for (const k of ['@graph', 'itemListElement', 'item', 'event', 'events', 'subEvent', 'mainEntity']) if (o[k]) visit(o[k], depth + 1);
  };
  for (const b of blocks) {
    try {
      visit(JSON.parse(b.trim().replace(/^<!--|-->$/g, '')));
    } catch {
      // Some sites ship slightly broken JSON-LD; skip that block.
    }
  }
  return found.map((e) => {
    const start = parseIsoLocal(e.startDate, timeZone);
    const offers = asArray(e.offers).flatMap((o: any) => (typeIs(o, /AggregateOffer/) && o.offers ? asArray(o.offers) : [o]));
    const onsales = offers
      .map((o: any) => parseIsoLocal(o.availabilityStarts ?? o.validFrom, timeZone).utc)
      .filter((x: number | null): x is number => x !== null);
    const prices = offers.map((o: any) => Number(o.lowPrice ?? o.price)).filter((n: number) => Number.isFinite(n) && n > 0);
    const performers = asArray(e.performer).map((p: any) => (typeof p === 'string' ? p : p?.name)).filter(Boolean);
    return {
      name: String(e.name ?? '').trim(),
      performers,
      startUtc: start.utc,
      localDate: start.localDate,
      venueName: asArray(e.location).map((l: any) => (typeof l === 'string' ? l : l?.name))[0] ?? null,
      url: typeof e.url === 'string' ? e.url : null,
      onsaleUtc: onsales.length ? Math.min(...onsales) : null,
      soldOut: offers.some((o: any) => /SoldOut/i.test(String(o.availability ?? ''))),
      priceMin: prices.length ? Math.min(...prices) : null,
    };
  }).filter((e) => e.name && e.localDate);
}

/** Events from an iCalendar (.ics) feed. */
export function extractIcsEvents(text: string, timeZone: string): PageEvent[] {
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  return [...unfolded.matchAll(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/g)].map((m) => {
    const get = (k: string) => m[1].match(new RegExp(`^${k}(?:;[^:\\r\\n]*)?:(.*)$`, 'm'))?.[1]?.trim() ?? null;
    const raw = m[1].match(/^DTSTART(?:;([^:\r\n]*))?:(.*)$/m);
    let startUtc: number | null = null;
    let localDate: string | null = null;
    if (raw) {
      const v = raw[2].trim();
      const tz = raw[1]?.match(/TZID=([^;]+)/)?.[1] ?? timeZone;
      const d = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?/);
      if (d) {
        localDate = `${d[1]}-${d[2]}-${d[3]}`;
        startUtc = d[7]
          ? Date.UTC(+d[1], +d[2] - 1, +d[3], +d[4], +d[5])
          : zonedToUtc(+d[1], +d[2] - 1, +d[3], d[4] ? +d[4] : 20, d[5] ? +d[5] : 0, tz);
        if (d[7]) localDate = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(startUtc));
      }
    }
    const unesc = (s: string | null) => s?.replace(/\\n/g, ' ').replace(/\\([,;\\])/g, '$1') ?? null;
    return {
      name: unesc(get('SUMMARY')) ?? '',
      performers: [],
      startUtc,
      localDate,
      venueName: unesc(get('LOCATION')),
      url: get('URL'),
      onsaleUtc: null,
      soldOut: false,
      priceMin: null,
    };
  }).filter((e) => e.name && e.localDate);
}

export function extractPageEvents(body: string, timeZone: string): PageEvent[] {
  return /BEGIN:VCALENDAR/.test(body) ? extractIcsEvents(body, timeZone) : extractJsonLdEvents(body, timeZone);
}

/** A headline act from an event title like "Glass Harbour with Special Guests" or "Glass Harbour: The Tour". */
export function headlineFrom(e: PageEvent): string {
  if (e.performers.length) return e.performers[0];
  return e.name.split(/\s+(?:with|w\/|feat\.?|ft\.?|\+|presents?)\s+|\s+[-–—:|]\s+/i)[0].trim() || e.name;
}

async function upsertPageEvent(ctx: Ctx, page: { url: string; venue_id: string | null; first: boolean }, e: PageEvent): Promise<{ matched: boolean; changes: Change[] }> {
  const t = now(ctx);
  if (e.startUtc !== null && e.startUtc < t) return { matched: true, changes: [] };
  const candidates = await ctx.db.query<any>(
    `SELECT id, name, venue_id, venue_name, attraction_names FROM events WHERE local_date = $1 AND source <> 'web'`,
    [e.localDate],
  );
  const headline = headlineFrom(e);
  const asSg = { id: '', title: e.name, url: e.url, localDate: e.localDate, startUtc: e.startUtc, venueName: e.venueName ?? '', city: null, performers: [headline, ...e.performers], low: null, count: null };
  if (pickMatch(asSg, candidates, page.venue_id)) return { matched: true, changes: [] };

  const id = `web:${(await sha256(`${page.venue_id ?? e.venueName}|${e.localDate}|${slugify(headline)}`)).slice(0, 16)}`;
  // Credit a followed artist when the headline is clearly them.
  const artistMatch = (await ctx.db.query<{ id: string; name: string }>('SELECT id, name FROM artists')).find(
    (a) => [...(nameTokens(a.name))].join(' ') === [...nameTokens(headline)].join(' '),
  );
  const event: NormalizedEvent = {
    id,
    name: e.name,
    url: e.url ?? page.url,
    image: null,
    localDate: e.localDate,
    localTime: null,
    startUtc: e.startUtc,
    venueId: page.venue_id,
    venueName: e.venueName,
    city: null,
    attractionIds: artistMatch ? [artistMatch.id] : [],
    attractionNames: [artistMatch?.name ?? headline],
    status: e.soldOut ? 'offsale' : 'onsale',
    priceMin: e.priceMin,
    priceMax: null,
    currency: null,
  };
  const sales: NormalizedSale[] =
    e.onsaleUtc && e.onsaleUtc > t - 86_400_000
      ? [{ id: `${id}:public`, eventId: id, kind: 'public', name: 'On-sale', slug: 'public', description: 'From the venue website', url: e.url ?? page.url, startUtc: e.onsaleUtc, endUtc: null, startTbd: false, requirement: 'none' }]
      : [];
  const changes = await upsertEvent(ctx, event, sales, page.first);
  await ctx.db.query(`UPDATE events SET source = 'web' WHERE id = $1`, [id]);
  return { matched: false, changes };
}

export async function checkVenuePages(ctx: Ctx, opts: { force?: boolean; url?: string } = {}): Promise<{ pages: number; found: number; added: number; errors: string[] }> {
  const t = now(ctx);
  const out = { pages: 0, found: 0, added: 0, errors: [] as string[] };
  const pages = await ctx.db.query<{ url: string; venue_id: string | null; last_checked: number | null; fail_count: number }>(
    `SELECT url, venue_id, last_checked, fail_count FROM venue_pages
      WHERE ($1::text IS NULL OR url = $1) AND ($2::boolean OR COALESCE(next_check, 0) <= $3)
      ORDER BY next_check ASC NULLS FIRST LIMIT 15`,
    [opts.url ?? null, !!opts.force, t],
  );
  for (const p of pages) {
    out.pages++;
    try {
      const body = await fetchPage(ctx, p.url, 'venue');
      const events = extractPageEvents(body, ctx.cfg.timeZone);
      const changes: Change[] = [];
      let added = 0;
      for (const e of events) {
        const r = await upsertPageEvent(ctx, { url: p.url, venue_id: p.venue_id, first: p.last_checked === null }, e);
        if (!r.matched) added++;
        changes.push(...r.changes);
      }
      await fanOut(ctx, changes);
      out.found += events.length;
      out.added += added;
      const every = events.length ? 60 : 360; // pages with no event data get checked rarely
      await ctx.db.query(
        `UPDATE venue_pages SET last_checked = $1, last_error = $2, last_found = $3, fail_count = 0, next_check = $4 WHERE url = $5`,
        [t, events.length ? null : 'No event listings found on this page', events.length, t + every * 60_000, p.url],
      );
    } catch (err: any) {
      const fails = p.fail_count + 1;
      out.errors.push(`${p.url}: ${String(err?.message ?? err).slice(0, 100)}`);
      await ctx.db.query(`UPDATE venue_pages SET last_checked = $1, last_error = $2, fail_count = $3, next_check = $4 WHERE url = $5`, [
        t, String(err?.message ?? err).slice(0, 200), fails, t + Math.min(15 * 2 ** fails, 24 * 60) * 60_000, p.url,
      ]);
    }
  }
  return out;
}
