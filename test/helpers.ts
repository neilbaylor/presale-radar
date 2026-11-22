import { embeddedDb, migrate } from '../src/database.js';
import { loadConfig } from '../src/config.js';
import type { Ctx } from '../src/types.js';
import { createUser } from '../src/auth.js';
import { pushTransport } from '../src/push.js';

export interface TestCtx extends Ctx {
  clock: { t: number };
}

export async function makeCtx(env: Record<string, string> = {}): Promise<TestCtx> {
  const db = await embeddedDb();
  await migrate(db);
  const cfg = loadConfig({ DEMO: '1', TICK_SECONDS: '300', ...env } as any);
  const clock = { t: Date.parse('2026-12-01T14:00:00Z') }; // 9:00 AM Toronto
  pushTransport.log = [];
  return { db, cfg, secret: 'test-secret', now: () => clock.t, clock };
}

export async function addUser(ctx: Ctx, name = 'Neil', role: 'owner' | 'member' = 'owner') {
  return createUser(ctx, { name, email: `${name.toLowerCase()}@example.com`, password: 'password123' }, role);
}

/** A raw Ticketmaster event, as the Discovery API returns it. */
export function tmEvent(o: {
  id: string;
  venueId?: string;
  venueName?: string;
  artistId?: string;
  artist?: string;
  showUtc: number;
  publicUtc?: number | null;
  presales?: { name: string; startUtc: number; description?: string }[];
  status?: string;
}) {
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return {
    id: o.id,
    name: o.artist ?? 'Some Artist',
    url: `https://www.ticketmaster.ca/event/${o.id}`,
    images: [],
    dates: {
      start: { localDate: iso(o.showUtc).slice(0, 10), localTime: '19:30:00', dateTime: iso(o.showUtc) },
      status: { code: o.status ?? 'onsale' },
    },
    sales: {
      public: o.publicUtc === null ? undefined : { startDateTime: iso(o.publicUtc ?? o.showUtc - 30 * 86_400_000), startTBD: false },
      presales: (o.presales ?? []).map((p) => ({ name: p.name, description: p.description, startDateTime: iso(p.startUtc), endDateTime: iso(p.startUtc + 86_400_000) })),
    },
    _embedded: {
      venues: [{ id: o.venueId ?? 'V1', name: o.venueName ?? 'Massey Hall', city: { name: 'Toronto' } }],
      attractions: o.artistId ? [{ id: o.artistId, name: o.artist ?? 'Some Artist' }] : [],
    },
  };
}

export const HOUR = 3_600_000;
export const DAY = 86_400_000;
