import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Ctx, User } from './types.js';
import { getUser, now, setUserEvent, normalizePrefs, saleSlug } from './db.js';
import {
  SESSION_COOKIE, SESSION_DAYS, checkInvite, createInvite, createSession, createUser, destroySession, login,
  recordFailure, sessionUser, throttled, useInvite, userCount, validateSignup, verifyAction,
} from './auth.js';
import { buildState } from './state.js';
import { buildCalendar } from './ics.js';
import { normalizeEvent, popularVenues, searchArtists, searchVenues, TmError } from './tm.js';
import { fanOut, syncSource, upsertEvent } from './sync.js';
import { findCodes } from './codes.js';
import { previewDigest } from './notify.js';
import { pushToUser } from './push.js';
import { syncDue, tick } from './jobs.js';
import { connectICloud, disconnectCalendar, scheduleCalendarSync } from './calsync.js';
import { linkSig } from './secrets.js';
import { setSetting } from './db.js';
import { DavError } from './caldav.js';

type Env = { Variables: { user: User } };

function baseUrl(ctx: Ctx, c: Context): string {
  if (ctx.cfg.publicUrl) return ctx.cfg.publicUrl;
  const proto = c.req.header('x-forwarded-proto') ?? new URL(c.req.url).protocol.replace(':', '');
  const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? 'localhost';
  return `${proto}://${host}`;
}

function clientIp(c: Context): string {
  return c.req.header('x-forwarded-for')?.split(',')[0].trim() ?? c.req.header('x-real-ip') ?? 'local';
}

function setSession(ctx: Ctx, c: Context, token: string) {
  const secure = (c.req.header('x-forwarded-proto') ?? new URL(c.req.url).protocol.replace(':', '')) === 'https';
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure, sameSite: 'Lax', path: '/', maxAge: SESSION_DAYS * 86_400 });
}

const memo = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, ms: number, fn: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.value as T;
  const value = await fn();
  memo.set(key, { at: Date.now(), value });
  return value;
}

export function createApp(ctx: Ctx) {
  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof TmError) return c.json({ error: `Ticketmaster: ${err.message}` }, 502);
    console.error('[http]', err);
    return c.json({ error: 'Something went wrong. Try again.' }, 500);
  });

  app.get('/healthz', (c) => c.json({ ok: true, time: now(ctx) }));

  // Remember our public address so scheduled calendar syncs can build links.
  let knownBase: string | null = null;
  app.use('/api/*', async (c, next) => {
    const b = baseUrl(ctx, c);
    if (b !== knownBase && !/localhost|127\.0\.0\.1/.test(b)) {
      knownBase = b;
      setSetting(ctx, 'base_url', b).catch(() => {});
    }
    await next();
  });

  // ------------------------------------------------------------ auth (no session needed)

  app.get('/api/auth/status', async (c) => {
    const uid = await sessionUser(ctx, getCookie(c, SESSION_COOKIE));
    const user = uid ? await getUser(ctx, uid) : null;
    return c.json({ needsSetup: (await userCount(ctx)) === 0, signedIn: !!user, name: user?.name ?? null, demo: ctx.cfg.demo });
  });

  app.post('/api/auth/setup', async (c) => {
    if ((await userCount(ctx)) > 0) return c.json({ error: 'This app already has an owner. Ask them for an invite.' }, 403);
    const input = validateSignup(await c.req.json().catch(() => ({})));
    if (typeof input === 'string') return c.json({ error: input }, 400);
    const id = await createUser(ctx, input, 'owner');
    setSession(ctx, c, await createSession(ctx, id, c.req.header('user-agent') ?? null));
    return c.json({ ok: true });
  });

  app.post('/api/auth/login', async (c) => {
    const ip = clientIp(c);
    if (throttled(ip)) return c.json({ error: 'Too many tries. Wait 15 minutes.' }, 429);
    const body = await c.req.json().catch(() => ({}));
    const id = await login(ctx, String(body.email ?? ''), String(body.password ?? ''));
    if (!id) {
      recordFailure(ip);
      return c.json({ error: "That email and password don't match." }, 401);
    }
    setSession(ctx, c, await createSession(ctx, id, c.req.header('user-agent') ?? null));
    return c.json({ ok: true });
  });

  app.post('/api/auth/logout', async (c) => {
    await destroySession(ctx, getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  app.get('/api/invites/:token', async (c) => {
    const info = await checkInvite(ctx, c.req.param('token'));
    return info ? c.json(info) : c.json({ error: 'This invite has expired or was already used.' }, 404);
  });

  app.post('/api/auth/join', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const token = String(body.token ?? '');
    if (!(await checkInvite(ctx, token))) return c.json({ error: 'This invite has expired or was already used.' }, 400);
    const input = validateSignup(body);
    if (typeof input === 'string') return c.json({ error: input }, 400);
    if (await ctx.db.one('SELECT 1 FROM users WHERE email = $1', [input.email])) return c.json({ error: 'That email already has an account. Sign in instead.' }, 409);
    const id = await createUser(ctx, input, 'member');
    await useInvite(ctx, token, id);
    setSession(ctx, c, await createSession(ctx, id, c.req.header('user-agent') ?? null));
    return c.json({ ok: true });
  });

  // Notification buttons. Signed per user, so no cookie is needed (service workers can't rely on one).
  app.post('/api/act', async (c) => {
    const q = c.req.query();
    const userId = Number(q.u);
    if (!userId || !q.a || !q.e || !q.s || !(await verifyAction(ctx, userId, q.a, q.e, q.x ?? null, q.s))) return c.json({ error: 'Invalid link' }, 403);
    if (q.a === 'dismiss') await setUserEvent(ctx, userId, q.e, { state: 'dismissed' });
    else if (q.a === 'mute' && q.x) await muteArtist(ctx, userId, q.x);
    else if (q.a === 'remind') await setUserEvent(ctx, userId, q.e, { state: 'tracked' });
    else return c.json({ error: 'Unknown action' }, 400);
    scheduleCalendarSync(ctx, userId);
    return c.json({ ok: true });
  });

  app.get('/cal/:file', async (c) => {
    const token = c.req.param('file').replace(/\.ics$/, '');
    const row = await ctx.db.one<{ id: number }>('SELECT id FROM users WHERE calendar_token = $1', [token]);
    if (!row) return c.text('Not found', 404);
    const user = (await getUser(ctx, Number(row.id)))!;
    return c.body(await buildCalendar(ctx, user, baseUrl(ctx, c)), 200, {
      'content-type': 'text/calendar; charset=utf-8',
      'cache-control': 'no-cache',
    });
  });


  // ------------------------------------------------------------ links from calendar events (no sign-in)

  async function checkLink(c: Context, kind: string) {
    const uid = Number(c.req.param('u'));
    const id = c.req.param('id');
    const sig = c.req.param('sig');
    if (!uid || !id || !sig) return null;
    const expected = await linkSig(ctx, uid, kind, id);
    if (expected !== sig) return null;
    return { uid, id };
  }

  app.get('/l/sale/:u/:id/:sig', async (c) => {
    const ok = await checkLink(c, 'sale');
    if (!ok) return c.text('This link is no longer valid.', 404);
    return c.redirect(`/#/link/${ok.uid}/${encodeURIComponent(ok.id)}/${c.req.param('sig')}`, 302);
  });

  /** Sale data for the sign-in-free sale screen. */
  app.get('/api/link/:u/:id/:sig', async (c) => {
    const ok = await checkLink(c, 'sale');
    if (!ok) return c.json({ error: 'This link is no longer valid.' }, 404);
    const user = await getUser(ctx, ok.uid);
    if (!user) return c.json({ error: 'This link is no longer valid.' }, 404);
    const state = await buildState(ctx, user, baseUrl(ctx, c));
    const show = [...state.shows, ...state.hidden].find((s) => s.sales.some((x: any) => x.id === ok.id));
    if (!show) return c.json({ error: "This sale isn't listed anymore." }, 404);
    const base = baseUrl(ctx, c);
    const [got, hide] = await Promise.all([linkSig(ctx, ok.uid, 'got', show.id), linkSig(ctx, ok.uid, 'hide', show.id)]);
    return c.json({
      show,
      saleId: ok.id,
      name: user.name,
      links: {
        got: `${base}/l/got/${ok.uid}/${encodeURIComponent(show.id)}/${got}`,
        hide: `${base}/l/hide/${ok.uid}/${encodeURIComponent(show.id)}/${hide}`,
      },
    });
  });

  for (const kind of ['got', 'hide'] as const) {
    const verb = kind === 'got' ? 'Got tickets' : 'Not interested';
    const done = kind === 'got' ? "Enjoy the show! Reminders for it are off, and it's been removed from your calendar." : "Done. This show won't bother you again, and it's been removed from your calendar.";
    // GET shows a confirm button, so link previews and mail scanners can't trigger it.
    app.get(`/l/${kind}/:u/:id/:sig`, async (c) => {
      const ok = await checkLink(c, kind);
      if (!ok) return c.html(page('Link expired', '<p>This link is no longer valid.</p>'), 404);
      const show = await ctx.db.one<{ name: string; attraction_names: string[]; venue_name: string | null; local_date: string | null }>(
        'SELECT name, attraction_names, venue_name, local_date FROM events WHERE id = $1',
        [ok.id],
      );
      const title = show ? (show.attraction_names[0] ?? show.name) : 'this show';
      return c.html(
        page(
          verb,
          `<h1>${escHtml(title)}</h1><p class="m">${escHtml(show?.venue_name ?? '')} ${escHtml(show?.local_date ?? '')}</p>
           <form method="post"><button>${kind === 'got' ? 'Yes, I got tickets' : 'Remove this show'}</button></form>
           <p class="m"><a href="/">Open Presale Radar</a></p>`,
        ),
      );
    });
    app.post(`/l/${kind}/:u/:id/:sig`, async (c) => {
      const ok = await checkLink(c, kind);
      if (!ok) return c.html(page('Link expired', '<p>This link is no longer valid.</p>'), 404);
      await setUserEvent(ctx, ok.uid, ok.id, kind === 'got' ? { got_tickets: true } : { state: 'dismissed' });
      scheduleCalendarSync(ctx, ok.uid, 0);
      return c.html(page(verb, `<h1>${kind === 'got' ? '🎉' : '👍'}</h1><p>${done}</p><p class="m"><a href="/">Open Presale Radar</a></p>`));
    });
  }

  // ------------------------------------------------------------ everything below needs a session

  app.use('/api/*', async (c, next) => {
    const uid = await sessionUser(ctx, getCookie(c, SESSION_COOKIE));
    const user = uid ? await getUser(ctx, uid) : null;
    if (!user) return c.json({ error: 'Sign in again.' }, 401);
    c.set('user', user);
    await next();
  });

  // Anything you change can change your calendar: resync shortly after (coalesced).
  app.use('/api/*', async (c, next) => {
    await next();
    if (c.req.method !== 'GET' && c.res.ok && !c.req.path.startsWith('/api/calendar')) scheduleCalendarSync(ctx, c.get('user').id);
  });

  app.get('/api/state', async (c) => c.json(await buildState(ctx, c.get('user'), baseUrl(ctx, c))));

  app.post('/api/prefs', async (c) => {
    const user = c.get('user');
    const body = await c.req.json().catch(() => ({}));
    const prefs = normalizePrefs({ ...user.prefs, ...body }, ctx.cfg.timeZone);
    await ctx.db.query('UPDATE users SET prefs = $1::jsonb WHERE id = $2', [JSON.stringify(prefs), user.id]);
    return c.json({ prefs });
  });

  app.post('/api/onboarded', async (c) => {
    await ctx.db.query('UPDATE users SET onboarded = TRUE WHERE id = $1', [c.get('user').id]);
    // Everything that existed before setup is "seen", so nothing looks new on day one.
    await ctx.db.query(
      `INSERT INTO user_events (user_id, event_id, seen, updated_at)
       SELECT $1, e.id, TRUE, $2 FROM events e
        WHERE e.venue_id IN (SELECT venue_id FROM user_venues WHERE user_id = $1)
           OR e.attraction_ids && ARRAY(SELECT artist_id FROM user_artists WHERE user_id = $1)
       ON CONFLICT (user_id, event_id) DO UPDATE SET seen = TRUE`,
      [c.get('user').id, now(ctx)],
    );
    return c.json({ ok: true });
  });

  // ---- search

  app.get('/api/search/venues', async (c) => {
    const q = (c.req.query('q') ?? '').trim();
    if (q.length < 2) return c.json({ results: [] });
    return c.json({ results: await cached(`v:${q.toLowerCase()}`, 10 * 60_000, () => searchVenues(ctx.cfg, q)) });
  });

  app.get('/api/venues/popular', async (c) => c.json({ results: await cached('popular', 24 * 3_600_000, () => popularVenues(ctx.cfg)) }));

  app.get('/api/search/artists', async (c) => {
    const q = (c.req.query('q') ?? '').trim();
    if (q.length < 2) return c.json({ results: [] });
    return c.json({ results: await cached(`a:${q.toLowerCase()}`, 10 * 60_000, () => searchArtists(ctx.cfg, q)) });
  });

  /** Artists playing your venues soon: one-tap suggestions during setup. */
  app.get('/api/artists/suggested', async (c) => {
    const user = c.get('user');
    const rows = await ctx.db.query(
      `SELECT e.attraction_ids[1] AS id, e.attraction_names[1] AS name, COUNT(*)::int AS shows, MIN(e.start_utc) AS next
         FROM events e
        WHERE e.venue_id IN (SELECT venue_id FROM user_venues WHERE user_id = $1)
          AND cardinality(e.attraction_ids) > 0 AND (e.start_utc IS NULL OR e.start_utc > $2)
          AND NOT (e.attraction_ids[1] = ANY(ARRAY(SELECT artist_id FROM user_artists WHERE user_id = $1)))
        GROUP BY 1, 2 ORDER BY shows DESC, next ASC LIMIT 24`,
      [user.id, now(ctx)],
    );
    return c.json({ results: rows });
  });

  // ---- follows

  app.post('/api/venues', async (c) => {
    const user = c.get('user');
    const b = await c.req.json().catch(() => ({}));
    if (!b.id || !b.name) return c.json({ error: 'Missing venue' }, 400);
    await ctx.db.query('INSERT INTO venues (id, name, city) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING', [b.id, b.name, b.city ?? null]);
    await ctx.db.query(
      'INSERT INTO user_venues (user_id, venue_id, remind_all, added_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
      [user.id, b.id, !!b.remindAll, now(ctx)],
    );
    await fillNow(ctx, 'venue', b.id, b.name);
    await markExistingSeen(ctx, user.id, 'e.venue_id = $2', b.id);
    return c.json({ ok: true });
  });

  app.patch('/api/venues/:id', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    await ctx.db.query('UPDATE user_venues SET remind_all = $1 WHERE user_id = $2 AND venue_id = $3', [!!b.remindAll, c.get('user').id, c.req.param('id')]);
    return c.json({ ok: true });
  });

  app.delete('/api/venues/:id', async (c) => {
    await ctx.db.query('DELETE FROM user_venues WHERE user_id = $1 AND venue_id = $2', [c.get('user').id, c.req.param('id')]);
    return c.json({ ok: true });
  });

  app.post('/api/artists', async (c) => {
    const user = c.get('user');
    const b = await c.req.json().catch(() => ({}));
    if (!b.id || !b.name) return c.json({ error: 'Missing artist' }, 400);
    const mode = b.mode === 'mute' ? 'mute' : 'follow';
    await ctx.db.query('INSERT INTO artists (id, name, image) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET image = COALESCE(excluded.image, artists.image)', [b.id, b.name, b.image ?? null]);
    await ctx.db.query(
      `INSERT INTO user_artists (user_id, artist_id, mode, added_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, artist_id) DO UPDATE SET mode = excluded.mode`,
      [user.id, b.id, mode, now(ctx)],
    );
    if (mode === 'follow') {
      await fillNow(ctx, 'artist', b.id, b.name);
      await markExistingSeen(ctx, user.id, '$2 = ANY(e.attraction_ids)', b.id);
    }
    return c.json({ ok: true });
  });

  app.delete('/api/artists/:id', async (c) => {
    await ctx.db.query('DELETE FROM user_artists WHERE user_id = $1 AND artist_id = $2', [c.get('user').id, c.req.param('id')]);
    return c.json({ ok: true });
  });

  // ---- shows

  app.post('/api/shows/:id', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const patch: Parameters<typeof setUserEvent>[3] = {};
    if (b.state === 'auto' || b.state === 'tracked' || b.state === 'dismissed') patch.state = b.state;
    if (typeof b.gotTickets === 'boolean') patch.got_tickets = b.gotTickets;
    if (typeof b.watchSoldout === 'boolean') patch.watch_soldout = b.watchSoldout;
    if (typeof b.seen === 'boolean') patch.seen = b.seen;
    if (b.resale && typeof b.resale === 'object') {
      const watch = b.resale.watch === true ? true : b.resale.watch === false ? false : null;
      const target = Number(b.resale.target);
      patch.resale = { watch, target: Number.isFinite(target) && target > 0 ? Math.round(target) : null };
    }
    await setUserEvent(ctx, c.get('user').id, c.req.param('id'), patch);
    return c.json({ ok: true });
  });

  app.post('/api/shows/seen', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const ids: string[] = Array.isArray(b.ids) ? b.ids.slice(0, 500).map(String) : [];
    for (const id of ids) await setUserEvent(ctx, c.get('user').id, id, { seen: true });
    return c.json({ ok: true });
  });

  app.post('/api/mute-artist', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    if (!b.id) return c.json({ error: 'Missing artist' }, 400);
    await ctx.db.query('INSERT INTO artists (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [b.id, b.name ?? b.id]);
    await muteArtist(ctx, c.get('user').id, b.id);
    return c.json({ ok: true });
  });

  // ---- codes

  app.post('/api/sales/:id/code', async (c) => {
    const user = c.get('user');
    const saleId = c.req.param('id');
    const b = await c.req.json().catch(() => ({}));
    const code = String(b.code ?? '').trim().slice(0, 40);
    if (!code) {
      await ctx.db.query('DELETE FROM user_sale_codes WHERE user_id = $1 AND sale_id = $2', [user.id, saleId]);
      return c.json({ ok: true });
    }
    await ctx.db.query(
      'INSERT INTO user_sale_codes (user_id, sale_id, code) VALUES ($1, $2, $3) ON CONFLICT (user_id, sale_id) DO UPDATE SET code = excluded.code',
      [user.id, saleId, code],
    );
    if (b.remember) {
      const ev = await ctx.db.one<{ attraction_ids: string[] }>('SELECT e.attraction_ids FROM sales s JOIN events e ON e.id = s.event_id WHERE s.id = $1', [saleId]);
      const artistId = ev?.attraction_ids?.[0];
      if (artistId)
        await ctx.db.query(
          `INSERT INTO user_artist_codes (user_id, artist_id, sale_slug, code, updated_at) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (user_id, artist_id, sale_slug) DO UPDATE SET code = excluded.code, updated_at = excluded.updated_at`,
          [user.id, artistId, saleSlug(saleId), code, now(ctx)],
        );
    }
    return c.json({ ok: true });
  });

  app.post('/api/codes/vote', async (c) => {
    const user = c.get('user');
    const b = await c.req.json().catch(() => ({}));
    const vote = b.vote === 1 ? 1 : b.vote === -1 ? -1 : 0;
    const keyParams = [String(b.scope ?? ''), String(b.key ?? ''), String(b.code ?? '')];
    if (!keyParams[0] || !keyParams[2]) return c.json({ error: 'Missing code' }, 400);
    if (vote === 0) await ctx.db.query('DELETE FROM code_votes WHERE user_id = $1 AND scope = $2 AND key = $3 AND code = $4', [user.id, ...keyParams]);
    else
      await ctx.db.query(
        `INSERT INTO code_votes (user_id, scope, key, code, vote) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (user_id, scope, key, code) DO UPDATE SET vote = excluded.vote`,
        [user.id, ...keyParams, vote],
      );
    await ctx.db.query(
      `UPDATE web_codes SET votes = COALESCE((SELECT SUM(vote) FROM code_votes v WHERE v.scope = $1 AND v.key = $2 AND v.code = $3), 0)
        WHERE scope = $1 AND key = $2 AND code = $3`,
      keyParams,
    );
    return c.json({ ok: true });
  });

  app.post('/api/code-sources', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    let url: URL;
    try {
      url = new URL(String(b.url ?? ''));
      if (!/^https?:$/.test(url.protocol)) throw new Error();
    } catch {
      return c.json({ error: 'Enter a full web address, starting with https://' }, 400);
    }
    await ctx.db.query(
      `INSERT INTO code_sources (url, kind, label, added_by) VALUES ($1, 'generic', $2, $3) ON CONFLICT (url) DO UPDATE SET enabled = TRUE`,
      [url.toString(), String(b.label ?? url.hostname).slice(0, 80), c.get('user').id],
    );
    findCodes(ctx, { force: true }).catch((e) => console.error('[codes]', e));
    return c.json({ ok: true });
  });

  app.delete('/api/code-sources', async (c) => {
    const url = c.req.query('url') ?? '';
    const user = c.get('user');
    const src = await ctx.db.one<{ kind: string; added_by: number | null }>('SELECT kind, added_by FROM code_sources WHERE url = $1', [url]);
    if (!src) return c.json({ ok: true });
    if (user.role !== 'owner' && Number(src.added_by) !== user.id) return c.json({ error: 'Only the owner or whoever added it can remove this.' }, 403);
    if (src.kind === 'livenation') await ctx.db.query('UPDATE code_sources SET enabled = FALSE WHERE url = $1', [url]);
    else await ctx.db.query('DELETE FROM code_sources WHERE url = $1', [url]);
    return c.json({ ok: true });
  });

  app.post('/api/codes/refresh', async (c) => c.json(await findCodes(ctx, { force: true })));

  // ---- push

  app.post('/api/push/subscribe', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const sub = b.subscription ?? b;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return c.json({ error: 'Invalid subscription' }, 400);
    await ctx.db.query(
      `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, user_agent, created_at) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, failures = 0`,
      [sub.endpoint, c.get('user').id, sub.keys.p256dh, sub.keys.auth, c.req.header('user-agent')?.slice(0, 200) ?? null, now(ctx)],
    );
    return c.json({ ok: true });
  });

  app.post('/api/push/unsubscribe', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    await ctx.db.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2', [String(b.endpoint ?? ''), c.get('user').id]);
    return c.json({ ok: true });
  });

  app.post('/api/push/test', async (c) => {
    const n = await pushToUser(ctx, c.get('user').id, { title: 'Notifications are on', body: "You'll hear from us only when it matters.", url: '/#/settings', tag: 'test' });
    return c.json({ delivered: n });
  });

  app.post('/api/digest/preview', async (c) => c.json({ sent: await previewDigest(ctx, c.get('user').id) }));

  // ---- calendar sync

  app.post('/api/calendar/icloud', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const email = String(b.email ?? '').trim();
    const password = String(b.password ?? '').trim();
    if (!email || !password) return c.json({ error: 'Enter your Apple ID email and an app-specific password.' }, 400);
    try {
      const r = await connectICloud(ctx, c.get('user').id, email, password, ctx.cfg.demo && process.env.CALDAV_TEST_SERVER ? process.env.CALDAV_TEST_SERVER : undefined);
      return c.json({ ok: true, ...r });
    } catch (err: any) {
      return c.json({ error: err instanceof DavError ? err.message : "Couldn't reach iCloud. Try again in a minute." }, 400);
    }
  });

  app.post('/api/calendar/sync', async (c) => {
    scheduleCalendarSync(ctx, c.get('user').id, 0);
    return c.json({ ok: true });
  });

  app.delete('/api/calendar', async (c) => {
    await disconnectCalendar(ctx, c.get('user').id, c.req.query('remove') === '1');
    return c.json({ ok: true });
  });

  // ---- activity

  app.post('/api/activity/read', async (c) => {
    await ctx.db.query('UPDATE activity SET read = TRUE WHERE user_id = $1 AND read = FALSE', [c.get('user').id]);
    return c.json({ ok: true });
  });

  // ---- refresh

  app.post('/api/refresh', async (c) => {
    const r = await ctx.db.withLock(7_321_001, () => syncDue(ctx, { limit: 30 }));
    return c.json(r ?? { busy: true });
  });

  // ---- people (owner)

  app.post('/api/invites', async (c) => {
    const user = c.get('user');
    if (user.role !== 'owner') return c.json({ error: 'Only the owner can invite people.' }, 403);
    const b = await c.req.json().catch(() => ({}));
    const { token, expiresAt } = await createInvite(ctx, user.id, b.note ? String(b.note) : null);
    return c.json({ url: `${baseUrl(ctx, c)}/#/join/${token}`, expiresAt });
  });

  app.delete('/api/users/:id', async (c) => {
    const user = c.get('user');
    const id = Number(c.req.param('id'));
    if (user.role !== 'owner' || id === user.id) return c.json({ error: 'Not allowed' }, 403);
    await ctx.db.query('DELETE FROM users WHERE id = $1', [id]);
    return c.json({ ok: true });
  });

  app.post('/api/account', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const name = String(b.name ?? '').trim().slice(0, 60);
    if (name) await ctx.db.query('UPDATE users SET name = $1 WHERE id = $2', [name, c.get('user').id]);
    return c.json({ ok: true });
  });

  if (ctx.cfg.demo) {
    // Demo only: pretend a new show was just announced at one of your venues, then run a tick.
    app.post('/api/demo/tick', async (c) => {
      const announced = await demoAnnounce(ctx, c.get('user').id);
      return c.json({ announced, tick: await tick(ctx) });
    });
  }

  // ------------------------------------------------------------ the app itself

  app.use('/*', serveStatic({ root: './public' }));
  app.get('*', serveStatic({ path: './public/index.html' }));

  return app;
}

async function muteArtist(ctx: Ctx, userId: number, artistId: string) {
  await ctx.db.query('INSERT INTO artists (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [artistId]);
  await ctx.db.query(
    `INSERT INTO user_artists (user_id, artist_id, mode, added_at) VALUES ($1, $2, 'mute', $3)
     ON CONFLICT (user_id, artist_id) DO UPDATE SET mode = 'mute'`,
    [userId, artistId, now(ctx)],
  );
  // Fix the placeholder name if we know the real one.
  await ctx.db.query(
    `UPDATE artists a SET name = e.attraction_names[array_position(e.attraction_ids, a.id)]
       FROM events e WHERE a.id = $1 AND a.name = a.id AND a.id = ANY(e.attraction_ids)`,
    [artistId],
  );
}

/** Shows that already existed when you followed something aren't "new" to you. */
async function markExistingSeen(ctx: Ctx, userId: number, where: string, id: string) {
  await ctx.db.query(
    `INSERT INTO user_events (user_id, event_id, seen, updated_at)
     SELECT $1, e.id, TRUE, $3 FROM events e WHERE ${where}
     ON CONFLICT (user_id, event_id) DO UPDATE SET seen = TRUE`,
    [userId, id, now(ctx)],
  );
}

async function demoAnnounce(ctx: Ctx, userId: number): Promise<string | null> {
  const venue = await ctx.db.one<{ id: string; name: string }>(
    'SELECT v.id, v.name FROM user_venues uv JOIN venues v ON v.id = uv.venue_id WHERE uv.user_id = $1 ORDER BY random() LIMIT 1',
    [userId],
  );
  if (!venue) return null;
  const names = ['Neon Orchard', 'The Quiet Harbour', 'Static Bloom', 'Paper Lanterns', 'Midnight Ferry', 'Golden Hour Club'];
  const t = now(ctx);
  const artist = names[Math.floor(Math.random() * names.length)];
  const id = `demo-x-${t}`;
  const day = 86_400_000;
  const raw = {
    id,
    name: artist,
    url: 'https://www.ticketmaster.ca/',
    images: [],
    dates: { start: { localDate: new Date(t + 75 * day).toISOString().slice(0, 10), localTime: '20:00:00', dateTime: new Date(t + 75 * day).toISOString() }, status: { code: 'onsale' } },
    sales: {
      public: { startDateTime: new Date(t + 3 * day).toISOString() },
      presales: [{ name: 'Artist Presale', description: 'Code sent to mailing list subscribers.', startDateTime: new Date(t + 2 * day).toISOString() }],
    },
    _embedded: { venues: [{ id: venue.id, name: venue.name, city: { name: 'Toronto' } }], attractions: [{ id: `demo-a-${artist.toLowerCase().replace(/\W+/g, '-')}`, name: artist }] },
  };
  const { event, sales } = normalizeEvent(raw);
  const changes = await upsertEvent(ctx, event, sales, false);
  await fanOut(ctx, changes);
  return `${artist} at ${venue.name}`;
}

/** First sync for a newly followed venue or artist, so the app fills in right away (silently). */
async function fillNow(ctx: Ctx, type: 'venue' | 'artist', id: string, name: string) {
  const table = type === 'venue' ? 'venues' : 'artists';
  const row = await ctx.db.one<{ last_synced: number | null }>(`SELECT last_synced FROM ${table} WHERE id = $1`, [id]);
  if (row?.last_synced) return;
  try {
    await syncSource(ctx, { type, id, name, lastSynced: null });
  } catch (err) {
    console.error('[fill]', err);
  }
}

function escHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)} · Presale Radar</title>
<style>body{font:17px/1.5 -apple-system,system-ui,sans-serif;background:#0f0f12;color:#f4f3f0;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
main{max-width:380px;padding:32px 24px;text-align:center}h1{font-size:28px;margin:0 0 8px}.m{color:rgba(244,243,240,.6);font-size:15px}
button{width:100%;margin:22px 0 8px;padding:16px;border:0;border-radius:16px;background:#ff5a36;color:#fff;font:600 17px -apple-system,system-ui,sans-serif}
a{color:#ff8a6e}@media(prefers-color-scheme:light){body{background:#f6f5f2;color:#16161a}.m{color:rgba(22,22,26,.6)}}</style></head>
<body><main>${body}</main></body></html>`;
}
