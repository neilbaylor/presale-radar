import { describe, expect, it, beforeEach } from 'vitest';
import { makeCtx, addUser, tmEvent, HOUR, DAY, type TestCtx } from './helpers.js';
import { normalizeEvent, classifyRequirement, geohash } from '../src/tm.js';
import { upsertEvent, fanOut, priorityFor } from '../src/sync.js';
import { setUserEvent, codesForSale, loadCodeContext, interest, getFollows } from '../src/db.js';
import { runReminders, graceMs } from '../src/reminders.js';
import { deliver, inQuietHours, localParts } from '../src/notify.js';
import { pushTransport } from '../src/push.js';
import { buildCalendar } from '../src/ics.js';
import { getUser } from '../src/db.js';
import { login, createSession, sessionUser, createInvite, checkInvite, useInvite, verifyAction, actionUrl } from '../src/auth.js';
import { buildState } from '../src/state.js';

async function follow(ctx: TestCtx, uid: number, venue?: { id: string; name: string; remindAll?: boolean }, artist?: { id: string; name: string; mode?: string }) {
  if (venue) {
    await ctx.db.query('INSERT INTO venues (id, name, last_synced) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [venue.id, venue.name, ctx.clock.t]);
    await ctx.db.query('INSERT INTO user_venues (user_id, venue_id, remind_all, added_at) VALUES ($1,$2,$3,$4)', [uid, venue.id, !!venue.remindAll, ctx.clock.t]);
  }
  if (artist) {
    await ctx.db.query('INSERT INTO artists (id, name, last_synced) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [artist.id, artist.name, ctx.clock.t]);
    await ctx.db.query('INSERT INTO user_artists (user_id, artist_id, mode, added_at) VALUES ($1,$2,$3,$4)', [uid, artist.id, artist.mode ?? 'follow', ctx.clock.t]);
  }
}

async function ingest(ctx: TestCtx, raw: any, silent = false) {
  const { event, sales } = normalizeEvent(raw);
  const changes = await upsertEvent(ctx, event, sales, silent);
  await fanOut(ctx, changes);
  return changes;
}

const activity = (ctx: TestCtx, uid: number) =>
  ctx.db.query<any>('SELECT type, priority, title, pushed_at FROM activity WHERE user_id = $1 ORDER BY id', [uid]);

describe('normalizing Ticketmaster data', () => {
  it('reads sales, presales and requirements', () => {
    const t = Date.parse('2026-12-01T15:00:00Z');
    const { event, sales } = normalizeEvent(
      tmEvent({ id: 'E1', artistId: 'A1', artist: 'Glass Harbour', showUtc: t + 60 * DAY, publicUtc: t + 3 * DAY, presales: [
        { name: 'Verified Fan Presale', startUtc: t + DAY },
        { name: 'American Express Presale', startUtc: t + 2 * DAY },
        { name: 'Artist Presale', startUtc: t + 2 * DAY, description: 'Use code HARBOUR at checkout' },
      ] }),
    );
    expect(event.attractionNames).toEqual(['Glass Harbour']);
    expect(sales.map((s) => [s.id, s.requirement])).toEqual([
      ['E1:verified-fan-presale', 'register'],
      ['E1:american-express-presale', 'card'],
      ['E1:artist-presale', 'code'],
      ['E1:public', 'none'],
    ]);
  });

  it('classifies common presale names', () => {
    expect(classifyRequirement('Live Nation Presale')).toBe('code');
    expect(classifyRequirement('Spotify Presale')).toBe('code');
    expect(classifyRequirement('RBC Avion Presale')).toBe('card');
    expect(classifyRequirement('Official Platinum Onsale')).toBe('none');
  });

  it('encodes a geohash for Toronto', () => {
    expect(geohash(43.6532, -79.3832, 5)).toBe('dpz83');
  });
});

describe('interest levels', () => {
  const f = { venues: new Map([['V1', { remindAll: false }], ['V2', { remindAll: true }]]), artists: new Set(['A1']), muted: new Set(['A9']) };
  it('ranks starred > muted > artist > venue', () => {
    expect(interest({ venue_id: 'V1', attraction_ids: ['A5'] }, null, f).level).toBe('feed');
    expect(interest({ venue_id: 'V2', attraction_ids: ['A5'] }, null, f).level).toBe('remind');
    expect(interest({ venue_id: 'VX', attraction_ids: ['A1'] }, null, f).level).toBe('remind');
    expect(interest({ venue_id: 'V1', attraction_ids: ['A9'] }, null, f).level).toBe('hidden');
    expect(interest({ venue_id: 'V1', attraction_ids: ['A9'] }, { state: 'tracked' }, f).level).toBe('remind');
    expect(interest({ venue_id: 'V2', attraction_ids: ['A1'] }, { state: 'dismissed' }, f).level).toBe('hidden');
  });
});

describe('sync and calm notifications', () => {
  let ctx: TestCtx;
  let neil: number;
  let katie: number;
  beforeEach(async () => {
    ctx = await makeCtx();
    neil = await addUser(ctx, 'Neil');
    katie = await addUser(ctx, 'Katie', 'member');
    await follow(ctx, neil, { id: 'V1', name: 'Massey Hall' }, { id: 'A1', name: 'Glass Harbour' });
    await follow(ctx, katie, { id: 'V1', name: 'Massey Hall' });
  });

  it('is silent on a first sync', async () => {
    const t = ctx.clock.t;
    const changes = await ingest(ctx, tmEvent({ id: 'E1', artistId: 'A1', artist: 'Glass Harbour', showUtc: t + 90 * DAY }), true);
    expect(changes).toEqual([]);
    expect(await activity(ctx, neil)).toEqual([]);
  });

  it('a followed artist is instant, a venue-only show waits for the digest', async () => {
    const t = ctx.clock.t;
    await ingest(ctx, tmEvent({ id: 'E1', artistId: 'A1', artist: 'Glass Harbour', showUtc: t + 90 * DAY }));
    expect((await activity(ctx, neil)).map((a) => a.priority)).toEqual(['instant']);
    expect((await activity(ctx, katie)).map((a) => a.priority)).toEqual(['digest']);
  });

  it('respects hidden shows and muted artists', async () => {
    const t = ctx.clock.t;
    await ingest(ctx, tmEvent({ id: 'E1', artistId: 'A2', artist: 'Maple Static', showUtc: t + 90 * DAY }), true);
    await setUserEvent(ctx, katie, 'E1', { state: 'dismissed' });
    await ingest(ctx, tmEvent({ id: 'E1', artistId: 'A2', artist: 'Maple Static', showUtc: t + 90 * DAY, presales: [{ name: 'Artist Presale', startUtc: t + DAY }] }));
    expect(await activity(ctx, katie)).toEqual([]);
    expect((await activity(ctx, neil)).map((a) => a.type)).toEqual(['new_sale']);
  });

  it('turns a presale moved to within 24h into an urgent push for people who care', async () => {
    const t = ctx.clock.t;
    await ingest(ctx, tmEvent({ id: 'E1', artistId: 'A1', artist: 'Glass Harbour', showUtc: t + 90 * DAY, presales: [{ name: 'Artist Presale', startUtc: t + 5 * DAY }] }), true);
    await ingest(ctx, tmEvent({ id: 'E1', artistId: 'A1', artist: 'Glass Harbour', showUtc: t + 90 * DAY, presales: [{ name: 'Artist Presale', startUtc: t + 20 * HOUR }] }));
    const a = await activity(ctx, neil);
    expect(a.map((x) => [x.type, x.priority])).toEqual([['time_change', 'urgent']]);
    expect(pushTransport.log!.filter((p) => p.userId === neil).length).toBe(1);
    expect(await activity(ctx, katie)).toEqual([{ type: 'time_change', priority: 'silent', title: expect.any(String), pushed_at: null }]);
  });

  it('after "got tickets" only cancellations get through', () => {
    const e = normalizeEvent(tmEvent({ id: 'E1', showUtc: Date.now() + 9 * DAY })).event;
    expect(priorityFor({ type: 'new_show', event: e, sales: [] }, 'remind', true, Date.now())).toBeNull();
    expect(priorityFor({ type: 'status_change', event: e, status: 'canceled' }, 'remind', true, Date.now())).toBe('instant');
  });
});

describe('reminders and delivery', () => {
  let ctx: TestCtx;
  let neil: number;
  beforeEach(async () => {
    ctx = await makeCtx();
    neil = await addUser(ctx, 'Neil');
    await follow(ctx, neil, { id: 'V1', name: 'Massey Hall' }, { id: 'A1', name: 'Glass Harbour' });
  });

  it('sends one urgent reminder 15 minutes before, with the code', async () => {
    const t = ctx.clock.t;
    const presale = t + 60 * 60_000;
    await ingest(ctx, tmEvent({ id: 'E1', artistId: 'A1', artist: 'Glass Harbour', showUtc: t + 60 * DAY, presales: [{ name: 'Artist Presale', startUtc: presale, description: 'Use code HARBOUR26' }] }), true);
    await ctx.db.query(`INSERT INTO web_codes (scope, key, code, score, source_url, first_seen, last_seen) VALUES ('sale', 'E1:artist-presale', 'HARBOUR26', 0.95, 'x', 0, 0)`);

    expect(await runReminders(ctx)).toBe(0); // 60 min out: nothing yet
    ctx.clock.t = presale - 15 * 60_000;
    expect(await runReminders(ctx)).toBe(1);
    expect(await runReminders(ctx)).toBe(0); // never twice
    const push = pushTransport.log!.at(-1)!;
    expect(push.urgency).toBe('high');
    expect(push.message.title).toBe('Glass Harbour: Artist Presale in 15 min');
    expect(push.message.body).toContain('Code: HARBOUR26');
    expect(push.message.url).toBe('/#/go/E1%3Aartist-presale');
  });

  it('skips reminders for venue-only shows and shows you bought', async () => {
    const t = ctx.clock.t;
    await ingest(ctx, tmEvent({ id: 'E2', artistId: 'A5', artist: 'Lake Effect', showUtc: t + 60 * DAY, presales: [{ name: 'Artist Presale', startUtc: t + 10 * 60_000 }] }), true);
    await ingest(ctx, tmEvent({ id: 'E3', artistId: 'A1', artist: 'Glass Harbour', showUtc: t + 61 * DAY, presales: [{ name: 'Artist Presale', startUtc: t + 10 * 60_000 }] }), true);
    await setUserEvent(ctx, neil, 'E3', { got_tickets: true });
    expect(await runReminders(ctx)).toBe(0);
    await setUserEvent(ctx, neil, 'E2', { state: 'tracked' }); // "Remind me"
    expect(await runReminders(ctx)).toBe(1);
  });

  it('holds instant pushes in quiet hours, caps them hourly, and merges', async () => {
    const t0 = Date.parse('2026-12-01T04:00:00Z'); // 11 PM Toronto
    ctx.clock.t = t0;
    await ingest(ctx, tmEvent({ id: 'E1', artistId: 'A1', artist: 'Glass Harbour', showUtc: t0 + 90 * DAY }));
    await ingest(ctx, tmEvent({ id: 'E2', artistId: 'A1', artist: 'Glass Harbour', showUtc: t0 + 91 * DAY }));
    await deliver(ctx);
    expect(pushTransport.log).toEqual([]);

    ctx.clock.t = Date.parse('2026-12-01T13:05:00Z'); // 8:05 AM
    await deliver(ctx);
    expect(pushTransport.log!.map((p) => p.message.title)).toEqual(['2 updates']);

    await ingest(ctx, tmEvent({ id: 'E3', artistId: 'A1', artist: 'Glass Harbour', showUtc: t0 + 92 * DAY }));
    ctx.clock.t += 20 * 60_000;
    await deliver(ctx);
    expect(pushTransport.log!.length).toBe(1); // hourly cap
    ctx.clock.t += 45 * 60_000;
    await deliver(ctx);
    expect(pushTransport.log!.length).toBe(2);
  });

  it('sends one evening digest with tomorrow’s sales', async () => {
    const evening = Date.parse('2026-12-02T00:30:00Z'); // 7:30 PM Toronto, Dec 1
    ctx.clock.t = evening - 3 * HOUR;
    await ingest(ctx, tmEvent({ id: 'E1', artistId: 'A1', artist: 'Glass Harbour', showUtc: evening + 60 * DAY, presales: [{ name: 'Artist Presale', startUtc: Date.parse('2026-12-02T15:00:00Z') }] }), true);
    await ingest(ctx, tmEvent({ id: 'E2', artistId: 'A7', artist: 'Copper Tides', showUtc: evening + 70 * DAY }));
    ctx.clock.t = evening;
    await deliver(ctx);
    const digest = pushTransport.log!.find((p) => p.message.tag === 'digest')!;
    expect(digest.message.title).toBe('Tomorrow: 1 sale for you');
    expect(digest.message.body).toContain('10:00 a.m. · Glass Harbour (Artist Presale)'.replace('a.m.', digest.message.body.includes('a.m.') ? 'a.m.' : 'AM'));
    expect(digest.message.body).toContain('1 new show');
    ctx.clock.t += HOUR;
    await deliver(ctx);
    expect(pushTransport.log!.filter((p) => p.message.tag === 'digest').length).toBe(1);
  });

  it('knows quiet hours across midnight', () => {
    expect(inQuietHours(23, 22, 8)).toBe(true);
    expect(inQuietHours(7, 22, 8)).toBe(true);
    expect(inQuietHours(8, 22, 8)).toBe(false);
    expect(inQuietHours(13, 12, 14)).toBe(true);
    expect(localParts(Date.parse('2026-12-01T04:00:00Z'), 'America/Toronto')).toEqual({ date: '2026-11-30', hour: 23 });
  });

  it('gives reminders enough grace for a 5 minute tick', () => {
    expect(graceMs(15, 300_000)).toBe(450_000);
    expect(graceMs(5, 300_000)).toBe(360_000);
  });
});

describe('codes per user', () => {
  it('ranks typed > saved > Ticketmaster > web, and respects votes', async () => {
    const ctx = await makeCtx();
    const uid = await addUser(ctx);
    const sale = { id: 'E1:artist-presale', name: 'Artist Presale', kind: 'presale' as const };
    await ctx.db.query(
      `INSERT INTO web_codes (scope, key, code, score, source_url, first_seen, last_seen) VALUES
       ('artist', 'A1', 'WEBONE', 0.6, 'u', 0, 0), ('artist', 'A1', 'WEBTWO', 0.8, 'u', 0, 0), ('sale', 'E1:artist-presale', 'TMCODE', 0.95, 'u', 0, 0)`,
    );
    let c = codesForSale(sale, ['A1'], await loadCodeContext(ctx, uid));
    expect(c.map((x) => x.code)).toEqual(['TMCODE', 'WEBTWO', 'WEBONE']);
    await ctx.db.query(`INSERT INTO code_votes (user_id, scope, key, code, vote) VALUES ($1, 'artist', 'A1', 'WEBTWO', -1)`, [uid]);
    await ctx.db.query(`INSERT INTO user_artist_codes (user_id, artist_id, sale_slug, code, updated_at) VALUES ($1, 'A1', 'artist-presale', 'MINE', 0)`, [uid]);
    c = codesForSale(sale, ['A1'], await loadCodeContext(ctx, uid));
    expect(c.map((x) => x.code)).toEqual(['MINE', 'TMCODE', 'WEBONE']);
  });
});

describe('accounts', () => {
  it('signs in, keeps a session, and invites', async () => {
    const ctx = await makeCtx();
    const owner = await addUser(ctx, 'Neil');
    expect(await login(ctx, 'NEIL@example.com', 'password123')).toBe(owner);
    expect(await login(ctx, 'neil@example.com', 'wrong')).toBeNull();
    const token = await createSession(ctx, owner, 'test');
    expect(await sessionUser(ctx, token)).toBe(owner);
    expect(await sessionUser(ctx, token + 'x')).toBeNull();

    const inv = await createInvite(ctx, owner, 'Katie');
    expect(await checkInvite(ctx, inv.token)).toEqual({ inviter: 'Neil' });
    const katie = await addUser(ctx, 'Katie', 'member');
    expect(await useInvite(ctx, inv.token, katie)).toBe(true);
    expect(await useInvite(ctx, inv.token, katie)).toBe(false);
  });

  it('signs notification buttons per user', async () => {
    const ctx = await makeCtx();
    const url = await actionUrl(ctx, 7, 'dismiss', 'E1');
    const q = new URL(url, 'http://x').searchParams;
    expect(await verifyAction(ctx, 7, 'dismiss', 'E1', null, q.get('s')!)).toBe(true);
    expect(await verifyAction(ctx, 8, 'dismiss', 'E1', null, q.get('s')!)).toBe(false);
  });
});

describe('calendar and state', () => {
  it('lists only sales you care about, linking to the sale screen', async () => {
    const ctx = await makeCtx();
    const uid = await addUser(ctx);
    await follow(ctx, uid, { id: 'V1', name: 'Massey Hall' }, { id: 'A1', name: 'Glass Harbour' });
    const t = ctx.clock.t;
    await ingest(ctx, tmEvent({ id: 'E1', artistId: 'A1', artist: 'Glass Harbour', showUtc: t + 60 * DAY, presales: [{ name: 'Artist Presale', startUtc: t + 2 * DAY }] }), true);
    await ingest(ctx, tmEvent({ id: 'E2', artistId: 'A2', artist: 'Lake Effect', showUtc: t + 61 * DAY, presales: [{ name: 'Artist Presale', startUtc: t + 2 * DAY }] }), true);
    const ics = await buildCalendar(ctx, (await getUser(ctx, uid))!, 'https://app.test');
    expect(ics.replace(/\r\n /g, '')).toContain('SUMMARY:🎟 Glass Harbour Artist presale');
    expect(ics).not.toContain('Lake Effect');
    expect(ics.replace(/\r\n /g, '')).toMatch(/URL:https:\/\/app\.test\/s\/[0-9A-Za-z]{10}/);
    expect(ics).toContain('BEGIN:VALARM'); // no push devices yet, so the calendar alarms
    for (const line of ics.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);

    const state = await buildState(ctx, (await getUser(ctx, uid))!, 'https://app.test');
    expect(state.shows.map((s) => [s.artist, s.level])).toEqual([
      ['Glass Harbour', 'remind'],
      ['Lake Effect', 'feed'],
    ]);
    const f = await getFollows(ctx, uid);
    expect(f.artists.has('A1')).toBe(true);
  });
});
