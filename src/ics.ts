/**
 * Calendar events for a person: every sale they'll act on. Used both for the
 * subscribed feed and for direct sync into iCloud. Each event links to a
 * sign-in-free sale screen and carries "Got tickets" / "Not interested" links.
 */
import type { Ctx, EventRow, SaleRow, User } from './types.js';
import { codesForSale, getFollows, getSetting, interest, loadCodeContext, now, userEventMap } from './db.js';
import { headliner } from './sync.js';
import { requirementHint } from './reminders.js';
import { shortLink } from './secrets.js';
import { formatDate, sha256 } from './util.js';

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** RFC 5545 line folding at 75 octets. */
export function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let cur = '';
  let curLen = 0;
  for (const ch of line) {
    const len = new TextEncoder().encode(ch).length;
    if (curLen + len > (parts.length ? 74 : 75)) {
      parts.push(cur);
      cur = '';
      curLen = 0;
    }
    cur += ch;
    curLen += len;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}

export function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export interface CalEntry {
  uid: string;
  saleId: string;
  eventId: string;
  kind: 'sale' | 'signup';
  target: string; // comma-separated event ids, or the sign-up key
  body: string[]; // VEVENT content lines (without DTSTAMP), already folded
  hash: string;
}

/** The base URL links should use when there's no request in hand (scheduler). */
export async function baseUrlFor(ctx: Ctx): Promise<string> {
  return ctx.cfg.publicUrl ?? (await getSetting<string>(ctx, 'base_url', 'http://localhost:3000'));
}

export function uidFor(saleId: string): string {
  return `${saleId.replace(/[^A-Za-z0-9:._-]/g, '')}@presale-radar`;
}

export async function calendarEntries(ctx: Ctx, user: User, baseUrl: string): Promise<CalEntry[]> {
  const t = now(ctx);
  const rows = await ctx.db.query<SaleRow & { ev: EventRow }>(
    `SELECT s.*, row_to_json(e.*) AS ev FROM sales s JOIN events e ON e.id = s.event_id
      WHERE s.removed = FALSE AND s.start_utc IS NOT NULL AND s.start_utc > $1
        AND COALESCE(e.status, '') <> 'canceled'
      ORDER BY s.start_utc LIMIT 500`,
    [t - 3 * 86_400_000],
  );
  const [follows, ue, codes, devices] = await Promise.all([
    getFollows(ctx, user.id),
    userEventMap(ctx, [...new Set(rows.map((r) => r.event_id))]),
    loadCodeContext(ctx, user.id),
    ctx.db.one<{ n: number }>('SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE user_id = $1', [user.id]),
  ]);
  // With push on, the app already pings 15 minutes before; a calendar alarm too would be a double ping.
  const withAlarm = (devices?.n ?? 0) === 0;

  // One calendar event per sale moment: a tour's two Toronto dates with the same
  // presale at the same time become one event, not two identical ones.
  type Row = (typeof rows)[number];
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const state = ue.get(`${user.id}:${r.event_id}`);
    if (state?.got_tickets || interest(r.ev, state, follows).level !== 'remind') continue;
    const key = `${r.ev.attraction_ids?.[0] ?? r.ev.name}|${r.kind}|${r.name.toLowerCase()}|${r.start_utc}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }

  const out: CalEntry[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => (a.ev.local_date ?? '').localeCompare(b.ev.local_date ?? ''));
    const r = group[0];
    const eventIds = [...new Set(group.map((g) => g.event_id))];
    const who = headliner(r.ev);
    const saleName = r.kind === 'public' ? 'On-sale' : r.name.replace(/\s*pre-?sale$/i, ' presale').trim();
    const list = codesForSale(r, r.ev.attraction_ids ?? [], codes);
    const best = list[0];
    // Show the code right in the title when we trust it.
    const titleCode = best && (best.source !== 'web' || best.confidence === 'high') ? ` · ${best.code}` : '';
    const [open, got, hide] = await Promise.all([
      shortLink(ctx, baseUrl, user.id, 'sale', r.id),
      shortLink(ctx, baseUrl, user.id, 'got', eventIds.join(',')),
      shortLink(ctx, baseUrl, user.id, 'hide', eventIds.join(',')),
    ]);
    const dates = group.map((g) => `${formatDate(g.ev.local_date)} · ${g.ev.venue_name ?? ''}`);
    const desc = [
      requirementHint(r, list),
      '',
      `Buy: ${open}`,
      '',
      ...(group.length > 1 ? ['Shows:', ...dates.map((d) => `• ${d}`)] : [dates[0]]),
      '',
      `Got tickets: ${got}`,
      `Not for me: ${hide}`,
      'Or just delete this event.',
    ].join('\n');
    const body = [
      `UID:${uidFor(r.id)}`,
      `DTSTART:${stamp(r.start_utc!)}`,
      'DURATION:PT30M',
      fold(`SUMMARY:${esc(`🎟 ${who} ${saleName}${titleCode}`)}`),
      fold(`LOCATION:${esc(group.length > 1 ? `${group.length} dates` : r.ev.venue_name ?? '')}`),
      fold(`DESCRIPTION:${esc(desc)}`),
      fold(`URL:${open}`),
      // RFC 7986 event image. Apple and Google Calendar ignore it today; some calendar apps show it.
      ...(r.ev.image && /^https:/.test(r.ev.image) ? [fold(`IMAGE;VALUE=URI;DISPLAY=BADGE:${r.ev.image}`)] : []),
      ...(withAlarm
        ? ['BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', fold(`DESCRIPTION:${esc(`${who} ${saleName} in 15 minutes`)}`), 'END:VALARM']
        : []),
    ];
    out.push({ uid: uidFor(r.id), saleId: r.id, eventId: r.event_id, kind: 'sale', target: eventIds.join(','), body, hash: await sha256(body.join('\n')) });
  }

  // Sign-up deadlines for artists you follow (skipped once you tap "I'm signed up").
  const signups = await ctx.db.query<{ artist_id: string; name: string; label: string; at_utc: number; url: string; signup_url: string | null; done: boolean }>(
    `SELECT n.artist_id, a.name, n.label, n.at_utc, n.url, n.signup_url,
            EXISTS (SELECT 1 FROM job_marks m WHERE m.key = 'signed:' || $1::text || ':' || n.artist_id || ':' || n.label || ':' || n.at_utc) AS done
       FROM artist_notes n JOIN artists a ON a.id = n.artist_id
      WHERE n.kind = 'signup_deadline' AND n.at_utc > $2
        AND EXISTS (SELECT 1 FROM user_artists ua WHERE ua.user_id = $1::bigint AND ua.artist_id = n.artist_id AND ua.mode = 'follow')`,
    [user.id, t],
  );
  for (const n of signups) {
    if (n.done) continue;
    const link = n.signup_url ?? n.url;
    const uid = `signup-${n.artist_id}-${n.at_utc}@presale-radar`;
    const body = [
      `UID:${uid}`,
      `DTSTART:${stamp(n.at_utc - 60 * 60_000)}`,
      'DURATION:PT1H',
      fold(`SUMMARY:${esc(`✍️ Sign up: ${n.name} ${n.label}`)}`),
      fold(`DESCRIPTION:${esc(`Sign-up closes at the end of this event. Without it there's no presale code.\n\nSign up: ${link}\n\nAlready signed up? Delete this event.`)}`),
      fold(`URL:${link}`),
    ];
    out.push({ uid, saleId: uid, eventId: n.artist_id, kind: 'signup', target: `${n.artist_id}|${n.label}|${n.at_utc}`, body, hash: await sha256(body.join('\n')) });
  }
  return out;
}

const HEADER = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Presale Radar//EN', 'CALSCALE:GREGORIAN'];

/** One event as a standalone calendar object (what CalDAV PUT expects). */
export function singleEventIcs(entry: CalEntry, t: number): string {
  return [...HEADER, 'BEGIN:VEVENT', `DTSTAMP:${stamp(t)}`, ...entry.body, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n') + '\r\n';
}

/** The subscribed feed (for calendars without direct sync). */
export async function buildCalendar(ctx: Ctx, user: User, baseUrl: string): Promise<string> {
  const t = now(ctx);
  const entries = await calendarEntries(ctx, user, baseUrl);
  const lines = [...HEADER, 'METHOD:PUBLISH', 'X-WR-CALNAME:Presales', 'X-PUBLISHED-TTL:PT1H', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H'];
  for (const e of entries) lines.push('BEGIN:VEVENT', `DTSTAMP:${stamp(t)}`, ...e.body, 'END:VEVENT');
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}
