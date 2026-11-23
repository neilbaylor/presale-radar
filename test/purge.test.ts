import { describe, expect, it } from 'vitest';
import { makeCtx, addUser } from './helpers.js';
import { syncSource } from '../src/sync.js';
import { purgeDemoData } from '../src/purge.js';

describe('switching from demo to real data', () => {
  it('removes demo shows and follows, keeps the account, and sends you back to setup', async () => {
    const ctx = await makeCtx();
    ctx.clock.t = Date.now();
    const uid = await addUser(ctx);
    await ctx.db.query(`UPDATE users SET onboarded = TRUE`);
    await ctx.db.query(`INSERT INTO venues (id, name) VALUES ('demo-v-mas', 'Massey Hall'), ('KovZ917A', 'Real Venue')`);
    await ctx.db.query(`INSERT INTO user_venues (user_id, venue_id, added_at) VALUES ($1, 'demo-v-mas', 0)`, [uid]);
    await ctx.db.query(`INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES ('https://push.example/1', $1, 'k', 'a', 0)`, [uid]);
    await syncSource(ctx, { type: 'venue', id: 'demo-v-mas', name: 'Massey Hall', lastSynced: null });
    expect((await ctx.db.query('SELECT 1 FROM events')).length).toBeGreaterThan(0);

    expect(await purgeDemoData(ctx)).toBeGreaterThan(0);
    expect(await ctx.db.query('SELECT 1 FROM events')).toEqual([]);
    expect((await ctx.db.query<any>('SELECT id FROM venues')).map((v) => v.id)).toEqual(['KovZ917A']);
    expect(await ctx.db.query('SELECT 1 FROM user_venues')).toEqual([]);
    expect((await ctx.db.one<any>('SELECT onboarded FROM users WHERE id = $1', [uid])).onboarded).toBe(false);
    expect((await ctx.db.query('SELECT 1 FROM push_subscriptions')).length).toBe(1);
    expect(await purgeDemoData(ctx)).toBe(0); // safe to run on every start
  });
});
