/**
 * Demo data cleanup. Running with DEMO=1 against the real database fills it with
 * made-up venues, artists and shows; the first start without DEMO removes them.
 * Accounts, push devices and calendar connections stay. Anyone left following
 * nothing is sent back through setup to pick real venues.
 */
import type { Ctx } from './types.js';

export async function purgeDemoData(ctx: Ctx): Promise<number> {
  const rows = await ctx.db.query<{ id: string }>(
    `DELETE FROM events
      WHERE id LIKE 'demo-%' OR id LIKE 'sg:sg-%' OR venue_id LIKE 'demo-%' OR sg_id LIKE 'sg-%'
         OR (source = 'web' AND url LIKE '%venue.example%')
     RETURNING id`,
  );
  await ctx.db.query(`DELETE FROM venues WHERE id LIKE 'demo-%'`);
  await ctx.db.query(`DELETE FROM artists WHERE id LIKE 'demo-%'`);
  await ctx.db.query(`DELETE FROM user_artist_codes WHERE artist_id LIKE 'demo-%'`);
  await ctx.db.query(`DELETE FROM web_codes WHERE key LIKE 'demo-%' OR source_url LIKE '%.test/%'`);
  await ctx.db.query(`DELETE FROM artist_notes WHERE artist_id LIKE 'demo-%'`);
  await ctx.db.query(`DELETE FROM venue_pages WHERE url LIKE '%venue.example%'`);
  await ctx.db.query(`DELETE FROM activity WHERE event_id LIKE 'demo-%' OR event_id LIKE 'sg:sg-%' OR body LIKE '%.test%'`);
  await ctx.db.query(`DELETE FROM job_marks WHERE key LIKE '%demo-%'`);
  // Old calendar entries for demo shows get removed by the next calendar sync.
  await ctx.db.query(
    `UPDATE users u SET onboarded = FALSE
      WHERE NOT EXISTS (SELECT 1 FROM user_venues v WHERE v.user_id = u.id)
        AND NOT EXISTS (SELECT 1 FROM user_artists a WHERE a.user_id = u.id)`,
  );
  return rows.length;
}
