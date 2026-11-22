import type { Ctx, EventRow, Level, Prefs, SaleRow, Source, User, UserEventRow } from './types.js';
import { DEFAULT_PREFS } from './types.js';

export const now = (ctx: Ctx) => (ctx.now ? ctx.now() : Date.now());

export async function getSetting<T>(ctx: Ctx, key: string, fallback: T): Promise<T> {
  const row = await ctx.db.one<{ value: T }>('SELECT value FROM settings WHERE key = $1', [key]);
  return row ? row.value : fallback;
}

export async function setSetting(ctx: Ctx, key: string, value: unknown): Promise<void> {
  await ctx.db.query(
    'INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    [key, JSON.stringify(value)],
  );
}

// ---------------------------------------------------------------- users

export function normalizePrefs(raw: Partial<Prefs> | null | undefined, defaultTz: string): Prefs {
  const p = raw ?? {};
  const hour = (v: unknown, d: number) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 23 ? (v as number) : d);
  const mins = Array.isArray(p.reminderMinutes)
    ? [...new Set(p.reminderMinutes.map(Number).filter((n) => Number.isFinite(n) && n >= 1 && n <= 24 * 60))].sort((a, b) => b - a)
    : DEFAULT_PREFS.reminderMinutes;
  let timeZone = typeof p.timeZone === 'string' && p.timeZone ? p.timeZone : defaultTz;
  try {
    new Intl.DateTimeFormat('en', { timeZone });
  } catch {
    timeZone = defaultTz;
  }
  return {
    reminderMinutes: mins,
    openPush: typeof p.openPush === 'boolean' ? p.openPush : DEFAULT_PREFS.openPush,
    quietStart: hour(p.quietStart, DEFAULT_PREFS.quietStart),
    quietEnd: hour(p.quietEnd, DEFAULT_PREFS.quietEnd),
    digestHour: hour(p.digestHour, DEFAULT_PREFS.digestHour),
    timeZone,
  };
}

function toUser(ctx: Ctx, r: any): User {
  return {
    id: Number(r.id),
    name: r.name,
    email: r.email,
    role: r.role,
    prefs: normalizePrefs(r.prefs, ctx.cfg.timeZone),
    calendar_token: r.calendar_token,
    onboarded: r.onboarded,
    last_digest: r.last_digest,
    last_push_at: r.last_push_at,
  };
}

export async function getUsers(ctx: Ctx): Promise<User[]> {
  return (await ctx.db.query('SELECT * FROM users ORDER BY id')).map((r) => toUser(ctx, r));
}

export async function getUser(ctx: Ctx, id: number): Promise<User | null> {
  const r = await ctx.db.one('SELECT * FROM users WHERE id = $1', [id]);
  return r ? toUser(ctx, r) : null;
}

// ---------------------------------------------------------------- interest

export interface Follows {
  venues: Map<string, { remindAll: boolean }>;
  artists: Set<string>;
  muted: Set<string>;
}

export async function getFollows(ctx: Ctx, userId: number): Promise<Follows> {
  const [v, a] = await Promise.all([
    ctx.db.query<{ venue_id: string; remind_all: boolean }>('SELECT venue_id, remind_all FROM user_venues WHERE user_id = $1', [userId]),
    ctx.db.query<{ artist_id: string; mode: string }>('SELECT artist_id, mode FROM user_artists WHERE user_id = $1', [userId]),
  ]);
  const artists = new Set<string>();
  const muted = new Set<string>();
  for (const r of a) (r.mode === 'mute' ? muted : artists).add(r.artist_id);
  return { venues: new Map(v.map((r) => [r.venue_id, { remindAll: r.remind_all }])), artists, muted };
}

/** Everyone's follows at once, for fanning out changes. */
export async function getAllFollows(ctx: Ctx): Promise<Map<number, Follows>> {
  const out = new Map<number, Follows>();
  const get = (id: number) => {
    let f = out.get(id);
    if (!f) out.set(id, (f = { venues: new Map(), artists: new Set(), muted: new Set() }));
    return f;
  };
  for (const u of await ctx.db.query<{ id: number }>('SELECT id FROM users')) get(Number(u.id));
  for (const r of await ctx.db.query<{ user_id: number; venue_id: string; remind_all: boolean }>('SELECT user_id, venue_id, remind_all FROM user_venues'))
    get(Number(r.user_id)).venues.set(r.venue_id, { remindAll: r.remind_all });
  for (const r of await ctx.db.query<{ user_id: number; artist_id: string; mode: string }>('SELECT user_id, artist_id, mode FROM user_artists')) {
    const f = get(Number(r.user_id));
    (r.mode === 'mute' ? f.muted : f.artists).add(r.artist_id);
  }
  return out;
}

export type InterestReason = 'starred' | 'artist' | 'venue_all' | 'venue' | 'hidden' | 'muted' | 'none';

/**
 * How much a user cares about a show:
 *  - remind: you starred it, follow the artist, or asked for every show at that venue
 *  - feed:   it's at a venue you follow (shows up in the app and the digest only)
 *  - hidden: you hid it, muted the artist, or follow nothing related
 */
export function interest(
  e: Pick<EventRow, 'venue_id' | 'attraction_ids'>,
  ue: Pick<UserEventRow, 'state'> | null | undefined,
  f: Follows,
): { level: Level; reason: InterestReason } {
  if (ue?.state === 'dismissed') return { level: 'hidden', reason: 'hidden' };
  if (ue?.state === 'tracked') return { level: 'remind', reason: 'starred' };
  const attractions = e.attraction_ids ?? [];
  if (attractions.some((id) => f.muted.has(id))) return { level: 'hidden', reason: 'muted' };
  if (attractions.some((id) => f.artists.has(id))) return { level: 'remind', reason: 'artist' };
  const v = e.venue_id ? f.venues.get(e.venue_id) : undefined;
  if (v) return v.remindAll ? { level: 'remind', reason: 'venue_all' } : { level: 'feed', reason: 'venue' };
  return { level: 'hidden', reason: 'none' };
}

export async function userEventMap(ctx: Ctx, eventIds: string[]): Promise<Map<string, UserEventRow>> {
  if (!eventIds.length) return new Map();
  const rows = await ctx.db.query<UserEventRow>('SELECT * FROM user_events WHERE event_id = ANY($1::text[])', [eventIds]);
  return new Map(rows.map((r) => [`${r.user_id}:${r.event_id}`, { ...r, user_id: Number(r.user_id) }]));
}

export async function setUserEvent(
  ctx: Ctx,
  userId: number,
  eventId: string,
  patch: Partial<Pick<UserEventRow, 'state' | 'got_tickets' | 'watch_soldout' | 'seen'>> & {
    resale?: { watch: boolean | null; target: number | null };
  },
): Promise<void> {
  await ctx.db.query(
    `INSERT INTO user_events (user_id, event_id, state, got_tickets, watch_soldout, seen, updated_at)
     VALUES ($1, $2, COALESCE($3, 'auto'), COALESCE($4, FALSE), COALESCE($5, TRUE), COALESCE($6, FALSE), $7)
     ON CONFLICT (user_id, event_id) DO UPDATE SET
       state = COALESCE($3, user_events.state),
       got_tickets = COALESCE($4, user_events.got_tickets),
       watch_soldout = COALESCE($5, user_events.watch_soldout),
       seen = COALESCE($6, user_events.seen),
       updated_at = $7`,
    [userId, eventId, patch.state ?? null, patch.got_tickets ?? null, patch.watch_soldout ?? null, patch.seen ?? null, now(ctx)],
  );
  if (patch.resale) {
    // Changing the target or turning the watch on starts fresh, so the next dip alerts.
    await ctx.db.query(
      'UPDATE user_events SET resale_watch = $1, resale_target = $2, resale_alerted = NULL WHERE user_id = $3 AND event_id = $4',
      [patch.resale.watch, patch.resale.target, userId, eventId],
    );
  }
}

// ---------------------------------------------------------------- sources

/** Venues and artists at least one person follows and that are due for a refresh. */
export async function dueSources(ctx: Ctx, _intervalMin?: number, limit = 500): Promise<Source[]> {
  const rows = await ctx.db.query<{ type: 'venue' | 'artist'; id: string; name: string; last_synced: number | null }>(
    `SELECT * FROM (
       SELECT 'venue' AS type, v.id, v.name, v.last_synced, v.next_sync FROM venues v
        WHERE EXISTS (SELECT 1 FROM user_venues uv WHERE uv.venue_id = v.id)
       UNION ALL
       SELECT 'artist' AS type, a.id, a.name, a.last_synced, a.next_sync FROM artists a
        WHERE EXISTS (SELECT 1 FROM user_artists ua WHERE ua.artist_id = a.id AND ua.mode = 'follow')
     ) s
     WHERE COALESCE(next_sync, 0) <= $1
     ORDER BY next_sync ASC NULLS FIRST
     LIMIT $2`,
    [now(ctx), limit],
  );
  return rows.map((r) => ({ type: r.type, id: r.id, name: r.name, lastSynced: r.last_synced }));
}

/** Weekday mornings in Toronto, when tours are usually announced and presales open. */
export function inAnnouncementWindow(ms: number, timeZone: string): boolean {
  const p = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' })
    .formatToParts(new Date(ms))
    .reduce<Record<string, string>>((a, x) => ((a[x.type] = x.value), a), {});
  const hour = Number(p.hour) % 24;
  return !['Sat', 'Sun'].includes(p.weekday) && hour >= 9 && hour < 12;
}

/**
 * How long until a source should be checked again:
 *   15 min  if it has a sale in the next 48 hours or changed in the last day
 *   60 min  normally (SYNC_INTERVAL_MIN)
 *   3 hours if nothing changed for a week
 * Weekday mornings cap it at 20 minutes, failures back off (5, 10, 20... up to 6 hours),
 * a busy daily budget triples it, and ±10% jitter spreads the load.
 */
export function nextSyncDelayMin(o: {
  base: number;
  hot: boolean;
  lastChange: number | null;
  firstSync: number | null;
  t: number;
  announcement: boolean;
  failCount: number;
  budgetRatio: number;
  jitter?: number; // -1..1, injectable for tests
}): number {
  if (o.failCount > 0) return Math.min(5 * 2 ** (o.failCount - 1), 360);
  const quietSince = o.lastChange ?? o.firstSync ?? o.t;
  let m = o.hot || (o.lastChange && o.t - o.lastChange < 86_400_000) ? 15 : o.t - quietSince > 7 * 86_400_000 ? 180 : o.base;
  if (o.announcement) m = Math.min(m, 20);
  if (o.budgetRatio > 0.8) m *= 3;
  const j = o.jitter ?? Math.random() * 2 - 1;
  return Math.max(5, Math.round(m * (1 + 0.1 * j)));
}

export async function markSourceSynced(ctx: Ctx, s: Source, error: string | null, changed = false, budgetRatio = 0): Promise<void> {
  const table = s.type === 'venue' ? 'venues' : 'artists';
  const t = now(ctx);
  const row = await ctx.db.one<{ fail_count: number; last_change: number | null }>(`SELECT fail_count, last_change FROM ${table} WHERE id = $1`, [s.id]);
  const failCount = error ? (row?.fail_count ?? 0) + 1 : 0;
  const lastChange = changed ? t : row?.last_change ?? null;
  const hot = await ctx.db.one(
    `SELECT 1 FROM sales sa JOIN events e ON e.id = sa.event_id
      WHERE sa.removed = FALSE AND sa.start_utc BETWEEN $1 AND $2
        AND ${s.type === 'venue' ? 'e.venue_id = $3' : '$3 = ANY(e.attraction_ids)'} LIMIT 1`,
    [t, t + 48 * 3_600_000, s.id],
  );
  const delay = nextSyncDelayMin({
    base: ctx.cfg.syncIntervalMin,
    hot: !!hot,
    lastChange,
    firstSync: s.lastSynced,
    t,
    announcement: inAnnouncementWindow(t, ctx.cfg.timeZone),
    failCount,
    budgetRatio,
  });
  await ctx.db.query(
    `UPDATE ${table} SET last_synced = $1, last_error = $2, fail_count = $3, last_change = $4, next_sync = $5 WHERE id = $6`,
    [t, error, failCount, lastChange, t + delay * 60_000, s.id],
  );
}

export async function prune(ctx: Ctx): Promise<void> {
  const t = now(ctx);
  const cutoffDate = new Date(t - 2 * 86_400_000).toISOString().slice(0, 10);
  await ctx.db.query(
    `DELETE FROM events
      WHERE (start_utc IS NOT NULL AND start_utc < $1)
         OR (start_utc IS NULL AND local_date IS NOT NULL AND local_date < $2)`,
    [t - 2 * 86_400_000, cutoffDate],
  );
  await ctx.db.query('DELETE FROM activity WHERE ts < $1', [t - 60 * 86_400_000]);
  await ctx.db.query('DELETE FROM web_codes WHERE last_seen < $1 AND votes <= 0', [t - 45 * 86_400_000]);
  await ctx.db.query('DELETE FROM code_searches WHERE ran_at < $1', [t - 14 * 86_400_000]);
  await ctx.db.query('DELETE FROM sessions WHERE expires_at < $1', [t]);
  await ctx.db.query('DELETE FROM user_sale_codes WHERE sale_id NOT IN (SELECT id FROM sales)');
  // Venues and artists nobody follows anymore.
  await ctx.db.query('DELETE FROM venues v WHERE NOT EXISTS (SELECT 1 FROM user_venues uv WHERE uv.venue_id = v.id)');
  await ctx.db.query(
    `DELETE FROM artists a WHERE NOT EXISTS (SELECT 1 FROM user_artists ua WHERE ua.artist_id = a.id)
       AND NOT EXISTS (SELECT 1 FROM user_artist_codes c WHERE c.artist_id = a.id)`,
  );
}

// ---------------------------------------------------------------- codes

export interface CodeCandidate {
  code: string;
  source: 'you' | 'saved' | 'ticketmaster' | 'livenation' | 'web';
  score: number;               // 0..1
  confidence: 'high' | 'medium' | 'low';
  scope?: string;
  key?: string;
  domains?: string[];
  sourceUrl?: string;
  snippet?: string | null;
  votes?: number;
  myVote?: number;
}

export function saleSlug(saleId: string): string {
  return saleId.slice(saleId.indexOf(':') + 1);
}

export function isLiveNationSale(name: string): boolean {
  return /live ?nation/i.test(name);
}

export function confidenceLabel(score: number): 'high' | 'medium' | 'low' {
  return score >= 0.7 ? 'high' : score >= 0.4 ? 'medium' : 'low';
}

export interface CodeContext {
  saleCodes: Map<string, string>;                  // your typed codes, by sale id
  artistCodes: { artist_id: string; sale_slug: string; code: string }[];
  webCodes: { scope: string; key: string; code: string; score: number; domains: string[]; source_url: string; snippet: string | null; votes: number }[];
  myVotes: Map<string, number>;                    // scope|key|code -> vote
}

export async function loadCodeContext(ctx: Ctx, userId: number): Promise<CodeContext> {
  const [sale, artist, web, votes] = await Promise.all([
    ctx.db.query<{ sale_id: string; code: string }>('SELECT sale_id, code FROM user_sale_codes WHERE user_id = $1', [userId]),
    ctx.db.query('SELECT artist_id, sale_slug, code FROM user_artist_codes WHERE user_id = $1', [userId]),
    ctx.db.query('SELECT scope, key, code, score, domains, source_url, snippet, votes FROM web_codes WHERE score >= 0.15 ORDER BY score DESC, last_seen DESC'),
    ctx.db.query<{ scope: string; key: string; code: string; vote: number }>('SELECT scope, key, code, vote FROM code_votes WHERE user_id = $1', [userId]),
  ]);
  return {
    saleCodes: new Map(sale.map((r) => [r.sale_id, r.code])),
    artistCodes: artist,
    webCodes: web,
    myVotes: new Map(votes.map((v) => [`${v.scope}|${v.key}|${v.code}`, Number(v.vote)])),
  };
}

/**
 * All code candidates for one sale, best first. A code you typed beats
 * everything, then one you saved for this artist + presale type, then
 * Ticketmaster's own text, the official Live Nation password, and web finds.
 */
export function codesForSale(sale: Pick<SaleRow, 'id' | 'name' | 'kind'> & { requirement?: SaleRow['requirement'] }, attractionIds: string[], c: CodeContext): CodeCandidate[] {
  const out: CodeCandidate[] = [];
  const seen = new Set<string>();
  const add = (cand: CodeCandidate) => {
    if (seen.has(cand.code)) return;
    seen.add(cand.code);
    out.push(cand);
  };
  const typed = c.saleCodes.get(sale.id);
  if (typed) add({ code: typed, source: 'you', score: 1, confidence: 'high' });
  if (sale.kind !== 'presale') return out;
  // Card and registration presales don't take shared codes; showing one would mislead.
  const takesSharedCodes = !['card', 'register', 'none'].includes(sale.requirement ?? 'unknown');

  const slug = saleSlug(sale.id);
  for (const r of c.artistCodes)
    if (r.sale_slug === slug && attractionIds.includes(r.artist_id)) add({ code: r.code, source: 'saved', score: 0.99, confidence: 'high' });

  const web = c.webCodes
    .filter((w) =>
      w.scope === 'sale'
        ? w.key === sale.id
        : w.scope === 'livenation'
          ? isLiveNationSale(sale.name)
          : takesSharedCodes && !isLiveNationSale(sale.name) && attractionIds.includes(w.key),
    )
    .map((w) => {
      const myVote = c.myVotes.get(`${w.scope}|${w.key}|${w.code}`) ?? 0;
      const score = myVote < 0 ? 0 : myVote > 0 ? Math.max(w.score, 0.97) : w.score;
      return { w, score, myVote };
    })
    .filter((x) => x.score >= 0.15)
    .sort((a, b) => b.score - a.score);

  for (const { w, score, myVote } of web) {
    add({
      code: w.code,
      source: w.scope === 'sale' ? 'ticketmaster' : w.scope === 'livenation' ? 'livenation' : 'web',
      score,
      confidence: confidenceLabel(score),
      scope: w.scope,
      key: w.key,
      domains: w.domains,
      sourceUrl: w.source_url,
      snippet: w.snippet,
      votes: w.votes,
      myVote,
    });
  }
  return out.slice(0, 6);
}
