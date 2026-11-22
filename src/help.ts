/**
 * Ticketmaster's help centre publishes an article per big tour: every presale,
 * when it starts, and (most useful) when Verified Fan / artist sign-up closes.
 * No API has the sign-up deadline, so we find those articles and read them.
 */
import type { Ctx } from './types.js';
import { now } from './db.js';
import { fetchPage, htmlToText, webSearch } from './codes.js';
import { findDates } from './textdates.js';
import { enqueue } from './notify.js';
import { canSpend } from './budget.js';
import { similarity } from './seatgeek.js';
import { formatWhen } from './util.js';

export interface HelpNote {
  kind: 'signup_deadline' | 'presale_time' | 'general_sale';
  label: string;
  atUtc: number;
  sentence: string;
  signupUrl: string | null;
}

const PRESALE_NAME = /\b((?:[A-Z][\w$&'’.-]*\s){0,4}(?:Verified Fan |Artist |Fan Club |Spotify |Live Nation |Venue |Cash App |American Express |Amex |Mastercard |Citi |RBC |Scotiabank |Rakuten )?Pre-?sale)\b/;

/** Pull sign-up deadlines and presale times out of a help article. */
export function parseHelpArticle(html: string, opts: { timeZone: string; ref: number }): HelpNote[] {
  const text = htmlToText(html);
  const links = [...html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => ({ href: m[1], text: htmlToText(m[2]).trim() }));
  const signupLink =
    links.find((l) => /verifiedfan|signup|sign-up|register|registration/i.test(l.href))?.href ??
    links.find((l) => /sign up|register/i.test(l.text))?.href ??
    null;
  const notes: HelpNote[] = [];
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  let lastPresale: string | null = null;
  for (const s of sentences) {
    const named = s.match(PRESALE_NAME)?.[1]?.trim() ?? null;
    if (named) lastPresale = named;
    const dates = findDates(s, { timeZone: opts.timeZone, ref: opts.ref, defaultHour: /before|by|until|closes|deadline|ends/i.test(s) ? 23 : 10, defaultMinute: /before|by|until|closes|deadline|ends/i.test(s) ? 59 : 0 });
    if (!dates.length) continue;

    if (/\b(sign up|sign-up|signup|register|registration)\b/i.test(s) && /\b(before|by|until|closes?|deadline|ends?)\b/i.test(s)) {
      const kw = s.search(/\b(before|by|until|closes?|deadline|ends?)\b/i);
      const d = dates.find((x) => x.index >= kw) ?? dates[dates.length - 1];
      notes.push({ kind: 'signup_deadline', label: named ?? lastPresale ?? 'Presale sign-up', atUtc: d.utc, sentence: s, signupUrl: signupLink });
      continue;
    }
    if (/\bgeneral (sale|on-?sale|public sale)\b|\bpublic on-?sale\b/i.test(s) && /\b(begins|starts|is on|opens|will be)\b/i.test(s)) {
      notes.push({ kind: 'general_sale', label: 'General sale', atUtc: dates[0].utc, sentence: s, signupUrl: null });
      continue;
    }
    if (named && /\b(begins|starts|is on|runs|opens|will be)\b/i.test(s)) {
      notes.push({ kind: 'presale_time', label: named, atUtc: dates[0].utc, sentence: s, signupUrl: null });
    }
  }
  // Same fact phrased twice: keep one.
  const seen = new Set<string>();
  return notes.filter((n) => {
    const k = `${n.kind}|${n.label.toLowerCase()}|${n.atUtc}`;
    return !seen.has(k) && seen.add(k);
  });
}

/** Artists worth looking up: followed ones, and headliners of shows people get reminders for. */
async function artistsToCheck(ctx: Ctx): Promise<{ id: string; name: string; urgent: boolean }[]> {
  const t = now(ctx);
  const rows = await ctx.db.query<{ id: string; name: string; help_checked: number | null; soon: boolean }>(
    `SELECT a.id, a.name, a.help_checked,
            EXISTS (SELECT 1 FROM events e JOIN sales s ON s.event_id = e.id
                     WHERE a.id = ANY(e.attraction_ids) AND s.kind = 'presale' AND s.removed = FALSE
                       AND s.start_utc BETWEEN $1 AND $2 AND COALESCE(s.requirement, '') IN ('register', 'code', 'unknown')) AS soon
       FROM artists a
      WHERE EXISTS (SELECT 1 FROM user_artists ua WHERE ua.artist_id = a.id AND ua.mode = 'follow')`,
    [t, t + 10 * 86_400_000],
  );
  return rows
    .filter((r) => {
      const every = r.soon ? 3 * 3_600_000 : 24 * 3_600_000;
      return !r.help_checked || t - r.help_checked > every;
    })
    .map((r) => ({ id: r.id, name: r.name, urgent: r.soon }))
    .sort((a, b) => Number(b.urgent) - Number(a.urgent));
}

export async function checkHelpArticles(ctx: Ctx): Promise<{ artists: number; notes: number; errors: string[] }> {
  const out = { artists: 0, notes: 0, errors: [] as string[] };
  if (!ctx.cfg.braveApiKey && !ctx.cfg.demo) return out;
  const t = now(ctx);
  for (const a of (await artistsToCheck(ctx)).slice(0, 6)) {
    if (!ctx.cfg.demo && !(await canSpend(ctx, 'brave'))) break;
    await ctx.db.query('UPDATE artists SET help_checked = $1 WHERE id = $2', [t, a.id]);
    out.artists++;
    try {
      const hits = (await webSearch(ctx, `site:help.ticketmaster.ca OR site:help.ticketmaster.com "${a.name}" presale`)).filter(
        (h) => /help\.ticketmaster\./.test(h.url) && similarity(a.name, `${h.title} ${h.snippet}`) === 1,
      );
      for (const h of hits.slice(0, 2)) {
        const html = await fetchPage(ctx, h.url, 'help');
        if (similarity(a.name, htmlToText(html)) < 1) continue;
        for (const n of parseHelpArticle(html, { timeZone: ctx.cfg.timeZone, ref: t })) {
          if (n.atUtc < t - 86_400_000) continue;
          const rows = await ctx.db.query(
            `INSERT INTO artist_notes (artist_id, kind, label, at_utc, url, signup_url, sentence, found_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING artist_id`,
            [a.id, n.kind, n.label, n.atUtc, h.url, n.signupUrl, n.sentence.slice(0, 400), t],
          );
          if (rows.length) {
            out.notes++;
            if (n.kind === 'signup_deadline' && n.atUtc > t) await announceSignup(ctx, a.id, a.name, n, h.url);
          }
        }
      }
    } catch (err: any) {
      out.errors.push(`${a.name}: ${String(err?.message ?? err).slice(0, 100)}`);
    }
  }
  return out;
}

/** People who'd want to know about this artist's sign-up: followers, minus anyone who muted them. */
async function interestedUsers(ctx: Ctx, artistId: string): Promise<{ id: number; tz: string }[]> {
  const rows = await ctx.db.query<{ id: number; prefs: any }>(
    `SELECT u.id, u.prefs FROM users u
      WHERE EXISTS (SELECT 1 FROM user_artists ua WHERE ua.user_id = u.id AND ua.artist_id = $1 AND ua.mode = 'follow')`,
    [artistId],
  );
  return rows.map((r) => ({ id: Number(r.id), tz: r.prefs?.timeZone || '' }));
}

async function announceSignup(ctx: Ctx, artistId: string, name: string, n: HelpNote, url: string) {
  for (const u of await interestedUsers(ctx, artistId)) {
    await enqueue(ctx, u.id, {
      type: 'signup',
      priority: 'instant',
      dedupeKey: `signup:${artistId}:${n.label}:${n.atUtc}`,
      title: `Sign up for ${name}'s ${n.label.replace(/^the /i, '')}`,
      body: `Sign-up closes ${formatWhen(n.atUtc, u.tz || ctx.cfg.timeZone)}. You can't get the code without it.`,
      url: n.signupUrl ?? url,
    });
  }
}

/** A last nudge 3 hours before a sign-up closes. */
export async function remindSignups(ctx: Ctx): Promise<number> {
  const t = now(ctx);
  const notes = await ctx.db.query<{ artist_id: string; label: string; at_utc: number; url: string; signup_url: string | null }>(
    `SELECT n.artist_id, n.label, n.at_utc, n.url, n.signup_url FROM artist_notes n
      WHERE n.kind = 'signup_deadline' AND n.at_utc BETWEEN $1 AND $2`,
    [t, t + 3 * 3_600_000],
  );
  let sent = 0;
  for (const n of notes) {
    const artist = await ctx.db.one<{ name: string }>('SELECT name FROM artists WHERE id = $1', [n.artist_id]);
    for (const u of await interestedUsers(ctx, n.artist_id)) {
      if (await ctx.db.one('SELECT 1 FROM job_marks WHERE key = $1', [signedUpKey(u.id, n.artist_id, n.label, n.at_utc)])) continue;
      const ok = await enqueue(ctx, u.id, {
        type: 'signup',
        priority: 'urgent',
        dedupeKey: `signup-last:${n.artist_id}:${n.label}:${n.at_utc}`,
        title: `Last call: ${artist?.name ?? 'presale'} sign-up closes ${formatWhen(n.at_utc, u.tz || ctx.cfg.timeZone).replace(/^\w+, /, '')}`,
        body: `${n.label}. Takes a minute. Skip it if you already signed up.`,
        url: n.signup_url ?? n.url,
      });
      if (ok) sent++;
    }
  }
  return sent;
}

/** "I'm signed up" marker, so the last-call nudge is skipped. */
export function signedUpKey(userId: number, artistId: string, label: string, atUtc: number): string {
  return `signed:${userId}:${artistId}:${label}:${atUtc}`;
}
