/**
 * Keeps each person's connected calendar in step with what they care about:
 * adds new sales, moves changed ones, removes shows they hid or bought.
 * Runs every scheduler tick and right after anything you do in the app.
 */
import type { Ctx } from './types.js';
import { getUser, now } from './db.js';
import { DavError, deleteResource, discoverHome, ensureCalendar, eventHref, ICLOUD_SERVER, listEventPaths, putEvent, type DavCreds } from './caldav.js';
import { setUserEvent } from './db.js';
import { signedUpKey } from './help.js';
import { enqueue } from './notify.js';
import { baseUrlFor, calendarEntries, singleEventIcs } from './ics.js';
import { decryptSecret, encryptSecret } from './secrets.js';

interface Account {
  user_id: number;
  provider: string;
  server: string;
  username: string;
  secret_enc: string;
  home_url: string | null;
  calendar_url: string | null;
  status: string;
  last_sync: number | null;
}

export async function connectICloud(ctx: Ctx, userId: number, appleId: string, appPassword: string, server = ICLOUD_SERVER): Promise<{ synced: number }> {
  // Apple shows these as xxxx-xxxx-xxxx-xxxx; accept them pasted with spaces too.
  const pw = appPassword.trim();
  const creds: DavCreds = { username: appleId.trim(), password: /^[a-z]{4}( [a-z]{4}){3}$/i.test(pw) ? pw.replace(/ /g, '-') : pw };
  const home = await discoverHome(server, creds);
  const calendarUrl = await ensureCalendar(home, creds);
  await ctx.db.query(
    `INSERT INTO calendar_accounts (user_id, provider, server, username, secret_enc, home_url, calendar_url, status, created_at)
     VALUES ($1, 'icloud', $2, $3, $4, $5, $6, 'ok', $7)
     ON CONFLICT (user_id) DO UPDATE SET provider = 'icloud', server = $2, username = $3, secret_enc = $4,
       home_url = $5, calendar_url = $6, status = 'ok', last_error = NULL`,
    [userId, server, creds.username, await encryptSecret(ctx, creds.password), home, calendarUrl, now(ctx)],
  );
  await ctx.db.query('DELETE FROM calendar_items WHERE user_id = $1', [userId]);
  const r = await syncUserCalendar(ctx, userId);
  return { synced: r.put };
}

export async function disconnectCalendar(ctx: Ctx, userId: number, removeCalendar: boolean): Promise<void> {
  const acct = await ctx.db.one<Account>('SELECT * FROM calendar_accounts WHERE user_id = $1', [userId]);
  if (!acct) return;
  if (removeCalendar && acct.calendar_url) {
    try {
      await deleteResource(acct.calendar_url, { username: acct.username, password: await decryptSecret(ctx, acct.secret_enc) });
    } catch (err) {
      console.error('[calendar] could not delete calendar', err);
    }
  }
  await ctx.db.query('DELETE FROM calendar_items WHERE user_id = $1', [userId]);
  await ctx.db.query('DELETE FROM calendar_accounts WHERE user_id = $1', [userId]);
}

const running = new Map<number, Promise<unknown>>();

/** Diff what should be in the calendar against what we wrote last time; send only the changes. */
export async function syncUserCalendar(ctx: Ctx, userId: number): Promise<{ put: number; deleted: number }> {
  const prev = running.get(userId);
  if (prev) await prev.catch(() => {});
  const job = doSync(ctx, userId);
  running.set(userId, job);
  try {
    return await job;
  } finally {
    if (running.get(userId) === job) running.delete(userId);
  }
}

async function doSync(ctx: Ctx, userId: number): Promise<{ put: number; deleted: number }> {
  const acct = await ctx.db.one<Account>('SELECT * FROM calendar_accounts WHERE user_id = $1', [userId]);
  const user = await getUser(ctx, userId);
  if (!acct || !acct.calendar_url || !user) return { put: 0, deleted: 0 };
  const creds: DavCreds = { username: acct.username, password: await decryptSecret(ctx, acct.secret_enc) };
  const t = now(ctx);
  let put = 0;
  let deleted = 0;
  try {
    await applyCalendarDeletes(ctx, acct, creds, userId);
    const desired = await calendarEntries(ctx, user, await baseUrlFor(ctx));
    const existing = new Map(
      (await ctx.db.query<{ uid: string; href: string; hash: string }>('SELECT uid, href, hash FROM calendar_items WHERE user_id = $1', [userId])).map(
        (r) => [r.uid, r],
      ),
    );
    for (const d of desired) {
      const have = existing.get(d.uid);
      existing.delete(d.uid);
      if (have && have.hash === d.hash) continue;
      const href = have?.href ?? eventHref(acct.calendar_url, d.uid);
      await putEvent(href, singleEventIcs(d, t), creds);
      await ctx.db.query(
        `INSERT INTO calendar_items (user_id, uid, href, hash, updated_at, kind, target) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (user_id, uid) DO UPDATE SET href = $3, hash = $4, updated_at = $5, kind = $6, target = $7`,
        [userId, d.uid, href, d.hash, t, d.kind, d.target],
      );
      put++;
    }
    for (const gone of existing.values()) {
      await deleteResource(gone.href, creds);
      await ctx.db.query('DELETE FROM calendar_items WHERE user_id = $1 AND uid = $2', [userId, gone.uid]);
      deleted++;
    }
    await ctx.db.query(`UPDATE calendar_accounts SET status = 'ok', last_error = NULL, last_sync = $1 WHERE user_id = $2`, [t, userId]);
  } catch (err: any) {
    const msg = err instanceof DavError ? err.message : `Calendar sync failed: ${String(err?.message ?? err).slice(0, 120)}`;
    await ctx.db.query(`UPDATE calendar_accounts SET status = 'error', last_error = $1, last_sync = $2 WHERE user_id = $3`, [msg, t, userId]);
    console.error('[calendar]', msg);
  }
  return { put, deleted };
}

/**
 * Deleting a presale event in Calendar is the natural way to say "not for me":
 * treat it like tapping Hide (or "I'm signed up" for a sign-up reminder).
 * If the whole calendar vanished, or most events disappeared at once, that's
 * not a choice about shows, so we put everything back instead.
 */
async function applyCalendarDeletes(ctx: Ctx, acct: Account, creds: DavCreds, userId: number): Promise<void> {
  const items = await ctx.db.query<{ uid: string; href: string; kind: string; target: string }>(
    'SELECT uid, href, kind, target FROM calendar_items WHERE user_id = $1',
    [userId],
  );
  if (!items.length) return;
  const onServer = await listEventPaths(acct.calendar_url!, creds);
  if (onServer === null) {
    // The Presales calendar itself was deleted: recreate it and re-add everything.
    const calendarUrl = await ensureCalendar(acct.home_url!, creds);
    await ctx.db.query('UPDATE calendar_accounts SET calendar_url = $1 WHERE user_id = $2', [calendarUrl, userId]);
    acct.calendar_url = calendarUrl;
    await ctx.db.query('DELETE FROM calendar_items WHERE user_id = $1', [userId]);
    return;
  }
  const missing = items.filter((i) => !onServer.has(decodeURIComponent(new URL(i.href).pathname)));
  if (!missing.length) return;
  if (missing.length > 3 && missing.length > items.length / 2) {
    await ctx.db.query('DELETE FROM calendar_items WHERE user_id = $1 AND uid = ANY($2::text[])', [userId, missing.map((m) => m.uid)]);
    return; // looks like a bulk wipe or a server hiccup: re-add on this sync
  }
  for (const m of missing) {
    if (m.kind === 'signup') {
      const [artistId, label, at] = m.target.split('|');
      await ctx.db.query('INSERT INTO job_marks (key, at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [signedUpKey(userId, artistId, label, Number(at)), now(ctx)]);
    } else {
      const ids = m.target.split(',').filter(Boolean);
      for (const id of ids) await setUserEvent(ctx, userId, id, { state: 'dismissed', seen: true });
      const ev = ids[0] ? await ctx.db.one<{ name: string; attraction_names: string[] }>('SELECT name, attraction_names FROM events WHERE id = $1', [ids[0]]) : null;
      if (ev)
        await enqueue(ctx, userId, {
          type: 'calendar_hide',
          priority: 'silent',
          dedupeKey: `calhide:${m.uid}:${now(ctx)}`,
          eventId: ids[0],
          title: `Hid ${ev.attraction_names[0] ?? ev.name}`,
          body: 'You deleted it from your calendar. Undo from the show page.',
        });
    }
    await ctx.db.query('DELETE FROM calendar_items WHERE user_id = $1 AND uid = $2', [userId, m.uid]);
  }
}

/** Called after anything a person does that could change their calendar. Coalesces bursts. */
const pending = new Map<number, ReturnType<typeof setTimeout>>();
export function scheduleCalendarSync(ctx: Ctx, userId: number, delayMs = 1500): void {
  clearTimeout(pending.get(userId));
  pending.set(
    userId,
    setTimeout(() => {
      pending.delete(userId);
      syncUserCalendar(ctx, userId).catch((e) => console.error('[calendar]', e));
    }, delayMs),
  );
}

export async function syncAllCalendars(ctx: Ctx): Promise<{ accounts: number; put: number; deleted: number }> {
  const accounts = await ctx.db.query<{ user_id: number }>('SELECT user_id FROM calendar_accounts');
  const out = { accounts: accounts.length, put: 0, deleted: 0 };
  for (const a of accounts) {
    const r = await syncUserCalendar(ctx, Number(a.user_id));
    out.put += r.put;
    out.deleted += r.deleted;
  }
  return out;
}
