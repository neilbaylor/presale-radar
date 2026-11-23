import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { makeCtx, addUser, tmEvent, DAY } from './helpers.js';
import { normalizeEvent } from '../src/tm.js';
import { upsertEvent } from '../src/sync.js';
import { setUserEvent, setSetting } from '../src/db.js';
import { connectICloud, syncUserCalendar, disconnectCalendar } from '../src/calsync.js';
import { linkSig, encryptSecret, decryptSecret } from '../src/secrets.js';

/** A tiny CalDAV server that behaves like iCloud: redirects, Basic auth, principal discovery. */
function fakeICloud() {
  const store = new Map<string, string>();
  const calendars = new Set<string>();
  const log: string[] = [];
  const auth = `Basic ${Buffer.from('neil@icloud.com:abcd-efgh-ijkl-mnop').toString('base64')}`;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      log.push(`${req.method} ${req.url}`);
      if (req.headers.authorization !== auth) return res.writeHead(401).end();
      const url = req.url!;
      // Like iCloud: the front door redirects to a per-account host.
      if (url === '/') return res.writeHead(301, { location: '/p42/' }).end();
      if (req.method === 'PROPFIND' && url === '/p42/')
        return res.writeHead(207).end('<d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop><d:current-user-principal><d:href>/123/principal/</d:href></d:current-user-principal></d:prop></d:propstat></d:response></d:multistatus>');
      if (req.method === 'PROPFIND' && url === '/123/principal/')
        return res.writeHead(207).end(`<multistatus xmlns="DAV:"><response><propstat><prop><calendar-home-set xmlns="urn:ietf:params:xml:ns:caldav"><href xmlns="DAV:">/123/calendars/</href></calendar-home-set></prop></propstat></response></multistatus>`);
      if (req.method === 'PROPFIND' && url.startsWith('/123/calendars/')) {
        if (!calendars.has(url)) return res.writeHead(404).end();
        const hrefs = req.headers.depth === '1' ? [url, ...[...store.keys()].filter((k) => k.startsWith(url))] : [url];
        return res.writeHead(207).end(`<d:multistatus xmlns:d="DAV:">${hrefs.map((h) => `<d:response><d:href>${h}</d:href></d:response>`).join('')}</d:multistatus>`);
      }
      if (req.method === 'MKCALENDAR') {
        if (!body.includes('Presales')) return res.writeHead(400).end();
        calendars.add(url);
        return res.writeHead(201).end();
      }
      if (req.method === 'PUT') {
        if (!body.includes('BEGIN:VEVENT')) return res.writeHead(400).end();
        const isNew = !store.has(url);
        store.set(url, body);
        return res.writeHead(isNew ? 201 : 204).end();
      }
      if (req.method === 'DELETE') {
        if (calendars.has(url)) {
          calendars.delete(url);
          for (const k of [...store.keys()]) if (k.startsWith(url)) store.delete(k);
          return res.writeHead(204).end();
        }
        return res.writeHead(store.delete(url) ? 204 : 404).end();
      }
      res.writeHead(405).end();
    });
  });
  return { server, store, calendars, log };
}

describe('iCloud calendar sync', () => {
  const fake = fakeICloud();
  let base = '';
  beforeAll(async () => {
    await new Promise<void>((r) => fake.server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}/`;
  });
  afterAll(() => fake.server.close());

  it('connects, adds sales, moves them, and removes them when you hide or buy', async () => {
    const ctx = await makeCtx();
    const uid = await addUser(ctx);
    await setSetting(ctx, 'base_url', 'https://radar.example');
    await ctx.db.query(`INSERT INTO artists (id, name) VALUES ('A1', 'Glass Harbour')`);
    await ctx.db.query(`INSERT INTO user_artists (user_id, artist_id, mode, added_at) VALUES ($1, 'A1', 'follow', 0)`, [uid]);
    const t = ctx.clock.t;
    const ingest = async (presaleAt: number) => {
      const { event, sales } = normalizeEvent(
        tmEvent({ id: 'E1', artistId: 'A1', artist: 'Glass Harbour', showUtc: t + 60 * DAY, publicUtc: t + 5 * DAY, presales: [{ name: 'Artist Presale', startUtc: presaleAt }] }),
      );
      await upsertEvent(ctx, event, sales, true);
    };
    await ingest(t + 2 * DAY);

    // Wrong password: a clear message, nothing stored.
    await expect(connectICloud(ctx, uid, 'neil@icloud.com', 'wrong', base)).rejects.toThrow(/app-specific password/);

    const r = await connectICloud(ctx, uid, 'neil@icloud.com', 'abcd efgh ijkl mnop', base);
    expect(r.synced).toBe(2); // presale + public on-sale
    expect(fake.calendars.size).toBe(1);
    const events = [...fake.store.values()];
    const flat = events.join('').replace(/\r\n /g, '');
    expect(flat).toContain('SUMMARY:🎟 Glass Harbour Artist presale');
    expect(flat).toMatch(/URL:https:\/\/radar\.example\/s\/[0-9A-Za-z]{10}/);
    expect(flat).toMatch(/Got tickets: https:\/\/radar\.example\/s\/[0-9A-Za-z]{10}/);
    expect(flat).toContain('Or just delete this event.');

    // Nothing changed: no writes.
    const before = fake.log.length;
    expect(await syncUserCalendar(ctx, uid)).toEqual({ put: 0, deleted: 0 });
    expect(fake.log.filter((l, i) => i >= before && /PUT|DELETE/.test(l))).toEqual([]);

    // Presale moved: one update.
    await ingest(t + 3 * DAY);
    expect(await syncUserCalendar(ctx, uid)).toEqual({ put: 1, deleted: 0 });

    // Got tickets: both events leave the calendar.
    await setUserEvent(ctx, uid, 'E1', { got_tickets: true });
    expect(await syncUserCalendar(ctx, uid)).toEqual({ put: 0, deleted: 2 });
    expect(fake.store.size).toBe(0);

    await disconnectCalendar(ctx, uid, true);
    expect(fake.calendars.size).toBe(0);
    expect(await ctx.db.one('SELECT 1 FROM calendar_accounts WHERE user_id = $1', [uid])).toBeNull();
  });

  it('marks the account as needing attention when Apple revokes the password', async () => {
    const ctx = await makeCtx();
    const uid = await addUser(ctx);
    await connectICloud(ctx, uid, 'neil@icloud.com', 'abcd-efgh-ijkl-mnop', base);
    await ctx.db.query(`UPDATE calendar_accounts SET secret_enc = $1`, [await encryptSecret(ctx, 'revoked')]);
    await ctx.db.query(`INSERT INTO artists (id, name) VALUES ('A1', 'X')`);
    await ctx.db.query(`INSERT INTO user_artists (user_id, artist_id, mode, added_at) VALUES ($1, 'A1', 'follow', 0)`, [uid]);
    const { event, sales } = normalizeEvent(tmEvent({ id: 'E9', artistId: 'A1', artist: 'X', showUtc: ctx.clock.t + 9 * DAY, publicUtc: ctx.clock.t + DAY }));
    await upsertEvent(ctx, event, sales, true);
    await syncUserCalendar(ctx, uid);
    const acct = await ctx.db.one<any>('SELECT status, last_error FROM calendar_accounts WHERE user_id = $1', [uid]);
    expect(acct.status).toBe('error');
    expect(acct.last_error).toMatch(/app-specific password/);
  });
});

describe('calendar as a remote control', () => {
  const fake = fakeICloud();
  let base = '';
  beforeAll(async () => {
    await new Promise<void>((r) => fake.server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}/`;
  });
  afterAll(() => fake.server.close());

  async function setup() {
    const ctx = await makeCtx();
    const uid = await addUser(ctx);
    await setSetting(ctx, 'base_url', 'https://radar.example');
    await ctx.db.query(`INSERT INTO artists (id, name) VALUES ('A1', 'Glass Harbour')`);
    await ctx.db.query(`INSERT INTO user_artists (user_id, artist_id, mode, added_at) VALUES ($1, 'A1', 'follow', 0)`, [uid]);
    const t = ctx.clock.t;
    // Two Toronto dates, same presale at the same moment.
    for (const [id, days] of [['E1', 60], ['E2', 61]] as const) {
      const { event, sales } = normalizeEvent(
        tmEvent({ id, artistId: 'A1', artist: 'Glass Harbour', showUtc: t + days * DAY, publicUtc: null, presales: [{ name: 'Artist Presale', startUtc: t + 2 * DAY, description: 'Use code HARBOUR26' }] }),
      );
      await upsertEvent(ctx, event, sales, true);
    }
    await ctx.db.query(`INSERT INTO web_codes (scope, key, code, score, source_url, first_seen, last_seen) VALUES ('sale', 'E1:artist-presale', 'HARBOUR26', 0.95, 'x', 0, 0)`);
    fake.store.clear();
    fake.calendars.clear();
    await connectICloud(ctx, uid, 'neil@icloud.com', 'abcd-efgh-ijkl-mnop', base);
    return { ctx, uid };
  }

  it('merges same-time presales into one event with the code in the title', async () => {
    await setup();
    expect(fake.store.size).toBe(1);
    const ev = [...fake.store.values()][0].replace(/\r\n /g, '');
    expect(ev).toContain('SUMMARY:🎟 Glass Harbour Artist presale · HARBOUR26');
    expect(ev).toContain('LOCATION:2 dates');
  });

  it('deleting the event in Calendar hides both shows and never re-adds them', async () => {
    const { ctx, uid } = await setup();
    fake.store.clear(); // the user swiped it away in Calendar
    expect(await syncUserCalendar(ctx, uid)).toEqual({ put: 0, deleted: 0 });
    const states = await ctx.db.query<any>('SELECT event_id, state FROM user_events WHERE user_id = $1 ORDER BY event_id', [uid]);
    expect(states.map((s) => [s.event_id, s.state])).toEqual([['E1', 'dismissed'], ['E2', 'dismissed']]);
    expect(fake.store.size).toBe(0);
  });

  it('puts everything back if the whole calendar was deleted', async () => {
    const { ctx, uid } = await setup();
    fake.calendars.clear();
    fake.store.clear();
    expect((await syncUserCalendar(ctx, uid)).put).toBe(1);
    expect(fake.calendars.size).toBe(1);
    expect(await ctx.db.query(`SELECT 1 FROM user_events WHERE state = 'dismissed'`)).toEqual([]);
  });

  it('one-tap links in the notes act immediately, with undo', async () => {
    const { ctx, uid } = await setup();
    const { createApp } = await import('../src/server.js');
    const app = createApp(ctx);
    const token = (await ctx.db.one<{ token: string }>(`SELECT token FROM short_links WHERE kind = 'hide'`))!.token;
    const res = await app.request(`/s/${token}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("won't bother you again");
    expect((await ctx.db.query<any>('SELECT state FROM user_events WHERE user_id = $1', [uid])).map((r) => r.state)).toEqual(['dismissed', 'dismissed']);
    await app.request(`/s/${token}/undo`, { method: 'POST' });
    expect((await ctx.db.query<any>('SELECT state FROM user_events WHERE user_id = $1', [uid])).map((r) => r.state)).toEqual(['auto', 'auto']);
    const sale = (await ctx.db.one<{ token: string }>(`SELECT token FROM short_links WHERE kind = 'sale'`))!.token;
    const r2 = await app.request(`/s/${sale}`);
    expect(r2.status).toBe(302);
    expect(r2.headers.get('location')).toMatch(/^\/#\/link\/\d+\/E1%3Aartist-presale\/[\w-]+$/);
    expect((await app.request('/s/nope123')).status).toBe(404);
  });
});

describe('secrets and links', () => {
  it('encrypts calendar passwords and signs links per user', async () => {
    const ctx = await makeCtx();
    const sealed = await encryptSecret(ctx, 'abcd-efgh');
    expect(sealed).not.toContain('abcd');
    expect(await decryptSecret(ctx, sealed)).toBe('abcd-efgh');
    expect(await linkSig(ctx, 1, 'got', 'E1')).not.toBe(await linkSig(ctx, 2, 'got', 'E1'));
    expect(await linkSig(ctx, 1, 'got', 'E1')).not.toBe(await linkSig(ctx, 1, 'hide', 'E1'));
  });
});
