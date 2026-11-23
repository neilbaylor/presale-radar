import type { Config, NormalizedEvent, NormalizedSale, Requirement } from './types.js';
import { slugify, sleep } from './util.js';
import { demoFetch } from './demo.js';

const ROOT = 'https://app.ticketmaster.com/discovery/v2/';

/** Ticketmaster allows 5 requests/second; keep a safe gap between calls. */
const MIN_GAP_MS = 230;
let lastCall = 0;
let callsSinceTake = 0;

/** Real Ticketmaster requests made since the last call to this (for the daily budget). */
export function takeTmCalls(): number {
  const n = callsSinceTake;
  callsSinceTake = 0;
  return n;
}

export class TmError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function tmGet(cfg: Config, path: string, params: Record<string, string | number | undefined>): Promise<any> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v));

  if (cfg.demo) return demoFetch(path, qs);
  if (!cfg.tmApiKey) throw new TmError('TM_API_KEY is not set', 0);
  qs.set('apikey', cfg.tmApiKey);

  const wait = lastCall + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  callsSinceTake++;

  let res = await fetch(`${ROOT}${path}?${qs}`, { headers: { accept: 'application/json' } });
  if (res.status === 429) {
    await sleep(1200);
    lastCall = Date.now();
    callsSinceTake++;
    res = await fetch(`${ROOT}${path}?${qs}`, { headers: { accept: 'application/json' } });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new TmError(`Ticketmaster ${res.status}: ${text.slice(0, 200)}`, res.status);
  }
  return res.json();
}

// ---------------------------------------------------------------- geohash

const GH32 = '0123456789bcdefghjkmnpqrstuvwxyz';
export function geohash(lat: number, lon: number, precision = 9): string {
  let latR = [-90, 90];
  let lonR = [-180, 180];
  let hash = '';
  let bit = 0;
  let ch = 0;
  let even = true;
  while (hash.length < precision) {
    const r = even ? lonR : latR;
    const v = even ? lon : lat;
    const mid = (r[0] + r[1]) / 2;
    if (v >= mid) {
      ch = (ch << 1) | 1;
      r[0] = mid;
    } else {
      ch = ch << 1;
      r[1] = mid;
    }
    even = !even;
    if (++bit === 5) {
      hash += GH32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return hash;
}

export function homeParams(cfg: Config) {
  return { geoPoint: geohash(cfg.homeLat, cfg.homeLon, 9), radius: cfg.radiusKm, unit: 'km' };
}

// ---------------------------------------------------------------- events

const PAGE_SIZE = 200;
const MAX_PAGES = 3; // TM deep paging stops at size * page < 1000

export async function fetchEventsForSource(
  cfg: Config,
  source: { type: 'venue' | 'artist'; id: string },
  musicOnly: boolean,
): Promise<any[]> {
  const base: Record<string, string | number | undefined> = {
    size: PAGE_SIZE,
    sort: 'date,asc',
    includeTBA: 'yes',
    includeTBD: 'yes',
  };
  if (source.type === 'venue') {
    base.venueId = source.id;
    if (musicOnly) base.classificationName = 'music';
  } else {
    base.attractionId = source.id;
    Object.assign(base, homeParams(cfg));
  }

  const out: any[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await tmGet(cfg, 'events.json', { ...base, page });
    const items = data?._embedded?.events ?? [];
    out.push(...items);
    const totalPages = data?.page?.totalPages ?? 1;
    if (page + 1 >= totalPages || items.length === 0) break;
  }
  return out;
}

export async function searchVenues(cfg: Config, keyword: string): Promise<any[]> {
  const data = await tmGet(cfg, 'venues.json', { keyword, size: 20, ...homeParams(cfg), sort: 'relevance,desc' });
  return (data?._embedded?.venues ?? []).map(simplifyVenue);
}

export async function popularVenues(cfg: Config): Promise<any[]> {
  const data = await tmGet(cfg, 'venues.json', { size: 200, ...homeParams(cfg) });
  const venues = (data?._embedded?.venues ?? []).map(simplifyVenue);
  return venues.sort((a: any, b: any) => b.upcoming - a.upcoming).slice(0, 16);
}

export async function searchArtists(cfg: Config, keyword: string): Promise<any[]> {
  const data = await tmGet(cfg, 'attractions.json', { keyword, size: 15, classificationName: 'music', sort: 'relevance,desc' });
  return (data?._embedded?.attractions ?? []).map((a: any) => ({
    id: a.id,
    name: a.name,
    image: pickImage(a.images, 300),
    upcoming: a.upcomingEvents?._total ?? 0,
    genre: a.classifications?.[0]?.genre?.name ?? null,
  }));
}

function simplifyVenue(v: any) {
  return {
    id: v.id,
    name: v.name,
    city: v.city?.name ?? null,
    address: v.address?.line1 ?? null,
    upcoming: v.upcomingEvents?._total ?? 0,
  };
}

/**
 * The best real artwork for a phone screen: 16:9, at least `minWidth` wide
 * (sharp on retina), skipping Ticketmaster's generic "fallback" category images.
 */
export function pickImage(images: any[] | undefined, minWidth = 1024): string | null {
  const real = (images ?? []).filter((i) => i?.url && !i.fallback && Number(i.width) > 0);
  if (!real.length) return null;
  const wide = real.filter((i) => i.ratio === '16_9').sort((a, b) => a.width - b.width);
  const pool = wide.length ? wide : [...real].sort((a, b) => a.width - b.width);
  return (pool.find((i) => i.width >= minWidth) ?? pool[pool.length - 1]).url;
}

function toMs(iso: string | undefined | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** Guess what a presale needs, from its name and description. */
export function classifyRequirement(name: string, description?: string | null): Requirement {
  const t = `${name} ${description ?? ''}`.toLowerCase();
  if (/verified fan|registration|register|sign[- ]?up|waitlist/.test(t)) return 'register';
  if (/american express|amex|card ?member|cardholder|mastercard|visa |rbc|scotiabank|td |cibc|bmo|citi|capital one|chase|cash app/.test(t))
    return 'card';
  if (/official platinum|verified resale|vip package/.test(t)) return 'none';
  if (/fan ?club|artist|spotify|live nation|venue|promoter|local|radio|label|album|code|password|ticketmaster presale|member/.test(t))
    return 'code';
  return 'unknown';
}

export function normalizeEvent(e: any): { event: NormalizedEvent; sales: NormalizedSale[] } {
  const venue = e?._embedded?.venues?.[0];
  const attractions: any[] = e?._embedded?.attractions ?? [];
  const price = (e.priceRanges ?? [])[0];
  const event: NormalizedEvent = {
    id: e.id,
    name: e.name,
    url: e.url ?? null,
    image: pickImage(e.images) ?? attractions.map((a) => pickImage(a.images)).find(Boolean) ?? null,
    localDate: e.dates?.start?.localDate ?? null,
    localTime: e.dates?.start?.localTime ?? null,
    startUtc: toMs(e.dates?.start?.dateTime),
    venueId: venue?.id ?? null,
    venueName: venue?.name ?? null,
    city: venue?.city?.name ?? null,
    attractionIds: attractions.map((a) => a.id),
    attractionNames: attractions.map((a) => a.name),
    status: e.dates?.status?.code ?? null,
    priceMin: price?.min ?? null,
    priceMax: price?.max ?? null,
    currency: price?.currency ?? null,
  };

  const sales: NormalizedSale[] = [];
  const seen = new Set<string>();
  for (const p of e.sales?.presales ?? []) {
    if (!p?.name) continue;
    let slug = slugify(p.name);
    // Same-named presales with different windows: keep them distinct.
    if (seen.has(slug)) slug = `${slug}-${toMs(p.startDateTime) ?? seen.size}`;
    seen.add(slug);
    sales.push({
      id: `${e.id}:${slug}`,
      eventId: e.id,
      kind: 'presale',
      name: p.name,
      slug,
      description: p.description ?? null,
      url: p.url ?? null,
      startUtc: toMs(p.startDateTime),
      endUtc: toMs(p.endDateTime),
      startTbd: false,
      requirement: classifyRequirement(p.name, p.description),
    });
  }
  const pub = e.sales?.public;
  if (pub && (pub.startDateTime || pub.startTBD)) {
    sales.push({
      id: `${e.id}:public`,
      eventId: e.id,
      kind: 'public',
      name: 'Public on-sale',
      slug: 'public',
      description: null,
      url: e.url ?? null,
      startUtc: pub.startTBD ? null : toMs(pub.startDateTime),
      endUtc: toMs(pub.endDateTime),
      startTbd: !!pub.startTBD,
      requirement: 'none',
    });
  }
  return { event, sales };
}
