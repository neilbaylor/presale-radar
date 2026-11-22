import { describe, expect, it } from 'vitest';
import { makeCtx, addUser, DAY } from './helpers.js';
import { checkResale, isWatching, pickMatch, shouldAlert, similarity, syncSeatGeek, normalizeSg } from '../src/seatgeek.js';
import { syncSource } from '../src/sync.js';
import { setUserEvent } from '../src/db.js';
import { pushTransport } from '../src/push.js';

describe('matching SeatGeek to Ticketmaster', () => {
  it('scores names by shared words', () => {
    expect(similarity('Scotiabank Arena', 'Scotiabank Arena - Toronto')).toBe(1);
    expect(similarity('The Weeknd', 'Weeknd')).toBe(1);
    expect(similarity('Massey Hall', 'History')).toBe(0);
  });

  const sg = normalizeSg({
    id: 1,
    title: 'Glass Harbour with Special Guests',
    datetime_local: '2027-02-05T19:30:00',
    datetime_utc: '2027-02-06T00:30:00',
    venue: { name: 'Massey Hall' },
    performers: [{ name: 'Glass Harbour', primary: true }],
  });

  it('matches the only show at the venue that night', () => {
    expect(pickMatch(sg, [{ id: 'T1', name: 'Something Else', venue_id: 'V1', venue_name: 'Massey Hall', attraction_names: [] }], 'V1')).toBe('T1');
  });

  it('picks by artist when a venue has two shows that night', () => {
    const c = [
      { id: 'T1', name: 'Early Show: Lake Effect', venue_id: 'V1', venue_name: 'Massey Hall', attraction_names: ['Lake Effect'] },
      { id: 'T2', name: 'Glass Harbour', venue_id: 'V1', venue_name: 'Massey Hall', attraction_names: ['Glass Harbour'] },
    ];
    expect(pickMatch(sg, c, 'V1')).toBe('T2');
  });

  it("doesn't match a different venue", () => {
    expect(pickMatch(sg, [{ id: 'T1', name: 'Glass Harbour', venue_id: 'V9', venue_name: 'History', attraction_names: ['Glass Harbour'] }], null)).toBeNull();
  });
});

describe('resale alert rules', () => {
  it('alerts at or under target, then only on a real new low', () => {
    expect(shouldAlert(80, 75, null)).toBe(false);
    expect(shouldAlert(75, 75, null)).toBe(true);
    expect(shouldAlert(70, 75, 75)).toBe(false); // $5 cheaper: not worth a ping
    expect(shouldAlert(64, 75, 75)).toBe(true);
    expect(shouldAlert(60, null, null)).toBe(false); // no face value and no target
  });

  it('watches automatically only once tickets are on sale, and never after you got tickets', () => {
    expect(isWatching(undefined, 'remind', true)).toBe(true);
    expect(isWatching(undefined, 'remind', false)).toBe(false);
    expect(isWatching(undefined, 'feed', true)).toBe(false);
    expect(isWatching({ resale_watch: true }, 'feed', false)).toBe(true);
    expect(isWatching({ resale_watch: true, got_tickets: true }, 'remind', true)).toBe(false);
    expect(isWatching({ resale_watch: false }, 'remind', true)).toBe(false);
  });
});

describe('SeatGeek sync (demo data)', () => {
  it('links shows, adds ones Ticketmaster lacks, and pings once on a price drop', async () => {
    const ctx = await makeCtx();
    ctx.clock.t = Date.now();
    const uid = await addUser(ctx);
    await ctx.db.query(`INSERT INTO venues (id, name) VALUES ('demo-v-mas', 'Massey Hall')`);
    await ctx.db.query(`INSERT INTO user_venues (user_id, venue_id, added_at) VALUES ($1, 'demo-v-mas', 0)`, [uid]);
    await syncSource(ctx, { type: 'venue', id: 'demo-v-mas', name: 'Massey Hall', lastSynced: null });

    const r = await syncSeatGeek(ctx);
    expect(r.sources).toBe(1);
    expect(r.matched).toBeGreaterThan(0);
    expect(r.added).toBe(1); // the show only SeatGeek knows about
    expect(r.changes).toEqual([]); // first sync is silent
    const linked = await ctx.db.query(`SELECT id, source, resale_low FROM events WHERE sg_id IS NOT NULL`);
    expect(linked.every((e: any) => e.resale_low > 0)).toBe(true);
    expect(linked.filter((e: any) => e.source === 'seatgeek').length).toBe(1);

    // Watch one show with a generous target: exactly one ping, even when checked again.
    const show = linked.find((e: any) => e.source === 'ticketmaster')!;
    await setUserEvent(ctx, uid, show.id, { resale: { watch: true, target: 10_000 } });
    pushTransport.log = [];
    expect((await checkResale(ctx)).alerts).toBe(1);
    ctx.clock.t += 31 * 60_000;
    expect((await checkResale(ctx)).alerts).toBe(0);
    const act = await ctx.db.query(`SELECT type, title FROM activity WHERE user_id = $1`, [uid]);
    expect(act[0].type).toBe('resale_deal');
    expect(act[0].title).toMatch(/resale from \$\d+/);
  });
});
