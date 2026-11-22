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
      if (req.method === 'PROPFIND' && url.startsWith('/123/calendars/')) return res.writeHead(calendars.has(url) ? 207 : 404).end('<multistatus xmlns="DAV:"/>');
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
    expect(events[0]).toContain('SUMMARY:🎟 Glass Harbour: Artist Presale');
    const flat = events.join('').replace(/\r\n /g, '');
    expect(flat).toContain('URL:https://radar.example/l/sale/');
    expect(flat).toContain('https://radar.example/l/got/');
    expect(flat).toContain('https://radar.example/l/hide/');

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
