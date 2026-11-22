/**
 * Last-minute checks: about 45 and 10 minutes before each sale someone cares
 * about, re-read that exact event from Ticketmaster. Catches a moved presale or
 * a code added to the presale text before the 15-minute reminder goes out.
 */
import type { Ctx } from './types.js';
import { getAllFollows, interest, now, userEventMap } from './db.js';
import { normalizeEvent, tmGet, takeTmCalls } from './tm.js';
import { fanOut, upsertEvent } from './sync.js';
import { scanDescriptions } from './codes.js';
import { canSpend, spend } from './budget.js';

const STAGES = [45, 10];

/** True the first time a global job marker is set. */
export async function markOnce(ctx: Ctx, key: string): Promise<boolean> {
  const rows = await ctx.db.query('INSERT INTO job_marks (key, at) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING RETURNING key', [key, now(ctx)]);
  return rows.length > 0;
}

export async function precheckSales(ctx: Ctx): Promise<{ checked: number; changes: number }> {
  const t = now(ctx);
  const rows = await ctx.db.query<{ event_id: string; start_utc: number; venue_id: string | null; attraction_ids: string[] }>(
    `SELECT s.event_id, s.start_utc, e.venue_id, e.attraction_ids
       FROM sales s JOIN events e ON e.id = s.event_id
      WHERE s.removed = FALSE AND e.source = 'ticketmaster' AND s.start_utc BETWEEN $1 AND $2`,
    [t + 2 * 60_000, t + (Math.max(...STAGES) + 5) * 60_000],
  );
  if (!rows.length) return { checked: 0, changes: 0 };
  const [follows, ue] = await Promise.all([getAllFollows(ctx), userEventMap(ctx, rows.map((r) => r.event_id))]);
  const due = new Set<string>();
  for (const r of rows) {
    const cares = [...follows].some(([uid, f]) => {
      const st = ue.get(`${uid}:${r.event_id}`);
      return !st?.got_tickets && interest(r, st, f).level === 'remind';
    });
    if (!cares) continue;
    for (const stage of STAGES) {
      if (t >= r.start_utc - stage * 60_000 && (await markOnce(ctx, `pre:${r.event_id}:${stage}:${r.start_utc}`))) due.add(r.event_id);
    }
  }
  let changes = 0;
  takeTmCalls();
  for (const id of [...due].slice(0, 20)) {
    if (!(await canSpend(ctx, 'ticketmaster'))) break;
    try {
      const raw = await tmGet(ctx.cfg, `events/${id}.json`, {});
      if (!raw?.id) continue;
      const { event, sales } = normalizeEvent(raw);
      const c = await upsertEvent(ctx, event, sales, false);
      changes += await fanOut(ctx, c);
    } catch (err) {
      console.error('[precheck]', id, err);
    } finally {
      await spend(ctx, 'ticketmaster', takeTmCalls());
    }
  }
  if (due.size) await scanDescriptions(ctx);
  return { checked: due.size, changes };
}
