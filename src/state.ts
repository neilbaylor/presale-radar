/** Everything the app needs for one person, in one request. */
import type { Ctx, EventRow, SaleRow, User } from './types.js';
import { codesForSale, getFollows, interest, loadCodeContext, now } from './db.js';
import { inventoryEnabled } from './availability.js';
import { isWatching, seatgeekEnabled } from './seatgeek.js';

export async function buildState(ctx: Ctx, user: User, baseUrl: string) {
  const t = now(ctx);
  const follows = await getFollows(ctx, user.id);
  const venueIds = [...follows.venues.keys()];
  const artistIds = [...follows.artists, ...follows.muted];

  const events = await ctx.db.query<EventRow>(
    `SELECT e.* FROM events e
      WHERE (e.start_utc IS NULL OR e.start_utc > $1)
        AND (e.venue_id = ANY($2::text[]) OR e.attraction_ids && $3::text[]
             OR EXISTS (SELECT 1 FROM user_events ue WHERE ue.user_id = $4 AND ue.event_id = e.id AND ue.state <> 'auto'))
      ORDER BY e.start_utc ASC NULLS LAST
      LIMIT 1200`,
    [t - 6 * 3_600_000, venueIds, artistIds, user.id],
  );
  const ids = events.map((e) => e.id);
  const [sales, ueRows, codes] = await Promise.all([
    ctx.db.query<SaleRow>('SELECT * FROM sales WHERE event_id = ANY($1::text[]) AND removed = FALSE ORDER BY start_utc ASC NULLS LAST', [ids]),
    ctx.db.query<any>('SELECT * FROM user_events WHERE user_id = $1 AND event_id = ANY($2::text[])', [user.id, ids]),
    loadCodeContext(ctx, user.id),
  ]);
  const ue = new Map(ueRows.map((r) => [r.event_id, r]));
  const salesBy = new Map<string, SaleRow[]>();
  for (const s of sales) {
    const list = salesBy.get(s.event_id) ?? [];
    list.push(s);
    salesBy.set(s.event_id, list);
  }

  const shows = [];
  const hidden = [];
  for (const e of events) {
    const st = ue.get(e.id);
    const { level, reason } = interest(e, st, follows);
    const show = {
      id: e.id,
      name: e.name,
      artist: e.attraction_names[0] ?? e.name,
      artistId: e.attraction_ids[0] ?? null,
      artists: e.attraction_names,
      url: e.url,
      image: e.image || null,
      date: e.local_date,
      time: e.local_time,
      startUtc: e.start_utc,
      venue: e.venue_name,
      venueId: e.venue_id,
      city: e.city,
      status: e.status,
      priceMin: e.price_min,
      priceMax: e.price_max,
      currency: e.currency,
      availability: e.availability,
      source: e.source ?? 'ticketmaster',
      resale: e.sg_id
        ? {
            low: e.resale_low ?? null,
            count: e.resale_count ?? null,
            checkedAt: e.resale_at ?? null,
            url: e.sg_url ?? null,
            target: st?.resale_target ?? e.price_min ?? null,
            customTarget: st?.resale_target ?? null,
            watching: isWatching(st, level, (salesBy.get(e.id) ?? []).some((s) => s.kind === 'public' && s.start_utc !== null && s.start_utc < t) || e.source === 'seatgeek'),
            explicit: st?.resale_watch ?? null,
          }
        : null,
      firstSeen: e.first_seen,
      level,
      reason,
      starred: st?.state === 'tracked',
      gotTickets: !!st?.got_tickets,
      watchSoldout: st?.watch_soldout ?? true,
      isNew: !st?.seen && t - e.first_seen < 7 * 86_400_000,
      sales: (salesBy.get(e.id) ?? []).map((s) => ({
        id: s.id,
        kind: s.kind,
        name: s.kind === 'public' ? 'Public on-sale' : s.name,
        description: s.description,
        url: s.url ?? e.url,
        startUtc: s.start_utc,
        endUtc: s.end_utc,
        startTbd: s.start_tbd,
        requirement: s.requirement,
        codes: codesForSale(s, e.attraction_ids, codes),
      })),
    };
    if (level === 'hidden') {
      if (reason === 'hidden' || reason === 'muted') hidden.push(show);
    } else shows.push(show);
  }

  // Sign-up deadlines for artists you follow (from Ticketmaster help articles).
  const signupRows = await ctx.db.query<any>(
    `SELECT n.artist_id AS "artistId", a.name AS artist, n.label, n.at_utc AS "at", n.url, n.signup_url AS "signupUrl",
            EXISTS (SELECT 1 FROM job_marks m WHERE m.key = 'signed:' || $1::text || ':' || n.artist_id || ':' || n.label || ':' || n.at_utc) AS done
       FROM artist_notes n JOIN artists a ON a.id = n.artist_id
      WHERE n.kind = 'signup_deadline' AND n.at_utc > $2
        AND EXISTS (SELECT 1 FROM user_artists ua WHERE ua.user_id = $1::bigint AND ua.artist_id = n.artist_id AND ua.mode = 'follow')
      ORDER BY n.at_utc`,
    [user.id, t],
  );
  const venuePages = await ctx.db.query(
    `SELECT p.url, p.venue_id AS "venueId", v.name AS venue, p.label, p.last_checked AS "lastChecked", p.last_error AS "lastError", p.last_found AS "lastFound"
       FROM venue_pages p LEFT JOIN venues v ON v.id = p.venue_id ORDER BY v.name NULLS LAST, p.url`,
  );
  const budgets = await ctx.db.query<{ provider: string; calls: number }>(`SELECT provider, calls FROM api_usage WHERE day = $1`, [new Date(t).toISOString().slice(0, 10)]);
  const calendar = await ctx.db.one<any>(
    `SELECT provider, username, status, last_error AS "lastError", last_sync AS "lastSync",
            (SELECT COUNT(*)::int FROM calendar_items i WHERE i.user_id = a.user_id) AS events
       FROM calendar_accounts a WHERE user_id = $1`,
    [user.id],
  );
  const [venues, artists, activity, sources, jobs, devices, members, artistCodes] = await Promise.all([
    ctx.db.query(
      `SELECT v.id, v.name, v.city, uv.remind_all AS "remindAll", v.last_synced AS "lastSynced", v.last_error AS "lastError"
         FROM user_venues uv JOIN venues v ON v.id = uv.venue_id WHERE uv.user_id = $1 ORDER BY v.name`,
      [user.id],
    ),
    ctx.db.query(
      `SELECT a.id, a.name, a.image, ua.mode, a.last_synced AS "lastSynced", a.last_error AS "lastError"
         FROM user_artists ua JOIN artists a ON a.id = ua.artist_id WHERE ua.user_id = $1 ORDER BY a.name`,
      [user.id],
    ),
    ctx.db.query(
      `SELECT id, ts, type, priority, event_id AS "eventId", sale_id AS "saleId", title, body, url, read, pushed_at AS "pushedAt"
         FROM activity WHERE user_id = $1 ORDER BY ts DESC LIMIT 80`,
      [user.id],
    ),
    ctx.db.query(
      `SELECT url, kind, label, enabled, last_checked AS "lastChecked", last_error AS "lastError", last_found AS "lastFound"
         FROM code_sources ORDER BY kind DESC, url`,
    ),
    ctx.db.query(`SELECT job, last_end AS "lastEnd", last_error AS "lastError", summary FROM job_runs`),
    ctx.db.one<{ n: number }>('SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE user_id = $1', [user.id]),
    user.role === 'owner'
      ? ctx.db.query(`SELECT id, name, email, role, created_at AS "createdAt" FROM users ORDER BY id`)
      : Promise.resolve([]),
    ctx.db.query(
      `SELECT c.artist_id AS "artistId", a.name AS artist, c.sale_slug AS "saleSlug", c.code
         FROM user_artist_codes c LEFT JOIN artists a ON a.id = c.artist_id WHERE c.user_id = $1`,
      [user.id],
    ),
  ]);

  return {
    now: t,
    me: { id: user.id, name: user.name, email: user.email, role: user.role, prefs: user.prefs, onboarded: user.onboarded },
    shows,
    hidden: hidden.slice(0, 80),
    venues,
    artists: artists.filter((a: any) => a.mode === 'follow'),
    muted: artists.filter((a: any) => a.mode === 'mute'),
    artistCodes,
    activity,
    codeSources: sources,
    jobs: Object.fromEntries(jobs.map((j: any) => [j.job, j])),
    members,
    features: {
      push: !!(ctx.cfg.vapidPublicKey && ctx.cfg.vapidPrivateKey),
      vapidPublicKey: ctx.cfg.vapidPublicKey,
      pushDevices: devices?.n ?? 0,
      webSearch: !!ctx.cfg.braveApiKey || ctx.cfg.demo,
      soldOutWatch: inventoryEnabled(ctx),
      seatgeek: seatgeekEnabled(ctx),
      x: !!ctx.cfg.xBearerToken,
      xLimit: ctx.cfg.xDailyPosts,
      ticketmaster: !!ctx.cfg.tmApiKey || ctx.cfg.demo,
      demo: ctx.cfg.demo,
    },
    calendarUrl: `${baseUrl}/cal/${user.calendar_token}.ics`,
    calendar: calendar ?? null,
    signups: signupRows,
    venuePages,
    budgets: Object.fromEntries(budgets.map((b) => [b.provider, b.calls])),
  };
}
