import pg from 'pg';
import { MIGRATIONS } from './schema.js';

export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = any>(sql: string, params?: unknown[]): Promise<T | null>;
  /** Run `fn` in a transaction. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  /** Run `fn` only if no other process holds `key` (Postgres advisory lock). Returns null if skipped. */
  withLock<T>(key: number, fn: () => Promise<T>): Promise<T | null>;
  close(): Promise<void>;
}

// BIGINT (int8) comes back as a string by default; our values are ms timestamps, safe as numbers.
pg.types.setTypeParser(20, (v) => Number(v));

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

function wrap(q: Queryable, extra: Pick<Db, 'tx' | 'withLock' | 'close'>): Db {
  return {
    async query(sql, params) {
      return (await q.query(sql, params as any[])).rows;
    },
    async one(sql, params) {
      return (await q.query(sql, params as any[])).rows[0] ?? null;
    },
    ...extra,
  };
}

export function postgresDb(connectionString: string): Db {
  const ssl = /sslmode=require/.test(connectionString) || process.env.PGSSL === '1' ? { rejectUnauthorized: false } : undefined;
  const pool = new pg.Pool({ connectionString, max: 5, ssl });
  pool.on('error', (err) => console.error('[db] idle client error', err));

  const db: Db = wrap(pool, {
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const inner = wrap(client, { tx: (f) => f(inner), withLock: db.withLock, close: async () => {} });
        const out = await fn(inner);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async withLock(key, fn) {
      const client = await pool.connect();
      try {
        const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [key]);
        if (!rows[0]?.ok) return null;
        try {
          return await fn();
        } finally {
          await client.query('SELECT pg_advisory_unlock($1)', [key]).catch(() => {});
        }
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  });
  return db;
}

/** Embedded Postgres (WASM). Used for tests and for demo mode without DATABASE_URL. */
export async function embeddedDb(dataDir?: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const lite = new PGlite(dataDir);
  await lite.waitReady;
  const q: Queryable = {
    query: async (sql, params) => {
      const r = await lite.query(sql, params as any[]);
      return { rows: r.rows.map(fixBigints) };
    },
  };
  let running: Promise<unknown> = Promise.resolve();
  const db: Db = wrap(q, {
    async tx(fn) {
      // PGlite is single-connection; serialize transactions.
      const run = running.then(async () => {
        await lite.query('BEGIN');
        try {
          const out = await fn(db);
          await lite.query('COMMIT');
          return out;
        } catch (err) {
          await lite.query('ROLLBACK').catch(() => {});
          throw err;
        }
      });
      running = run.catch(() => {});
      return run;
    },
    async withLock(_key, fn) {
      return fn();
    },
    async close() {
      await lite.close();
    },
  });
  return db;
}

function fixBigints(row: any) {
  for (const k in row) if (typeof row[k] === 'bigint') row[k] = Number(row[k]);
  return row;
}

export async function migrate(db: Db): Promise<number> {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)');
  const done = new Set((await db.query<{ version: number }>('SELECT version FROM schema_migrations')).map((r) => Number(r.version)));
  let applied = 0;
  for (let i = 0; i < MIGRATIONS.length; i++) {
    const version = i + 1;
    if (done.has(version)) continue;
    await db.tx(async (t) => {
      for (const stmt of splitSql(MIGRATIONS[i])) await t.query(stmt);
      await t.query('INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)', [version, Date.now()]);
    });
    applied++;
  }
  return applied;
}

/** Split a migration into statements. Our schema has no `--` or `;` inside string literals. */
export function splitSql(sql: string): string[] {
  return sql
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}
