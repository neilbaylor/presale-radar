/**
 * The scheduler. Every tick (5 minutes by default):
 *   1. refresh venues and artists that are due (each about once an hour)
 *   2. fan changes out to the people who care
 *   3. sold-out watch (if Inventory Status access is set up)
 *   4. sale reminders
 *   5. code finder (frequency ramps up as presales approach)
 *   6. release queued pushes and evening digests
 *   7. housekeeping once an hour
 * A Postgres advisory lock keeps two app instances from doubling up.
 */
import type { Ctx } from './types.js';
import { dueSources, getAllFollows, getSetting, now, prune, setSetting } from './db.js';
import { fanOut, syncSource, type Change } from './sync.js';
import { checkAvailability } from './availability.js';
import { runReminders } from './reminders.js';
import { findCodes } from './codes.js';
import { deliver } from './notify.js';
import { TmError } from './tm.js';
import { checkResale, syncSeatGeek } from './seatgeek.js';
import { syncAllCalendars } from './calsync.js';

const LOCK_KEY = 7_321_001;
/** Stay under Ticketmaster's 5,000 calls/day. */
const TM_DAILY_SOFT_LIMIT = 4_500;

async function step<T>(ctx: Ctx, name: string, fn: () => Promise<T>): Promise<T | { error: string }> {
  const start = now(ctx);
  try {
    const summary = await fn();
    await ctx.db.query(
      `INSERT INTO job_runs (job, last_start, last_end, last_error, summary) VALUES ($1, $2, $3, NULL, $4::jsonb)
       ON CONFLICT (job) DO UPDATE SET last_start = $2, last_end = $3, last_error = NULL, summary = $4::jsonb`,
      [name, start, now(ctx), JSON.stringify(summary ?? null)],
    );
    return summary;
  } catch (err: any) {
    const error = String(err?.message ?? err).slice(0, 500);
    console.error(`[job:${name}]`, err);
    await ctx.db.query(
      `INSERT INTO job_runs (job, last_start, last_end, last_error) VALUES ($1, $2, $3, $4)
       ON CONFLICT (job) DO UPDATE SET last_start = $2, last_end = $3, last_error = $4`,
      [name, start, now(ctx), error],
    );
    return { error };
  }
}

export async function syncDue(ctx: Ctx, opts: { limit?: number } = {}) {
  const day = new Date(now(ctx)).toISOString().slice(0, 10);
  const usage = await getSetting<{ day: string; calls: number }>(ctx, 'tm_usage', { day, calls: 0 });
  if (usage.day !== day) Object.assign(usage, { day, calls: 0 });
  // Back off to every 3 hours if we're burning through the daily quota.
  const interval = usage.calls > TM_DAILY_SOFT_LIMIT * 0.8 ? 180 : ctx.cfg.syncIntervalMin;
  if (usage.calls >= TM_DAILY_SOFT_LIMIT) return { skipped: 'daily Ticketmaster quota nearly used' };

  const sources = await dueSources(ctx, interval, opts.limit ?? 120);
  const changes: Change[] = [];
  const errors: string[] = [];
  let events = 0;
  for (const s of sources) {
    try {
      const r = await syncSource(ctx, s);
      events += r.events;
      changes.push(...r.changes);
      if (r.error) errors.push(`${r.source}: ${r.error}`);
    } catch (err) {
      if (err instanceof TmError) {
        errors.push(err.message);
        break;
      }
      throw err;
    }
    usage.calls += 1;
  }
  await setSetting(ctx, 'tm_usage', usage);
  const queued = await fanOut(ctx, changes, await getAllFollows(ctx));
  return { sources: sources.length, events, changes: changes.length, queued, errors: errors.slice(0, 5) };
}

export async function tick(ctx: Ctx): Promise<Record<string, unknown> | null> {
  return ctx.db.withLock(LOCK_KEY, async () => {
    const summary: Record<string, unknown> = {};
    summary.sync = await step(ctx, 'sync', () => syncDue(ctx));
    summary.seatgeek = await step(ctx, 'seatgeek', async () => {
      const r = await syncSeatGeek(ctx);
      const queued = await fanOut(ctx, r.changes);
      return { sources: r.sources, matched: r.matched, added: r.added, queued, errors: r.errors.slice(0, 5) };
    });
    summary.resale = await step(ctx, 'resale', () => checkResale(ctx));
    summary.availability = await step(ctx, 'availability', () => checkAvailability(ctx));
    summary.reminders = await step(ctx, 'reminders', () => runReminders(ctx));
    summary.codes = await step(ctx, 'codes', () => findCodes(ctx));
    summary.deliver = await step(ctx, 'deliver', () => deliver(ctx));
    summary.calendars = await step(ctx, 'calendars', () => syncAllCalendars(ctx));

    const lastPrune = await getSetting<number>(ctx, 'last_prune', 0);
    if (now(ctx) - lastPrune > 3_600_000) {
      await step(ctx, 'prune', () => prune(ctx));
      await setSetting(ctx, 'last_prune', now(ctx));
    }
    return summary;
  });
}

export function startScheduler(ctx: Ctx): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const s = await tick(ctx);
      if (s) console.log('[tick]', JSON.stringify(s));
    } catch (err) {
      console.error('[tick] failed', err);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(run, 5_000);
  const timer = setInterval(run, ctx.cfg.tickSeconds * 1000);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
