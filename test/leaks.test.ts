import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeCtx, tmEvent, HOUR, DAY } from './helpers.js';
import { normalizeEvent } from '../src/tm.js';
import { upsertEvent } from '../src/sync.js';
import { searchForCodes, extractArtistCodes } from '../src/codes.js';
import { feedbackAdjust, parseBlueskySearch, parseRedditListing, parseRedditThread, recencyFactor, tourWordBoost } from '../src/social.js';

const sec = (ms: number) => ms / 1000;

function redditFixtures(t: number) {
  const listing = {
    data: {
      children: [
        { kind: 't3', data: { author: 'op1', title: 'Imagine Dragons LOOM tour presale code thread', selftext: 'Toronto presale tomorrow 10am, post codes below', permalink: '/r/ConcertTickets/comments/abc/id_presale/', created_utc: sec(t - 5 * HOUR), num_comments: 4 } },
        { kind: 't3', data: { author: 'old', title: 'Imagine Dragons presale code', selftext: 'code is MERCURY', permalink: '/r/x/comments/old/', created_utc: sec(t - 80 * DAY), num_comments: 0 } },
        { kind: 't3', data: { author: 'other', title: 'Best seats at Scotiabank?', selftext: '', permalink: '/r/x/comments/zzz/', created_utc: sec(t - HOUR), num_comments: 3 } },
      ],
    },
  };
  const thread = [
    listing,
    {
      data: {
        children: [
          { kind: 't1', data: { author: 'fan_a', body: 'Artist presale code is LOOMTOUR', permalink: '/r/c/comments/abc/_/c1/', created_utc: sec(t - 3 * HOUR),
              replies: { data: { children: [{ kind: 't1', data: { author: 'fan_b', body: 'worked for me, thanks!', permalink: '/r/c/comments/abc/_/c2/', created_utc: sec(t - 2 * HOUR), replies: '' } }] } } } },
          { kind: 't1', data: { author: 'fan_c', body: 'try DRAGONS2027', permalink: '/r/c/comments/abc/_/c3/', created_utc: sec(t - 2 * HOUR),
              replies: { data: { children: [{ kind: 't1', data: { author: 'fan_d', body: "didn't work, says invalid", permalink: '/r/c/comments/abc/_/c4/', created_utc: sec(t - HOUR), replies: '' } }] } } } },
          { kind: 't1', data: { author: 'fan_e', body: 'IMAGINE DRAGONS presale was chaos lol', permalink: '/r/c/comments/abc/_/c5/', created_utc: sec(t - HOUR), replies: '' } },
        ],
      },
    },
  ];
  const bsky = {
    posts: [
      { uri: 'at://did:plc:x/app.bsky.feed.post/3kabc', author: { handle: 'loomfan.bsky.social' }, record: { text: 'Imagine Dragons presale password: LOOMTOUR 🐉', createdAt: new Date(t - 4 * HOUR).toISOString() } },
    ],
  };
  return { listing, thread, bsky };
}

describe('reading fan posts', () => {
  const t = Date.parse('2026-12-01T14:00:00Z');
  it('parses Reddit listings, threads (with replies) and Bluesky posts', () => {
    const { listing, thread, bsky } = redditFixtures(t);
    expect(parseRedditListing(listing)).toHaveLength(3);
    const comments = parseRedditThread(thread);
    expect(comments.map((c) => c.domain)).toEqual(['reddit.com/u/fan_a', 'reddit.com/u/fan_b', 'reddit.com/u/fan_c', 'reddit.com/u/fan_d', 'reddit.com/u/fan_e']);
    expect(comments[0].replies).toContain('worked');
    expect(parseBlueskySearch(bsky)[0].url).toBe('https://bsky.app/profile/loomfan.bsky.social/post/3kabc');
  });

  it('weighs replies, age and tour words', () => {
    expect(feedbackAdjust('worked for me, thanks!')).toBeGreaterThan(0);
    expect(feedbackAdjust("didn't work, says invalid")).toBeLessThan(-0.5);
    expect(feedbackAdjust('')).toBe(0);
    expect(recencyFactor(t - 2 * HOUR, t)).toBe(1);
    expect(recencyFactor(t - 80 * DAY, t)).toBe(0);
    expect(tourWordBoost('LOOMTOUR', ['Imagine Dragons: LOOM World Tour'], 'Imagine Dragons')).toBeGreaterThan(0);
    expect(tourWordBoost('DRAGONS', ['Imagine Dragons: LOOM World Tour'], 'Imagine Dragons')).toBe(0);
  });

  it("doesn't take a word of the artist's name as a code unless someone says it is one", () => {
    const a = [{ id: 'A', name: 'Imagine Dragons' }];
    expect(extractArtistCodes('IMAGINE DRAGONS presale was chaos', a)).toEqual([]);
    expect(extractArtistCodes('Imagine Dragons presale: the code is DRAGONS', a).map((c) => c.code)).toEqual(['DRAGONS']);
  });
});

describe('finding leaked codes end to end', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('finds the confirmed code, drops the one people said failed and ignores stale posts', async () => {
    const ctx = await makeCtx({ DEMO: '0' });
    const t = ctx.clock.t;
    const raw = tmEvent({ id: 'E1', artistId: 'ID', artist: 'Imagine Dragons', venueName: 'Scotiabank Arena', showUtc: t + 200 * DAY, presales: [{ name: 'Artist Presale', startUtc: t + 20 * HOUR }] });
    raw.name = 'Imagine Dragons: LOOM World Tour';
    const { event, sales } = normalizeEvent(raw);
    await upsertEvent(ctx, event, sales, true);

    const { listing, thread, bsky } = redditFixtures(t);
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(url);
      const body = url.includes('bsky') ? bsky : url.includes('/comments/abc') ? thread : url.includes('/search') ? listing : null;
      return new Response(JSON.stringify(body ?? {}), { status: body ? 200 : 404, headers: { 'content-type': 'application/json' } });
    });

    const res = await searchForCodes(ctx);
    expect(res.errors).toEqual([]);
    const codes = await ctx.db.query<{ code: string; score: number; domains: string[] }>(`SELECT code, score, domains FROM web_codes WHERE scope = 'artist' AND key = 'ID' ORDER BY score DESC`);
    const byCode = Object.fromEntries(codes.map((c) => [c.code, c]));
    expect(codes[0].code).toBe('LOOMTOUR');
    expect(byCode.LOOMTOUR.score).toBeGreaterThan(0.85); // two people, one "worked", fits the tour name
    expect(byCode.LOOMTOUR.domains.length).toBe(2);
    expect(byCode.DRAGONS2027?.score ?? 0).toBeLessThan(0.4); // "didn't work" under it
    expect(byCode.MERCURY).toBeUndefined(); // 80-day-old post
    expect(byCode.DRAGONS).toBeUndefined();
    expect(res.promoted.map((p) => p.code)).toContain('LOOMTOUR');
    // Only the relevant thread was opened.
    expect(seen.filter((u) => u.includes('/comments/')).length).toBe(1);

    // Ran again straight away: nothing re-fetched.
    seen.length = 0;
    await searchForCodes(ctx);
    expect(seen).toEqual([]);
  });

  it('rests a source that refuses us instead of retrying every tick', async () => {
    const ctx = await makeCtx({ DEMO: '0' });
    const t = ctx.clock.t;
    const { event, sales } = normalizeEvent(tmEvent({ id: 'E2', artistId: 'ID', artist: 'Imagine Dragons', showUtc: t + 200 * DAY, presales: [{ name: 'Artist Presale', startUtc: t + 2 * HOUR }] }));
    await upsertEvent(ctx, event, sales, true);
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return new Response('blocked', { status: 403 });
    });
    const first = await searchForCodes(ctx);
    expect(first.errors.some((e) => /resting/.test(e))).toBe(true);
    const before = calls;
    ctx.clock.t += 15 * 60_000; // due again by schedule, but still resting
    await searchForCodes(ctx);
    expect(calls).toBe(before);
  });
});
