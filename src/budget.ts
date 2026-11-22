/** One daily budget per outside service, shared by every job. */
import type { Ctx } from './types.js';
import { now } from './db.js';

export const DAILY_LIMITS = {
  ticketmaster: 4500, // Discovery API allows 5,000/day
  seatgeek: 5000,
  brave: 30, // roughly what Brave's monthly free credit covers
  web: 3000, // venue sites, help articles, code pages
} as const;
export type Provider = keyof typeof DAILY_LIMITS;

const day = (ctx: Ctx) => new Date(now(ctx)).toISOString().slice(0, 10);

export async function spend(ctx: Ctx, provider: Provider, n = 1): Promise<void> {
  if (n <= 0) return;
  await ctx.db.query(
    `INSERT INTO api_usage (provider, day, calls) VALUES ($1, $2, $3)
     ON CONFLICT (provider, day) DO UPDATE SET calls = api_usage.calls + $3`,
    [provider, day(ctx), n],
  );
}

export async function usage(ctx: Ctx, provider: Provider): Promise<{ calls: number; limit: number; ratio: number }> {
  const row = await ctx.db.one<{ calls: number }>('SELECT calls FROM api_usage WHERE provider = $1 AND day = $2', [provider, day(ctx)]);
  const calls = row?.calls ?? 0;
  const limit = DAILY_LIMITS[provider];
  return { calls, limit, ratio: calls / limit };
}

export async function canSpend(ctx: Ctx, provider: Provider, n = 1): Promise<boolean> {
  const u = await usage(ctx, provider);
  return u.calls + n <= u.limit;
}
