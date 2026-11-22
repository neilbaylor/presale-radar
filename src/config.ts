import type { Config } from './types.js';

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const demo = env.DEMO === '1' || env.DEMO === 'true';

  const railwayDomain = env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : null;
  return {
    port: num(env.PORT, 3000),
    publicUrl: (env.PUBLIC_URL || railwayDomain || null)?.replace(/\/+$/, '') ?? null,
    appSecret: env.APP_SECRET || null,
    tmApiKey: env.TM_API_KEY || null,
    vapidPublicKey: env.VAPID_PUBLIC_KEY || null,
    vapidPrivateKey: env.VAPID_PRIVATE_KEY || null,
    vapidSubject: env.VAPID_SUBJECT || 'mailto:presale-radar@example.com',
    homeLat: num(env.HOME_LAT, 43.6532),
    homeLon: num(env.HOME_LON, -79.3832),
    radiusKm: num(env.RADIUS_KM, 80),
    timeZone: env.TIMEZONE || 'America/Toronto',
    musicOnly: env.MUSIC_ONLY !== '0' && env.MUSIC_ONLY !== 'false',
    syncIntervalMin: num(env.SYNC_INTERVAL_MIN, 60),
    tickSeconds: num(env.TICK_SECONDS, 300),
    codeScrapeIntervalMin: num(env.CODE_SCRAPE_INTERVAL_MIN, 180),
    braveApiKey: env.BRAVE_API_KEY || null,
    seatgeekClientId: env.SEATGEEK_CLIENT_ID || null,
    inventoryApiKey: env.TM_INVENTORY_API_KEY || null,
    demo,
  };
}
