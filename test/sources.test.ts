import { describe, expect, it } from 'vitest';
import { makeCtx, addUser, tmEvent, DAY } from './helpers.js';
import { findDates, zonedToUtc } from '../src/textdates.js';
import { parseHelpArticle } from '../src/help.js';
import { extractIcsEvents, extractJsonLdEvents, headlineFrom, parseIsoLocal, checkVenuePages } from '../src/venuepages.js';
import { nextSyncDelayMin, inAnnouncementWindow, dueSources } from '../src/db.js';
import { candidatesIn } from '../src/codes.js';
import { spend, usage, canSpend } from '../src/budget.js';
import { precheckSales } from '../src/precheck.js';
import { normalizeEvent } from '../src/tm.js';
import { upsertEvent } from '../src/sync.js';

const TZ = 'America/Toronto';
const ref = Date.parse('2026-01-10T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

describe('reading dates people write', () => {
  it('handles Ticketmaster help-centre phrasing, time zones and DST', () => {
    const d = (s: string, h = 10) => findDates(s, { timeZone: TZ, ref, defaultHour: h }).map((x) => iso(x.utc));
    expect(d('sign up any time before Wednesday, January 21, 2026 at 10:00 p.m. ET')).toEqual(['2026-01-22T03:00:00.000Z']);
    expect(d('The Artist Presale is on Friday, January 23, 2026 and runs from 10:00 a.m. local venue time')).toEqual(['2026-01-23T15:00:00.000Z']);
    expect(d('On sale Feb 3 at noon PT')).toEqual(['2026-02-03T20:00:00.000Z']);
    expect(d('Presale: 23 January 2026, 10:00')).toEqual(['2026-01-23T15:00:00.000Z']);
    expect(d('Registration closes Jan 5', 23)).toEqual(['2027-01-06T04:00:00.000Z']); // no year, already past: next year
    expect(iso(zonedToUtc(2026, 6, 1, 10, 0, TZ))).toBe('2026-07-01T14:00:00.000Z'); // summer time
  });
});

describe('Ticketmaster help articles', () => {
  const html = `<h1>Glass Harbour Presale Information</h1>
    <h2>Verified Fan Presale</h2>
    <p>You can sign up any time before Wednesday, January 21, 2026 at 10:00 p.m. ET. <a href="https://signup.ticketmaster.ca/glassharbour">Sign up</a></p>
    <p>The Verified Fan Presale begins on Friday, January 23, 2026 at 10:00 a.m. local venue time.</p>
    <p>The Spotify Presale begins on Monday, January 26, 2026 at 12:00 p.m. local venue time.</p>
    <p>The general sale starts on Friday, January 30, 2026 at 10:00 a.m. local venue time.</p>`;
  it('finds the sign-up deadline, presale times and general sale', () => {
    const notes = parseHelpArticle(html, { timeZone: TZ, ref });
    expect(notes.map((n) => [n.kind, n.label, iso(n.atUtc)])).toEqual([
      ['signup_deadline', 'Verified Fan Presale', '2026-01-22T03:00:00.000Z'],
      ['presale_time', 'The Verified Fan Presale', '2026-01-23T15:00:00.000Z'],
      ['presale_time', 'The Spotify Presale', '2026-01-26T17:00:00.000Z'],
      ['general_sale', 'General sale', '2026-01-30T15:00:00.000Z'],
    ]);
    expect(notes[0].signupUrl).toBe('https://signup.ticketmaster.ca/glassharbour');
  });
});

describe('venue websites', () => {
  it('reads schema.org events, nested in @graph or ItemList, with on-sale times', () => {
    const page = `<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'ItemList', itemListElement: [{ '@type': 'ListItem', item: { '@type': 'MusicEvent', name: 'Lily Pad Choir', startDate: '2026-03-14T20:00', location: { name: 'The Opera House' }, offers: { '@type': 'Offer', price: '28', availabilityStarts: '2026-01-20T10:00:00-05:00' } } }] },
        { '@type': ['Event', 'MusicEvent'], name: 'Midnight Ferry w/ Guests', startDate: '2026-04-02', performer: [{ name: 'Midnight Ferry' }], offers: [{ availability: 'https://schema.org/SoldOut' }] },
        { '@type': 'Organization', name: 'Not an event' },
      ],
    })}</script><script type="application/ld+json">{ broken json </script>`;
    const ev = extractJsonLdEvents(page, TZ);
    expect(ev.map((e) => [e.name, e.localDate, e.onsaleUtc && iso(e.onsaleUtc), e.soldOut, e.priceMin])).toEqual([
      ['Lily Pad Choir', '2026-03-14', '2026-01-20T15:00:00.000Z', false, 28],
      ['Midnight Ferry w/ Guests', '2026-04-02', null, true, null],
    ]);
    expect(iso(ev[0].startUtc!)).toBe('2026-03-15T00:00:00.000Z'); // 8 PM local
    expect(headlineFrom(ev[1])).toBe('Midnight Ferry');
    expect(headlineFrom({ ...ev[0], performers: [] })).toBe('Lily Pad Choir');
  });

  it('reads .ics feeds with folded lines and time zones', () => {
    const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Basement Tapes Live\\, with friends\r\nDTSTART;TZID=America/Toronto:20260320T193000\r\nURL:https://venue.example/e/\r\n 42\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nSUMMARY:Late Set\r\nDTSTART:20260321T030000Z\r\nEND:VEVENT\r\nEND:VCALENDAR';
    const ev = extractIcsEvents(ics, TZ);
    expect(ev.map((e) => [e.name, e.localDate, iso(e.startUtc!), e.url])).toEqual([
      ['Basement Tapes Live, with friends', '2026-03-20', '2026-03-20T23:30:00.000Z', 'https://venue.example/e/42'],
      ['Late Set', '2026-03-20', '2026-03-21T03:00:00.000Z', null],
    ]);
  });

  it('treats ISO dates without an offset as local venue time', () => {
    expect(iso(parseIsoLocal('2026-03-14T20:00', TZ).utc!)).toBe('2026-03-15T00:00:00.000Z');
    expect(iso(parseIsoLocal('2026-03-14T20:00:00+0000', TZ).utc!)).toBe('2026-03-14T20:00:00.000Z');
  });

  it('adds shows Ticketmaster lacks, quietly the first time', async () => {
    const ctx = await makeCtx();
    ctx.clock.t = Date.now();
    const uid = await addUser(ctx);
    await ctx.db.query(`INSERT INTO venues (id, name) VALUES ('demo-v-opr', 'The Opera House')`);
    await ctx.db.query(`INSERT INTO user_venues (user_id, venue_id, added_at) VALUES ($1, 'demo-v-opr', 0)`, [uid]);
    await ctx.db.query(`INSERT INTO venue_pages (url, venue_id) VALUES ('https://venue.example/events', 'demo-v-opr')`);
    const r = await checkVenuePages(ctx);
    expect(r).toMatchObject({ pages: 1, found: 2, added: 2 });
    const rows = await ctx.db.query<any>(`SELECT name, source FROM events WHERE source = 'web' ORDER BY name`);
    expect(rows.map((x) => x.name)).toEqual(['Harbourfront Sessions: Lily Pad Choir', 'Midnight Ferry']);
    const sale = await ctx.db.one<any>(`SELECT kind, start_utc FROM sales WHERE event_id LIKE 'web:%'`);
    expect(sale.kind).toBe('public');
    expect(await ctx.db.query(`SELECT 1 FROM activity`)).toEqual([]); // first check is silent
  });
});

describe('smarter scheduling', () => {
  const base = { base: 60, hot: false, lastChange: null, firstSync: ref - 2 * DAY, t: ref, announcement: false, failCount: 0, budgetRatio: 0, jitter: 0 };
  it('checks hot sources often, quiet ones rarely, and backs off on errors', () => {
    expect(nextSyncDelayMin(base)).toBe(60);
    expect(nextSyncDelayMin({ ...base, hot: true })).toBe(15);
    expect(nextSyncDelayMin({ ...base, lastChange: ref - 3_600_000 })).toBe(15);
    expect(nextSyncDelayMin({ ...base, firstSync: ref - 10 * DAY })).toBe(180);
    expect(nextSyncDelayMin({ ...base, firstSync: ref - 10 * DAY, announcement: true })).toBe(20);
    expect(nextSyncDelayMin({ ...base, budgetRatio: 0.9 })).toBe(180);
    expect([1, 2, 3, 9].map((n) => nextSyncDelayMin({ ...base, failCount: n }))).toEqual([5, 10, 20, 360]);
    expect(nextSyncDelayMin({ ...base, jitter: 1 })).toBe(66);
  });

  it('knows weekday mornings in Toronto', () => {
    expect(inAnnouncementWindow(Date.parse('2026-01-13T15:30:00Z'), TZ)).toBe(true); // Tue 10:30
    expect(inAnnouncementWindow(Date.parse('2026-01-13T19:00:00Z'), TZ)).toBe(false); // Tue 2 PM
    expect(inAnnouncementWindow(Date.parse('2026-01-17T15:30:00Z'), TZ)).toBe(false); // Saturday
  });

  it('only returns sources whose next check is due', async () => {
    const ctx = await makeCtx();
    const uid = await addUser(ctx);
    await ctx.db.query(`INSERT INTO venues (id, name, next_sync) VALUES ('A', 'Due', $1), ('B', 'Later', $2), ('C', 'New', NULL)`, [ctx.clock.t - 1, ctx.clock.t + 60_000]);
    for (const v of ['A', 'B', 'C']) await ctx.db.query(`INSERT INTO user_venues (user_id, venue_id, added_at) VALUES ($1, $2, 0)`, [uid, v]);
    expect((await dueSources(ctx)).map((s) => s.name)).toEqual(['New', 'Due']);
  });

  it('shares one daily budget per service', async () => {
    const ctx = await makeCtx();
    await spend(ctx, 'brave', 29);
    expect(await canSpend(ctx, 'brave')).toBe(true);
    await spend(ctx, 'brave');
    expect(await canSpend(ctx, 'brave')).toBe(false);
    expect((await usage(ctx, 'brave')).ratio).toBe(1);
  });

  it('re-checks a sale 45 and 10 minutes before it starts, once each', async () => {
    const ctx = await makeCtx();
    ctx.clock.t = Date.now();
    const uid = await addUser(ctx);
    // Use a real demo event so the detail lookup finds it.
    const { demoFetch } = await import('../src/demo.js');
    const raw = demoFetch('events.json', new URLSearchParams())._embedded.events.find((e: any) =>
      e.sales.presales.some((p: any) => Date.parse(p.startDateTime) > Date.now() + 3_600_000),
    );
    const { event, sales } = normalizeEvent(raw);
    await upsertEvent(ctx, event, sales, true);
    await ctx.db.query(`INSERT INTO artists (id, name) VALUES ($1, 'x')`, [event.attractionIds[0]]);
    await ctx.db.query(`INSERT INTO user_artists (user_id, artist_id, mode, added_at) VALUES ($1, $2, 'follow', 0)`, [uid, event.attractionIds[0]]);
    const first = sales.filter((s) => s.startUtc! > ctx.clock.t).sort((a, b) => a.startUtc! - b.startUtc!)[0];
    ctx.clock.t = first.startUtc! - 44 * 60_000;
    expect((await precheckSales(ctx)).checked).toBe(1);
    expect((await precheckSales(ctx)).checked).toBe(0);
    ctx.clock.t = first.startUtc! - 9 * 60_000;
    expect((await precheckSales(ctx)).checked).toBe(1);
  });
});

describe('code parsing', () => {
  const codes = (t: string) => candidatesIn(t).map((c) => c.code);
  it('keeps case, reads quotes and lists, ignores everyday words', () => {
    expect(codes('The fan club password is “harbourLove” this time')).toEqual(['harbourLove']);
    expect(codes('Use code Spring2026 at checkout')).toEqual(['Spring2026']);
    expect(codes('codes: ONE11, Two22 and three33')).toEqual(['ONE11', 'Two22', 'three33']);
    expect(codes('The password is required for entry. Code below.')).toEqual([]);
    expect(codes('presale code was "sunshine" for Toronto')).toEqual(['sunshine']);
  });
});
