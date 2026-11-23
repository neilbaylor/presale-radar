/**
 * Demo mode (DEMO=1): fake Ticketmaster responses so you can try the app
 * before you have an API key. Artists are invented; venues are real Toronto rooms
 * with made-up ids.
 */

const DAY = 86_400_000;
const HOUR = 3_600_000;

const VENUES = [
  { id: 'demo-v-sba', name: 'Scotiabank Arena', upcoming: 61 },
  { id: 'demo-v-bud', name: 'Budweiser Stage', upcoming: 44 },
  { id: 'demo-v-mas', name: 'Massey Hall', upcoming: 52 },
  { id: 'demo-v-his', name: 'History', upcoming: 38 },
  { id: 'demo-v-dan', name: 'Danforth Music Hall', upcoming: 35 },
  { id: 'demo-v-coc', name: 'Coca-Cola Coliseum', upcoming: 27 },
  { id: 'demo-v-reb', name: 'Rebel', upcoming: 22 },
  { id: 'demo-v-mer', name: 'Meridian Hall', upcoming: 19 },
  { id: 'demo-v-rog', name: 'Rogers Centre', upcoming: 9 },
  { id: 'demo-v-opr', name: 'The Opera House', upcoming: 24 },
];

const ARTISTS = [
  { id: 'demo-a-glass', name: 'Glass Harbour', genre: 'Indie' },
  { id: 'demo-a-maple', name: 'Maple Static', genre: 'Rock' },
  { id: 'demo-a-june', name: 'June Fireflies', genre: 'Pop' },
  { id: 'demo-a-velvet', name: 'Velvet Transit', genre: 'R&B' },
  { id: 'demo-a-lake', name: 'Lake Effect', genre: 'Alternative' },
  { id: 'demo-a-copper', name: 'Copper Tides', genre: 'Folk' },
  { id: 'demo-a-arcade', name: 'Northern Arcade', genre: 'Electronic' },
  { id: 'demo-a-paper', name: 'Paper Satellites', genre: 'Indie' },
];

const PRESALE_KINDS = [
  { name: 'Artist Presale', description: 'Sign up on the artist website to receive a code.' },
  { name: 'Live Nation Presale', description: 'Use the Live Nation presale code.' },
  { name: 'American Express Presale', description: 'Use your American Express card. No code needed.' },
  { name: 'Spotify Presale', description: 'Spotify will email selected fans a code.' },
  { name: 'Verified Fan Presale', description: 'Registration required. Registration closes before the presale.' },
  { name: 'Venue Presale', description: 'Venue newsletter subscribers get the code by email.' },
];

function h(s: string): number {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619);
  return x >>> 0;
}

function iso(ms: number) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function buildEvent(venueIdx: number, n: number, now: number) {
  const v = VENUES[venueIdx];
  const seed = h(`${v.id}:${n}`);
  const artist = ARTISTS[seed % ARTISTS.length];
  const anchor = Math.floor(now / DAY) * DAY + 15 * HOUR; // 10am Toronto-ish
  const announceDay = (seed >> 3) % 6; // some shows "appear" during the week
  if (n === 3 && (now - anchor) / DAY < announceDay - 3) return null;

  const saleDay = ((seed >> 5) % 9) + (n === 0 ? 0 : 1);
  const publicStart = anchor + saleDay * DAY;
  const showStart = publicStart + (30 + ((seed >> 7) % 150)) * DAY + 9 * HOUR;
  const presaleCount = 1 + ((seed >> 9) % 3);
  const presales: { name: string; description: string; url: string; startDateTime: string; endDateTime: string }[] = [];
  for (let i = 0; i < presaleCount; i++) {
    const kind = PRESALE_KINDS[(seed >> (11 + i * 3)) % PRESALE_KINDS.length];
    if (presales.some((p) => p.name === kind.name)) continue;
    const start = publicStart - (i + 1) * DAY;
    presales.push({ name: kind.name, description: kind.description, url: 'https://www.ticketmaster.ca/', startDateTime: iso(start), endDateTime: iso(publicStart - HOUR * 2) });
  }
  const local = new Date(showStart - 5 * HOUR);
  return {
    id: `demo-e-${v.id.slice(7)}-${n}`,
    name: `${artist.name}${n % 2 ? ' — North American Tour' : ''}`,
    type: 'event',
    url: 'https://www.ticketmaster.ca/',
    // Demo art for most artists (two have none, to show the initials fallback).
    images: ARTISTS.indexOf(artist) < 6 ? [{ ratio: '16_9', width: 1280, height: 720, url: `/demo-art/${ARTISTS.indexOf(artist) + 1}.jpg`, fallback: false }] : [],
    dates: {
      start: { localDate: local.toISOString().slice(0, 10), localTime: '19:30:00', dateTime: iso(showStart) },
      status: { code: n === 2 && seed % 7 === 0 ? 'postponed' : 'onsale' },
      timezone: 'America/Toronto',
    },
    sales: { public: { startDateTime: iso(publicStart), startTBD: false }, presales },
    priceRanges: [{ type: 'standard', currency: 'CAD', min: 45 + (seed % 60), max: 120 + (seed % 200) }],
    _embedded: {
      venues: [{ id: v.id, name: v.name, city: { name: 'Toronto' } }],
      attractions: [{ id: artist.id, name: artist.name }],
    },
  };
}

function allEvents(now: number) {
  const out: any[] = [];
  VENUES.forEach((_, vi) => {
    for (let n = 0; n < 4; n++) {
      const e = buildEvent(vi, n, now);
      if (e) out.push(e);
    }
  });
  return out;
}

export function demoFetch(path: string, qs: URLSearchParams): any {
  const now = Date.now();
  const kw = (qs.get('keyword') ?? '').toLowerCase();
  if (path === 'venues.json') {
    const list = VENUES.filter((v) => !kw || v.name.toLowerCase().includes(kw)).map((v) => ({
      id: v.id,
      name: v.name,
      city: { name: 'Toronto' },
      upcomingEvents: { _total: v.upcoming },
    }));
    return { _embedded: { venues: list }, page: { totalPages: 1 } };
  }
  if (path === 'attractions.json') {
    const list = ARTISTS.filter((a) => !kw || a.name.toLowerCase().includes(kw)).map((a) => ({
      id: a.id,
      name: a.name,
      upcomingEvents: { _total: 3 },
      classifications: [{ genre: { name: a.genre } }],
    }));
    return { _embedded: { attractions: list }, page: { totalPages: 1 } };
  }
  const detail = path.match(/^events\/(.+)\.json$/);
  if (detail) return allEvents(now).find((e) => e.id === detail[1]) ?? {};
  if (path === 'events.json') {
    let list = allEvents(now);
    const venueId = qs.get('venueId');
    const attractionId = qs.get('attractionId');
    if (venueId) list = list.filter((e) => e._embedded.venues[0].id === venueId);
    if (attractionId) list = list.filter((e) => e._embedded.attractions[0].id === attractionId);
    return { _embedded: { events: list }, page: { totalPages: 1 } };
  }
  return {};
}

function demoWhen(ms: number): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Toronto', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(ms));
}

export function demoCodePage(kind: string, url = ''): string {
  const t = Date.now();
  if (kind === 'help') {
    const artist = ARTISTS.find((a) => url.endsWith(a.id)) ?? ARTISTS[0];
    return `<html><body><h1>${artist.name} Presale Information</h1>
      <h2>Verified Fan Presale</h2>
      <p>You can sign up any time before ${demoWhen(t + 2 * DAY)} at 10:00 p.m. ET. <a href="https://signup.ticketmaster.ca/demo">Sign up here</a>.</p>
      <p>The Verified Fan Presale begins on ${demoWhen(t + 4 * DAY)} at 10:00 a.m. local venue time.</p>
      <p>The general sale starts on ${demoWhen(t + 5 * DAY)} at 10:00 a.m. local venue time.</p></body></html>`;
  }
  if (kind === 'venue') {
    const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16);
    return `<html><head><script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'MusicEvent', name: 'Harbourfront Sessions: Lily Pad Choir', startDate: iso(t + 33 * DAY), location: { '@type': 'Place', name: 'The Opera House' },
          url: 'https://venue.example/events/lily-pad', offers: { '@type': 'Offer', price: '28', availabilityStarts: iso(t + 2 * DAY) } },
        { '@type': 'MusicEvent', name: 'Midnight Ferry', startDate: iso(t + 47 * DAY), location: { name: 'The Opera House' }, performer: { name: 'Midnight Ferry' },
          offers: [{ '@type': 'Offer', price: 35, validFrom: iso(t - DAY), availability: 'https://schema.org/InStock' }] },
      ],
    })}</script></head><body>Events</body></html>`;
  }
  if (kind === 'livenation') {
    return '<html><body><h2>Live Nation Presale</h2><p>Need the Live Nation presale password? Use <strong>HYPED</strong> or <strong>SETBREAK</strong>.</p></body></html>';
  }
  if (url.includes('forum')) {
    return `<html><body>
      <p>Anyone have the Glass Harbour artist presale code for Toronto?</p>
      <p>The Glass Harbour presale code is HARBOUR26, worked for me at Massey Hall!</p>
      <p>Maple Static code was STATICTOUR last time. Lake Effect fan club password: SNOWBELT</p>
      <p>confirmed glass harbour HARBOUR26</p></body></html>`;
  }
  return `<html><body><article><h1>Presale codes this week</h1>
    <p>June Fireflies Spotify presale: try code FIREFLY or SUMMERGLOW.</p>
    <p>Glass Harbour presale code: HARBOUR26</p>
    <p>Velvet Transit artist presale password is NIGHTLINE.</p></article></body></html>`;
}

export function demoSearch(query: string): { url: string; title: string; snippet: string }[] {
  const q = query.toLowerCase();
  const artist = ARTISTS.find((a) => q.includes(a.name.toLowerCase()));
  if (!artist) return [];
  if (q.includes('help.ticketmaster'))
    return [{ url: `https://help.ticketmaster.ca/demo/${artist.id}`, title: `${artist.name} Presale Information`, snippet: `Everything you need to know about the ${artist.name} presales.` }];
  return [
    { url: 'https://example-forum.test/thread/presales', title: `${artist.name} presale code?`, snippet: `Fans sharing the ${artist.name} presale code for the Toronto dates.` },
    { url: 'https://example-blog.test/presale-codes', title: 'Presale codes this week', snippet: `Roundup of codes including ${artist.name}.` },
  ];
}

/** Every few hours one demo show "sells out" and then gets seats back. */
export function demoAvailability(eventId: string, now: number): { status: string; resale: string | null } {
  const phase = Math.floor(now / (20 * 60_000)) % 3;
  const seed = h(eventId) % 5;
  if (seed === 0) return { status: phase === 2 ? 'FEW_TICKETS_LEFT' : 'TICKETS_NOT_AVAILABLE', resale: 'TICKETS_AVAILABLE' };
  return { status: seed === 1 ? 'FEW_TICKETS_LEFT' : 'TICKETS_AVAILABLE', resale: null };
}

// ---------------------------------------------------------------- SeatGeek (demo)

function sgFromTm(e: any, now: number) {
  const seed = h(e.id);
  const face = e.priceRanges?.[0]?.min ?? 60;
  // Resale prices drift around face value, dipping below it now and then.
  const wave = Math.sin(now / (2 * 3_600_000) + (seed % 7));
  const low = Math.round(face * (1.05 + 0.25 * wave));
  return {
    id: `sg-${e.id}`,
    title: e.name,
    url: 'https://seatgeek.com/',
    datetime_local: `${e.dates.start.localDate}T19:30:00`,
    datetime_utc: e.dates.start.dateTime.replace(/Z$/, ''),
    venue: { id: `sg-${e._embedded.venues[0].id}`, name: e._embedded.venues[0].name, city: 'Toronto' },
    performers: e._embedded.attractions.map((a: any, i: number) => ({ id: `sg-${a.id}`, name: a.name, primary: i === 0 })),
    stats: { lowest_price: low, listing_count: 3 + (seed % 40) },
  };
}

/** Shows sold elsewhere (Dice, box office) that only SeatGeek knows about. */
function sgOnly(venueIdx: number, now: number) {
  const v = VENUES[venueIdx];
  const day = Math.floor(now / DAY) * DAY;
  const start = day + (20 + venueIdx * 3) * DAY + 24 * HOUR;
  const name = ['Late Night Jazz Trio', 'Basement Tapes Live', 'The Paper Boats'][venueIdx % 3];
  return {
    id: `sg-only-${v.id}`,
    title: name,
    url: 'https://seatgeek.com/',
    datetime_local: new Date(start - 5 * HOUR).toISOString().slice(0, 19),
    datetime_utc: new Date(start).toISOString().slice(0, 19),
    venue: { id: `sg-${v.id}`, name: v.name, city: 'Toronto' },
    performers: [{ id: `sg-p-${venueIdx}`, name, primary: true }],
    stats: { lowest_price: 35 + venueIdx * 4, listing_count: 6 },
  };
}

export function demoSeatGeek(path: string, qs: URLSearchParams, now: number): any {
  const q = (qs.get('q') ?? '').toLowerCase();
  if (path === 'venues') return { venues: VENUES.filter((v) => !q || v.name.toLowerCase().includes(q)).map((v) => ({ id: `sg-${v.id}`, name: v.name })) };
  if (path === 'performers') return { performers: ARTISTS.filter((a) => !q || a.name.toLowerCase().includes(q)).map((a) => ({ id: `sg-${a.id}`, name: a.name })) };
  const all = [...allEvents(now).map((e) => sgFromTm(e, now)), ...VENUES.slice(0, 4).map((_, i) => sgOnly(i, now))];
  if (path.startsWith('events/')) return all.find((e) => e.id === path.slice(7)) ?? {};
  const venueId = qs.get('venue.id');
  const perfId = qs.get('performers.id');
  return { events: all.filter((e) => (!venueId || e.venue.id === venueId) && (!perfId || e.performers.some((p: any) => p.id === perfId))) };
}
