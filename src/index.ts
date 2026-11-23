import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { embeddedDb, migrate, postgresDb, type Db } from './database.js';
import { createApp } from './server.js';
import { startScheduler } from './jobs.js';
import { getSetting, setSetting } from './db.js';
import { randomToken } from './util.js';
import type { Ctx } from './types.js';
import { purgeDemoData } from './purge.js';

async function main() {
  const cfg = loadConfig();
  let db: Db;
  if (process.env.DATABASE_URL) db = postgresDb(process.env.DATABASE_URL);
  else if (cfg.demo) {
    console.log('[boot] No DATABASE_URL: using an in-memory database (demo only, nothing is kept).');
    db = await embeddedDb();
  } else throw new Error('DATABASE_URL is required. On Railway, add a Postgres database and reference it from this service.');

  const applied = await migrate(db);
  if (applied) console.log(`[boot] applied ${applied} migration(s)`);

  const ctx: Ctx = { db, cfg, secret: cfg.appSecret ?? '' };
  if (!ctx.secret) {
    ctx.secret = await getSetting<string>(ctx, 'app_secret', '');
    if (!ctx.secret) {
      ctx.secret = randomToken(32);
      await setSetting(ctx, 'app_secret', ctx.secret);
    }
  }

  if (!cfg.demo) {
    const n = await purgeDemoData(ctx);
    if (n) console.log(`[boot] removed ${n} demo shows; real data from here on`);
  }

  const missing = [
    !cfg.tmApiKey && !cfg.demo && 'TM_API_KEY (no shows will load)',
    (!cfg.vapidPublicKey || !cfg.vapidPrivateKey) && 'VAPID keys (push notifications are off; run `npm run vapid`)',
    !cfg.braveApiKey && 'BRAVE_API_KEY (code finder will skip web search)',
    !cfg.seatgeekClientId && 'SEATGEEK_CLIENT_ID (no resale prices or non-Ticketmaster shows)',
    !cfg.inventoryApiKey && 'TM_INVENTORY_API_KEY (sold-out watch is off until Ticketmaster approves access)',
  ].filter(Boolean);
  if (!cfg.demo) for (const m of missing) console.warn(`[boot] missing ${m}`);

  const app = createApp(ctx);
  const server = serve({ fetch: app.fetch, port: cfg.port }, (info) => console.log(`[boot] Presale Radar on :${info.port}${cfg.demo ? ' (demo)' : ''}`));
  const stop = startScheduler(ctx);

  const shutdown = async () => {
    console.log('[boot] shutting down');
    stop();
    server.close();
    await db.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[boot] failed:', err?.message ?? err);
  process.exit(1);
});
