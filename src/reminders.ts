import type { Ctx, EventRow, SaleRow } from './types.js';
import { codesForSale, getFollows, getUsers, interest, loadCodeContext, now, userEventMap, type CodeCandidate } from './db.js';
import { enqueue } from './notify.js';
import { headliner } from './sync.js';
import { formatTime } from './util.js';

export function requirementHint(sale: Pick<SaleRow, 'kind' | 'requirement'>, codes: CodeCandidate[]): string {
  const best = codes[0];
  if (best) {
    const tag = best.source === 'you' || best.source === 'saved' ? '' : best.source === 'ticketmaster' ? ' (from Ticketmaster)' : ` (${best.confidence} confidence)`;
    const alts = codes.slice(1, 3).map((c) => c.code);
    return `Code: ${best.code}${tag}${alts.length ? ` · backup: ${alts.join(', ')}` : ''}`;
  }
  if (sale.kind === 'public') return 'Public sale, no code needed.';
  switch (sale.requirement) {
    case 'card':
      return 'No code needed, just the eligible card.';
    case 'register':
      return 'Registration required. You must have signed up.';
    case 'code':
      return 'Needs a code. None found yet, so check your email.';
    case 'none':
      return '';
    default:
      return 'Check the presale details for access.';
  }
}

/** How long after it's due a reminder may still go out (missed ticks, late discovery). */
export function graceMs(offsetMin: number, tickMs: number): number {
  return Math.max(Math.min(offsetMin * 30_000, 6 * 3_600_000), tickMs + 60_000);
}

type Row = SaleRow & { ev: EventRow };

export async function runReminders(ctx: Ctx): Promise<number> {
  const t = now(ctx);
  const tick = ctx.cfg.tickSeconds * 1000;
  const users = await getUsers(ctx);
  if (!users.length) return 0;
  const maxOffset = Math.max(0, ...users.flatMap((u) => u.prefs.reminderMinutes));

  const rows = await ctx.db.query<Row>(
    `SELECT s.*, row_to_json(e.*) AS ev
       FROM sales s JOIN events e ON e.id = s.event_id
      WHERE s.removed = FALSE AND s.start_utc > $1 AND s.start_utc <= $2
        AND COALESCE(e.status, '') NOT IN ('canceled', 'postponed')
      ORDER BY s.start_utc`,
    [t - tick - 60_000, t + maxOffset * 60_000 + 60_000],
  );
  if (!rows.length) return 0;
  const ue = await userEventMap(ctx, [...new Set(rows.map((r) => r.event_id))]);

  let queued = 0;
  for (const user of users) {
    const follows = await getFollows(ctx, user.id);
    const offsets = [...user.prefs.reminderMinutes, ...(user.prefs.openPush ? [0] : [])];
    let codes: Awaited<ReturnType<typeof loadCodeContext>> | null = null;
    for (const row of rows) {
      const state = ue.get(`${user.id}:${row.event_id}`);
      if (state?.got_tickets) continue;
      if (interest(row.ev, state, follows).level !== 'remind') continue;
      const start = row.start_utc!;
      for (const offset of offsets) {
        const due = start - offset * 60_000;
        const fire = offset === 0 ? t >= start && t < start + tick + 60_000 : t >= due && t < start && t < due + graceMs(offset, tick);
        if (!fire) continue;

        codes ??= await loadCodeContext(ctx, user.id);
        const list = codesForSale(row, row.ev.attraction_ids ?? [], codes);
        const who = headliner(row.ev);
        const saleName = row.kind === 'public' ? 'Public on-sale' : row.name;
        const mins = Math.max(1, Math.round((start - t) / 60_000));
        const title = offset === 0 ? `${who}: ${saleName} is open` : `${who}: ${saleName} in ${mins} min`;
        // The earliest heads-up is the moment to catch an expired Ticketmaster session.
        const signin = offset > 0 && offset === Math.max(...offsets) ? 'Check you’re still signed in to Ticketmaster.' : null;
        const body = [`${row.ev.venue_name ?? ''} · ${formatTime(start, user.prefs.timeZone)}`, requirementHint(row, list), signin].filter(Boolean).join('\n');
        if (
          await enqueue(ctx, user.id, {
            type: 'reminder',
            priority: 'urgent',
            dedupeKey: `rem:${row.id}:${offset}:${start}`,
            eventId: row.event_id,
            saleId: row.id,
            title,
            body,
          })
        )
          queued++;
      }
    }
  }
  return queued;
}
